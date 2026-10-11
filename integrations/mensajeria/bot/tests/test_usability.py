"""No external HTTP. PostgreSQL tests require explicit disposable QA DSN."""
import base64
import copy
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta
from types import SimpleNamespace
from unittest.mock import patch

from app import inbox
from app.inbox_templates import TemplateCatalog, TemplateError, template_view, render_template, verified_template
from app.inbox_media import CloudTransport, MediaError, SendRejected
from app.inbox_recording import convert_recording
from app import inbox_recording
from app.outbox_worker import run_once
from app.storage import connection, get_system_setting
import test_inbox as fixtures
from test_inbox import ACTOR, READER, SUPERVISOR, PNG


def raw_template(**overrides):
    value={'id':'12345','name':'contacto_inicial','language':'es_AR','status':'APPROVED','category':'MARKETING','parameter_format':'POSITIONAL',
        'components':[{'type':'HEADER','format':'TEXT','text':'Hola {{1}}'},{'type':'BODY','text':'Somos Fusion Bikes. Consultaste por {{1}}.'},{'type':'FOOTER','text':'Canal de atención'}]}
    value.update(overrides)
    return value


class CatalogFake:
    def __init__(self, raw=None): self.raw=raw or raw_template()
    def resolve(self,number_id,template_id,language,name=None):
        view=template_view(self.raw)
        if str(template_id)!=view['id'] or language!=view['language']: raise TemplateError('template_not_available')
        if not view['supported']: raise TemplateError(view['unsupported_reason'])
        return view


def selected(raw=None):
    view=template_view(raw or raw_template())
    return {'id':view['id'],'language':view['language'],'fingerprint':view['fingerprint'],'parameters':{'header':['Cliente QA'],'body':['una bicicleta']}}


