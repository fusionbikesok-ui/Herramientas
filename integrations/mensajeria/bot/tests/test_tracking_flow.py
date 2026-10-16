import unittest
from unittest.mock import patch
from concurrent.futures import ThreadPoolExecutor
from app import tracking_flow as t
from app.invoice_flow import lookup_allowed,InvoiceUnavailable,invoice_decision
from app.inbox_events import enqueue_ai,ai_revision,ingest
from app.outbox_worker import run_once
from app.storage import connection
import test_inbox as fixture

PHONE='5493511234567'
CONV={'channel':'whatsapp','external_user_id':PHONE,'customer_phone':'5493519999999'}
H=[{'sender':'customer','body':'necesito seguimiento'},{'sender':'bot','body':t.PROMPT}]
TRACK={'tracking':{'carrier':'Andreani','number':'1234567890'}}

class TrackingFlowTests(unittest.TestCase):
 def setUp(self):
  self.budget=patch.object(t,'lookup_allowed',return_value=True).start();self.addCleanup(patch.stopall)
 def test_asks_order_and_stays_active(self):
  with patch.object(t,'retrieve_tracking') as lookup:
   for text in ['necesito el seguimiento del envío','me pasas el numero de guia?','quiero rastrear mi pedido']:
    d=t.tracking_decision(text,[],CONV,'k');self.assertFalse(d.handoff);self.assertIn(t.PROMPT,d.reply)
   lookup.assert_not_called()
 def test_followup_and_inline_id_return_verified_code_and_link(self):
  with patch.object(t,'retrieve_tracking',return_value=('1234567890',t.BASE+'1234567890')) as lookup:
   for text,h in [('70704',H),('es el 70704',H),('mi pedido es 70704',H),('seguimiento pedido #70704',[])]:
    d=t.tracking_decision(text,h,CONV,'k');self.assertFalse(d.handoff);self.assertIn('Número de seguimiento: 1234567890',d.reply);self.assertIn(t.BASE+'1234567890',d.reply)
    lookup.assert_called_with(70704,PHONE);self.budget.assert_called_with('k',PHONE,70704,purpose='tracking')
 def test_only_last_verified_answer_can_supply_order(self):
  with patch.object(t,'retrieve_tracking',return_value=('1234567890',t.BASE+'1234567890')) as lookup:
   for last in ['Te comparto la factura del pedido #70704.','Seguimiento del pedido #70704\nAndreani']:
    h=[{'sender':'bot','body':last}]
    self.assertIn('1234567890',t.tracking_decision('y el seguimiento?',h,CONV,'k').reply)
    lookup.assert_called_with(70704,PHONE)
   lookup.reset_mock()
   h=[{'sender':'bot','body':'Te comparto la factura del pedido #70704.'},{'sender':'bot','body':'¿Cuál de tus pedidos querés revisar?'}]
   self.assertIn(t.PROMPT,t.tracking_decision('y el seguimiento?',h,CONV,'k').reply);lookup.assert_not_called()
 def test_other_order_or_invalid_explicit_number_never_reuses_old_context(self):
  h=[{'sender':'bot','body':'Te comparto la factura del pedido #70704.'}]
  with patch.object(t,'retrieve_tracking') as lookup:
   for text in ['seguimiento de otro pedido','seguimiento pedido 9999999999999','seguimiento pedido 70704.5','seguimiento #70704 y #70705','seguimiento del pedido #ABC','seguimiento pedido numero ABC','seguimiento pedido ABC']:
    d=t.tracking_decision(text,h,CONV,'k');self.assertIn(t.PROMPT,d.reply)
   lookup.assert_not_called()
 def test_wrong_contact_and_errors_disclose_no_tracking(self):
  with patch.object(t,'retrieve_tracking',side_effect=InvoiceUnavailable('contact')):
   d=t.tracking_decision('70704',H,CONV,'k');self.assertTrue(d.handoff);self.assertNotIn(t.BASE,d.reply)
 def test_phone_typed_by_customer_is_ignored(self):
  with patch.object(t,'retrieve_tracking',return_value=None) as lookup:
   t.tracking_decision('seguimiento pedido 70704, telefono 5493519999999',[],CONV,'k')
   lookup.assert_called_once_with(70704,PHONE)
 def test_web_missing_identity_and_limit_never_lookup(self):
  with patch.object(t,'retrieve_tracking') as lookup:
   for conv in [{'channel':'web','customer_phone':PHONE},{'channel':'whatsapp','customer_phone':PHONE}]:
    self.assertTrue(t.tracking_decision('70704',H,conv,'k').handoff)
   self.budget.return_value=False;self.assertTrue(t.tracking_decision('70704',H,CONV,'k').handoff);lookup.assert_not_called()
 def test_tracking_absent_does_not_invent_dispatch_or_date(self):
  with patch.object(t,'retrieve_tracking',return_value=None):
   d=t.tracking_decision('70704',H,CONV,'k');self.assertFalse(d.handoff);self.assertIn('no tiene un número de seguimiento cargado',d.reply)
   for text in ['despachado','mañana','entregado','llega el']:self.assertNotIn(text,d.reply)
 def test_unrelated_questions_and_pre_purchase_leave_flow(self):
  for text,h in [('70704',[]),('todavía no compré, como es el envio?',[]),('necesito la factura del pedido 70704',H),('quiero hablar con un asesor',H),('busco una bici',H),('mi pedido llego roto',[])]:
   self.assertIsNone(t.tracking_decision(text,h,CONV,'k'))
 def test_missing_order_and_declining_are_handled(self):
  self.assertTrue(t.tracking_decision('no lo tengo',H,CONV,'k').handoff)
  self.assertFalse(t.tracking_decision('no gracias',H,CONV,'k').handoff)
 def test_tracking_contract_and_fixed_url(self):
  with patch.object(t,'_get',return_value=TRACK) as get:
   self.assertEqual(t.retrieve_tracking(70704,PHONE),('1234567890',t.BASE+'1234567890'));get.assert_called_once_with(70704,PHONE)
  with patch.object(t,'_get',return_value={'tracking':None}):self.assertIsNone(t.retrieve_tracking(70704,PHONE))
  for value in [{},{'tracking':{}},{'tracking':{'carrier':'Unknown','number':'123456'}},{'tracking':{'carrier':'Andreani','number':'https://evil.test'}},{'tracking':{'carrier':'Andreani','number':'12345/../../x'}},{'tracking':{'carrier':'Andreani','number':123456}}]:
   with patch.object(t,'_get',return_value=value):
    with self.assertRaises(InvoiceUnavailable):t.retrieve_tracking(70704,PHONE)
 def test_worker_intercepts_and_invoice_prompt_does_not_capture_tracking(self):
  from app import worker
  from app.invoice_flow import PROMPT as invoice_prompt
  h=[{'sender':'bot','body':invoice_prompt}]
  with patch.object(worker,'recent_messages',return_value=h),patch.object(worker,'get_system_setting',side_effect=AssertionError('must bypass model')):
   d=worker._decision_for(key='k',text='necesito el seguimiento',conversation=CONV,department='ventas')
   self.assertIn(t.PROMPT,d.reply);self.assertFalse(d.handoff)
 def test_worker_payment_and_cbu_with_order_keep_payment_route(self):
  from app import worker
  from app.payment_answers import payment_decision
  def commercial(text,history,conversation=None):
   return payment_decision(text,history,conversation,{'payment_methods':['transferencia']},lambda:[]),[]
  with patch.object(worker,'recent_messages',return_value=[]),patch.object(worker,'get_system_setting',return_value='fast'),patch('app.catalog_flow.catalog_decision',side_effect=commercial),patch('app.payment_answers.bank_instructions',return_value='Alias: PRUEBA.SIN.CUENTA'),patch.object(t,'retrieve_tracking') as lookup:
   d=worker._decision_for(key='k',text='cómo puedo pagar el pedido 70704?',conversation=CONV,department='ventas')
   self.assertIn('Podés pagar con transferencia',d.reply)
   d=worker._decision_for(key='k',text='pasame el CBU para pagar el pedido 70704',conversation=CONV,department='ventas')
   self.assertIn('PRUEBA.SIN.CUENTA',d.reply);lookup.assert_not_called()

