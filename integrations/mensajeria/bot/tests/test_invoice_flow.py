import base64,copy,hashlib,json,os,unittest,uuid
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
from dataclasses import replace
from app import invoice_flow as f
import test_inbox as fixture
from app.inbox_events import enqueue_ai,ai_revision,ingest
from app.outbox_worker import run_once
from app.storage import connection

PHONE='5493511234567'
CONV={'channel':'whatsapp','external_user_id':PHONE,'customer_phone':'5493519999999'}
PDF=b'%PDF-1.4\nSynthetic private invoice for automated QA\n%%EOF'
ROW={'id':19,'order_id':70704,'type':6,'status':'authorized','environment':'production'}
LIST={'schema':1,'read_only':True,'order_id':70704,'has_more':False,'invoices':[ROW]}
DOC={'schema':1,'read_only':True,'order_id':70704,'invoice_id':19,'invoice':ROW,'mime':'application/pdf','filename':'Factura-70704.pdf','size':len(PDF),'sha256':hashlib.sha256(PDF).hexdigest(),'data_base64':base64.b64encode(PDF).decode()}
H=[{'sender':'customer','body':'necesito mi factura'},{'sender':'bot','body':f.PROMPT}]
def attachment():return f.InvoiceAttachment(70704,19,PHONE,'Factura-70704.pdf',PDF)
def decision():return f.InvoiceDecision('Te comparto la factura del pedido #70704.',False,'posventa_taller','Recuperación de factura',invoice_attachment=attachment(),invoice_order=70704)