class TemplateTests(unittest.TestCase):
    def test_text_preview_and_payload_are_derived_from_server_components(self):
        view=template_view(raw_template())
        self.assertTrue(view['supported'])
        stored,r=verified_template(None,'111',selected(),CatalogFake())
        self.assertEqual(r['preview'],'Hola Cliente QA\n\nSomos Fusion Bikes. Consultaste por una bicicleta.\n\nCanal de atención')
        self.assertEqual(r['payload']['components'][0],{'type':'header','parameters':[{'type':'text','text':'Cliente QA'}]})
        self.assertEqual(stored['name'],'contacto_inicial')

    def test_unsupported_definition_does_not_guess_payload(self):
        samples=[raw_template(status='PAUSED'),raw_template(parameter_format='NAMED'),
            raw_template(components=[{'type':'BODY','text':'Hola'},{'type':'BUTTONS','buttons':[]}]),
            raw_template(components=[{'type':'BODY','text':'Hola {{2}}'}]),
            raw_template(components=[{'type':'BODY','text':'Hola {{nombre}}'}]),
            raw_template(components=[{'type':'BODY','text':'Hola'},{'type':'HEADER','format':'IMAGE'}]),
            raw_template(components=[{'type':'BODY','text':'Hola'},{'type':'FOOTER','text':'{{1}}'}])]
        for sample in samples:
            with self.subTest(sample=sample):
                view=template_view(sample)
                self.assertFalse(view['supported'])
                with self.assertRaises(TemplateError):render_template(view,{'header':[],'body':[]})

    def test_changed_template_and_invalid_variables_fail_closed(self):
        changed=raw_template();changed['components'][1]['text']='Otro {{1}}'
        with self.assertRaisesRegex(TemplateError,'template_changed'):verified_template(None,'111',selected(),CatalogFake(changed))
        for params in ({'header':[],'body':['x']},{'header':['A'],'body':['x\ny']},{'header':['A'],'body':['{{1}}']},{'header':['A'],'body':['x'*501]}, {'header':['A'],'body':['x'],'url':'evil'}):
            with self.assertRaises(TemplateError):render_template(template_view(raw_template()),params)

    def test_waba_scope_pagination_and_secret_not_in_url(self):
        calls=[]
        class Client:
            def __init__(self,**kw):pass
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def get(self,url,**kw):
                calls.append((url,copy.deepcopy(kw)))
                payload={'data':[raw_template()]}
                if len(calls)==1:payload['paging']={'next':'https://evil.test/?access_token=leak','cursors':{'after':'cursor'}}
                return SimpleNamespace(status_code=200,content=b'{}',json=lambda:payload)
        settings=SimpleNamespace(whatsapp_numbers={'111':{'waba_id':'777'}},meta_graph_version='v26.0',whatsapp_access_token='fake-secret')
        with patch('app.inbox_templates.httpx.Client',Client):
            result=TemplateCatalog(settings).list('111')
            self.assertEqual(len(result['templates']),2)
            self.assertEqual({c[0] for c in calls},{'https://graph.facebook.com/v26.0/777/message_templates'})
            self.assertEqual(calls[1][1]['params']['after'],'cursor')
            with self.assertRaisesRegex(TemplateError,'templates_not_configured'):TemplateCatalog(settings).list('999')

    def test_transport_revalidates_before_sending_and_never_retries(self):
        posted=[]
        class Client:
            def __init__(self,**kw):pass
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def post(self,url,**kw):
                posted.append(kw['json'])
                return SimpleNamespace(status_code=200,raise_for_status=lambda:None,json=lambda:{'messages':[{'id':'wamid.fake'}]})
        settings=SimpleNamespace(meta_graph_version='v26.0',whatsapp_access_token='fake')
        thread={'channel_number_id':'111','external_user_id':'5493511234567'}
        message={'kind':'template','body':'not trusted','metadata':{'template':selected(),'opt_in':True}}
        with patch('app.inbox_templates.TemplateCatalog',return_value=CatalogFake()),patch('app.inbox_media.httpx.Client',Client):
            self.assertEqual(CloudTransport(settings).send(thread,message,None,'id'),'wamid.fake')
        self.assertEqual(posted[0]['type'],'template')
        self.assertNotIn('text',posted[0])
        with patch('app.inbox_templates.TemplateCatalog',return_value=CatalogFake(raw_template(status='PAUSED'))),patch('app.inbox_media.httpx.Client',Client):
            with self.assertRaisesRegex(SendRejected,'template_not_approved'):CloudTransport(settings).send(thread,message,None,'id')
        self.assertEqual(len(posted),1)

    def test_phone_has_no_country_inference_or_suffix_matching(self):
        self.assertEqual(inbox.normalize_international_phone('+54 9 (351) 123-4567'),'5493511234567')
        self.assertEqual(inbox.normalize_international_phone('5493511234567'),'5493511234567')
        self.assertEqual(inbox.normalize_international_phone('+1 202 555 0100'),'12025550100')
        for invalid in ('005493511234567','54+93511234567','+5493511234567 ext 2','123','+012345678','+'*10):
            with self.assertRaises(inbox.InboxError):inbox.normalize_international_phone(invalid)


