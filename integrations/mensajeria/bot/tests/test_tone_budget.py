import json,unittest
from unittest.mock import patch
from concurrent.futures import ThreadPoolExecutor
from app import ai_budget as budget,sales_config as sc,sales_engine as se,sales_tools as st,multimedia as mm,multimedia_config as cfg
from app.storage import connection,set_system_setting,save_prompt_version
from app.inbox_events import ingest,ai_revision
import test_sales_upgrade as old
import test_inbox as f

class SharedBudgetTests(unittest.TestCase):
 setUpClass=classmethod(f.DatabaseTests.setUpClass.__func__)
 tearDownClass=classmethod(f.DatabaseTests.tearDownClass.__func__)
 incoming=f.DatabaseTests.incoming
 call=f.DatabaseTests.call
 row=f.DatabaseTests.row
 setUp=old.SalesIntegration.setUp
 setup_msg=old.SalesIntegration.setup_msg
 enable=old.SalesIntegration.enable
 final=old.SalesIntegration.final
 def audio_message(self):
  p=self.incoming(recipient='5493512223344',raw={'type':'audio','audio':{'id':'456','mime_type':'audio/ogg'}})
  key,_=ingest(p);eid=p['message']['external_id']
  with connection() as c:c.execute('UPDATE inbox_media SET content=%s WHERE conversation_key=%s',(f.PNG,key))
  return key,eid,ai_revision(key,eid)
 def test_audio_and_text_share_existing_month_and_images_are_separate(self):
  self.setup_msg();self.enable(1)
  with connection() as c:c.execute("INSERT INTO multimedia_jobs(message_id,conversation_key,kind,state,reserved_microusd) VALUES(%s,%s,'audio','failed',990000)",(self.mid,self.key))
  self.assertEqual(sc.public_config()['used_usd'],.99);self.assertEqual(cfg.public_config()['used_usd'],0)
  with self.assertRaisesRegex(sc.SalesError,'budget'):sc.reserve(self.mid,self.key,0,20000,1)
  with connection() as c:c.execute("UPDATE multimedia_jobs SET kind='image'")
  self.assertEqual(sc.public_config()['used_usd'],0);self.assertEqual(cfg.public_config()['used_usd'],.99)
  self.assertTrue(sc.reserve(self.mid,self.key,0,20000,1))
 def test_previous_month_does_not_consume_current_pool(self):
  self.setup_msg();self.enable(1)
  with connection() as c:c.execute("INSERT INTO multimedia_jobs(message_id,conversation_key,kind,state,reserved_microusd,created_at) VALUES(%s,%s,'audio','failed',1000000,date_trunc('month',NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'-interval '1 second')",(self.mid,self.key))
  self.assertEqual(sc.public_config()['used_usd'],0)
 def test_audio_stops_at_shared_limit_even_with_unused_image_budget(self):
  self.setup_msg();self.enable(1);sc.reserve(self.mid,self.key,0,980000,1);key,eid,rev=self.audio_message()
  with patch.object(mm,'normalize',return_value=(b'fake','audio/wav','a.wav',1)),patch.object(mm,'provider') as provider:
   with self.assertRaisesRegex(cfg.MultimediaError,'budget'):mm.read_attachment(key,eid,rev,'audio')
   provider.assert_not_called()
  self.assertEqual(cfg.public_config()['used_usd'],0)
 def test_text_and_audio_concurrent_reservations_share_atomic_gate(self):
  self.setup_msg();self.enable(1);sc.reserve(self.mid,self.key,0,940000,1);key,eid,rev=self.audio_message()
  def text():
   try:sc.reserve(self.mid,self.key,1,50000,1);return True
   except sc.SalesError:return False
  def audio():
   try:mm.read_attachment(key,eid,rev,'audio');return True
   except cfg.MultimediaError:return False
  with patch.object(mm,'normalize',return_value=(b'fake','audio/wav','a.wav',1)),patch.object(mm,'provider',return_value=({'text':'hola','category':'audio'},50000)):
   with ThreadPoolExecutor(max_workers=2) as pool:
    a=pool.submit(text);b=pool.submit(audio);self.assertEqual(int(a.result())+int(b.result()),1)
  self.assertEqual(sc.public_config()['used_usd'],.99)
 def test_audio_still_works_if_image_budget_zero_or_seller_switch_off(self):
  self.setup_msg()
  cfg.save_config(dict(revision=1,images=False,audio=True,monthly_usd=0))
  sc.save_config(dict(enabled=False,monthly_usd=1,revision=0))
  key,eid,rev=self.audio_message()
  with patch.object(mm,'normalize',return_value=(b'fake','audio/wav','a.wav',1)),patch.object(mm,'provider',return_value=({'text':'hola','category':'audio'},50000)):
   mm.read_attachment(key,eid,rev,'audio')
  self.assertEqual(sc.public_config()['used_usd'],.05);self.assertEqual(cfg.public_config()['used_usd'],0)
 def test_published_prompt_reaches_external_model(self):
  self.setup_msg();self.enable()
  save_prompt_version({'business_notes':'MARCADOR_OPERATIVO. Usá voseo sin repetir saludos.','tone':'TONO_TEST_ARGENTINO'},'Test')
  with patch.object(se,'request',return_value=self.final()) as request:
   result=se.run('consulta',[],self.payload['conversation'],self.key,self.payload['message']['external_id'],self.revision)
   instructions=request.call_args.args[0]['instructions']
   self.assertIn('MARCADOR_OPERATIVO',instructions);self.assertIn('TONO_TEST_ARGENTINO',instructions);self.assertIn('No pidas claves',instructions)
   self.assertFalse(result.handoff)
 def test_invalid_commercial_copy_gets_one_bounded_external_repair(self):
  self.setup_msg();self.enable()
  with patch.object(se,'request',side_effect=[self.final('Sale $ 200'),self.final('Dale, ¿para qué uso la querés?')]) as provider:
   result=se.run('consulta',[],self.payload['conversation'],self.key,self.payload['message']['external_id'],self.revision)
   self.assertFalse(result.handoff);self.assertEqual(provider.call_count,2);self.assertNotIn('$',result.reply)
 def test_unrepairable_copy_never_reaches_client(self):
  self.setup_msg();self.enable()
  with patch.object(se,'request',return_value=self.final('Sale $ 200')) as provider:
   result=se.run('consulta',[],self.payload['conversation'],self.key,self.payload['message']['external_id'],self.revision)
   self.assertTrue(result.handoff);self.assertEqual(provider.call_count,2);self.assertNotIn('$',result.reply)