class InvoiceFlowTests(unittest.TestCase):
 def setUp(self):
  self.budget=patch.object(f,'lookup_allowed',return_value=True).start();self.addCleanup(patch.stopall)
 def test_request_stays_active_and_asks_order_before_handoff(self):
  with patch.object(f,'retrieve') as lookup:
   for text in ['necesito mi factura','compré una bicicleta y no tengo la factura','me pasas la factura?']:
    d=f.invoice_decision(text,[],CONV,'k');self.assertIn(f.PROMPT,d.reply);self.assertFalse(d.handoff)
   lookup.assert_not_called()
 def test_number_followup_and_inline_order_use_authenticated_sender(self):
  with patch.object(f,'retrieve',return_value=attachment()) as lookup:
   for text,history in [('70704',H),('es 70704',H),('mi pedido es 70704',H),('quiero factura del pedido #70704',[]),('me pasás la factura A del pedido 70704',[]),('me pasás la factura B del pedido 70704',[])]:
    d=f.invoice_decision(text,history,CONV,'k');self.assertEqual(d.invoice_attachment,attachment());self.assertFalse(d.handoff)
    lookup.assert_called_with(70704,PHONE)
 def test_foreign_number_in_message_never_changes_recipient(self):
  with patch.object(f,'retrieve',return_value=attachment()) as lookup:
   f.invoice_decision('Factura pedido 70704, mi telefono es 5493519999999',[],CONV,'k')
   lookup.assert_called_once_with(70704,PHONE)
 def test_web_and_missing_identity_collect_order_for_human(self):
  with patch.object(f,'retrieve') as lookup:
   for conv in [{'channel':'web','customer_phone':PHONE},{'channel':'whatsapp','customer_phone':PHONE}]:
    d=f.invoice_decision('70704',H,conv,'k');self.assertTrue(d.handoff);self.assertIn('#70704',d.reply)
   lookup.assert_not_called()
 def test_multiple_ids_phone_and_invalid_numbers_do_not_lookup(self):
  with patch.object(f,'retrieve') as lookup:
   for text in ['#70704 y #70705','70704 70705',PHONE,'0','-70704','70704.5']:
    d=f.invoice_decision(text,H,CONV,'k');self.assertIn(f.PROMPT,d.reply);self.assertIsNone(d.invoice_attachment)
   lookup.assert_not_called()
 def test_numeric_without_context_and_other_intents_are_not_consumed(self):
  for text,history in [('70704',[]),('como va el envio del pedido70704',H),('quiero hablar con un asesor sobre mi factura',H),('hacen factura A?',[]),('busco una Venzo',H)]:
   self.assertIsNone(f.invoice_decision(text,history,CONV,'k'))
 def test_missing_order_failure_and_rate_limit_offer_human(self):
  d=f.invoice_decision('no lo tengo',H,CONV,'k');self.assertTrue(d.handoff)
  with patch.object(f,'retrieve',side_effect=f.InvoiceUnavailable('identity')):
   d=f.invoice_decision('70704',H,CONV,'k');self.assertTrue(d.handoff);self.assertIsNone(d.invoice_attachment)
  self.budget.return_value=False
  with patch.object(f,'retrieve') as lookup:
   self.assertTrue(f.invoice_decision('70704',H,CONV,'k').handoff);lookup.assert_not_called()
 def test_pdf_is_validated_and_not_in_repr(self):
  with patch.object(f,'_get',side_effect=[LIST,DOC]):
   a=f.retrieve(70704,PHONE);self.assertEqual(a,attachment());self.assertNotIn('Synthetic',repr(a))
 def test_ambiguous_unissued_credit_note_or_wrong_order_never_fetch_pdf(self):
  for listing in [dict(LIST,invoices=[]),dict(LIST,invoices=[ROW,ROW]),dict(LIST,has_more=True),dict(LIST,invoices=[dict(ROW,type=8)]),dict(LIST,invoices=[dict(ROW,status='draft')]),dict(LIST,invoices=[dict(ROW,environment='testing')]),dict(LIST,invoices=[dict(ROW,order_id=1)])]:
   with self.subTest(listing=listing),patch.object(f,'_get',return_value=listing) as get:
    with self.assertRaises(f.InvoiceUnavailable):f.retrieve(70704,PHONE)
    get.assert_called_once_with(70704,PHONE)
 def test_pdf_identity_digest_size_and_active_content_rejected(self):
  evil=b'%PDF-1.4 /JavaScript (not allowed) %%EOF'
  docs=[dict(DOC,invoice_id=20),dict(DOC,invoice=dict(ROW,order_id=1)),dict(DOC,invoice=dict(ROW,status='draft')),dict(DOC,size=1),dict(DOC,sha256='0'*64),dict(DOC,mime='text/html'),dict(DOC,data_base64='!!!!'),dict(DOC,size=len(evil),sha256=hashlib.sha256(evil).hexdigest(),data_base64=base64.b64encode(evil).decode())]
  for doc in docs:
   with self.subTest(doc=doc),patch.object(f,'_get',side_effect=[LIST,doc]):
    with self.assertRaises((ValueError,TypeError)):f.retrieve(70704,PHONE)
 def test_http_fixed_get_phone_and_auth_no_redirects(self):
  calls=[]
  class Client:
   def __init__(self,**kw):self.kw=kw
   def __enter__(self):return self
   def __exit__(self,*args):pass
   def stream(self,method,url,**kw):calls.append((self.kw,method,url,kw));return Response()
  class Response:
   status_code=200;headers={}
   def __enter__(self):return self
   def __exit__(self,*args):pass
   def iter_bytes(self):yield json.dumps(LIST).encode()
  with patch.dict(os.environ,{'BOT_COMMERCE_WOO_URL':'https://fusionbikes.com.ar','BOT_COMMERCE_WOO_CK':'qa','BOT_COMMERCE_WOO_CS':'qa'}),patch.object(f.httpx,'Client',Client):
   self.assertEqual(f._get(70704,PHONE),LIST)
  config,method,url,kw=calls[0];self.assertFalse(config['follow_redirects']);self.assertEqual(method,'GET');self.assertEqual(url,'https://fusionbikes.com.ar/wp-json/wc/v3/fusion-herramientas/messaging-orders/70704');self.assertEqual(kw['headers']['X-Fusion-Contact-Phone'],'+'+PHONE)
 def test_http_unsafe_config_and_path_injection_rejected_without_network(self):
  with patch.object(f.httpx,'Client') as client:
   for base in ['http://fusionbikes.com.ar','https://evil.test','https://u:p@fusionbikes.com.ar','https://fusionbikes.com.ar:443','https://fusionbikes.com.ar?x=1']:
    with patch.dict(os.environ,{'BOT_COMMERCE_WOO_URL':base}):
     with self.assertRaises(f.InvoiceUnavailable):f._get(70704,PHONE)
   for identifier in ['../orders',True,0,-1]:
    with self.assertRaises(f.InvoiceUnavailable):f._get(identifier,PHONE)
   client.assert_not_called()
 def test_worker_intercepts_invoice_before_model_and_keeps_prompt(self):
  from app import worker
  with patch.object(worker,'recent_messages',return_value=[]),patch.object(worker,'get_system_setting',side_effect=AssertionError('invoice must bypass model')):
   d=worker._decision_for(key='k',text='necesito mi factura',conversation=CONV,department='ventas')
   self.assertFalse(d.handoff);self.assertIn(f.PROMPT,d.reply)

