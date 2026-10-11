import copy,importlib.util,json,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('metrics',Path(__file__).with_name('sync-metrics.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Facts(unittest.TestCase):
 def setUp(self):
  self.order={'id':1,'created_at':'2026-10-01T02:59:59','status':'completed','currency':'ARS','shipping':{'country':'AR','state':'B','city':' La Plata '},'billing':{'country':'UY','city':'Montevideo','email':'private@example.invalid','first_name':'Private'},'items':[{'id':11,'product_id':2,'variation_id':3,'quantity':3,'total':'100.50','name':'Bici'}],'is_ml_mirror':False}
 def test_timezone_shipping_and_privacy(self):
  f=m.fact(self.order,None,m.timezone('-03:00'));self.assertEqual(f['date'],'2026-09-30');self.assertEqual(f['city'],'La Plata');self.assertNotIn('Private',json.dumps(f));self.assertNotIn('email',json.dumps(f))
 def test_partial_refund_original_period(self):
  f=m.fact(self.order,{'items':[{'id':11,'quantity':-1,'amount':-30}],'unassigned':True},m.timezone('UTC'));self.assertEqual(f['items'][0]['quantity'],2);self.assertEqual(f['items'][0]['amount'],70.5);self.assertTrue(f['unassigned'])
 def test_full_refund_clamps_quantity_not_negative_amount(self):
  f=m.fact(self.order,{'items':[{'id':11,'quantity':9,'amount':110}]},m.timezone('UTC'));self.assertEqual(f['items'][0]['quantity'],0);self.assertEqual(f['items'][0]['amount'],-9.5)
 def test_billing_fallback_and_currency_mirror(self):
  self.order['shipping']={};self.order['currency']='USD';self.order['is_ml_mirror']=True
  f=m.fact(self.order,None,m.timezone('UTC'));self.assertEqual(f['country'],'UY');self.assertEqual(f['currency'],'USD');self.assertTrue(f['ml_mirror']);self.assertEqual(len(f['items']),1)
 def test_invalid_money_fails_closed(self):
  self.order['items'][0]['total']='NaN'
  with self.assertRaises(RuntimeError):m.fact(self.order,None,m.timezone('UTC'))
if __name__=='__main__':unittest.main()
