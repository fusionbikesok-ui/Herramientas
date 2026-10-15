"""Disposable, network-isolated PostgreSQL integration tests. No real recipients."""
import copy,json,os,unittest
from datetime import datetime,timezone,timedelta
from pathlib import Path
from unittest.mock import patch
import stock_alerts as alerts
from app.storage import connection,init_schema
from app.inbox_templates import template_view,TemplateError,render_template
from app.inbox_media import SendRejected

NOW=datetime(2026,10,15,12,0,tzinfo=timezone.utc)
NUMBER='106810789054504'
CFG={'schema':1,'enabled':True,'timezone':'America/Argentina/Buenos_Aires','hour':9,
 'number_id':NUMBER,'sender':'5493518752035','template_name':'fusion_resumen_reposicion_v1',
 'template_language':'es_AR','template_id':'1426400428877821',
 'recipients':[{'name':'Operador QA A','phone':'5493510000001'},{'name':'Operador QA B','phone':'5493510000002'}]}

def report(now=NOW,stock=1,alert='critical'):
 stamp=now.isoformat()
 return {'schema':1,'period':{'days':90,'cover':15},'snapshot':{'generated_at':stamp,'orders_at':stamp,'ml_at':stamp,'ml_complete':False},
 'rows':[{'id':1,'sku':'QA-1','name':'Bicicleta ejemplo','variant':'Talle M','stock':stock,'units':18,'coverage_days':5,'alert':alert,'issue':'','stock_at':stamp,'stock_stale':False}]}

class Catalog:
 def resolve(self,*args,**kw):
  raw=json.loads(Path('/qa/template-request.json').read_text())
  raw.update(id=CFG['template_id'],status='APPROVED')
  return template_view(raw)

class Transport:
 def __init__(self,first_error=None,callback=None):self.calls=[];self.first_error=first_error;self.callback=callback
 def send(self,row,message,media,outbox_id):
  self.calls.append((copy.deepcopy(row),copy.deepcopy(message),outbox_id))
  if self.callback:self.callback(row,message,outbox_id)
  if len(self.calls)==1 and self.first_error:raise self.first_error
  return 'wamid.qa.'+outbox_id

class PureTests(unittest.TestCase):
 def test_argentina_schedule(self):
  self.assertTrue(alerts.scheduled(NOW,CFG))
  self.assertFalse(alerts.scheduled(NOW-timedelta(minutes=1),CFG))
  self.assertFalse(alerts.scheduled(NOW+timedelta(hours=1),CFG))
 def test_wrong_sender_duplicate_recipient_rejected(self):
  for field,value in [('sender','5493510000000'),('hour',10),('number_id','2185814538178526')]:
   cfg=copy.deepcopy(CFG);cfg[field]=value
   with self.assertRaises(ValueError):alerts.validate_config(cfg)
  cfg=copy.deepcopy(CFG);cfg['recipients'][1]['phone']=cfg['recipients'][0]['phone']
  with self.assertRaises(ValueError):alerts.validate_config(cfg)
 def test_snapshot_periods_and_stale_data_fail_closed(self):
  for field in ['generated_at','orders_at','ml_at']:
   r=report();r['snapshot'][field]=(NOW-timedelta(days=2)).isoformat()
   with self.assertRaises(ValueError):alerts.validate_report(r,NOW)
  r=report();r['period']['days']=30
  with self.assertRaises(ValueError):alerts.validate_report(r,NOW)
 def test_stock_unknown_shared_stale_and_nonfinite_fail_closed(self):
  for field,value in [('stock',None),('stock',float('nan')),('stock',True),('issue','shared'),('stock_at','bad'),('stock_stale',True)]:
   r=report();r['rows'][0][field]=value
   with self.assertRaises(ValueError):alerts.validate_report(r,NOW)
 def test_services_healthy_and_no_sales_are_not_notified(self):
  for state in ['service','healthy','no_sales','review']:
   r=report(alert=state)
   self.assertEqual(alerts.validate_report(r,NOW),{})
   self.assertEqual(alerts.changed_rows(r['rows'],{}),[])
 def test_new_lower_unchanged_and_improving(self):
  previous={'1':{'stock':2,'alert':'critical'}}
  self.assertEqual(len(alerts.changed_rows(report(stock=1)['rows'],previous)),1)
  self.assertEqual(alerts.changed_rows(report(stock=2)['rows'],previous),[])
  self.assertEqual(alerts.changed_rows(report(stock=3)['rows'],previous),[])
  self.assertEqual(len(alerts.changed_rows(report()['rows'],{})),1)
 def test_priority_and_bounded_parameters_include_variants(self):
  rows=[]
  for i in range(10):
   r=report()['rows'][0];r.update(id=i+1,name='x'*200,variant='Talle M',stock=0,alert='missing');rows.append(r)
  rows[5].update(stock=-1,alert='negative')
  sorted_rows=alerts.changed_rows(rows,{})
  self.assertEqual(sorted_rows[0]['id'],6)
  params=alerts.template_parameters(CFG['recipients'][0],NOW.date(),sorted_rows)
  self.assertLessEqual(len(params['body'][3]),500)
  self.assertIn('Talle M',params['body'][3]);self.assertTrue(params['body'][3].endswith('+7 productos en Herramientas.'))
  render_template(Catalog().resolve(),params)

