import json,os,tempfile,unittest,subprocess,threading
from pathlib import Path
from unittest.mock import patch,MagicMock
from concurrent.futures import ThreadPoolExecutor
from app import multimedia as m,multimedia_config as cfg,inbox,worker
from app.inbox_events import ingest,ai_revision
from app.storage import connection,set_system_setting,recent_messages
import test_inbox as f

FAKE='sk-'+('unit-test-only_'*4)

@unittest.skipUnless(os.getenv('INBOX_TEST_DATABASE_URL'),'Isolated database required')
class MultimediaTests(unittest.TestCase):
 setUpClass=classmethod(f.DatabaseTests.setUpClass.__func__)
 tearDownClass=classmethod(f.DatabaseTests.tearDownClass.__func__)
 incoming=f.DatabaseTests.incoming
 call=f.DatabaseTests.call
 row=f.DatabaseTests.row
 def setUp(self):
  f.DatabaseTests.setUp(self)
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
  self.path=Path(self.temp.name)/'config.json'
  self.env=patch.dict(os.environ,{'MULTIMEDIA_CONFIG_PATH':str(self.path)});self.env.start();self.addCleanup(self.env.stop)
  set_system_setting('bot_enabled',True);set_system_setting('whatsapp_bot_number:5493515214819',True)
 def setup_config(self,budget=10,**extra):
  return cfg.save_config(dict(revision=cfg.read_config()['revision'],api_key=FAKE,images=True,audio=True,monthly_usd=budget,**extra))
 def media(self,kind='image'):
  raw={'type':kind,kind:{'id':'123','mime_type':'image/png' if kind=='image' else 'audio/ogg'}}
  p=self.incoming(raw=raw);self.key,_=ingest(p);eid=p['message']['external_id']
  with connection() as conn:conn.execute('UPDATE inbox_media SET content=%s WHERE conversation_key=%s',(f.PNG,self.key))
  return p,eid,ai_revision(self.key,eid)
 def read(self,eid,rev,kind='image'):
  return m.read_attachment(self.key,eid,rev,kind)
 def test_config_key_never_returned_private_permissions_and_cas(self):
  r=self.setup_config();self.assertNotIn(FAKE,json.dumps(r));self.assertEqual(self.path.stat().st_mode&0o777,0o600)
  self.assertTrue(r['configured'])
  with self.assertRaisesRegex(cfg.MultimediaError,'changed'):cfg.save_config(dict(revision=0,images=False,audio=False,monthly_usd=0))
  self.assertEqual(cfg.read_config()['key'],FAKE)
 def test_disabled_default_zero_budget_and_disconnect(self):
  self.assertFalse(cfg.read_config()['audio'])
  for budget in (0,-1,True,1.5,201):
   with self.assertRaises(cfg.MultimediaError):self.setup_config(budget)
  self.setup_config();r=cfg.save_config(dict(revision=1,images=False,audio=False,monthly_usd=10,remove_key=True))
  self.assertFalse(r['configured']);self.assertEqual(cfg.read_config()['key'],'')
 def test_secret_file_public_permissions_rejected(self):
  self.setup_config();self.path.chmod(0o644)
  with self.assertRaises(cfg.MultimediaError):cfg.read_config()
 def test_config_only_platform_admin_and_supervisor(self):
  for actor,flag in ((f.ACTOR,True),(f.READER,True),(f.SUPERVISOR,False)):
   with self.assertRaises(inbox.InboxError):inbox.handle({'op':'multimedia-config','actor':actor,'platform_admin':flag})
  self.assertFalse(inbox.handle({'op':'multimedia-config','actor':f.SUPERVISOR,'platform_admin':True})['configured'])
 def test_latest_attachment_cached_once_and_reading_shown(self):
  self.setup_config();p,eid,rev=self.media()
  with patch.object(m,'normalize',return_value=(b'fake','image/jpeg','f.jpg',0)),patch.object(m,'provider',return_value=({'text':'Una bicicleta azul','category':'product'},120)) as provider:
   self.read(eid,rev);self.read(eid,rev);provider.assert_called_once()
  with connection() as conn:
   job=conn.execute('SELECT * FROM multimedia_jobs').fetchone();self.assertEqual(job['reserved_microusd'],120)
   row=conn.execute('SELECT * FROM messages WHERE external_id=%s',(eid,)).fetchone()
  self.assertEqual(inbox.message_view(row)['media_reading']['text'],'Una bicicleta azul')
 def test_paused_owner_stale_and_disabled_never_call_provider(self):
  self.setup_config();p,eid,rev=self.media()
  with patch.object(m,'provider') as provider:
   self.call('take',actor=f.ACTOR)
   with self.assertRaises(cfg.MultimediaError):self.read(eid,rev)
   provider.assert_not_called()
 def test_foreign_media_and_history_rejected(self):
  self.setup_config();p,eid,rev=self.media()
  with connection() as conn:conn.execute("UPDATE inbox_media SET number_id='222'")
  with self.assertRaisesRegex(cfg.MultimediaError,'missing'):self.read(eid,rev)
 def test_provider_failure_does_not_retry_and_keeps_reservation(self):
  self.setup_config();p,eid,rev=self.media()
  with patch.object(m,'normalize',return_value=(b'fake','image/jpeg','f.jpg',0)),patch.object(m,'provider',side_effect=RuntimeError('secret private body')) as provider:
   for _ in range(2):
    with self.assertRaises(cfg.MultimediaError) as exc:self.read(eid,rev)
    self.assertNotIn('secret',str(exc.exception))
   provider.assert_called_once()
  with connection() as conn:self.assertEqual(conn.execute('SELECT reserved_microusd FROM multimedia_jobs').fetchone()['reserved_microusd'],m.RESERVE)
 def test_budget_prevents_dispatch(self):
  self.setup_config(1);p,eid,rev=self.media()
  with connection() as conn:
   mid=conn.execute('SELECT id FROM messages WHERE external_id!=%s LIMIT 1',(eid,)).fetchone()['id']
   conn.execute("INSERT INTO multimedia_jobs(message_id,conversation_key,kind,state,reserved_microusd) VALUES(%s,%s,'image','failed',999999)",(mid,self.key))
  with patch.object(m,'normalize',return_value=(b'fake','image/jpeg','f.jpg',0)),patch.object(m,'provider') as provider:
   with self.assertRaisesRegex(cfg.MultimediaError,'budget'):self.read(eid,rev)
   provider.assert_not_called()
 def test_take_during_generation_never_enqueues(self):
  self.setup_config();p,eid,rev=self.media('audio')
  def response(*args):
   self.call('take',actor=f.ACTOR);return {'text':'Busco una bicicleta','category':'audio'},100
  with patch.object(m,'normalize',return_value=(b'fake','audio/wav','f.wav',1)),patch.object(m,'provider',side_effect=response),patch.object(worker,'_decision_for') as decision:
   worker._reply_whatsapp(p,self.key,p['conversation'],p['message']);decision.assert_not_called()
  with connection() as conn:self.assertEqual(conn.execute('SELECT count(*) AS n FROM inbox_outbox').fetchone()['n'],0)
 def test_audio_uses_existing_commercial_flow_and_history(self):
  self.setup_config();p,eid,rev=self.media('audio')
  from app.ai import BotDecision
  with patch.object(m,'normalize',return_value=(b'fake','audio/wav','f.wav',1)),patch.object(m,'provider',return_value=({'text':'Me pasás el CBU?','category':'audio'},100)),patch.object(worker,'_decision_for',return_value=BotDecision('datos oficiales',False,'ventas','ok','normal')) as decision:
   worker._reply_whatsapp(p,self.key,p['conversation'],p['message']);self.assertEqual(decision.call_args.kwargs['text'],'Me pasás el CBU?')
  self.assertTrue(any(row['body']=='Me pasás el CBU?' for row in recent_messages(self.key)))
 def test_revoke_hides_and_does_not_reuse_transcript(self):
  self.setup_config();p,eid,rev=self.media('audio')
  with connection() as conn:conn.execute("UPDATE messages SET metadata=metadata || %s::jsonb WHERE external_id=%s",(json.dumps({'revoked':True,'media_reading':{'text':'private','kind':'audio'}}),eid))
  self.assertFalse(any(row['body']=='private' for row in recent_messages(self.key)))
 def test_disabled_kind_never_downloads(self):
  p,eid,rev=self.media();transport=MagicMock()
  with self.assertRaisesRegex(cfg.MultimediaError,'disabled'):m.read_attachment(self.key,eid,rev,'image',transport)
  transport.download.assert_not_called()
 def test_duplicate_worker_waits_for_original_without_handoff(self):
  self.setup_config();p,eid,rev=self.media('audio');started=threading.Event();finish=threading.Event()
  from app.ai import BotDecision
  def response(*args):started.set();self.assertTrue(finish.wait(10));return {'text':'busco una bici','category':'audio'},100
  with patch.object(m,'normalize',return_value=(b'fake','audio/wav','f.wav',1)),patch.object(m,'provider',side_effect=response) as provider,patch.object(worker,'_decision_for',return_value=BotDecision('respuesta correcta',False,'ventas','ok','normal')):
   with ThreadPoolExecutor(max_workers=2) as pool:
    first=pool.submit(worker._reply_whatsapp,p,self.key,p['conversation'],p['message']);self.assertTrue(started.wait(10))
    worker._reply_whatsapp(p,self.key,p['conversation'],p['message']);finish.set();first.result(10)
   provider.assert_called_once()
  with connection() as conn:
   out=conn.execute("SELECT body,metadata FROM messages WHERE sender='bot'").fetchall()
  self.assertEqual(len(out),1);self.assertEqual(out[0]['body'],'respuesta correcta');self.assertFalse(out[0]['metadata']['handoff'])
 def test_disconnect_during_provider_does_not_send(self):
  self.setup_config();p,eid,rev=self.media('audio')
  def response(*args):
   cfg.save_config(dict(revision=1,images=False,audio=False,monthly_usd=10,remove_key=True));return {'text':'busco una bici','category':'audio'},100
  with patch.object(m,'normalize',return_value=(b'fake','audio/wav','f.wav',1)),patch.object(m,'provider',side_effect=response),patch.object(worker,'_decision_for') as decision:
   worker._reply_whatsapp(p,self.key,p['conversation'],p['message']);decision.assert_not_called()
  with connection() as conn:
   self.assertEqual(conn.execute('SELECT count(*) AS n FROM inbox_outbox').fetchone()['n'],0)
   self.assertEqual(conn.execute('SELECT state FROM multimedia_jobs').fetchone()['state'],'cancelled')
 def test_audio_recalculates_service_department(self):
  self.setup_config();p,eid,rev=self.media('audio')
  from app.ai import BotDecision
  with patch.object(m,'normalize',return_value=(b'fake','audio/wav','f.wav',1)),patch.object(m,'provider',return_value=({'text':'necesito un service de mi bicicleta','category':'audio'},100)),patch.object(worker,'_decision_for',return_value=BotDecision('asesor',False,'posventa_taller','ok','normal')) as decision:
   worker._reply_whatsapp(p,self.key,p['conversation'],p['message']);self.assertEqual(decision.call_args.kwargs['department'],'posventa_taller')
 def test_disconnect_during_text_decision_cancels_reply(self):
  self.setup_config();p,eid,rev=self.media('audio')
  from app.ai import BotDecision
  def decision(**kwargs):
   cfg.save_config(dict(revision=1,images=False,audio=False,monthly_usd=10,remove_key=True));return BotDecision('cancelada',False,'ventas','ok','normal')
  with patch.object(m,'normalize',return_value=(b'fake','audio/wav','f.wav',1)),patch.object(m,'provider',return_value=({'text':'consulta','category':'audio'},100)),patch.object(worker,'_decision_for',side_effect=decision):
   worker._reply_whatsapp(p,self.key,p['conversation'],p['message'])
  with connection() as conn:self.assertEqual(conn.execute('SELECT count(*) AS n FROM inbox_outbox').fetchone()['n'],0)
 def test_key_check_uses_fixed_endpoint_no_files(self):
  self.setup_config()
  with patch.object(cfg.httpx,'Client') as cl:
   cl.return_value.__enter__.return_value.get.return_value.status_code=200
   self.assertTrue(cfg.check_key()['ok'])
   for call in cl.return_value.__enter__.return_value.get.call_args_list:self.assertTrue(call.args[0].startswith('https://api.openai.com/v1/models/'))
 def test_edited_attachment_cannot_reuse_reading(self):
  self.setup_config();p,eid,rev=self.media()
  with connection() as conn:conn.execute("UPDATE messages SET metadata=metadata || '{\"edited\":true}'::jsonb WHERE external_id=%s",(eid,))
  with patch.object(m,'provider') as provider:
   with self.assertRaisesRegex(cfg.MultimediaError,'missing'):self.read(eid,rev)
   provider.assert_not_called()
 def test_two_chats_compete_for_last_reservation(self):
  self.setup_config(1);p,eid,rev=self.media();key=self.key
  other=self.incoming(recipient='5493512223344',raw={'type':'image','image':{'id':'456','mime_type':'image/png'}});key2,_=ingest(other);eid2=other['message']['external_id'];rev2=ai_revision(key2,eid2)
  with connection() as conn:
   conn.execute('UPDATE inbox_media SET content=%s',(f.PNG,))
   mid=conn.execute('SELECT id FROM messages WHERE external_id!=%s AND external_id!=%s LIMIT 1',(eid,eid2)).fetchone()['id']
   conn.execute("INSERT INTO multimedia_jobs(message_id,conversation_key,kind,state,reserved_microusd) VALUES(%s,%s,'image','failed',750000)",(mid,key))
  started=threading.Event();finish=threading.Event()
  def response(*args):started.set();self.assertTrue(finish.wait(10));return {'text':'bici','category':'product'},100
  with patch.object(m,'normalize',return_value=(b'fake','image/jpeg','f.jpg',0)),patch.object(m,'provider',side_effect=response) as provider:
   with ThreadPoolExecutor(max_workers=2) as pool:
    first=pool.submit(m.read_attachment,key,eid,rev,'image');self.assertTrue(started.wait(10))
    with self.assertRaisesRegex(cfg.MultimediaError,'budget'):m.read_attachment(key2,eid2,rev2,'image')
    finish.set();first.result(10)
   provider.assert_called_once()

