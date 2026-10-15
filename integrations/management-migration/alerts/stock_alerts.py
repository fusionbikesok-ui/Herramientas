"""Local service notifications; no public route, stock writes or human-chat claims.

Loaded into the existing bot runtime by the root-owned VPS runner. Reuses CloudTransport
and the inbox delivery ledger without inserting work into the human outbox queue.
"""
from __future__ import annotations
import json
import math
import re
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

ACTOR = {'id':'system:stock-replenishment','name':'Reposición automática'}
CRITICAL = {'critical','missing','negative'}
SCHEMA = (
 '''CREATE TABLE IF NOT EXISTS stock_alert_runs (
 id BIGSERIAL PRIMARY KEY, day DATE NOT NULL, recipient TEXT NOT NULL,
 state TEXT NOT NULL, snapshot JSONB NOT NULL, previous_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb, changes INTEGER NOT NULL,
 outbox_id UUID REFERENCES inbox_outbox(id), error_code TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(day,recipient))''',
 '''CREATE TABLE IF NOT EXISTS stock_alert_state (
 recipient TEXT PRIMARY KEY, snapshot JSONB NOT NULL,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())''',
)

def clean(value, limit=100):
    return re.sub(r'[\x00-\x1f\x7f]+',' ',str('' if value is None else value)).replace('{{','').replace('}}','').strip()[:limit]

def validate_config(cfg):
    if cfg.get('schema') != 1 or cfg.get('number_id') != '106810789054504' or cfg.get('sender') != '5493518752035':
        raise ValueError('invalid_sender_config')
    if cfg.get('timezone') != 'America/Argentina/Buenos_Aires' or (type(cfg.get('hour')) is not int or not 0<=cfg['hour']<=23 or type(cfg.get('minute',0)) is not int or not 0<=cfg.get('minute',0)<=59):
        raise ValueError('invalid_schedule')
    recipients=cfg.get('recipients',[])
    if len(recipients)!=2 or len({r.get('phone') for r in recipients})!=2:
        raise ValueError('invalid_recipients')
    for r in recipients:
        if not re.fullmatch(r'549[1-9]\d{9}',r.get('phone','')) or not isinstance(r.get('name'),str) or not r['name'].strip() or len(r['name'])>70 or re.search(r'[\x00-\x1f\x7f]',r['name']) or type(r.get('enabled',True)) is not bool:
            raise ValueError('invalid_recipient')
    if cfg.get('template_name')!='fusion_resumen_reposicion_v1' or cfg.get('template_language')!='es_AR' or not re.fullmatch(r'\d{1,40}',cfg.get('template_id','')):
        raise ValueError('invalid_template_config')
    return cfg

def scheduled(now,cfg):
    local=now.astimezone(ZoneInfo(cfg['timezone']))
    return local.hour==cfg['hour'] and local.minute==cfg.get('minute',0)

def stamp(value):
    try:return datetime.fromisoformat(str(value).replace('Z','+00:00'))
    except (ValueError,TypeError):return None

def fresh(value,now,seconds):
    t=stamp(value)
    return bool(t and t.tzinfo and -60<=(now-t).total_seconds()<=seconds)

def validate_report(report,now):
    if report.get('schema')!=1 or report.get('period',{}).get('days')!=90 or report.get('period',{}).get('cover')!=15:
        raise ValueError('invalid_report')
    snapshot=report.get('snapshot',{})
    if not fresh(snapshot.get('generated_at'),now,600) or not fresh(snapshot.get('orders_at'),now,3600) or not fresh(snapshot.get('ml_at'),now,86400):
        raise ValueError('sales_snapshot_stale')
    rows=report.get('rows')
    if not isinstance(rows,list) or not rows or len(rows)>50000:
        raise ValueError('catalog_unavailable')
    ids=set()
    for r in rows:
        if not isinstance(r,dict) or type(r.get('id')) is not int or r['id']<1 or r['id'] in ids:
            raise ValueError('invalid_product_identity')
        ids.add(r['id'])
        if r.get('alert') in CRITICAL:
            if r.get('issue') or type(r.get('stock')) not in (int,float) or not math.isfinite(r['stock']):
                raise ValueError('unverified_stock')
            if r.get('stock_stale') or not fresh(r.get('stock_at'),now,86400):
                raise ValueError('stock_snapshot_stale')
    return {str(r['id']):{'stock':r['stock'],'alert':r['alert']} for r in rows if r.get('alert') in CRITICAL}

def changed_rows(rows,previous):
    result=[]
    for r in rows:
        if r.get('alert') not in CRITICAL:continue
        old=previous.get(str(r['id']))
        if old is None or r['stock']<old['stock'] or (old.get('alert')=='critical' and r['alert'] in {'missing','negative'}):
            result.append(r)
    return sorted(result,key=lambda r:({'negative':0,'missing':1,'critical':2}[r['alert']],r.get('coverage_days') or 0,-float(r.get('units') or 0),r['id']))

