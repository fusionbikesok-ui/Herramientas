"""unittest suite; PostgreSQL integration uses a disposable schema, fake transports.
Set INBOX_TEST_DATABASE_URL explicitly. Never points to production by default.
"""
from __future__ import annotations
import base64
import hashlib
import hmac
import json
import os
import threading
import time
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta
from types import SimpleNamespace
from unittest.mock import patch

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo

from app.config import get_settings
from app import inbox
from app.inbox_events import ingest, ai_revision, enqueue_ai, delivery_status
from app.inbox_media import MediaError, SendRejected, CloudTransport, validate_media, decode_upload
from app.inbox_webhook import events_from_meta, history_events
from app.outbox_worker import run_once, recover_interrupted
from app.storage import connection, init_schema, recent_messages, set_system_setting

PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR4sAAAAASUVORK5CYII=')
ACTOR = {'id': 'herramientas:1', 'name': 'Operador 1', 'role': 'agent'}
SUPERVISOR = {'id': 'herramientas:99', 'name': 'Supervisión', 'role': 'supervisor'}
READER = {'id': 'herramientas:20', 'name': 'Consulta', 'role': 'reader'}


class MemoryNonce:
    def __init__(self): self.values = set()
    def set(self, key, value, nx, ex):
        if key in self.values: return False
        self.values.add(key)
        return True


class SecurityTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {'INBOX_PROXY_SECRET': 's' * 48})
        self.env.start()
        self.addCleanup(self.env.stop)

    def headers(self, body=b'{"op":"status"}', stamp=None):
        stamp = str(int(time.time()) if stamp is None else stamp)
        nonce = str(uuid.uuid4())
        signature = hmac.new(b's' * 48, (stamp + '.' + nonce + '.').encode() + body, hashlib.sha256).hexdigest()
        return {'x-inbox-timestamp': stamp, 'x-inbox-nonce': nonce, 'x-inbox-signature': signature}

    def test_signature_replay_body_and_timestamp(self):
        body = b'{"op":"status"}'
        headers = self.headers(body)
        nonce = MemoryNonce()
        inbox.verify_request(body, headers, nonce)
        with self.assertRaisesRegex(inbox.InboxError, 'replayed_request'):
            inbox.verify_request(body, headers, nonce)
        with self.assertRaisesRegex(inbox.InboxError, 'invalid_signature'):
            inbox.verify_request(body + b' ', self.headers(body), nonce)
        with self.assertRaisesRegex(inbox.InboxError, 'invalid_timestamp'):
            inbox.verify_request(body, self.headers(body, int(time.time()) - 61), nonce)

    def test_absent_secret_and_redis_failure_are_closed(self):
        with patch.dict(os.environ, {'INBOX_PROXY_SECRET': ''}):
            with self.assertRaisesRegex(inbox.InboxError, 'inbox_not_configured'):
                inbox.verify_request(b'', {}, MemoryNonce())
        class Down:
            def set(self, *args, **kwargs): raise OSError('unavailable')
        with self.assertRaisesRegex(inbox.InboxError, 'nonce_store_unavailable'):
            inbox.verify_request(b'', self.headers(b''), Down())

    def test_actor_requires_server_namespace_and_known_role(self):
        for actor in ({'id':'1','name':'A','role':'agent'}, {'id':'herramientas:1','name':'A','role':'admin'}, {}):
            with self.assertRaises(inbox.InboxError): inbox.actor_from({'actor': actor})

    def test_media_real_signature_size_and_safe_filename(self):
        mime, name, kind = validate_media(PNG, 'image/png', '../../factura.exe')
        self.assertEqual((mime, name, kind), ('image/png', 'factura.png', 'image'))
        for data, mime in ((b'<svg onload=alert(1)>', 'image/png'), (b'MZ' + PNG, 'image/png'),
                           (b'%PDF-1.4 /JavaScript (evil) %%EOF', 'application/pdf')):
            with self.assertRaises(MediaError): validate_media(data, mime, 'archivo')
        with self.assertRaises(MediaError): validate_media(b'x' * (5 * 1024 * 1024 + 1), 'image/png', 'a.png')
        with self.assertRaises(MediaError): decode_upload('abc!')
        with self.assertRaises(MediaError): validate_media(b'OggS' + b'vorbis' + b'0' * 40, 'audio/ogg', 'a.ogg')

    def test_related_phone_identity_is_strict_not_suffix_matching(self):
        for number in ('3511234567','54 351 123-4567','+54 9 (351) 1234567'):
            self.assertEqual(inbox.related_phone_identity(number),('ar','3511234567'))
        self.assertEqual(inbox.related_phone_identity('+3511234567'),('exact','3511234567'))
        self.assertEqual(inbox.related_phone_identity('+1 3511234567'),('exact','13511234567'))
        self.assertEqual(inbox.related_phone_identity('+44 3511234567'),('exact','443511234567'))
        self.assertIsNone(inbox.related_phone_identity('3511234567 ext 9'))
        self.assertIsNone(inbox.related_phone_identity('54+93511234567'))

    def test_download_rejects_untrusted_url_before_fetch(self):
        class Response:
            def raise_for_status(self): pass
            def json(self): return {'url':'https://127.0.0.1/private','mime_type':'image/png'}
        class Client:
            def __init__(self, **kwargs): pass
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def get(self, *args, **kwargs): return Response()
            def stream(self, *args, **kwargs): raise AssertionError('SSRF request attempted')
        with patch('app.inbox_media.httpx.Client', Client):
            with self.assertRaisesRegex(MediaError, 'unsafe_media_url'):
                CloudTransport(SimpleNamespace(meta_graph_version='v26.0', whatsapp_access_token='fake')).download('123','111')

    def test_parser_echo_and_history_are_explicit(self):
        settings = SimpleNamespace(number=lambda number: {'label':'Ventas','display_number':'5493515214819'})
        value = {'metadata': {'phone_number_id':'111'}, 'message_echoes':[
            {'id':'wamid.echo','from':'5493515214819','to':'5493511234567','timestamp':str(int(time.time())), 'type':'text','text':{'body':'Hola'}}]}
        events = events_from_meta({'entry':[{'changes':[{'field':'smb_message_echoes','value':value}]}]}, settings)
        self.assertEqual(events[0]['event_type'], 'whatsapp_echo')
        self.assertEqual(events[0]['conversation']['external_user_id'],'5493511234567')
        history = {'metadata':{'phone_number_id':'111'},'history':[{'threads':[{'id':'5493511234567','messages':[
            {'id':'history1','from':'5493511234567','timestamp':'1600000000','type':'text','text':{'body':'Viejo'}}]}]}]}
        batch = events_from_meta({'entry':[{'changes':[{'field':'history','value':history}]}]}, settings)
        self.assertEqual(len(batch),1)
        self.assertEqual(batch[0]['event_type'],'whatsapp_history_batch')
        self.assertTrue(list(history_events(history,settings))[0]['historical'])