class DatabaseTests(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  assert os.environ['DATABASE_URL'].endswith('/stock_alerts_test'), 'Refuse non-QA database'
  init_schema()
  with connection() as conn:alerts.ensure_schema(conn)
 def setUp(self):
  with connection() as conn:
   conn.execute('TRUNCATE stock_alert_runs,stock_alert_state,messages,conversations,inbox_outbox CASCADE')
  self.transport=Transport()
 def run_alert(self,r=None,now=NOW,**kw):
  return alerts.run(r or report(now),copy.deepcopy(CFG),now=now,catalog=kw.pop('catalog',Catalog()),transport=self.transport,**kw)
 def counts(self):
  with connection() as conn:return tuple(conn.execute('SELECT COUNT(*) AS n FROM '+t).fetchone()['n'] for t in ['stock_alert_runs','stock_alert_state','messages','conversations','inbox_outbox'])
 def test_dry_run_renders_two_without_writes_or_sends(self):
  result=self.run_alert(dry_run=True)
  self.assertEqual(len(result['recipients']),2);self.assertIn('Bicicleta ejemplo',result['recipients'][0]['preview'])
  self.assertEqual(self.counts(),(0,0,0,0,0));self.assertEqual(self.transport.calls,[])
 def test_outside_schedule_or_disabled_never_touches_transport(self):
  self.assertEqual(self.run_alert(now=NOW+timedelta(hours=1))['state'],'outside_schedule')
  cfg=copy.deepcopy(CFG);cfg['enabled']=False
  self.assertEqual(alerts.run(report(),cfg,now=NOW)['state'],'disabled')
  self.assertEqual(self.counts(),(0,0,0,0,0))
 def test_template_pending_never_sends(self):
  with patch.object(Catalog,'resolve',side_effect=TemplateError('template_not_approved')):
   self.assertEqual(self.run_alert()['state'],'template_pending_or_unavailable')
  self.assertEqual(self.counts(),(0,0,0,0,0))
 def test_disconnected_does_not_send(self):
  with patch('app.inbox.number_connected',return_value=False):
   self.assertEqual(self.run_alert()['state'],'number_disconnected')
  self.assertEqual(self.counts(),(0,0,0,0,0))
 def test_commit_sending_before_http_system_sender_and_idempotency(self):
  def check(row,msg,oid):
   with connection() as conn:
    state=conn.execute('SELECT state FROM inbox_outbox WHERE id=%s',(oid,)).fetchone()['state']
    self.assertEqual(state,'sending')
    m=conn.execute('SELECT sender FROM messages WHERE id=%s',(msg['id'],)).fetchone()
    self.assertEqual(m['sender'],'system')
    self.assertIsNone(conn.execute("SELECT 1 FROM inbox_outbox WHERE state='queued'").fetchone())
  self.transport=Transport(callback=check)
  result=self.run_alert();self.assertEqual([r['state'] for r in result['recipients']],['sent','sent'])
  self.assertEqual(self.counts(),(2,2,2,2,2));self.assertEqual(len(self.transport.calls),2)
  self.run_alert();self.assertEqual(len(self.transport.calls),2)
 def test_existing_owner_status_ai_and_last_inbound_preserved(self):
  phone=CFG['recipients'][0]['phone'];key='whatsapp:'+NUMBER+':'+phone
  with connection() as conn:
   conn.execute("INSERT INTO conversations(conversation_key,channel,external_user_id,channel_number_id,owner_id,owner_name,bot_status,inbox_status,revision,last_inbound_at) VALUES(%s,'whatsapp',%s,%s,'herramientas:qa','QA','active','closed',7,NOW()-INTERVAL '5 days')",(key,phone,NUMBER))
   before=conn.execute('SELECT * FROM conversations WHERE conversation_key=%s',(key,)).fetchone()
  self.run_alert()
  with connection() as conn:after=conn.execute('SELECT * FROM conversations WHERE conversation_key=%s',(key,)).fetchone()
  for field in ['owner_id','owner_name','bot_status','inbox_status','revision','last_inbound_at']:
   self.assertEqual(after[field],before[field])
 def test_same_stock_next_day_no_message_then_lower_stock_notifies(self):
  self.run_alert(report(stock=2))
  day2=NOW+timedelta(days=1);result=self.run_alert(report(day2,stock=2),now=day2)
  self.assertEqual([r['state'] for r in result['recipients']],['unchanged','unchanged'])
  day3=NOW+timedelta(days=2);self.run_alert(report(day3,stock=1),now=day3)
  self.assertEqual(len(self.transport.calls),4)
 def test_recovery_then_critical_again_notifies(self):
  self.run_alert();day2=NOW+timedelta(days=1)
  self.run_alert(report(day2,stock=12,alert='healthy'),now=day2)
  self.assertEqual(len(self.transport.calls),2)
  day3=NOW+timedelta(days=2);self.run_alert(report(day3),now=day3)
  self.assertEqual(len(self.transport.calls),4)
 def test_one_definite_failure_does_not_block_other_recipient(self):
  self.transport=Transport(first_error=SendRejected('http_400'))
  result=self.run_alert();self.assertEqual([r['state'] for r in result['recipients']],['failed','sent'])
  self.run_alert();self.assertEqual(len(self.transport.calls),2)
  day2=NOW+timedelta(days=1);self.run_alert(report(day2),now=day2)
  self.assertEqual(len(self.transport.calls),3)
 def test_ambiguous_no_retry_even_next_day_and_late_delivery_reconciles(self):
  self.transport=Transport(first_error=TimeoutError())
  result=self.run_alert();self.assertEqual([r['state'] for r in result['recipients']],['unknown','sent'])
  day2=NOW+timedelta(days=1);result=self.run_alert(report(day2),now=day2)
  self.assertEqual(result['recipients'][0]['state'],'unknown_requires_review');self.assertEqual(len(self.transport.calls),2)
  with connection() as conn:
   conn.execute("UPDATE messages SET delivery_status='delivered' WHERE id=(SELECT message_id FROM inbox_outbox WHERE state='unknown')")
  result=self.run_alert(report(day2),now=day2)
  self.assertEqual(result['recipients'][0]['state'],'unchanged');self.assertEqual(len(self.transport.calls),2)
 def test_concurrent_run_lock_prevents_second_sender(self):
  with connection() as conn:
   conn.execute('SELECT pg_advisory_lock(7381274991)')
   self.assertEqual(self.run_alert()['state'],'already_running')
  self.assertEqual(self.counts(),(0,0,0,0,0))
 def test_later_meta_delivery_failure_restores_baseline_for_next_day(self):
  self.run_alert()
  with connection() as conn:
   phone=CFG['recipients'][0]['phone']
   oid=conn.execute('SELECT outbox_id FROM stock_alert_runs WHERE recipient=%s',(phone,)).fetchone()['outbox_id']
   conn.execute("UPDATE inbox_outbox SET state='failed' WHERE id=%s",(oid,))
   conn.execute("UPDATE messages SET delivery_status='failed' WHERE id=(SELECT message_id FROM inbox_outbox WHERE id=%s)",(oid,))
  day2=NOW+timedelta(days=1);result=self.run_alert(report(day2),now=day2)
  self.assertEqual([r['state'] for r in result['recipients']],['sent','unchanged'])
  self.assertEqual(len(self.transport.calls),3)

if __name__=='__main__':unittest.main()