class RecordingResourceTests(unittest.TestCase):
    def test_two_conversions_busy_and_error_releases_capacity(self):
        capacity=threading.BoundedSemaphore(2)
        with patch.object(inbox_recording,'_CONVERSIONS',capacity):
            self.assertTrue(capacity.acquire(blocking=False));self.assertTrue(capacity.acquire(blocking=False))
            with patch.object(inbox_recording,'_convert_recording') as convert:
                with self.assertRaisesRegex(MediaError,'recording_converter_busy'):convert_recording(b'valid','audio/ogg')
                convert.assert_not_called()
            capacity.release();capacity.release()
            with patch.object(inbox_recording,'_convert_recording',side_effect=MediaError('recording_invalid_audio')):
                with self.assertRaisesRegex(MediaError,'recording_invalid_audio'):convert_recording(b'bad','audio/ogg')
            self.assertTrue(capacity.acquire(blocking=False));self.assertTrue(capacity.acquire(blocking=False))
            self.assertFalse(capacity.acquire(blocking=False))
            capacity.release();capacity.release()

    def test_transport_voice_flag_requires_server_recording_marker(self):
        posts=[]
        class Client:
            def __init__(self,**kw):pass
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def post(self,url,**kw):
                posts.append(kw)
                return SimpleNamespace(status_code=200,raise_for_status=lambda:None,json=lambda:{'id':'999','messages':[{'id':'wamid.voice'}]})
        settings=SimpleNamespace(meta_graph_version='v26.0',whatsapp_access_token='fake')
        thread={'channel_number_id':'111','external_user_id':'5493511234567'}
        message={'kind':'audio','body':''}
        media={'content':b'OggS'+b'\0'*24+b'OpusHead'+b'\0'*12,'mime':'audio/ogg','name':'audio.ogg'}
        with patch('app.inbox_media.httpx.Client',Client):
            CloudTransport(settings).send(thread,message,dict(media,is_voice=False),'plain')
            CloudTransport(settings).send(thread,message,dict(media,is_voice=True),'voice')
        sends=[p['json'] for p in posts if 'json' in p]
        self.assertNotIn('voice',sends[0]['audio']);self.assertIs(sends[1]['audio']['voice'],True)


@unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'),'Requires isolated FFmpeg image')
class RecordingTests(unittest.TestCase):
    def sample(self,extension,codec,seconds=1):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/('sample.'+extension)
            subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','anullsrc=r=48000:cl=stereo','-t',str(seconds),'-c:a',codec,'-threads','1',str(path)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=20)
            return path.read_bytes()

    def test_browser_formats_are_mono_opus_validated(self):
        for extension,codec,mime in [('webm','libopus','audio/webm;codecs=opus'),('ogg','libopus','audio/ogg;codecs=opus'),('mp4','aac','audio/mp4')]:
            with self.subTest(mime=mime):
                converted,duration=convert_recording(self.sample(extension,codec),mime)
                self.assertTrue(converted.startswith(b'OggS'));self.assertIn(b'OpusHead',converted[:4096]);self.assertLess(duration,2)

    def test_long_corrupt_and_forged_recordings_are_rejected(self):
        with self.assertRaisesRegex(MediaError,'recording_too_long'):convert_recording(self.sample('ogg','libopus',301),'audio/ogg')
        with self.assertRaisesRegex(MediaError,'recording_unsupported_format'):convert_recording(b'evil playlist','audio/mp4')
        with self.assertRaisesRegex(MediaError,'recording_invalid_audio'):convert_recording(b'OggS'+b'fake'*100,'audio/ogg')