class ConversionTests(unittest.TestCase):
 def test_provider_contract_and_invalid_usage_keep_reserve(self):
  for usage in ({},{'input_tokens':-2,'output_tokens':10},{'input_tokens':True,'output_tokens':1},{'input_tokens':1000,'output_tokens':300}):
   with patch.object(m.httpx,'Client') as cl:
    post=cl.return_value.__enter__.return_value.post
    post.return_value.status_code=200;post.return_value.content=b'{}'
    post.return_value.json.return_value={'status':'completed','usage':usage,'output':[{'type':'message','content':[{'type':'output_text','text':json.dumps({'category':'product','description':'Una bicicleta'})}]}]}
    result,cost=m.provider({'key':FAKE},b'fake','image/jpeg','f.jpg','image',0)
    call=post.call_args;self.assertEqual(call.args[0],'https://api.openai.com/v1/responses');data=call.kwargs['json']
    self.assertEqual(data['model'],cfg.IMAGE_MODEL);self.assertIs(data['store'],False);self.assertNotIn('conversation',data);self.assertNotIn('phone',data)
    self.assertEqual(data['max_output_tokens'],1600);self.assertTrue(data['input'][0]['content'][0]['image_url'].startswith('data:image/jpeg;base64,'))
    self.assertEqual(cost,5000 if usage.get('input_tokens')==1000 else m.RESERVE)
 def test_provider_error_sanitizes_external_response(self):
  with patch.object(m.httpx,'Client') as cl:
   cl.return_value.__enter__.return_value.post.return_value.status_code=401
   with self.assertRaisesRegex(cfg.MultimediaError,'multimedia_provider_error') as error:m.provider({'key':FAKE},b'fake','audio/wav','a.wav','audio',1)
   self.assertNotIn(FAKE,str(error.exception))
 def test_generated_picture_and_audio_are_normalized(self):
  image=subprocess.check_output(['ffmpeg','-v','error','-f','lavfi','-i','color=blue:s=64x64','-frames:v','1','-threads','1','-f','image2pipe','-vcodec','png','pipe:1'])
  data,mime,name,seconds=m.normalize(image,'image/png','image');self.assertEqual(mime,'image/jpeg');self.assertTrue(data.startswith(b'\xff\xd8'))
  audio=subprocess.check_output(['ffmpeg','-v','error','-f','lavfi','-i','sine=frequency=400:duration=0.3','-c:a','libopus','-f','ogg','pipe:1'])
  data,mime,name,seconds=m.normalize(audio,'audio/ogg','audio');self.assertEqual(mime,'audio/wav');self.assertTrue(data.startswith(b'RIFF'));self.assertLess(seconds,1)
 def test_long_invalid_and_unsupported_are_rejected(self):
  with self.assertRaises(cfg.MultimediaError):m.normalize(b'bad','application/pdf','document')
  with patch.object(m,'validate_media'),patch.object(m,'_run',return_value=json.dumps({'streams':[{'codec_type':'audio'}],'format':{'duration':'301'}}).encode()):
   with self.assertRaisesRegex(cfg.MultimediaError,'too_long'):m.normalize(b'OggS','audio/ogg','audio')
 def test_payment_image_never_confirms_transfer(self):
  d=m.image_decision({'category':'payment','text':'Pago acreditado'},'ventas');self.assertTrue(d.handoff);self.assertNotIn('acreditado',d.reply)
 def test_visual_price_does_not_bypass_commercial_guard(self):
  d=m.image_decision({'category':'product','text':'Bicicleta cuesta $200'},'ventas');self.assertNotIn('$200',d.reply)

if __name__=='__main__':unittest.main()
