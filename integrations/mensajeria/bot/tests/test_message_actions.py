import json,uuid,unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
from types import SimpleNamespace
import test_inbox as f
from app import inbox
from app.storage import connection,set_system_setting
from app.inbox_events import ingest
from app.message_actions import version,web_reply_text
from app.inbox_media import CloudTransport
from app.config import get_settings
from app.outbox_worker import run_once

class MessageActionTests(unittest.TestCase):
    setUpClass=classmethod(f.DatabaseTests.setUpClass.__func__)
    tearDownClass=classmethod(f.DatabaseTests.tearDownClass.__func__)
    setUp=f.DatabaseTests.setUp
    incoming=f.DatabaseTests.incoming
    row=f.DatabaseTests.row
    call=f.DatabaseTests.call
    count=f.DatabaseTests.count
    def original(self,media=False):
        event=self.incoming(external_id='wamid.'+uuid.uuid4().hex)
        if media:event['message'].update(type='image',raw={'type':'image','image':{'id':'123456','mime_type':'image/png'}})
        ingest(event)
        with connection() as conn:
            row=conn.execute('SELECT * FROM messages WHERE external_id=%s',(event['message']['external_id'],)).fetchone()
            if media:conn.execute('UPDATE inbox_media SET content=%s,size=%s WHERE id=%s',(f.PNG,len(f.PNG),row['media_id']))
        return row
    def forward(self,original,**changes):
        target,_=ingest(self.incoming(recipient='5493517654321'))
        with connection() as conn:row=conn.execute('SELECT * FROM conversations WHERE conversation_key=%s',(target,)).fetchone()
        payload=dict(op='command',actor=f.ACTOR,key=target,revision=row['revision'],action='forward',source_key=self.key,
            source_message_id=str(original['id']),source_version=version(original),take_if_unassigned=True,request_id=str(uuid.uuid4()))
        payload.update(changes)
        return payload
    def test_quote_is_same_conversation_and_native_id(self):
        original=self.original();self.call('take')
        result=self.call('send',text='Sí, ese modelo.',reply_to_id=str(original['id']),reply_to_version=version(original))
        self.assertEqual(result['message']['quoted']['id'],str(original['id']))
        with connection() as conn:
            meta=conn.execute('SELECT metadata FROM messages WHERE id=%s',(int(result['message']['id']),)).fetchone()['metadata']
        self.assertEqual(meta['reply_to_external_id'],original['external_id'])
        target,_=ingest(self.incoming(recipient='5493511112222',external_id='wamid.other'))
        with connection() as conn:other=conn.execute("SELECT * FROM messages WHERE external_id='wamid.other'").fetchone()
        with self.assertRaisesRegex(inbox.InboxError,'message_reference_unavailable'):
            self.call('send',text='X',reply_to_id=str(other['id']),reply_to_version=version(other))
    def test_changed_or_private_reference_is_rejected(self):
        original=self.original();self.call('take')
        with connection() as conn:conn.execute('UPDATE messages SET body=%s WHERE id=%s',('Editado',original['id']))
        with self.assertRaisesRegex(inbox.InboxError,'message_reference_changed'):
            self.call('send',text='X',reply_to_id=str(original['id']),reply_to_version=version(original))
        note=self.call('note',text='Nota privada')['message']
        with self.assertRaisesRegex(inbox.InboxError,'message_reference_unavailable'):
            self.call('send',text='X',reply_to_id=note['id'],reply_to_version='a'*64)
    def test_incoming_reply_and_revocation_view(self):
        original=self.original();event=self.incoming(raw={'type':'text','text':{'body':'Respuesta'},'context':{'id':original['external_id'],'forwarded':True}});ingest(event)
        detail=inbox.handle(dict(op='thread',actor=f.ACTOR,key=self.key))
        reply=next(m for m in detail['messages'] if m['forwarded'])
        self.assertEqual(reply['quoted']['id'],str(original['id']))
        with connection() as conn:conn.execute("UPDATE messages SET metadata=metadata || '{\"revoked\":true}'::jsonb WHERE id=%s",(original['id'],))
        detail=inbox.handle(dict(op='thread',actor=f.ACTOR,key=self.key))
        self.assertTrue(next(m for m in detail['messages'] if m['forwarded'])['quoted']['unavailable'])
    def test_native_context_in_transport(self):
        sent=[]
        class Client:
            def __init__(self,**kw):pass
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def post(self,url,**kw):
                sent.append(kw['json']);return SimpleNamespace(status_code=200,raise_for_status=lambda:None,json=lambda:{'messages':[{'id':'wamid.result'}]})
        with patch('app.inbox_media.httpx.Client',Client):
            CloudTransport(get_settings()).send({'channel_number_id':'111','external_user_id':'5493511234567'},
              {'body':'Hola','metadata':{'reply_to_external_id':'wamid.origin'}},None,'outbox-id')
        self.assertEqual(sent[0]['context'],{'message_id':'wamid.origin'})
    def test_forward_text_is_idempotent_and_takes_unassigned(self):
        original=self.original();payload=self.forward(original)
        first=inbox.handle(payload);again=inbox.handle(payload)
        self.assertEqual(first,again);self.assertEqual(self.count('inbox_outbox'),1)
        self.assertEqual(first['thread']['owner_id'],f.ACTOR['id']);self.assertTrue(first['message']['forwarded'])
        self.assertEqual(first['message']['text'],original['body'])
    def test_forward_concurrent_retry_creates_one_message(self):
        payload=self.forward(self.original())
        with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(lambda _:inbox.handle(payload),range(2)))
        self.assertEqual(results[0],results[1]);self.assertEqual(self.count('inbox_outbox'),1)
    def test_forward_copy_is_scoped_to_destination(self):
        original=self.original(media=True);payload=self.forward(original);result=inbox.handle(payload)
        self.assertNotEqual(result['message']['media_id'],original['media_id'])
        with connection() as conn:copy=conn.execute('SELECT * FROM inbox_media WHERE id=%s',(result['message']['media_id'],)).fetchone()
        self.assertEqual(copy['conversation_key'],payload['key']);self.assertEqual(bytes(copy['content']),f.PNG)
    def test_forward_checks_reader_owner_window_and_version(self):
        original=self.original();payload=self.forward(original)
        with self.assertRaisesRegex(inbox.InboxError,'write_required'):inbox.handle(dict(payload,actor=f.READER))
        with self.assertRaisesRegex(inbox.InboxError,'owner_required'):inbox.handle(dict(payload,take_if_unassigned=False))
        with self.assertRaisesRegex(inbox.InboxError,'message_reference_changed'):inbox.handle(dict(payload,source_version='0'*64))
        with connection() as conn:conn.execute("UPDATE conversations SET last_inbound_at=NOW()-INTERVAL '25 hours' WHERE conversation_key=%s",(payload['key'],))
        with self.assertRaisesRegex(inbox.InboxError,'window_closed'):inbox.handle(payload)
        self.assertEqual(self.count('inbox_outbox'),0)
    def test_forward_never_steals_other_agent(self):
        payload=self.forward(self.original())
        with connection() as conn:conn.execute("UPDATE conversations SET owner_id='herramientas:222',owner_name='Otro' WHERE conversation_key=%s",(payload['key'],))
        with self.assertRaisesRegex(inbox.InboxError,'owner_required'):inbox.handle(payload)
    def test_forward_private_and_revoked_blocked(self):
        original=self.original();payload=self.forward(original)
        for change in ("sender='note',kind='note'","sender='customer',kind='text',metadata='{\"revoked\":true}'::jsonb"):
            with connection() as conn:conn.execute('UPDATE messages SET '+change+' WHERE id=%s',(original['id'],))
            with self.assertRaisesRegex(inbox.InboxError,'message_reference_unavailable'):inbox.handle(payload)
    def test_revoke_after_queue_cancels_reply_before_network(self):
        original=self.original();self.call('take');self.call('send',text='Respuesta',reply_to_id=str(original['id']),reply_to_version=version(original))
        with connection() as conn:conn.execute("UPDATE messages SET metadata='{\"revoked\":true}'::jsonb WHERE id=%s",(original['id'],))
        class NoNetwork:
            def send(self,*args):raise AssertionError('Must not send')
        self.assertTrue(run_once(NoNetwork()))
        with connection() as conn:self.assertEqual(conn.execute('SELECT state FROM inbox_outbox').fetchone()['state'],'cancelled')
    def test_web_quote_is_readable_text(self):
        self.assertEqual(web_reply_text({'body':'Respuesta','metadata':{'reply_preview':{'text':'Pregunta'}}}),'En respuesta a: «Pregunta»\n\nRespuesta')

    def test_revoke_after_queue_cancels_forward_before_network(self):
        original=self.original();inbox.handle(self.forward(original))
        with connection() as conn:conn.execute("UPDATE messages SET metadata='{\"revoked\":true}'::jsonb WHERE id=%s",(original['id'],))
        class NoNetwork:
            def send(self,*args):raise AssertionError('Must not send')
        self.assertTrue(run_once(NoNetwork()))
        with connection() as conn:self.assertEqual(conn.execute('SELECT state FROM inbox_outbox').fetchone()['state'],'cancelled')

    def test_forward_media_quota_and_invalid_version_fail_closed(self):
        original=self.original(media=True);payload=self.forward(original)
        with self.assertRaisesRegex(inbox.InboxError,'invalid_message_reference'):inbox.handle(dict(payload,source_version=None))
        with connection() as conn:conn.execute('UPDATE inbox_media SET actor_id=%s,size=%s WHERE id=%s',(f.ACTOR['id'],128*1024*1024,original['media_id']))
        with self.assertRaisesRegex(inbox.InboxError,'upload_quota_exceeded'):inbox.handle(payload)
        self.assertEqual(self.count('inbox_outbox'),0)

    def test_forward_holds_both_chats_through_transport(self):
        original=self.original();payload=self.forward(original);inbox.handle(payload)
        test=self
        class CheckLocks:
            def send(self,*args):
                with connection() as conn:
                    for key in [payload['key'],payload['source_key']]:
                        held=conn.execute('SELECT pg_try_advisory_lock(hashtextextended(%s,171717)) AS held',(key,)).fetchone()['held']
                        if held:conn.execute('SELECT pg_advisory_unlock(hashtextextended(%s,171717))',(key,))
                        test.assertFalse(held)
                return 'wamid.forwarded'
        self.assertTrue(run_once(CheckLocks()))
        with connection() as conn:self.assertEqual(conn.execute('SELECT state FROM inbox_outbox').fetchone()['state'],'sent')

    def test_opposite_forward_workers_do_not_deadlock_or_duplicate(self):
        original=self.original();a=self.forward(original)
        with connection() as conn:other=conn.execute('SELECT * FROM messages WHERE conversation_key=%s ORDER BY id DESC LIMIT 1',(a['key'],)).fetchone()
        b=dict(a,key=self.key,source_key=a['key'],source_message_id=str(other['id']),source_version=version(other),revision=self.row()['revision'],request_id=str(uuid.uuid4()))
        inbox.handle(a);inbox.handle(b)
        class Fake:
            def send(self,*args):return 'wamid.'+uuid.uuid4().hex
        with ThreadPoolExecutor(max_workers=2) as pool:list(pool.map(lambda _:run_once(Fake()),range(2)))
        while run_once(Fake()):pass
        with connection() as conn:self.assertEqual(conn.execute("SELECT count(*) AS n FROM inbox_outbox WHERE state='sent'").fetchone()['n'],2)

    def test_two_separate_forward_destinations_share_actor_quota(self):
        original=self.original(media=True);a=self.forward(original)
        event=self.incoming(recipient='5493510000005',external_id='wamid.othermedia',raw={'type':'image','image':{'id':'8888','mime_type':'image/png'}})
        event['message']['type']='image';event['message']['raw']={'type':'image','image':{'id':'8888','mime_type':'image/png'}}
        source,_=ingest(event);dest,_=ingest(self.incoming(recipient='5493510000006'))
        with connection() as conn:
            other=conn.execute('SELECT * FROM messages WHERE conversation_key=%s ORDER BY id DESC LIMIT 1',(source,)).fetchone()
            conn.execute('UPDATE inbox_media SET content=%s,size=%s WHERE id=%s',(f.PNG,len(f.PNG),other['media_id']))
            conn.execute('UPDATE inbox_media SET actor_id=%s,size=%s WHERE id=%s',(f.ACTOR['id'],128*1024*1024-len(f.PNG),original['media_id']))
            revision=conn.execute('SELECT revision FROM conversations WHERE conversation_key=%s',(dest,)).fetchone()['revision']
        b=dict(a,key=dest,source_key=source,source_message_id=str(other['id']),source_version=version(other),revision=revision,request_id=str(uuid.uuid4()))
        def attempt(payload):
            try:inbox.handle(payload);return 'ok'
            except inbox.InboxError as exc:return str(exc)
        with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(attempt,[a,b]))
        self.assertCountEqual(results,['ok','upload_quota_exceeded']);self.assertEqual(self.count('inbox_outbox'),1)

if __name__=='__main__':unittest.main()
