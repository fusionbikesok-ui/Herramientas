import json,os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from concurrent.futures import ThreadPoolExecutor
from app import catalog_flow as cf,catalog_spelling as spelling,sales_tools as st,sales_config as sc,sales_engine as se,media_context as mc,multimedia as mm,multimedia_config as mcfg,inbox,worker
from app.storage import connection,set_system_setting
from app.inbox_events import ingest,ai_revision
import test_inbox as f

def product(pid=1):
 return {'id':pid,'name':'Bicicleta MTB R29 Venzo Raptor 2025','brand':'Venzo','url':'https://fusionbikes.com.ar/?p='+str(pid),'in_stock':True,'currency':'ARS','price_source':'catalog_base_unverified','cash_price':'99999999','variations':[
 {'id':11,'sku':'FB-11','is_in_stock':True,'stock_quantity':8,'display_price':'99999999','attributes':{'attribute_pa_talle':'M','attribute_pa_color':'Negro'}},
 {'id':12,'sku':'FB-12','is_in_stock':False,'stock_quantity':0,'display_price':'99999999','attributes':{'attribute_pa_talle':'S','attribute_pa_color':'Rojo'}}]}

class CatalogRegression(unittest.TestCase):
 def test_audio_confirmation_keeps_identity_and_medium(self):
  history=[{'sender':'customer','body':'Hola, buen día, ¿cómo estás? Mirá, quería saber si tienen disponible bicicleta Benzo Raptor.'},{'sender':'bot','body':'Para confirmar disponibilidad. ¿Te referís a «venzo raptor»?'},{'sender':'customer','body':'Si'},{'sender':'bot','body':'¿Qué talle buscás?'}]
  for phrase in ['M','en M','tenes en M?','M tenes?','M hay stock?','talle mediano']:
   text,rows,action=spelling.confirmed_search(phrase,history)
   state,_=cf._state(text,rows,{'venzo'},[product()])
   self.assertIsNotNone(state,phrase);self.assertEqual(state['size'],'M',phrase)
   exact,_=cf._match([product()],state);self.assertEqual([p['id'] for p in exact],[1],(phrase,state))
 def test_rejected_confirmation_does_not_select(self):
  _,_,action=spelling.confirmed_search('No',[{'sender':'customer','body':'Benzo Raptor'},{'sender':'bot','body':'Para confirmar disponibilidad. ¿Te referís a «venzo raptor»?'}]);self.assertEqual(action,'rejected')
 def test_search_does_not_quote_ml_prices_or_empty_variants(self):
  tools=st.Tools('',[],{},'synthetic')
  with patch.object(st,'load_products',return_value=[product()]),patch('app.commercial_prices._fetch',side_effect=RuntimeError()):
   found=tools.search({'query':'venzo raptor','size':'M','color':''})
   p=found['products'][0];self.assertIsNone(p['cash_price']);self.assertIsNone(p['variants'][0]['cash_price'])
   self.assertEqual(len(p['variants']),1)
   self.assertEqual(tools.search({'query':'venzo raptor','size':'S','color':''})['products'],[])
 def test_money_link_unknown_product_and_order_injection(self):
  tools=st.Tools('Hola',[],{},'synthetic')
  for message in ['Pagá $ 100','12 cuotas sin interés','https://evil.example','CBU 999','Contado: 1.017.000','ARS 1017000','Envío gratis','¿Te sirve contado 1.017.000 con envío gratis?']:
   with self.assertRaises(ValueError):tools.render({'message':message})
  with self.assertRaises(ValueError):tools.render({'product_ids':[987]})
  self.assertIn('error',tools.after_sale({'purpose':'factura','order_id':'999'}))
 def test_history_is_bounded_and_retains_previous_product(self):
  rows=se.history_input('M',[{'sender':'customer','body':'Venzo Raptor'},{'sender':'bot','body':'Precio anterior $123456.000. Qué talle?'}])
  self.assertEqual(rows[-1]['content'],'M');self.assertIn('Venzo Raptor',json.dumps(rows));self.assertNotIn('$123456',json.dumps(rows))
 def test_visual_hypothesis_not_stock_claim_from_model(self):
  from app import visual_catalog as vc
  with patch.object(vc,'load_products',return_value=[product()]):
   d=vc.decision({'category':'product','candidate_ids':[1]},'ventas');self.assertFalse(d.handoff);self.assertIn('posibles coincidencias',d.reply);self.assertIn('M / Negro',d.reply);self.assertNotIn('S / Rojo',d.reply)
 def test_visual_candidates_do_not_inherit_one_anothers_sizes(self):
  from app import visual_catalog as vc
  second=product(2);second['variations'][0]['attributes']['attribute_pa_talle']='L'
  with patch.object(vc,'load_products',return_value=[product(),second]):
   d=vc.decision({'category':'product','candidate_ids':[1,2]},'ventas');self.assertIn('M / Negro',d.reply);self.assertIn('L / Negro',d.reply);self.assertNotIn('no muestra stock',d.reply)
   d=vc.decision({'category':'product','candidate_ids':[1,2]},'ventas','Esa bici la tenés?\nM');self.assertIn('M / Negro',d.reply);self.assertNotIn('L / Negro',d.reply);self.assertIn('en talle M',d.reply)