class InvoiceQueueTests(unittest.TestCase):
 setUpClass=classmethod(fixture.DatabaseTests.setUpClass.__func__)
 tearDownClass=classmethod(fixture.DatabaseTests.tearDownClass.__func__)
 incoming=fixture.DatabaseTests.incoming
 row=fixture.DatabaseTests.row
 call=fixture.DatabaseTests.call
 count=fixture.DatabaseTests.count
 enable_ai=fixture.DatabaseTests.enable_ai
 def setUp(self):fixture.DatabaseTests.setUp(self);self.enable_ai()
 def test_pdf_and_message_atomic_idempotent_and_delivered_by_existing_transport(self):
  revision=ai_revision(self.key);self.assertTrue(enqueue_ai(self.key,'invoice:1',revision,decision()))
  self.assertFalse(enqueue_ai(self.key,'invoice:1',revision,decision()))
  self.assertEqual(self.count('inbox_media'),1);self.assertEqual(self.count('inbox_outbox'),1)
  sent=[]
  class Transport:
   def send(self,thread,message,media,outbox_id):sent.append((thread,message,media));return 'qa-delivered-invoice'
  self.assertTrue(run_once(Transport()));self.assertFalse(run_once(Transport()))
  self.assertEqual(len(sent),1);thread,message,media=sent[0]
  self.assertEqual(thread['external_user_id'],PHONE);self.assertEqual(message['kind'],'document');self.assertEqual(bytes(media['content']),PDF);self.assertTrue(message['metadata']['invoice_order']==70704)
 def test_take_during_lookup_drops_pdf_without_storing_it(self):
  revision=ai_revision(self.key);self.call('take')
  self.assertFalse(enqueue_ai(self.key,'invoice:2',revision,decision()));self.assertEqual(self.count('inbox_media'),0)
 def test_new_inbound_after_lookup_drops_pdf_without_storing_it(self):
  revision=ai_revision(self.key);ingest(self.incoming())
  self.assertFalse(enqueue_ai(self.key,'invoice:3',revision,decision()));self.assertEqual(self.count('inbox_media'),0)
 def test_take_after_enqueue_cancels_transport(self):
  self.assertTrue(enqueue_ai(self.key,'invoice:4',ai_revision(self.key),decision()));self.call('take')
  class Never:
   def send(self,*args):raise AssertionError('Invoice must not send after human takeover')
  self.assertFalse(run_once(Never()))
  with connection() as c:self.assertEqual(c.execute('SELECT state FROM inbox_outbox').fetchone()['state'],'cancelled')
 def test_recipient_mismatch_rolls_back_entire_attachment(self):
  bad=replace(decision(),invoice_attachment=replace(attachment(),recipient='5493519999999'))
  with self.assertRaises(f.InvoiceUnavailable):enqueue_ai(self.key,'invoice:5',ai_revision(self.key),bad)
  self.assertEqual(self.count('inbox_media'),0);self.assertEqual(self.count('inbox_outbox'),0)
 def test_lookup_budget_counts_attempts_even_if_new_messages_cancel_replies(self):
  for i in range(3):
   revision=ai_revision(self.key)
   self.assertTrue(f.lookup_allowed(self.key,PHONE,70704))
   ingest(self.incoming())
   self.assertFalse(enqueue_ai(self.key,'cancelled:'+str(i),revision,decision()))
  self.assertEqual(self.count('inbox_outbox'),0);self.assertEqual(self.count('inbox_media'),0)
  self.assertFalse(f.lookup_allowed(self.key,PHONE,70704));self.assertEqual(self.count('inbox_audit'),3)
 def test_lookup_reservation_rechecks_identity_and_paused_state(self):
  self.assertFalse(f.lookup_allowed(self.key,'5493519999999',70704));self.assertEqual(self.count('inbox_audit'),0)
  self.call('take');before=self.count('inbox_audit')
  self.assertFalse(f.lookup_allowed(self.key,PHONE,70704));self.assertEqual(self.count('inbox_audit'),before)
 def test_parallel_lookup_reservations_never_exceed_three(self):
  with ThreadPoolExecutor(5) as pool:results=list(pool.map(lambda _:f.lookup_allowed(self.key,PHONE,70704),range(5)))
  self.assertEqual(results.count(True),3);self.assertEqual(self.count('inbox_audit'),3)
