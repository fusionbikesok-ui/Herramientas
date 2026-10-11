"""Unified Web integration: same isolated schema and fake transports as WA QA."""
import json
import os
import threading
import time
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import patch

import test_inbox as fixtures
from app import inbox, worker, clients
from app.inbox_web import (ingest_web, import_web_history, web_source_id, WebTransport,
    flush_web_sync, sync_web_presence)
from app.inbox_events import ai_revision, enqueue_ai
from app.inbox_media import SendRejected
from app.outbox_worker import run_once
from app.storage import connection, set_system_setting, recent_messages


class WebTransportUnitTests(unittest.TestCase):
    def test_exact_callback_payload_and_positive_ack(self):
        row={'wp_token':'token-web','customer_phone':'3511234567','customer_name':'Cliente','context':{},
             'revision':4,'owner_name':'Operador','bot_status':'paused','inbox_status':'open'}
        message={'sender':'operator','agent_name':'Operador','kind':'text','body':'Hola','metadata':{}}
        calls=[]
        with patch.object(clients,'wordpress_callback',side_effect=lambda payload:calls.append(payload) or {'ok':True,'message_id':123}):
            result=WebTransport().send(row,message,None,'1234')
        self.assertEqual(result,'inbox:1234')
        self.assertEqual(calls[0]['event_id'],calls[0]['message']['external_id'])
        self.assertEqual(calls[0]['event_type'],'inbox_message')
        self.assertEqual(calls[0]['inbox']['revision'],4)
        self.assertEqual(calls[0]['conversation']['customer_phone'],'3511234567')

    def test_missing_ack_ambiguous_and_4xx_is_rejected(self):
        row={'wp_token':'token-web','context':{},'revision':1,'bot_status':'active','inbox_status':'open'}
        msg={'sender':'bot','kind':'text','body':'Hola','metadata':{}}
        for ack in ({'ok':True}, {'ok':True,'message_id':0},{'ok':True,'message_id':True},{'ok':False,'message_id':2}):
            with patch.object(clients,'wordpress_callback',return_value=ack):
                with self.assertRaises(ValueError):WebTransport().send(row,msg,None,'1234')
        with patch.object(clients,'wordpress_callback',side_effect=clients.RemoteServiceError('rejected',status_code=409)):
            with self.assertRaisesRegex(SendRejected,'wordpress_rejected_409'):WebTransport().send(row,msg,None,'1234')