def template_parameters(recipient,day,rows,partial_sales=False):
    entries=[]
    for r in rows[:3]:
        coverage='sin stock' if r['stock']==0 else 'stock negativo' if r['stock']<0 else ('cobertura '+str(round(r.get('coverage_days') or 0,1)).replace('.',',')+' días')
        variant=clean(r.get('variant'),35)
        label=clean(r.get('name'),50)+((' / '+variant) if variant else '')
        entries.append(f"{clean(r.get('sku'),20)} {label}: stock {r['stock']:g}; {clean(r.get('units'),12)} ventas/90d; {coverage}")
    detail=('Historial de Mercado Libre parcial. ' if partial_sales else '')+' | '.join(entries)
    tail=f' | +{len(rows)-3} productos en Herramientas.' if len(rows)>3 else ''
    return {'body':[clean(recipient['name'],70),day.strftime('%d/%m/%Y'),str(len(rows)),clean(detail,500-len(tail))+tail]}

def ensure_schema(conn):
    with conn.transaction():
        conn.execute('SELECT pg_advisory_xact_lock(7381274990)')
        for sql in SCHEMA:conn.execute(sql)

def state_update(conn,phone,snapshot):
    conn.execute('''INSERT INTO stock_alert_state(recipient,snapshot) VALUES(%s,%s::jsonb)
      ON CONFLICT(recipient) DO UPDATE SET snapshot=EXCLUDED.snapshot,updated_at=NOW()''',(phone,json.dumps(snapshot)))

def reconcile(conn,phone):
    rows=conn.execute("SELECT r.*,o.state AS delivery_state,m.delivery_status FROM stock_alert_runs r JOIN inbox_outbox o ON o.id=r.outbox_id JOIN messages m ON m.id=o.message_id WHERE r.recipient=%s AND (r.state IN ('sending','unknown') OR (r.state='sent' AND o.state='failed')) ORDER BY r.id",(phone,)).fetchall()
    for r in rows:
        delivered=r['delivery_state']=='sent' or r['delivery_status'] in {'sent','delivered','read'}
        state='sent' if delivered else 'failed' if r['delivery_state'] in {'failed','cancelled'} else 'unknown'
        with conn.transaction():
            conn.execute('UPDATE stock_alert_runs SET state=%s,updated_at=NOW() WHERE id=%s',(state,r['id']))
            if delivered:state_update(conn,phone,r['snapshot'])
            elif state=='failed' and r['state']=='sent':
                newer=conn.execute("SELECT 1 FROM stock_alert_runs WHERE recipient=%s AND id>%s AND state='sent' LIMIT 1",(phone,r['id'])).fetchone()
                if not newer:state_update(conn,phone,r['previous_snapshot'])
    return conn.execute("SELECT 1 FROM stock_alert_runs WHERE recipient=%s AND state IN ('sending','unknown') LIMIT 1",(phone,)).fetchone() is not None