@unittest.skipUnless(os.getenv('INBOX_TEST_DATABASE_URL'), 'Explicit isolated PostgreSQL URL required')
class DatabaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.original_env = dict(os.environ)
        cls.dsn = os.environ['INBOX_TEST_DATABASE_URL']
        cls.schema = 'inbox_test_' + uuid.uuid4().hex
        with psycopg.connect(cls.dsn, autocommit=True) as conn:
            conn.execute(sql.SQL('CREATE SCHEMA {}').format(sql.Identifier(cls.schema)))
        os.environ.update(DATABASE_URL=make_conninfo(cls.dsn, options='-c search_path=' + cls.schema),
            WHATSAPP_NUMBERS_JSON=json.dumps({'111':{'display_number':'5493515214819','label':'Ventas'}}),
            WHATSAPP_ACCESS_TOKEN='fake-never-network', INBOX_CONNECTED_NUMBER_IDS='111', INBOX_PROXY_SECRET='s'*48)
        get_settings.cache_clear()
        init_schema()

    @classmethod
    def tearDownClass(cls):
        assert cls.schema.startswith('inbox_test_') and len(cls.schema) == len('inbox_test_') + 32
        with psycopg.connect(cls.dsn, autocommit=True) as conn:
            conn.execute(sql.SQL('DROP SCHEMA {} CASCADE').format(sql.Identifier(cls.schema)))
        os.environ.clear()
        os.environ.update(cls.original_env)
        get_settings.cache_clear()

    def setUp(self):
        with connection() as conn:
            conn.execute('TRUNCATE inbox_audit,inbox_outbox,inbox_requests,inbox_media,messages,conversations,inbox_presence,system_settings RESTART IDENTITY CASCADE')
        set_system_setting('bot_enabled',False)
        set_system_setting('whatsapp_bot_number:5493515214819',False)
        self.key, _ = ingest(self.incoming())

    def incoming(self, external_id=None, recipient='5493511234567', historical=False, echo=False, stamp=None, raw=None):
        external_id = external_id or 'wa.' + uuid.uuid4().hex
        raw = raw or {'type':'text','text':{'body':'Consulta'}}
        return {'event_id':'event:' + external_id, 'event_type':'whatsapp_echo' if echo else 'whatsapp_inbound',
            'historical':historical,'occurred_at':str(int(time.time()) if stamp is None else stamp),
            'conversation':{'channel':'whatsapp','channel_number_id':'111','external_user_id':recipient,
                'customer_phone':recipient,'channel_label':'Ventas','customer_name':'Cliente'},
            'message':{'external_id':external_id,'type':raw['type'],'raw':raw,'text':'Consulta','sender':'operator' if echo else 'customer'}}

    def row(self):
        with connection() as conn:
            return conn.execute('SELECT * FROM conversations WHERE conversation_key=%s',(self.key,)).fetchone()

    def call(self, action, actor=ACTOR, revision=None, **extra):
        payload = dict(op='command',actor=actor,key=self.key,request_id=str(uuid.uuid4()),
            revision=self.row()['revision'] if revision is None else revision,action=action)
        payload.update(extra)
        return inbox.handle(payload)

    def enable_ai(self):
        set_system_setting('bot_enabled',True)
        set_system_setting('whatsapp_bot_number:5493515214819',True)

    def decision(self):
        return SimpleNamespace(reply='Respuesta IA', handoff=False, reason='')

    def count(self, table):
        with connection() as conn:
            return conn.execute(sql.SQL('SELECT count(*) AS n FROM {}').format(sql.Identifier(table))).fetchone()['n']

    def test_five_agents_compete_only_one_takes(self):
        revision = self.row()['revision']
        barrier = threading.Barrier(5)
        def take(i):
            barrier.wait()
            try:
                return self.call('take', actor={'id':f'herramientas:{i+1}','name':f'Agente {i+1}','role':'agent'},revision=revision)
            except inbox.InboxError as exc: return exc.code
        started=time.monotonic()
        with ThreadPoolExecutor(5) as pool: results = list(pool.map(take,range(5)))
        print(f'5-agent concurrent take wall_ms={(time.monotonic()-started)*1000:.1f}', flush=True)
        self.assertEqual(sum(isinstance(r,dict) for r in results),1)
        self.assertEqual(results.count('revision_conflict'),4)
        self.assertTrue(self.row()['owner_id'])
        self.assertEqual(self.row()['bot_status'],'paused')

    def test_five_concurrent_same_uuid_sends_once(self):
        self.call('take')
        request_id = str(uuid.uuid4())
        revision = self.row()['revision']
        barrier = threading.Barrier(5)
        def send(i):
            barrier.wait()
            return self.call('send',revision=revision,request_id=request_id,text='Un solo envío')
        with ThreadPoolExecutor(5) as pool: results=list(pool.map(send,range(5)))
        self.assertEqual(len({r['message']['id'] for r in results}),1)
        self.assertEqual(self.count('inbox_outbox'),1)

    def test_five_distinct_uuids_same_revision_cannot_double_send(self):
        self.call('take')
        revision=self.row()['revision']
        barrier=threading.Barrier(5)
        def send(i):
            barrier.wait()
            try: return self.call('send',revision=revision,text=f'Hola {i}')
            except inbox.InboxError as exc: return exc.code
        with ThreadPoolExecutor(5) as pool: results=list(pool.map(send,range(5)))
        self.assertEqual(sum(isinstance(r,dict) for r in results),1)
        self.assertEqual(self.count('inbox_outbox'),1)

    def test_idempotency_rejects_changed_payload_and_keeps_original(self):
        self.call('take')
        rid=str(uuid.uuid4()); rev=self.row()['revision']
        result=self.call('send',revision=rev,request_id=rid,text='Hola')
        self.assertEqual(self.call('send',revision=rev,request_id=rid,text='Hola'),result)
        with self.assertRaisesRegex(inbox.InboxError,'idempotency_conflict'):
            self.call('send',revision=rev,request_id=rid,text='Otro')

    def test_owner_required_supervisor_transfer_and_release_stays_paused(self):
        self.call('take')
        other={'id':'herramientas:2','name':'Otra','role':'agent'}
        with self.assertRaisesRegex(inbox.InboxError,'owner_required'): self.call('send',actor=other,text='No')
        self.call('transfer',actor=SUPERVISOR,target={'id':other['id'],'name':other['name']})
        with self.assertRaisesRegex(inbox.InboxError,'owner_required'): self.call('note',text='No')
        self.call('release',actor=other)
        self.assertIsNone(self.row()['owner_id'])
        self.assertEqual(self.row()['bot_status'],'paused')
        self.call('resume')
        self.assertEqual(self.row()['bot_status'],'active')

    def test_reader_cannot_mutate_but_reads_notes_and_audit(self):
        self.call('take'); self.call('note',text='Nota privada')
        with self.assertRaisesRegex(inbox.InboxError,'write_required'): self.call('note',actor=READER,text='No')
        result=inbox.handle({'op':'thread','actor':READER,'key':self.key})
        self.assertTrue(any(m['sender']=='note' for m in result['messages']))
        self.assertFalse(result['thread']['can_send'])
        self.assertTrue(result['audit'])
        self.assertFalse(any(m['body']=='Nota privada' for m in recent_messages(self.key)))

    def test_window_and_connection_gates(self):
        self.call('take')
        with patch.dict(os.environ,{'INBOX_CONNECTED_NUMBER_IDS':''}):
            with self.assertRaisesRegex(inbox.InboxError,'number_not_connected'): self.call('send',text='No')
        with connection() as conn: conn.execute("UPDATE conversations SET last_inbound_at=NOW()-INTERVAL '25 hours' WHERE conversation_key=%s",(self.key,))
        with self.assertRaisesRegex(inbox.InboxError,'window_closed'): self.call('send',text='No')

    def test_new_inbound_reopens_without_stealing_owner(self):
        self.call('take'); self.call('close')
        ingest(self.incoming())
        row=self.row()
        self.assertEqual(row['inbox_status'],'open'); self.assertEqual(row['owner_id'],ACTOR['id'])
        self.assertEqual(row['bot_status'],'paused')

    def test_closed_thread_requires_explicit_reopen(self):
        self.call('take'); self.call('close')
        for action in ('take','send','transfer','resume'):
            with self.assertRaisesRegex(inbox.InboxError,'thread_closed'):
                self.call(action,text='No',target={'id':'herramientas:2','name':'Otra'})
        self.call('reopen')
        self.assertEqual(self.row()['inbox_status'],'open')

    def test_history_and_duplicate_never_trigger_ai_or_open_window(self):
        self.enable_ai()
        event=self.incoming(external_id='same')
        _,should_reply=ingest(event)
        self.assertTrue(should_reply)
        revision=self.row()['revision']
        enqueue_ai(self.key,'bot:' + event['event_id'],revision,self.decision())
        _,should_reply=ingest(event)
        self.assertFalse(should_reply); self.assertEqual(self.row()['revision'],revision)
        key,should_reply=ingest(self.incoming(recipient='5493519999999',historical=True,stamp=1600000000))
        with connection() as conn: historical=conn.execute('SELECT * FROM conversations WHERE conversation_key=%s',(key,)).fetchone()
        self.assertFalse(should_reply); self.assertIsNone(historical['last_inbound_at'])
        self.assertEqual(historical['bot_status'],'paused')

    def test_recovered_inbound_resumes_after_commit_before_ai_enqueue(self):
        self.enable_ai()
        event=self.incoming(external_id='recover-before-ai')
        _,should_reply=ingest(event)
        self.assertTrue(should_reply)
        revision=self.row()['revision']
        # Simulate process death here: inbound committed, outgoing not yet created.
        _,should_reply=ingest(event)
        self.assertTrue(should_reply)
        self.assertEqual(self.row()['revision'],revision)
        self.assertTrue(enqueue_ai(self.key,'bot:' + event['event_id'],revision,self.decision()))
        _,should_reply=ingest(event)
        self.assertFalse(should_reply)
        self.assertEqual(self.count('inbox_outbox'),1)

    def test_recovery_does_not_resume_stale_customer_message(self):
        self.enable_ai()
        old=self.incoming(external_id='older-before-ai',stamp=int(time.time())-60)
        ingest(old)
        current=self.incoming(external_id='current-before-ai')
        ingest(current)
        self.assertFalse(ingest(old)[1])
        self.assertTrue(ingest(current)[1])

    def test_future_timestamp_cannot_open_window(self):
        key,_=ingest(self.incoming(recipient='5493519999999',stamp=int(time.time())+3600))
        with connection() as conn: row=conn.execute('SELECT * FROM conversations WHERE conversation_key=%s',(key,)).fetchone()
        self.assertIsNone(row['last_inbound_at'])

    def test_echo_pauses_and_duplicate_is_idempotent(self):
        self.enable_ai(); event=self.incoming(external_id='echo1',echo=True)
        ingest(event); revision=self.row()['revision']
        self.assertEqual(self.row()['bot_status'],'paused')
        ingest(event); self.assertEqual(self.row()['revision'],revision)
        self.assertEqual(self.count('inbox_audit'),1)

    def test_edit_and_revoke_are_audited_without_ai(self):
        original=self.incoming(external_id='original',echo=True); ingest(original)
        edited=self.incoming(external_id='edit1',echo=True,raw={'type':'edit','edit':{'original_message_id':'original','message':{'type':'text','text':{'body':'Texto corregido'}}}})
        ingest(edited); ingest(edited)
        revoked=self.incoming(external_id='revoke1',echo=True,raw={'type':'revoke','revoke':{'original_message_id':'original'}})
        ingest(revoked)
        with connection() as conn: row=conn.execute("SELECT * FROM messages WHERE external_id='original'").fetchone()
        self.assertTrue(row['metadata']['edited']); self.assertTrue(row['metadata']['revoked'])
        self.assertEqual(self.count('inbox_audit'),3)

    def test_human_take_during_ai_generation_discards_old_generation(self):
        self.enable_ai(); revision=ai_revision(self.key)
        self.call('take')
        self.assertFalse(enqueue_ai(self.key,'ai-old',revision,self.decision()))
        self.assertEqual(self.count('inbox_outbox'),0)

    def test_queued_ai_cancelled_after_take(self):
        self.enable_ai(); revision=ai_revision(self.key)
        self.assertTrue(enqueue_ai(self.key,'ai-queued',revision,self.decision()))
        self.call('take')
        class Never:
            def send(self,*args): raise AssertionError('AI must not send')
        self.assertFalse(run_once(Never()))
        with connection() as conn: row=conn.execute('SELECT state,error_code FROM inbox_outbox').fetchone()
        self.assertEqual(row['state'],'cancelled'); self.assertEqual(row['error_code'],'control_take')

    def test_number_or_master_disabled_prevents_ai(self):
        self.assertIsNone(ai_revision(self.key))
        set_system_setting('bot_enabled',True)
        self.assertIsNone(ai_revision(self.key))
        set_system_setting('whatsapp_bot_number:5493515214819',True)
        self.assertIsNotNone(ai_revision(self.key))
        set_system_setting('bot_enabled',False)
        self.assertIsNone(ai_revision(self.key))

    def test_ambiguous_delivery_never_retries(self):
        self.call('take'); self.call('send',text='Uno')
        class Ambiguous:
            calls=0
            def send(self,*args): self.calls+=1; raise TimeoutError('after transmission')
        transport=Ambiguous(); self.assertTrue(run_once(transport)); self.assertFalse(run_once(transport))
        self.assertEqual(transport.calls,1)
        with connection() as conn: row=conn.execute('SELECT * FROM inbox_outbox').fetchone()
        self.assertEqual(row['state'],'unknown'); self.assertEqual(row['error_code'],'delivery_ambiguous_no_retry')

    def test_explicit_rejection_failed_never_retries(self):
        self.call('take'); self.call('send',text='Uno')
        class Rejected:
            def send(self,*args): raise SendRejected('meta_rejected_400')
        run_once(Rejected()); self.assertFalse(run_once(Rejected()))
        with connection() as conn: row=conn.execute('SELECT state FROM inbox_outbox').fetchone()
        self.assertEqual(row['state'],'failed')

    def test_interrupted_sending_recovery_is_unknown(self):
        self.call('take'); self.call('send',text='Uno')
        with connection() as conn: conn.execute("UPDATE inbox_outbox SET state='sending',updated_at=NOW()-INTERVAL '6 minutes'")
        recover_interrupted()
        with connection() as conn: row=conn.execute('SELECT state FROM inbox_outbox').fetchone()
        self.assertEqual(row['state'],'unknown')
        self.assertFalse(run_once(SimpleNamespace(send=lambda *args: self.fail('must not send'))))

    def test_send_lock_serializes_transfer_while_http_is_in_flight(self):
        self.call('take'); self.call('send',text='Uno')
        entered=threading.Event(); release=threading.Event(); mutation_started=threading.Event()
        class Slow:
            def send(self,*args): entered.set(); release.wait(5); return 'wamid.sent'
        def transfer():
            mutation_started.set()
            return self.call('transfer',actor=SUPERVISOR,target={'id':'herramientas:2','name':'Otra'})
        with ThreadPoolExecutor(2) as pool:
            sending=pool.submit(run_once,Slow())
            self.assertTrue(entered.wait(3))
            change=pool.submit(transfer)
            self.assertTrue(mutation_started.wait(3))
            try:
                time.sleep(.1); self.assertFalse(change.done())
            finally: release.set()
            self.assertTrue(sending.result(5)); change.result(5)
        self.assertEqual(self.row()['owner_id'],'herramientas:2')

    def test_queued_human_cancelled_when_transferred_before_send(self):
        self.call('take'); self.call('send',text='Uno')
        self.call('transfer',actor=SUPERVISOR,target={'id':'herramientas:2','name':'Otra'})
        run_once(SimpleNamespace(send=lambda *args:self.fail('outdated owner must not send')))
        with connection() as conn: row=conn.execute('SELECT state FROM inbox_outbox').fetchone()
        self.assertEqual(row['state'],'cancelled')

    def test_close_reopen_cannot_revive_cancelled_send(self):
        self.call('take'); self.call('send',text='Borrador antiguo')
        self.call('close'); self.call('reopen')
        self.assertFalse(run_once(SimpleNamespace(send=lambda *args:self.fail('closed queue revived'))))
        with connection() as conn: out=conn.execute('SELECT * FROM inbox_outbox').fetchone()
        self.assertEqual(out['state'],'cancelled'); self.assertEqual(out['error_code'],'control_close')

    def test_transfer_roundtrip_cannot_revive_cancelled_send(self):
        self.call('take'); self.call('send',text='Borrador antiguo')
        self.call('transfer',actor=SUPERVISOR,target={'id':'herramientas:2','name':'Otra'})
        self.call('transfer',actor=SUPERVISOR,target={'id':ACTOR['id'],'name':ACTOR['name']})
        self.assertFalse(run_once(SimpleNamespace(send=lambda *args:self.fail('transferred queue revived'))))
        with connection() as conn: out=conn.execute('SELECT * FROM inbox_outbox').fetchone()
        self.assertEqual(out['state'],'cancelled')

    def test_release_retake_cannot_revive_cancelled_send(self):
        self.call('take'); self.call('send',text='Borrador antiguo')
        self.call('release'); self.call('take')
        self.assertFalse(run_once(SimpleNamespace(send=lambda *args:self.fail('released queue revived'))))

    def test_late_history_cannot_hide_current_or_contaminate_ai_order(self):
        for i in range(55):
            event=self.incoming(external_id=f'late-history{i}',historical=True,stamp=1600000000+i)
            event['message']['text']=f'Historia {i}'
            ingest(event)
        current=inbox.handle({'op':'thread','actor':READER,'key':self.key})
        self.assertEqual(current['messages'][-1]['text'],'Consulta')
        self.assertTrue(current['more'])
        old=inbox.handle({'op':'thread','actor':READER,'key':self.key,'before':current['messages'][0]['id']})
        self.assertEqual(len(old['messages']),6)
        self.assertEqual(old['messages'][0]['text'],'Historia 0')
        listing=inbox.handle({'op':'list','actor':READER})
        self.assertEqual(listing['threads'][0]['preview'],'Consulta')
        self.assertEqual(recent_messages(self.key,16)[-1]['body'],'Consulta')

    def test_unsent_messages_never_become_ai_history(self):
        self.call('take'); self.call('send',text='Todavía no enviado')
        self.assertNotIn('Todavía no enviado',[m['body'] for m in recent_messages(self.key)])
        self.call('close'); self.call('reopen')
        self.assertNotIn('Todavía no enviado',[m['body'] for m in recent_messages(self.key)])

    def test_media_upload_idempotent_and_scope_bound(self):
        self.call('take')
        payload={'op':'upload','actor':ACTOR,'key':self.key,'request_id':str(uuid.uuid4()),'name':'foto.png','mime':'image/png','data_base64':base64.b64encode(PNG).decode()}
        media=inbox.handle(payload); self.assertEqual(media,inbox.handle(payload)); self.assertEqual(self.count('inbox_media'),1)
        result=inbox.handle({'op':'media','actor':READER,'id':media['media_id']})
        self.assertEqual(base64.b64decode(result['data_base64']),PNG)
        key,_=ingest(self.incoming(recipient='5493519999999')); old=self.key; self.key=key
        try:
            self.call('take')
            with self.assertRaisesRegex(inbox.InboxError,'media_not_available'): self.call('send',media_id=media['media_id'])
        finally: self.key=old

    def test_delivery_status_monotonic_and_ambiguous_reconciliation(self):
        self.call('take'); self.call('send',text='Uno')
        run_once(SimpleNamespace(send=lambda *args: (_ for _ in ()).throw(TimeoutError())))
        with connection() as conn: out=conn.execute('SELECT * FROM inbox_outbox').fetchone()
        def status(value):
            delivery_status({'conversation':{'channel_number_id':'111','external_user_id':'5493511234567'},
                'message':{'external_id':'wamid.recovered','outbox_id':str(out['id']),'status':value}})
        status('read'); status('sent'); status('failed')
        with connection() as conn: message=conn.execute('SELECT * FROM messages WHERE id=%s',(out['message_id'],)).fetchone()
        self.assertEqual(message['delivery_status'],'read'); self.assertEqual(message['external_id'],'wamid.recovered')

    def test_list_search_and_history_pagination(self):
        for i in range(55): ingest(self.incoming(external_id=f'page{i}'))
        result=inbox.handle({'op':'thread','actor':READER,'key':self.key})
        self.assertEqual(len(result['messages']),50); self.assertTrue(result['more'])
        older=inbox.handle({'op':'thread','actor':READER,'key':self.key,'before':result['messages'][0]['id']})
        self.assertEqual(len(older['messages']),6); self.assertFalse(older['more'])
        found=inbox.handle({'op':'list','actor':READER,'filter':'unassigned','search':'Consulta'})
        self.assertEqual(len(found['threads']),1)

    def public_key(self, key):
        with connection() as conn:
            row=conn.execute('SELECT * FROM conversations WHERE conversation_key=%s',(key,)).fetchone()
        return inbox.public_thread_key(row)

    def add_web(self, token, phone, text='Consulta desde web'):
        key='web:' + token
        with connection() as conn:
            conn.execute("""INSERT INTO conversations(conversation_key,channel,customer_name,customer_phone,bot_status,context)
                VALUES(%s,'web',%s,%s,'handoff',%s::jsonb)""",
                (key,'Visitante ' + token,phone,json.dumps({'page_title':'Bicicleta','page_url':'https://example.test/bici'})))
            conn.execute("""INSERT INTO messages(conversation_key,sender,body,metadata)
                VALUES(%s,'customer',%s,'{}'::jsonb)""",(key,text))
        return key

    def test_related_web_argentina_national_and_e164_with_or_without_mobile_nine(self):
        for phone in ('3511234567','+54 351 1234567','+54 9 351 1234567'):
            with self.subTest(phone=phone):
                with connection() as conn:
                    conn.execute("DELETE FROM conversations WHERE channel='web'")
                key=self.add_web('argentina',phone)
                result=inbox.handle({'op':'thread','actor':READER,'key':self.key})
                self.assertEqual([r['key'] for r in result['related_web']],[self.public_key(key)])
                self.assertEqual(result['related_web'][0]['messages'][0]['text'],'Consulta desde web')
                with connection() as conn:
                    self.assertEqual(conn.execute('SELECT customer_phone FROM conversations WHERE conversation_key=%s',(key,)).fetchone()['customer_phone'],phone)
        with connection() as conn:
            conn.execute("UPDATE conversations SET customer_phone='543511234567' WHERE conversation_key=%s",(self.key,))
        self.assertEqual(len(inbox.handle({'op':'thread','actor':READER,'key':self.key})['related_web']),1)

    def test_related_web_never_links_foreign_prefix_or_different_number(self):
        for i,phone in enumerate(('+1 3511234567','+44 3511234567','+3511234567','5493511234568','3511234568')):
            self.add_web('foreign-' + str(i),phone)
        result=inbox.handle({'op':'thread','actor':READER,'key':self.key})
        self.assertEqual(result['related_web'],[])

    def test_related_web_foreign_international_requires_full_number(self):
        key=self.add_web('international','+1 (415) 555-2671')
        self.add_web('same-suffix','4155552671')
        self.add_web('argentina-same-suffix','+54 9 4155552671')
        with connection() as conn:
            conn.execute("UPDATE conversations SET customer_phone='+1 4155552671' WHERE conversation_key=%s",(self.key,))
        result=inbox.handle({'op':'thread','actor':READER,'key':self.key})
        self.assertEqual([r['key'] for r in result['related_web']],[self.public_key(key)])

    def test_related_web_multiple_matches_preserve_independent_identity_and_history(self):
        first=self.add_web('first','3511234567','Primer contexto')
        second=self.add_web('second','+54 9 3511234567','Segundo contexto')
        result=inbox.handle({'op':'thread','actor':READER,'key':self.key})
        self.assertEqual({r['key'] for r in result['related_web']},{self.public_key(first),self.public_key(second)})
        self.assertEqual({r['name'] for r in result['related_web']},{'Visitante first','Visitante second'})
        self.assertTrue(all(len(r['messages'])==1 for r in result['related_web']))
        self.assertEqual(self.row()['customer_name'],'Cliente')
        self.assertEqual(self.count('inbox_outbox'),0)


if __name__=='__main__': unittest.main()