class ReplyStructureTests(unittest.TestCase):
 def test_followup_after_official_source(self):
  from app.ai import BotDecision
  tools=st.Tools('',[],{},'test');ref=tools.remember({'answer':'Dato oficial'},BotDecision('Dato oficial',False,'ventas','test'))['source']
  result=tools.render({'message':'Dale, te cuento.','sources':[ref],'followup':'¿Cómo preferís pagarlo?'})
  self.assertEqual(result.reply,'Dale, te cuento.\n\nDato oficial\n\n¿Cómo preferís pagarlo?')
 def test_followup_cannot_bypass_price_or_link_guard(self):
  tools=st.Tools('',[],{},'test')
  for text in ['¿Querés pagar $ 10?','https://evil.test','Tenemos stock','Envío gratis']:
   with self.assertRaises(ValueError):tools.render({'message':'Dale.','followup':text})
 def test_no_repeated_stock_intro_with_natural_intro(self):
  tools=st.Tools('',[],{},'test');tools.products={1:old.product()}
  with patch('app.commercial_prices._fetch',side_effect=RuntimeError()):
   result=tools.render({'message':'Dale, mirá esta opción.','product_ids':[1],'followup':'¿Te gusta en negro?'})
  self.assertNotIn('Te paso lo que encontré',result.reply);self.assertIn('Con stock:',result.reply);self.assertTrue(result.reply.endswith('¿Te gusta en negro?'))

if __name__=='__main__':unittest.main()