@unittest.skipUnless(os.getenv('INBOX_TEST_DATABASE_URL'),'Isolated database required')
class SalesIntegration(unittest.TestCase):
 setUpClass=classmethod(f.DatabaseTests.setUpClass.__func__)
 tearDownClass=classmethod(f.DatabaseTests.tearDownClass.__func__)
 incoming=f.DatabaseTests.incoming
 call=f.DatabaseTests.call
 row=f.DatabaseTests.row
 def setUp(self):
  f.DatabaseTests.setUp(self)
  with connection() as conn:conn.execute('DELETE FROM sales_ai_calls')
  set_system_setting('sales_openai',dict(sc.DEFAULT));set_system_setting('bot_enabled',True);set_system_setting('whatsapp_bot_number:5493515214819',True)
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
  p=Path(self.tmp.name)/'config.json';p.write_text(json.dumps({'key':'sk-'+('test_only_'*5),'images':True,'audio':True,'monthly_usd':50,'revision':1}));p.chmod(0o600)
  self.env=patch.dict(os.environ,{'MULTIMEDIA_CONFIG_PATH':str(p)});self.env.start();self.addCleanup(self.env.stop)
 def setup_msg(self):
  self.payload=self.incoming();self.key,_=ingest(self.payload);self.revision=ai_revision(self.key,self.payload['message']['external_id'])
  with connection() as conn:self.mid=conn.execute('SELECT id FROM messages WHERE external_id=%s',(self.payload['message']['external_id'],)).fetchone()['id']
 def enable(self,budget=1):return sc.save_config({'enabled':True,'monthly_usd':budget,'revision':0})
 def final(self,message='¿Para qué uso la querés?'):
  return {'status':'completed','usage':{'input_tokens':10,'output_tokens':20},'output':[{'type':'message','content':[{'type':'output_text','text':json.dumps({'message':message,'product_ids':[],'sources':[],'handoff':False,'department':'ventas'})}]}]}
 def test_default_off_and_permissions(self):
  self.assertIsNone(se.run('hola',[],{},'missing'))
  for actor,flag in [(f.ACTOR,True),(f.SUPERVISOR,False),(f.READER,True)]:
   with self.assertRaises(inbox.InboxError):inbox.handle({'op':'sales-config','actor':actor,'platform_admin':flag})
  self.assertFalse(sc.public_config()['enabled'])
 def test_budget_is_separate_and_cas(self):
  self.enable(20);self.assertEqual(mcfg.public_config()['monthly_usd'],50)
  self.assertEqual(sc.public_config()['monthly_usd'],20)
  with self.assertRaisesRegex(sc.SalesError,'changed'):self.enable(30)
 def test_atomic_reservation_never_exceeds_budget(self):
  self.setup_msg();self.enable()
  def attempt(step):
   try:sc.reserve(self.mid,self.key,step,600_000,1);return True
   except sc.SalesError:return False
  with ThreadPoolExecutor(max_workers=2) as pool:self.assertEqual(sum(pool.map(attempt,[0,1])),1)
 def test_live_model_body_no_store_and_usage(self):
  self.setup_msg();self.enable()
  with patch.object(se,'request',return_value=self.final()) as request:
   d=se.run('busco una bici',[],self.payload['conversation'],self.key,self.payload['message']['external_id'],self.revision)
   self.assertFalse(d.handoff);self.assertFalse(request.call_args.args[0]['store']);self.assertEqual(request.call_args.args[0]['model'],'gpt-6.1-sol')
  self.assertEqual(sc.public_config()['used_usd'],.00022)
 def test_duplicate_does_not_call_or_send_again(self):
  self.setup_msg();self.enable()
  with patch.object(se,'request',return_value=self.final()) as request:
   se.run('hola',[],self.payload['conversation'],self.key,self.payload['message']['external_id'],self.revision)
   self.assertEqual(se.run('hola',[],self.payload['conversation'],self.key,self.payload['message']['external_id'],self.revision).reply,'');self.assertEqual(request.call_count,1)
 def test_function_call_roundtrip_renders_verified_stock(self):
  self.setup_msg();self.enable()
  call={'status':'completed','usage':{'input_tokens':10,'output_tokens':20},'output':[{'type':'function_call','call_id':'call_test','name':'buscar_productos','arguments':json.dumps({'query':'venzo raptor','size':'M','color':''})}]}
  final=self.final('Encontré esta opción. ¿Qué uso le vas a dar?');answer=json.loads(final['output'][0]['content'][0]['text']);answer['product_ids']=[1];final['output'][0]['content'][0]['text']=json.dumps(answer)
  with patch.object(st,'load_products',return_value=[product()]),patch('app.commercial_prices._fetch',side_effect=RuntimeError()),patch.object(se,'request',side_effect=[call,final]) as request:
   d=se.run('Venzo Raptor M',[],self.payload['conversation'],self.key,self.payload['message']['external_id'],self.revision)
   self.assertFalse(d.handoff);self.assertIn('talle M',d.reply);self.assertNotIn('99999999',d.reply);self.assertEqual(request.call_count,2)
   self.assertEqual(request.call_args.args[0]['service_tier'],'default');self.assertTrue(any(i.get('type')=='function_call_output' for i in request.call_args.args[0]['input']))
 def test_human_take_during_generation_cancels(self):
  self.setup_msg();self.enable()
  def response(*a):self.call('take',actor=f.ACTOR);return self.final()
  with patch.object(se,'request',side_effect=response):self.assertEqual(se.run('hola',[],self.payload['conversation'],self.key,self.payload['message']['external_id'],self.revision).reply,'')
 def test_failure_retains_reserve_and_no_paid_retry(self):
  self.setup_msg();self.enable()
  with patch.object(se,'request',side_effect=sc.SalesError('sales_provider_error')) as request:
   self.assertTrue(se.run('hola',[],self.payload['conversation'],self.key,self.payload['message']['external_id'],self.revision).handoff)
   self.assertEqual(se.run('hola',[],self.payload['conversation'],self.key,self.payload['message']['external_id'],self.revision).reply,'');self.assertEqual(request.call_count,1)
  self.assertGreater(sc.public_config()['used_usd'],0)
 def test_fresh_caption_can_read_previous_image_once(self):
  media=self.incoming(raw={'type':'image','image':{'id':'123','mime_type':'image/png'}});key,_=ingest(media)
  caption=self.incoming();caption['event_id']='caption-event';caption['message']['external_id']='caption-message';caption['message']['text']='Esa bici la tenes?';ingest(caption)
  rev=ai_revision(key,caption['message']['external_id'])
  with connection() as conn:conn.execute('UPDATE inbox_media SET content=%s WHERE conversation_key=%s',(f.PNG,key))
  related=mc.related_attachment(key,caption['message']['external_id']);self.assertIsNotNone(related)
  with patch.object(mm,'normalize',return_value=(b'fake','image/jpeg','photo.jpg',0)),patch.object(mm,'provider',return_value=({'text':'Bicicleta Trek','category':'product','candidate_ids':[]},200)) as provider:
   for _ in range(2):mm.read_attachment(key,related['external_id'],rev,'image',anchor_external_id=caption['message']['external_id'])
   provider.assert_called_once()
  self.call('take',actor=f.ACTOR)
  with self.assertRaises(mcfg.MultimediaError):mm.read_attachment(key,related['external_id'],rev,'image',anchor_external_id=caption['message']['external_id'])
 def test_old_or_foreign_caption_cannot_read(self):
  self.setup_msg()
  self.assertIsNone(mc.related_attachment(self.key,'another-customer'))
 def test_new_inbound_does_not_let_old_event_spend_its_budget(self):
  self.setup_msg();self.enable();old=self.payload;revision=self.revision
  newer=self.incoming();newer['message']['external_id']='new-event';newer['event_id']='new';ingest(newer)
  with patch.object(se,'request',return_value=self.final()) as request:
   self.assertEqual(se.run('viejo',[],old['conversation'],self.key,old['message']['external_id'],revision).reply,'')
   request.assert_not_called()
   d=se.run('nuevo',[],newer['conversation'],self.key,'new-event',ai_revision(self.key,'new-event'))
   self.assertTrue(d.reply);request.assert_called_once()
 def test_two_captions_and_human_request_never_calls_provider(self):
  p=self.incoming(raw={'type':'image','image':{'id':'123','mime_type':'image/png'}});key,_=ingest(p)
  for i,text in enumerate(['Esa bici la tenes?','quiero hablar con una persona']):
   caption=self.incoming();caption['event_id']='cap'+str(i);caption['message']['external_id']='cap'+str(i);caption['message']['text']=text;ingest(caption)
  linked=mc.related_attachment(key,'cap1');self.assertEqual(linked['external_id'],p['message']['external_id']);self.assertIn('Esa bici',linked['caption'])
  with patch.object(mm,'read_attachment') as media,patch.object(se,'request') as provider:
   worker._reply_whatsapp(caption,key,caption['conversation'],caption['message']);media.assert_not_called();provider.assert_not_called()
  with connection() as conn:
   row=conn.execute("SELECT metadata FROM messages WHERE sender='bot'").fetchone();self.assertTrue(row['metadata']['handoff'])
