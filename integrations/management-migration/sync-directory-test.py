import importlib.util, unittest, tempfile, os, json, io, urllib.parse
from unittest.mock import patch
from pathlib import Path
spec=importlib.util.spec_from_file_location('directory',Path(__file__).with_name('sync-directory.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class DirectoryNormalization(unittest.TestCase):
 def test_customer_allowlist_and_fiscal_document(self):
  c=m.customer({'id':3,'email':'test@example.invalid','password':'secret','roles':['administrator'],'billing':{'first_name':'José','phone':'+54 (11) 1234-5678'},'meta_data':[{'key':'billing_dni','value':'12.345.678'},{'key':'auth_token','value':'secret'}]})
  self.assertEqual(c['document'],'12345678');self.assertEqual(c['marketing_consent'],'unknown')
  self.assertNotIn('secret',m.json.dumps(c));self.assertIn('jose',m.customer_search(c));self.assertIn('541112345678',m.customer_search(c))
 def test_order_preserves_historical_amount_and_mirror(self):
  o=m.order({'id':4,'total':'99.13','currency':'USD','line_items':[{'id':11,'product_id':2,'name':'A','quantity':2,'total':'85.00','private':'secret'}],'meta_data':[{'key':'_ml_order_id','value':'555'}],'refunds':[{'id':5,'total':'-1.25'}]})
  self.assertEqual(o['total'],'99.13');self.assertTrue(o['is_ml_mirror']);self.assertEqual(o['items'][0]['total'],'85.00');self.assertNotIn('secret',m.json.dumps(o))
 def test_guests_are_per_order_even_when_names_match(self):
  a=m.guest(m.order({'id':1,'billing':{'first_name':'Ana'}}));b=m.guest(m.order({'id':2,'billing':{'first_name':'Ana'}}))
  self.assertNotEqual(a['key'],b['key']);self.assertEqual(a['id'],0)
 def test_shipping_only_imports_allowed_draft_fields_and_existing_export_mark(self):
  o=m.order({'id':6,'shipping_lines':[{'method_title':'Andreani'}],'meta_data':[{'key':'_shipping_dni','value':'12345678'},{'key':'_fbam_exported_at','value':'2026-10-01'},{'key':'_fbam_draft','value':{'first_name':'Ana','private_secret':'omit','reviewed':True,'packages':[{'profile':'manual','weight':'2000','private_secret':'omit'}]}}]})
  self.assertEqual(o['shipping_document'],'12345678');self.assertEqual(o['shipping_methods'],['Andreani']);self.assertTrue(o['andreani']['draft']['reviewed']);self.assertEqual(o['andreani']['exported_at'],'2026-10-01');self.assertNotIn('private_secret',json.dumps(o))
 def test_placeholder_email_not_marketing_contact(self):
  c=m.customer({'id':5,'email':'customer@pos.local'})
  self.assertEqual(c['email'],'');self.assertEqual(c['marketing_consent'],'unknown')
@unittest.skipUnless(os.name=='posix','Production synchronization uses Linux file locks')
class SynchronizationRecovery(unittest.TestCase):
 def test_interrupted_history_resumes_and_publishes_only_complete_orders(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);cache=root/'directory-cache';cache.mkdir();env=root/'source.env';env.write_text('WOO_URL=https://fusionbikes.com.ar\nWOO_CK=test\nWOO_CS=test\n');(root/'.task-owner').write_text('fusion-management-migration-20261004')
   calls=[];fail=[True]
   class Response(io.BytesIO):
    def __init__(self,rows,total,pages):super().__init__(json.dumps(rows).encode());self.headers={'X-WP-Total':str(total),'X-WP-TotalPages':str(pages)}
   class Opener:
    def open(self,req,timeout):
     u=urllib.parse.urlsplit(req.full_url);q=urllib.parse.parse_qs(u.query);page=int(q.get('page',['1'])[0]);calls.append((u.path,page))
     if u.path.endswith('/customers'):return Response([{'id':3,'billing':{'first_name':'Ana'}}],1,1)
     assert q.get('dp')==['8'],'Historical monetary values must not use shop display rounding'
     if page==2 and fail[0]:raise RuntimeError('simulated_failure')
     return Response([{'id':page,'customer_id':3 if page==1 else 0,'billing':{'first_name':'Ana'},'date_created_gmt':'2023-01-01T00:00:00','total':'12.34'}],2,2)
   with patch.object(m,'ROOT',root),patch.object(m,'CACHE',cache),patch.object(m,'ENV_FILE',env),patch.object(m.urllib.request,'build_opener',return_value=Opener()),patch.object(m.shutil,'chown'),patch.object(m.time,'sleep'),patch.object(m.sys,'argv',['sync-directory.py']):
    with self.assertRaises(SystemExit):m.run()
    db=m.sqlite3.connect(cache/'directory.sqlite');self.assertEqual(db.execute('SELECT COUNT(*) FROM customers').fetchone()[0],1);self.assertEqual(db.execute('SELECT COUNT(*) FROM orders').fetchone()[0],0);db.close()
    before=len(calls);fail[0]=False;m.run()
    self.assertEqual(calls[before:],[('/wp-json/wc/v3/orders',2)])
    db=m.sqlite3.connect(cache/'directory.sqlite');self.assertEqual(db.execute('SELECT COUNT(*) FROM orders').fetchone()[0],2);self.assertEqual(db.execute('SELECT COUNT(*) FROM guests').fetchone()[0],1);self.assertEqual(json.loads(db.execute("SELECT value FROM state WHERE key='orders_complete'").fetchone()[0]),True);db.close()
    self.assertFalse((cache/'build-state.json').exists())
if __name__=='__main__':unittest.main()
