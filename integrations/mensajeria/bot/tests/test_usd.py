import copy, unittest
from unittest.mock import patch
from app import usd_payments as u, commercial_prices as cp, payment_answers as pa, sales_tools as st
POLICY={'enabled':True,'currency':'USD','domestic_only':True,'bank':'Banco prueba USD','holder':'Empresa de prueba','cbu':'0'*22,'alias':'PRUEBA.USD','account':'TEST-USD','cuit':'TEST'}
def product():
 return {'id':52569,'name':'Bicicleta MTB - TREK MARLIN 5 - GEN 3 2026','brand':'Trek','url':'https://fusionbikes.com.ar/?p=52569','sku':'PARENT','in_stock':True,'price_source':cp.UNVERIFIED,'cash_price':'99999999','usd_price':'99999','variations':[{'id':52570,'sku':'FB-52570','is_in_stock':True,'attributes':{'attribute_pa_talle':'ML','attribute_pa_color':'Azul'},'display_price':'99999999','usd_price':'99999'}]}
def quote(pid=52570,sku='FB-52570',usd='967'):
 return {'state':'ok','source':'master_control_pricing_engine','id':pid,'sku':sku,'quantity':1,'base_amount':'1450000','free_shipping':True,'plans':[{'plan':str(n),'installment_amount':'100','unit_amount':'200'} for n in cp.COUNTS],'usd_reference':{'currency':'USD','amount':usd,'source':'master_control_public_display','rounding':'ceil'}}
class DollarPayments(unittest.TestCase):
 def setUp(self):
  cp._cache.clear();self.settings=patch.object(u,'get_system_setting',return_value=copy.deepcopy(POLICY));self.settings.start();self.addCleanup(self.settings.stop)
 def decide(self,text,history=None,rows=None):
  with patch.object(cp,'_fetch',return_value=rows or [quote()]):return pa.payment_decision(text,history or [],{}, {},lambda:[product()])
 def test_exact_customer_question_gets_verified_web_usd_not_ml(self):
  d=self.decide('Otra consulta, reciben dólares para pagar la trek Marlin 5 esa')
  self.assertFalse(d.handoff);self.assertIn('US$ 967',d.reply);self.assertNotIn('99999',d.reply)
  for text in ['PRUEBA.USD','cuentas nacionales','día','compra','Confirmá el total']:self.assertIn(text,d.reply)
 def test_currency_symbols_and_bank_followup(self):
  for text in ['y en USD?','puedo pagar U$D?','cuánto sale en dólares?']:
   self.assertFalse(self.decide(text,[{'sender':'bot','body':'Trek Marlin 5 https://fusionbikes.com.ar/?p=52569'}]).handoff)
  d=self.decide('pasame el CBU',[{'sender':'bot','body':'Podés pagar en dólares.'}]);self.assertIn('PRUEBA.USD',d.reply)
 def test_pesos_not_misrouted_after_usd(self):
  self.assertFalse(u.usd_context('ahora el alias en pesos',[{'sender':'bot','body':'cuenta USD'}]))
  with patch.object(pa,'bank_instructions',return_value='CUENTA ARS'):
   d=self.decide('alias en pesos');self.assertIn('CUENTA ARS',d.reply);self.assertNotIn('PRUEBA.USD',d.reply)
 def test_explicit_human_and_combination_stay_unsupported(self):
  self.assertIsNone(u.usd_decision('mitad dólares y resto tarjeta',[],{},lambda:[]))
  self.assertIsNone(u.usd_decision('pasame con un asesor para pagar en dólares',[],{},lambda:[]))
 def test_foreign_account_not_accepted(self):
  d=self.decide('puedo transferir dólares desde el exterior?');self.assertIn('no recibe transferencias desde el exterior',d.reply);self.assertFalse(d.handoff)
 def test_missing_quote_never_falls_back_to_catalog_price(self):
  row=quote();row.pop('usd_reference')
  d=self.decide('pago Trek Marlin 5 en dólares',rows=[row]);self.assertNotIn('US$ 967',d.reply);self.assertNotIn('99999',d.reply);self.assertIn('No pude confirmar',d.reply)
 def test_no_policy_never_uses_invented_account(self):
  with patch.object(u,'get_system_setting',return_value={}):self.assertIsNone(u.usd_decision('en dólares?',[],{},lambda:[]))
 def test_wrong_identity_currency_and_bad_amounts_are_rejected(self):
  with self.assertRaises(cp.QuoteUnavailable):cp._validated(quote(),999,'FB-52570')
  for changes in [{'currency':'ARS'},{'source':'ml'},{'amount':'NaN'},{'amount':'-2'},{'rounding':'floor'}]:
   row=quote();row['usd_reference'].update(changes);self.assertNotIn('usd_price',cp._validated(row,52570,'FB-52570'))
 def test_different_variants_never_quote_parent_minimum(self):
  p=product();v=copy.deepcopy(p['variations'][0]);v.update(id=52571,sku='FB-52571');v['attributes']['attribute_pa_color']='Rojo';p['variations'].append(v)
  with patch.object(cp,'_fetch',return_value=[quote(),quote(52571,'FB-52571','1000')]):
   d=pa.payment_decision('Trek Marlin 5 en dólares?',[],{}, {},lambda:[p]);self.assertIn('Qué talle y color',d.reply);self.assertNotIn('US$ 967',d.reply)
 def test_named_product_uses_previously_shown_version(self):
  p=product();q=copy.deepcopy(p);q.update(id=9,name='Bicicleta TREK MARLIN 5 GEN 2',url='https://fusionbikes.com.ar/?p=9')
  history=[{'sender':'bot','body':p['name']+' '+p['url']},{'sender':'bot','body':'Factura recuperada'}]
  self.assertEqual(u.candidates_for('pago trek marlin 5 en dólares',history,{},[p,q]),[p])
 def test_unknown_model_does_not_inherit_old_model(self):
  self.assertEqual(u.candidates_for('Trek Emonda en dólares', [{'sender':'bot','body':product()['url']}],{},[product()]),[])
 def test_openai_conditions_returns_official_source(self):
  t=st.Tools('Trek Marlin 5 en dólares',[],{},'qa')
  with patch('app.learning.active_config',return_value={'rules':[]}),patch('app.learning.clean',return_value={}),patch.object(st,'load_products',return_value=[product()]),patch.object(cp,'_fetch',return_value=[quote()]):
   result=t.conditions({'question':'Trek Marlin 5 en dólares'})
  d=t.render({'message':'Dale, te paso la información.','sources':[result['source']],'handoff':False})
  self.assertFalse(d.handoff);self.assertIn('US$ 967',d.reply)

if __name__=='__main__':unittest.main()