def run(report,cfg,*,dry_run=False,now=None,connect=None,catalog=None,transport=None):
    from app.storage import connection
    from app.config import get_settings
    from app.inbox import lock_thread,queue_message,audit,number_connected
    from app.inbox_templates import TemplateCatalog,TemplateError,render_template
    from app.inbox_media import CloudTransport,SendRejected
    from app.outbox_worker import finish
    from app.number_controls import configured_number
    now=now or datetime.now(timezone.utc)
    validate_config(cfg)
    day=now.astimezone(ZoneInfo(cfg['timezone'])).date()
    if cfg.get('enabled') is not True:return {'state':'disabled'}
    if not dry_run and not scheduled(now,cfg):return {'state':'outside_schedule','day':str(day)}
    if not any(r.get('enabled',True) for r in cfg['recipients']):return {'state':'no_recipients'}
    snapshot=validate_report(report,now)
    settings=get_settings()
    if not number_connected(cfg['number_id']):return {'state':'number_disconnected'}
    if configured_number(cfg['number_id'],settings.whatsapp_numbers)!=cfg['sender']:raise ValueError('sender_mismatch')
    catalog=catalog or TemplateCatalog(settings)
    try:
        view=catalog.resolve(cfg['number_id'],cfg['template_id'],cfg['template_language'],name=cfg['template_name'])
    except TemplateError as e:
        return {'state':'template_pending_or_unavailable','reason':clean(str(e),80),'critical':len(snapshot)}
    results=[]
    with (connect or connection)() as conn:
        if not conn.execute('SELECT pg_try_advisory_lock(7381274991) AS held').fetchone()['held']:return {'state':'already_running'}
        try:
            for recipient in cfg['recipients']:
                if not recipient.get('enabled',True):continue
                phone=recipient['phone'];result={'name':recipient['name'],'phone_suffix':phone[-4:]};results.append(result)
                if not dry_run and reconcile(conn,phone):result['state']='unknown_requires_review';continue
                existing=conn.execute('SELECT state FROM stock_alert_runs WHERE day=%s AND recipient=%s',(day,phone)).fetchone()
                if existing and not dry_run:result['state']='already_processed';continue
                previous=conn.execute('SELECT snapshot FROM stock_alert_state WHERE recipient=%s',(phone,)).fetchone()
                changes=changed_rows(report['rows'],previous['snapshot'] if previous else {})
                result.update(changes=len(changes),critical=len(snapshot))
                if dry_run:
                    result.update(state='preview',preview=render_template(view,template_parameters(recipient,day,changes,not report['snapshot'].get('ml_complete',False)))['preview'] if changes else None)
                    continue
                if not changes:
                    with conn.transaction():
                        state_update(conn,phone,snapshot)
                        conn.execute("INSERT INTO stock_alert_runs(day,recipient,state,snapshot,changes) VALUES(%s,%s,'unchanged',%s::jsonb,0)",(day,phone,json.dumps(snapshot)))
                    result['state']='unchanged';continue
                rendered=render_template(view,template_parameters(recipient,day,changes,not report['snapshot'].get('ml_complete',False)))
                stored={'id':view['id'],'name':view['name'],'language':view['language'],'fingerprint':view['fingerprint'],'parameters':rendered['parameters']}
                key='whatsapp:'+cfg['number_id']+':'+phone
                lock_thread(conn,key,session=True)
                try:
                    with conn.transaction():
                        row=conn.execute('SELECT * FROM conversations WHERE conversation_key=%s FOR UPDATE',(key,)).fetchone()
                        if row is None:
                            row=conn.execute('''INSERT INTO conversations(conversation_key,channel,external_user_id,channel_number_id,channel_label,customer_phone,customer_name,department,bot_status)
                              VALUES(%s,'whatsapp',%s,%s,%s,%s,%s,'ventas','paused') RETURNING *''',(key,phone,cfg['number_id'],settings.whatsapp_numbers[cfg['number_id']]['label'],phone,recipient['name'])).fetchone()
                        source=f'stock-digest:{day}:{phone}'
                        message=queue_message(conn,row,ACTOR,rendered['preview'],source_id=source,metadata={'template':stored,'opt_in':True,'automation':'stock_replenishment','report_day':str(day)})
                        # Commit sending before HTTP. The human worker only claims queued;
                        # its interrupted-send recovery and delivery webhooks still apply.
                        out=conn.execute("UPDATE inbox_outbox SET state='sending',updated_at=NOW() WHERE message_id=%s RETURNING *",(message['id'],)).fetchone()
                        # Notifications must not be learned as human agent answers.
                        conn.execute("UPDATE messages SET delivery_status='sending',sender='system' WHERE id=%s",(message['id'],))
                        conn.execute("INSERT INTO stock_alert_runs(day,recipient,state,snapshot,previous_snapshot,changes,outbox_id) VALUES(%s,%s,'sending',%s::jsonb,%s::jsonb,%s,%s)",(day,phone,json.dumps(snapshot),json.dumps(previous['snapshot'] if previous else {}),len(changes),out['id']))
                        audit(conn,key,ACTOR,'stock_digest',{'day':str(day),'changes':len(changes),'outbox_id':str(out['id'])})
                    try:
                        remote_id=(transport or CloudTransport(settings)).send(row,message,None,str(out['id']))
                        if not isinstance(remote_id,str) or not remote_id:raise ValueError('missing_message_id')
                    except SendRejected as e:
                        state='failed';error=clean(str(e),80);remote_id=None
                    except Exception:
                        state='unknown';error='delivery_ambiguous_no_retry';remote_id=None
                    else:state='sent';error=None
                    finish(conn,out,state,error=error,remote_id=remote_id)
                    with conn.transaction():
                        conn.execute('UPDATE stock_alert_runs SET state=%s,error_code=%s,updated_at=NOW() WHERE outbox_id=%s',(state,error,out['id']))
                        if state=='sent':state_update(conn,phone,snapshot)
                    result.update(state=state,error=error)
                finally:conn.execute('SELECT pg_advisory_unlock(hashtextextended(%s,171717))',(key,))
        finally:conn.execute('SELECT pg_advisory_unlock(7381274991)')
    return {'state':'preview' if dry_run else 'completed','day':str(day),'recipients':results,'partial_sales':not report['snapshot'].get('ml_complete',False)}