@unittest.skipUnless(os.getenv('INBOX_TEST_DATABASE_URL'),'Explicit isolated PostgreSQL URL required')
class WebUnifiedTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls): fixtures.DatabaseTests.setUpClass.__func__(cls)
    @classmethod
    def tearDownClass(cls): fixtures.DatabaseTests.tearDownClass.__func__(cls)
    incoming=fixtures.DatabaseTests.incoming
    row=fixtures.DatabaseTests.row
    count=fixtures.DatabaseTests.count

    def public_key(self):
        return inbox.public_thread_key(self.row())

    def call(self, action, actor=fixtures.ACTOR, revision=None, **extra):
        payload=dict(op='command',actor=actor,key=self.public_key(),request_id=str(uuid.uuid4()),
                     revision=self.row()['revision'] if revision is None else revision,action=action)
        payload.update(extra)
        return inbox.handle(payload)

    def payload(self,mid=1001,**snapshot):
        conv={'channel':'web','token':'unified-token','customer_name':'Visita','customer_phone':'',
              'page_url':'https://example.test/bici','page_title':'Bicicleta','bot_status':'active'}
        conv.update(snapshot)
        return {'event_id':str(uuid.uuid4()),'event_type':'web_message','occurred_at':'2026-10-07T10:00:00+00:00',
                'conversation':conv,'message':{'id':mid,'text':'Consulta web','created_at':'2026-10-07T10:00:00+00:00'}}

    def setUp(self):
        fixtures.DatabaseTests.setUp(self)
        self.wa_key=self.key
        set_system_setting('web_inbox_enabled',True)
        self.key,_,_=ingest_web(self.payload())

    def decision(self):
        return SimpleNamespace(reply='Respuesta web',handoff=True,reason='Necesita asesor',contact_phone='3511234567',department='ventas',priority='high')

    def test_channel_filters_counts_and_web_capabilities(self):
        all_rows=inbox.handle({'actor':fixtures.READER,'op':'list','channel':'all'})
        web=inbox.handle({'actor':fixtures.READER,'op':'list','channel':'web'})
        wa=inbox.handle({'actor':fixtures.READER,'op':'list','channel':'whatsapp'})
        self.assertEqual(len(all_rows['threads']),2)
        self.assertEqual(web['counts']['all'],1);self.assertEqual(wa['counts']['all'],1)
        self.assertEqual(web['threads'][0]['channel'],'web')
        self.assertFalse(web['threads'][0]['capabilities']['media'])
        self.assertEqual(web['threads'][0]['page_title'],'Bicicleta')
        with self.assertRaisesRegex(inbox.InboxError,'invalid_channel'):
            inbox.handle({'actor':fixtures.READER,'op':'list','channel':'email'})

    def test_flag_false_blocks_mutations_not_reading(self):
        set_system_setting('web_inbox_enabled',False)
        with self.assertRaisesRegex(inbox.InboxError,'web_not_connected'):self.call('take')
        view=inbox.handle({'actor':fixtures.READER,'op':'thread','key':self.public_key()})
        self.assertEqual(view['thread']['send_blocked_reason'],'web_not_connected')
        self.assertFalse(inbox.status(fixtures.READER)['web']['connected'])

    def test_five_web_agents_take_once(self):
        revision=self.row()['revision'];barrier=threading.Barrier(5)
        def take(i):
            barrier.wait()
            try:return self.call('take',revision=revision,actor={'id':f'herramientas:{i}','name':f'Agente {i}','role':'agent'})
            except inbox.InboxError as exc:return exc.code
        with ThreadPoolExecutor(5) as pool:result=list(pool.map(take,range(1,6)))
        self.assertEqual(sum(isinstance(r,dict) for r in result),1)
        self.assertEqual(result.count('revision_conflict'),4)

    def test_stale_wp_snapshot_never_overwrites_owner_pause_or_contact(self):
        self.call('take')
        with connection() as conn:conn.execute("UPDATE conversations SET customer_phone='3519999999' WHERE conversation_key=%s",(self.key,))
        ingest_web(self.payload(1002,bot_status='active',customer_phone='3510000000'))
        row=self.row()
        self.assertEqual(row['owner_id'],fixtures.ACTOR['id']);self.assertEqual(row['bot_status'],'paused')
        self.assertEqual(row['customer_phone'],'3519999999')

    def test_legacy_events_ignored_only_after_cutover(self):
        with patch.object(worker,'upsert_conversation') as upsert,patch.object(worker,'set_bot_status') as change:
            worker.process_control({'conversation':{'channel':'web','token':'unified-token'},'control':{'action':'release'}})
            worker.process_agent_message({'conversation':{'channel':'web','token':'unified-token'},'message':{'text':'Legacy'}})
        upsert.assert_not_called();change.assert_not_called()

    def test_web_send_has_no_24h_gate_and_is_durable_idempotent(self):
        self.call('take');rid=str(uuid.uuid4());revision=self.row()['revision']
        with connection() as conn:conn.execute("UPDATE conversations SET last_inbound_at=NOW()-INTERVAL '30 days' WHERE conversation_key=%s",(self.key,))
        one=self.call('send',text='Hola humana',revision=revision,request_id=rid)
        two=self.call('send',text='Hola humana',revision=revision,request_id=rid)
        self.assertEqual(one['message']['id'],two['message']['id'])
        calls=[]
        with patch.object(clients,'wordpress_callback',side_effect=lambda p:calls.append(p) or {'ok':True,'message_id':321}):
            self.assertTrue(run_once());self.assertFalse(run_once())
        self.assertEqual(len(calls),1);self.assertEqual(calls[0]['message']['sender'],'operator')
        with connection() as conn:out=conn.execute('SELECT * FROM inbox_outbox').fetchone()
        self.assertEqual(out['state'],'sent');self.assertEqual(out['remote_id'],'inbox:'+str(out['id']))

    def test_web_unknown_ack_not_resent(self):
        self.call('take');self.call('send',text='Hola')
        with patch.object(clients,'wordpress_callback',return_value={'ok':True}) as callback:
            self.assertTrue(run_once());self.assertFalse(run_once())
        callback.assert_called_once()
        with connection() as conn:out=conn.execute('SELECT state FROM inbox_outbox').fetchone()
        self.assertEqual(out['state'],'unknown')

    def test_web_media_rejected_and_note_private(self):
        self.call('take')
        with self.assertRaisesRegex(inbox.InboxError,'web_media_unsupported'):self.call('send',media_id='some-media')
        self.call('note',text='Nota privada')
        self.assertNotIn('Nota privada',[m['body'] for m in recent_messages(self.key)])
        self.assertEqual(self.count('inbox_outbox'),0)

    def test_ai_global_schedule_gates_and_handoff_phone_preserved(self):
        self.assertIsNone(ai_revision(self.key))
        set_system_setting('bot_enabled',True)
        set_system_setting('bot_channel_config',{'web':{'enabled':False}})
        self.assertIsNone(ai_revision(self.key))
        set_system_setting('bot_channel_config',{'web':{'enabled':True}})
        event=self.payload(1002)
        with patch.object(worker,'_decision_for',return_value=self.decision()):
            self.assertEqual(worker.process_web_message(event),'done')
            self.assertEqual(worker.process_web_message(event),'done')
        self.assertEqual(self.count('inbox_outbox'),1)
        self.assertEqual(self.row()['customer_phone'],'3511234567')
        calls=[]
        with patch.object(clients,'wordpress_callback',side_effect=lambda p:calls.append(p) or {'ok':True,'message_id':432}):run_once()
        self.assertTrue(calls[0]['handoff']['requested'])
        self.assertEqual(calls[0]['conversation']['customer_phone'],'3511234567')
        self.assertEqual(self.row()['bot_status'],'handoff')

    def test_take_during_web_generation_prevents_queue(self):
        set_system_setting('bot_enabled',True)
        revision=ai_revision(self.key);self.call('take')
        self.assertFalse(enqueue_ai(self.key,'bot:wp:1001',revision,self.decision()))

    def test_control_sync_latest_state_retries_safely_and_clears(self):
        self.call('take');self.call('close')
        calls=[]
        self.assertTrue(flush_web_sync(lambda p:calls.append(p) or {'ok':True}))
        self.assertEqual(calls[0]['inbox']['status'],'closed')
        self.assertEqual(calls[0]['inbox']['owner_name'],fixtures.ACTOR['name'])
        self.assertFalse(flush_web_sync(lambda p:self.fail('no pending control')))
        self.call('reopen')
        self.assertTrue(flush_web_sync(lambda p:(_ for _ in ()).throw(TimeoutError())))
        with connection() as conn:
            row=conn.execute('SELECT * FROM inbox_web_sync').fetchone()
            self.assertEqual(row['attempts'],1)
            conn.execute('UPDATE inbox_web_sync SET retry_at=NOW()')
        self.assertTrue(flush_web_sync(lambda p:{'ok':True}))

    def test_presence_aggregate_has_names_and_heartbeat_without_tokens(self):
        inbox.handle({'op':'presence','actor':fixtures.ACTOR,'status':'available'})
        calls=[]
        sync_web_presence(lambda p:calls.append(p) or {'ok':True})
        self.assertEqual(calls[0]['event_type'],'inbox_presence')
        agents=calls[0]['presence']['agents']
        self.assertEqual(agents[0]['name'],fixtures.ACTOR['name'])
        self.assertIsInstance(agents[0]['heartbeat'],int)
        self.assertNotIn('token',json.dumps(calls[0]))

    def export(self):
        return {'sessions':[{'token':'import-token','created_at':'2025-01-01T12:00:00Z','updated_at':'2025-01-01T12:30:00Z',
            'status':'open','agent':'Operador WP','bot_status':'paused','customer_name':'Histórico','customer_phone':'3511234567',
            'page_title':'Producto histórico','handoff_reason':'Consultar pedido',
            'messages':[{'id':9001,'sender':'customer','message':'Antes','external_id':'','created_at':'2025-01-01T12:00:00Z'},
                        {'id':9002,'sender':'bot','message':'Respuesta vieja','external_id':'bot:old-event','created_at':'2025-01-01T12:01:00Z'}]}]}

    def test_import_preserves_legacy_event_id_mapping_and_times_no_ai(self):
        with connection() as conn:
            conn.execute("INSERT INTO conversations(conversation_key,channel,wp_token) VALUES('web:import-token','web','import-token')")
            event={'event_id':'old-event','conversation':{'token':'import-token'},'message':{'id':9001}}
            conn.execute("INSERT INTO events(event_id,event_type,payload) VALUES('old-event','web_message',%s::jsonb)",(json.dumps(event),))
            conn.execute("INSERT INTO messages(conversation_key,external_id,sender,body) VALUES('web:import-token','old-event','customer','Antes')")
        owner={'Operador WP':{'id':'herramientas:7','name':'Usuario real'}}
        first=import_web_history(self.export(),owner)
        second=import_web_history(self.export(),owner)
        self.assertEqual(first['existing'],1);self.assertEqual(first['messages'],1)
        self.assertEqual(second['messages'],0)
        with connection() as conn:
            messages=conn.execute("SELECT * FROM messages WHERE conversation_key='web:import-token' ORDER BY created_at").fetchall()
            row=conn.execute("SELECT * FROM conversations WHERE conversation_key='web:import-token'").fetchone()
        self.assertEqual(len(messages),2);self.assertEqual(messages[0]['external_id'],'old-event')
        self.assertEqual(messages[0]['created_at'].year,2025)
        self.assertEqual(row['owner_id'],'herramientas:7');self.assertIsNone(row['last_inbound_at'])
        self.assertEqual(self.count('inbox_outbox'),0)

    def test_reimport_cannot_overwrite_live_owner_or_reopen_closed_thread(self):
        export=self.export();import_web_history(export)
        previous=self.key;self.key='web:import-token'
        self.call('take');self.call('close')
        export['sessions'][0].update(agent='',bot_status='active',status='open',customer_phone='3510000000')
        import_web_history(export)
        row=self.row();self.key=previous
        self.assertEqual(row['owner_id'],fixtures.ACTOR['id']);self.assertEqual(row['inbox_status'],'closed')
        self.assertEqual(row['customer_phone'],'3511234567')

    def test_ingest_recovery_after_commit_no_duplicate_event_or_ai(self):
        set_system_setting('bot_enabled',True)
        event=self.payload(1002)
        key,eligible,stored=ingest_web(event)
        self.assertTrue(eligible)
        retry=dict(event,event_id=str(uuid.uuid4()))
        _,eligible2,stored2=ingest_web(retry)
        self.assertTrue(eligible2);self.assertEqual(stored,stored2)
        self.assertTrue(enqueue_ai(key,web_source_id(event['message']),ai_revision(key,stored),self.decision()))
        self.assertFalse(ingest_web(retry)[1])
        self.assertEqual(self.count('inbox_outbox'),1)

    def test_partial_import_retry_refreshes_only_untouched_legacy_state(self):
        set_system_setting('web_inbox_enabled',False)
        batch=self.export()
        batch['sessions'].append({'token':'broken-token','created_at':'bad','updated_at':'bad','messages':[]})
        owners={'Operador WP':{'id':'herramientas:7','name':'Anterior'},'Nuevo WP':{'id':'herramientas:8','name':'Nuevo'}}
        with self.assertRaisesRegex(ValueError,'web_timestamp_requires_timezone'):
            import_web_history(batch,owners,refresh_initial=True)
        with connection() as conn:
            original=conn.execute("SELECT * FROM conversations WHERE conversation_key='web:import-token'").fetchone()
            ids=[r['id'] for r in conn.execute("SELECT id FROM messages WHERE conversation_key='web:import-token' ORDER BY id").fetchall()]
        self.assertEqual(original['owner_id'],'herramientas:7')
        retry=self.export();retry['sessions'][0].update(agent='Nuevo WP',status='archived')
        import_web_history(retry,owners,refresh_initial=True)
        with connection() as conn:
            refreshed=conn.execute("SELECT * FROM conversations WHERE conversation_key='web:import-token'").fetchone()
            after=[r['id'] for r in conn.execute("SELECT id FROM messages WHERE conversation_key='web:import-token' ORDER BY id").fetchall()]
        self.assertEqual(refreshed['owner_id'],'herramientas:8');self.assertEqual(refreshed['inbox_status'],'closed')
        self.assertEqual(ids,after);self.assertEqual(original['inbox_public_id'],refreshed['inbox_public_id'])

    def test_initial_refresh_never_overwrites_central_revision_live_marker_or_active_flag(self):
        set_system_setting('web_inbox_enabled',False)
        owners={'Operador WP':{'id':'herramientas:7','name':'Anterior'},'Nuevo WP':{'id':'herramientas:8','name':'Nuevo'}}
        original=self.export();import_web_history(original,owners)
        changed=self.export();changed['sessions'][0].update(agent='Nuevo WP',status='archived')
        cases=[(True,0,False),(False,1,False),(False,0,True)]
        for flag,revision,live in cases:
            with self.subTest(flag=flag,revision=revision,live=live):
                set_system_setting('web_inbox_enabled',flag)
                with connection() as conn:
                    conn.execute("UPDATE conversations SET revision=%s,context=context || %s::jsonb WHERE conversation_key='web:import-token'",(revision,json.dumps({'web_inbox_live':live})))
                import_web_history(changed,owners,refresh_initial=True)
                with connection() as conn:row=conn.execute("SELECT * FROM conversations WHERE conversation_key='web:import-token'").fetchone()
                self.assertEqual(row['owner_id'],'herramientas:7');self.assertEqual(row['inbox_status'],'open')


if __name__=='__main__':unittest.main()