@unittest.skipUnless(os.getenv('INBOX_TEST_DATABASE_URL'),'Explicit isolated PostgreSQL URL required')
class UsabilityDatabaseTests(unittest.TestCase):
    setUpClass=classmethod(fixtures.DatabaseTests.setUpClass.__func__)
    tearDownClass=classmethod(fixtures.DatabaseTests.tearDownClass.__func__)
    setUp=fixtures.DatabaseTests.setUp
    incoming=fixtures.DatabaseTests.incoming
    row=fixtures.DatabaseTests.row
    call=fixtures.DatabaseTests.call
    count=fixtures.DatabaseTests.count

    def test_list_previews_label_media_preserve_text_and_exclude_private_notes(self):
        def preview():
            result=inbox.handle({'op':'list','actor':ACTOR})
            return next(t['preview'] for t in result['threads'] if t['key']==self.key)
        for kind,label in [('audio','Audio'),('image','Imagen'),('video','Video'),('document','Archivo')]:
            with self.subTest(kind=kind):
                with connection() as conn:
                    conn.execute("INSERT INTO messages(conversation_key,sender,body,kind) VALUES(%s,'operator','',%s)",(self.key,kind))
                self.assertEqual(preview(),label)
        with connection() as conn:
            conn.execute("INSERT INTO messages(conversation_key,sender,body,kind) VALUES(%s,'operator','Foto del producto','image')",(self.key,))
        self.assertEqual(preview(),'Foto del producto')
        with connection() as conn:
            conn.execute("INSERT INTO messages(conversation_key,sender,body,kind) VALUES(%s,'customer','Mensaje normal','text')",(self.key,))
            conn.execute("INSERT INTO messages(conversation_key,sender,agent_name,body,kind,delivery_status) VALUES(%s,'note','Otro agente','Nota privada que no debe mostrarse','note','private')",(self.key,))
        self.assertEqual(preview(),'Mensaje normal')

    def start(self,phone='+5493519998888',actor=ACTOR,**extra):
        return inbox.handle(dict(op='start',actor=actor,number_id='111',phone=phone,request_id=str(uuid.uuid4()),**extra))

    def test_start_reuses_same_identity_without_reassign_reopen_or_messages(self):
        self.call('take');self.call('close')
        before=self.row();messages=self.count('messages')
        result=self.start('+54 9 (351) 123-4567',SUPERVISOR,name='Do not replace')
        self.assertFalse(result['created']);self.assertEqual(self.row(),before)
        self.assertEqual(self.count('messages'),messages);self.assertEqual(self.count('inbox_outbox'),0)

    def test_new_start_and_concurrent_double_start_are_one_owned_paused_thread(self):
        barrier=threading.Barrier(2)
        def create(_):barrier.wait();return self.start()
        with ThreadPoolExecutor(2) as pool:results=list(pool.map(create,range(2)))
        self.assertEqual(sum(r['created'] for r in results),1)
        self.assertEqual(len({r['thread']['key'] for r in results}),1)
        row=results[0]['thread'];self.assertEqual(row['owner_id'],ACTOR['id']);self.assertTrue(row['bot_paused']);self.assertTrue(row['can_send_template']);self.assertEqual(row['send_blocked_reason'],'window_closed')
        self.assertEqual(self.count('inbox_outbox'),0)
        self.assertIs(get_system_setting('whatsapp_bot_number:5493515214819'),False)

    def test_start_permissions_and_idempotency(self):
        with self.assertRaisesRegex(inbox.InboxError,'write_required'):self.start(actor=READER)
        payload={'op':'start','actor':ACTOR,'number_id':'111','phone':'+5493519998888','request_id':str(uuid.uuid4())}
        first=inbox.handle(payload);self.assertEqual(inbox.handle(payload),first)
        with self.assertRaisesRegex(inbox.InboxError,'idempotency_conflict'):inbox.handle(dict(payload,phone='+5493519998887'))

    def test_template_closed_window_optin_preview_and_idempotent_outbox(self):
        self.call('take')
        with connection() as conn:conn.execute("UPDATE conversations SET last_inbound_at=NOW()-INTERVAL '25 hours' WHERE conversation_key=%s",(self.key,))
        with patch('app.inbox_templates.TemplateCatalog',return_value=CatalogFake()):
            with self.assertRaisesRegex(inbox.InboxError,'template_opt_in_required'):self.call('send',template=selected())
            request_id=str(uuid.uuid4());revision=self.row()['revision']
            result=self.call('send',template=selected(),opt_in=True,request_id=request_id,revision=revision)
            self.assertEqual(self.call('send',template=selected(),opt_in=True,request_id=request_id,revision=revision),result)
        self.assertEqual(result['message']['kind'],'template');self.assertEqual(self.count('inbox_outbox'),1)
        class Fake:
            def send(self,row,message,media,outid):return 'wamid.template'
        self.assertTrue(run_once(Fake()))
        with connection() as conn:self.assertEqual(conn.execute('SELECT state FROM inbox_outbox').fetchone()['state'],'sent')

    def test_template_does_not_bypass_owner_closed_or_disconnected_gate(self):
        self.call('take')
        other=dict(ACTOR,id='herramientas:2')
        with self.assertRaisesRegex(inbox.InboxError,'owner_required'):self.call('send',actor=other,template=selected(),opt_in=True)
        self.call('close')
        with self.assertRaisesRegex(inbox.InboxError,'thread_closed'):self.call('send',template=selected(),opt_in=True)
        self.call('reopen')
        with patch.dict(os.environ,{'INBOX_CONNECTED_NUMBER_IDS':''}):
            with self.assertRaisesRegex(inbox.InboxError,'number_not_connected'):self.call('send',template=selected(),opt_in=True)

    def test_template_revoked_before_transport_is_failed_without_message_post(self):
        self.call('take')
        with patch('app.inbox_templates.TemplateCatalog',return_value=CatalogFake()):self.call('send',template=selected(),opt_in=True)
        with patch('app.inbox_templates.TemplateCatalog',return_value=CatalogFake(raw_template(status='PAUSED'))),patch('app.inbox_media.httpx.Client') as http:
            self.assertTrue(run_once());http.assert_not_called()
        with connection() as conn:
            result=conn.execute('SELECT state,error_code FROM inbox_outbox').fetchone()
            self.assertEqual(result,{'state':'failed','error_code':'template_not_approved'})

    def test_template_owner_change_cancels_queued_send(self):
        self.call('take')
        with patch('app.inbox_templates.TemplateCatalog',return_value=CatalogFake()):self.call('send',template=selected(),opt_in=True)
        self.call('transfer',actor=SUPERVISOR,target={'id':'herramientas:2','name':'Other'})
        self.assertFalse(run_once())
        with connection() as conn:self.assertEqual(conn.execute('SELECT state FROM inbox_outbox').fetchone()['state'],'cancelled')

    def test_recording_checks_permission_first_and_marks_only_converted_content(self):
        payload={'op':'upload','actor':ACTOR,'key':self.key,'request_id':str(uuid.uuid4()),'recording':True,'mime':'audio/webm','data_base64':base64.b64encode(b'input').decode()}
        ogg=b'OggS'+b'\0'*24+b'OpusHead'+b'\0'*12
        with patch('app.inbox_recording.convert_recording',return_value=(ogg,1.0)) as convert:
            with self.assertRaisesRegex(inbox.InboxError,'owner_required'):inbox.handle(payload)
            convert.assert_not_called();self.call('take')
            result=inbox.handle(payload);self.assertEqual(inbox.handle(payload),result);convert.assert_called_once()
        with connection() as conn:
            media=conn.execute('SELECT is_voice,mime,content FROM inbox_media WHERE id=%s',(result['media_id'],)).fetchone()
            self.assertTrue(media['is_voice']);self.assertEqual(media['mime'],'audio/ogg');self.assertEqual(bytes(media['content']),ogg)
        regular=inbox.handle(dict(payload,recording=False,mime='image/png',data_base64=base64.b64encode(PNG).decode(),request_id=str(uuid.uuid4())))
        with connection() as conn:self.assertFalse(conn.execute('SELECT is_voice FROM inbox_media WHERE id=%s',(regular['media_id'],)).fetchone()['is_voice'])

    def test_template_ambiguous_transport_is_never_retried(self):
        self.call('take')
        with patch('app.inbox_templates.TemplateCatalog',return_value=CatalogFake()):self.call('send',template=selected(),opt_in=True)
        class Fake:
            def send(self,*args):raise TimeoutError()
        self.assertTrue(run_once(Fake()));self.assertFalse(run_once(Fake()))
        with connection() as conn:self.assertEqual(conn.execute('SELECT state FROM inbox_outbox').fetchone()['state'],'unknown')