class TrackingQueueTests(unittest.TestCase):
 setUpClass=classmethod(fixture.DatabaseTests.setUpClass.__func__)
 tearDownClass=classmethod(fixture.DatabaseTests.tearDownClass.__func__)
 incoming=fixture.DatabaseTests.incoming
 row=fixture.DatabaseTests.row
 call=fixture.DatabaseTests.call
 count=fixture.DatabaseTests.count
 enable_ai=fixture.DatabaseTests.enable_ai
 def setUp(self):fixture.DatabaseTests.setUp(self);self.enable_ai()
 def test_invoice_and_tracking_have_separate_bounded_reservations(self):
  for _ in range(3):self.assertTrue(lookup_allowed(self.key,PHONE,70704))
  self.assertFalse(lookup_allowed(self.key,PHONE,70704))
  with ThreadPoolExecutor(5) as pool:r=list(pool.map(lambda _:lookup_allowed(self.key,PHONE,70704,purpose='tracking'),range(5)))
  self.assertEqual(r.count(True),3);self.assertEqual(self.count('inbox_audit'),6)
  with self.assertRaises(InvoiceUnavailable):lookup_allowed(self.key,PHONE,70704,purpose='anything')
 def test_real_decision_queues_once_and_synthetic_transport_gets_link(self):
  with patch.object(t,'_get',return_value=TRACK):d=t.tracking_decision('70704',H,CONV,self.key)
  self.assertFalse(d.handoff);revision=ai_revision(self.key)
  self.assertTrue(enqueue_ai(self.key,'tracking:one',revision,d));self.assertFalse(enqueue_ai(self.key,'tracking:one',revision,d))
  sent=[]
  class Transport:
   def send(self,row,msg,media,oid):sent.append((row,msg,media));return 'qa-tracking'
  self.assertTrue(run_once(Transport()));self.assertFalse(run_once(Transport()))
  self.assertEqual(len(sent),1);self.assertIn(t.BASE+'1234567890',sent[0][1]['body']);self.assertIsNone(sent[0][2]);self.assertEqual(sent[0][0]['external_user_id'],PHONE)
 def test_take_or_new_message_after_lookup_cancels_reply(self):
  for mode in ['take','new']:
   if mode=='new':self.setUp()
   revision=ai_revision(self.key)
   with patch.object(t,'_get',return_value=TRACK):d=t.tracking_decision('70704',H,CONV,self.key)
   if mode=='take':self.call('take')
   else:ingest(self.incoming())
   self.assertFalse(enqueue_ai(self.key,'tracking:'+mode,revision,d));self.assertEqual(self.count('inbox_outbox'),0)
