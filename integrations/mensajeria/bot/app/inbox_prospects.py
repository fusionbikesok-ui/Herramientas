"""Sales context only: importing a prospect never simulates an incoming message."""
from __future__ import annotations
import hashlib
import json
import re
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

from .storage import connection
from .config import get_settings
from .number_controls import configured_number

TABLE_SQL = """CREATE TABLE IF NOT EXISTS inbox_prospect_sources (
    source TEXT NOT NULL CHECK(source IN ('lead','cart')), external_id BIGINT NOT NULL,
    conversation_key TEXT NOT NULL REFERENCES conversations(conversation_key),
    origin TEXT NOT NULL CHECK(origin IN ('gift','cart','contact')),
    active BOOLEAN NOT NULL, payload JSONB NOT NULL, fingerprint TEXT NOT NULL,
    source_updated_at TEXT NOT NULL, imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(source,external_id))"""
INDEX_SQL = 'CREATE INDEX IF NOT EXISTS inbox_prospects_key_idx ON inbox_prospect_sources(conversation_key,active,origin)'
ACTIVE_SQL = 'EXISTS (SELECT 1 FROM inbox_prospect_sources p WHERE p.conversation_key=c.conversation_key AND p.active)'
# Read state and assignment are separate. New commercial context remains visible
# until acknowledged, while assigned chats return when a new message arrives.
PENDING_SQL = """c.inbox_status='open' AND ((c.unread>0 AND EXISTS (
    SELECT 1 FROM messages m WHERE m.conversation_key=c.conversation_key AND m.sender='customer'
      AND COALESCE(m.metadata->>'historical','false')!='true'
      AND COALESCE(m.metadata->>'revoked','false')!='true')) OR (c.owner_id IS NULL AND
    EXISTS (SELECT 1 FROM inbox_prospect_sources p WHERE p.conversation_key=c.conversation_key
      AND p.active AND p.imported_at>COALESCE(c.inbox_read_at,'-infinity'::timestamptz))))"""



def clean(value, limit=500):
    return re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', '', str(value or ''))[:limit].strip()


def website(value):
    value=clean(value,2000)
    try:
        u=urlsplit(value)
        return value if u.scheme in {'http','https'} and u.hostname in {'fusionbikes.com.ar','www.fusionbikes.com.ar'} and not u.username and not u.password else ''
    except ValueError:return ''


def phone_identity(value):
    """Complete numbers only; never match suffixes or guess a missing area code."""
    raw=clean(value,80)
    if not re.fullmatch(r'\+?[0-9 ().-]+',raw):return ''
    n=re.sub(r'\D','',raw)
    if not raw.startswith('+') and len(n)==11 and n.startswith('0'):n=n[1:]
    if not raw.startswith('+') and len(n)==10:return '549'+n
    if len(n)==12 and n.startswith('54'):return '549'+n[2:]
    if len(n)==13 and n.startswith('549'):return n
    if raw.startswith('+') and re.fullmatch(r'[1-9][0-9]{7,14}',n) and not n.startswith('54'):return n
    return ''


def normalized(record):
    if not isinstance(record,dict) or record.get('source') not in {'lead','cart'}:raise ValueError('invalid_prospect')
    source=record['source'];ident=record.get('id')
    if isinstance(ident,bool) or not isinstance(ident,int) or not 0<ident<2**63:raise ValueError('invalid_prospect_id')
    phone=clean(record.get('phone'),80);email=clean(record.get('email'),190)
    if not phone and not email:raise ValueError('missing_contact')
    status=clean(record.get('status'),30)
    reason=clean(record.get('reason'),120)
    origin='cart' if source=='cart' else 'gift' if 'regalo' in reason.lower() else 'contact'
    data={k:clean(record.get(k),limit) for k,limit in [('name',120),('phone',80),('email',190),('created_at',30),('updated_at',30),('reason',120),('message',2000),('page_title',500),('payment_method',120),('installments',60),('exit_reason',120),('stage',40),('currency',10)]}
    data.update(source=source,id=ident,status=status,origin=origin,page_url=website(record.get('page_url')))
    data['order_id']=int(record.get('order_id') or 0)
    total=record.get('total',0)
    data['total']=float(total) if isinstance(total,(int,float)) and 0<=total<=1e15 else 0
    data['items']=[]
    for item in (record.get('items') or [])[:50]:
        if not isinstance(item,dict):continue
        quantity=item.get('quantity',0)
        data['items'].append({'name':clean(item.get('name'),500),'quantity':quantity if isinstance(quantity,(int,float)) and 0<quantity<=100000 else 0,'url':website(item.get('url'))})
    active=status=='pending' if source=='lead' else status=='abandoned' and data['order_id']==0 and bool(data['items'])
    return data,active


def sales_number():
    numbers=get_settings().whatsapp_numbers
    matches=[(str(k),v) for k,v in numbers.items() if configured_number(str(k),numbers)=='5493518752035']
    if len(matches)!=1:raise ValueError('sales_number_not_configured')
    return matches[0]


def import_record(conn,record,number_id,label):
    from .inbox import lock_thread
    data,active=normalized(record)
    fingerprint=hashlib.sha256(json.dumps(data,sort_keys=True,ensure_ascii=False,allow_nan=False).encode()).hexdigest()
    with conn.transaction():
        conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,171721))',(f"{data['source']}:{data['id']}",))
        previous=conn.execute('SELECT * FROM inbox_prospect_sources WHERE source=%s AND external_id=%s FOR UPDATE',(data['source'],data['id'])).fetchone()
        if previous and previous['fingerprint']==fingerprint:return 'unchanged'
        phone=phone_identity(data['phone'])
        if previous:
            key=previous['conversation_key']
            old_phone=phone_identity(previous['payload'].get('phone'))
            if old_phone!=phone or (not phone and previous['payload'].get('email')!=data['email']):
                # Do not attach a changed person's information to an existing chat.
                raise ValueError('source_contact_changed')
        elif phone:
            key='whatsapp:'+number_id+':'+phone
            variants=[phone,'54'+phone[3:]] if phone.startswith('549') and len(phone)==13 else [phone]
            existing=conn.execute("SELECT conversation_key FROM conversations WHERE channel='whatsapp' AND channel_number_id=%s AND external_user_id=ANY(%s) ORDER BY (external_user_id=%s) DESC,created_at LIMIT 1",(number_id,variants,phone)).fetchone()
            if existing:key=existing['conversation_key']
        else:
            identity=data['email'].casefold() if data['email'] else data['phone']
            key='prospect:'+hashlib.sha256(identity.encode()).hexdigest()
        lock_thread(conn,key)
        row=conn.execute('SELECT * FROM conversations WHERE conversation_key=%s FOR UPDATE',(key,)).fetchone()
        if not active and not previous:
            if not row or (data['source']=='cart' and not record.get('abandoned_at')):return 'ignored'
        try:stamp=datetime.fromisoformat(data['created_at']).replace(tzinfo=ZoneInfo('America/Argentina/Buenos_Aires')).astimezone(timezone.utc)
        except (ValueError,TypeError):stamp=datetime.now(timezone.utc)
        stamp=min(stamp,datetime.now(timezone.utc))
        if not row:
            conn.execute("""INSERT INTO conversations(conversation_key,channel,external_user_id,channel_number_id,channel_label,
                customer_name,customer_phone,department,bot_status,created_at,updated_at)
                VALUES(%s,%s,%s,%s,%s,%s,%s,'ventas','paused',%s,%s)""",
                (key,'whatsapp' if phone else 'lead',phone or '',number_id if phone else '',label if phone else 'Contacto web',data['name'],phone or data['phone'],stamp,stamp))
        elif not previous:
            # Attach context without overwriting actual chat identity, ownership,
            # AI policy, inbound window, unread count or human closed state.
            conn.execute("UPDATE conversations SET customer_name=CASE WHEN COALESCE(customer_name,'')='' THEN %s ELSE customer_name END,updated_at=GREATEST(updated_at,%s) WHERE conversation_key=%s",(data['name'],stamp,key))
        conn.execute("""INSERT INTO inbox_prospect_sources(source,external_id,conversation_key,origin,active,payload,fingerprint,source_updated_at)
            VALUES(%s,%s,%s,%s,%s,%s::jsonb,%s,%s)
            ON CONFLICT(source,external_id) DO UPDATE SET active=EXCLUDED.active,payload=EXCLUDED.payload,
            fingerprint=EXCLUDED.fingerprint,source_updated_at=EXCLUDED.source_updated_at,imported_at=NOW()""",
            (data['source'],data['id'],key,data['origin'],active,json.dumps(data,ensure_ascii=False,allow_nan=False),fingerprint,data['updated_at']))
    return 'updated' if previous else 'created'


def annotate(conn,rows):
    if not rows:return
    keys=[r['conversation_key'] for r in rows]
    origins=conn.execute("SELECT p.conversation_key,p.origin,bool_or(p.active) AS active,bool_or(p.active AND p.imported_at>COALESCE(c.inbox_read_at,'-infinity'::timestamptz)) AS pending FROM inbox_prospect_sources p JOIN conversations c ON c.conversation_key=p.conversation_key WHERE p.conversation_key=ANY(%s) GROUP BY p.conversation_key,p.origin",(keys,)).fetchall()
    mapped={k:[] for k in keys}
    for r in origins:mapped[r['conversation_key']].append({'origin':r['origin'],'active':r['active'],'pending':r['pending']})
    for r in rows:
        r['prospect_origins']=mapped[r['conversation_key']]
        r['prospect_pending']=r['inbox_status']=='open' and not r.get('owner_id') and any(x['pending'] for x in r['prospect_origins'])


def detail(conn,key):
    return [dict(r['payload'],active=r['active']) for r in conn.execute('SELECT payload,active FROM inbox_prospect_sources WHERE conversation_key=%s ORDER BY active DESC,external_id DESC LIMIT 50',(key,)).fetchall()]


def sync(fetch=None):
    from .clients import post_wordpress
    fetch=fetch or post_wordpress
    number_id,config=sales_number()
    url=get_settings().wordpress_base_url.rstrip('/')+'/wp-json/fusion-chat/v1/prospects-export'
    totals={k:0 for k in ('created','updated','unchanged','ignored','invalid')}
    with connection() as conn:
        if not conn.execute('SELECT pg_try_advisory_lock(171721204) AS ok').fetchone()['ok']:return {'busy':True}
        for source in ('lead','cart'):
            state=conn.execute('SELECT setting_value FROM system_settings WHERE setting_key=%s',('prospects_sync:'+source,)).fetchone()
            old=(state or {}).get('setting_value') or {}
            try:since=(datetime.fromisoformat(old['through'])-timedelta(hours=2)).strftime('%Y-%m-%d %H:%M:%S')
            except (KeyError,ValueError,TypeError):since='1970-01-01 00:00:00'
            after=0;through=None;invalid_before=totals['invalid']
            for page in range(300):
                result=fetch(url,{'source':source,'since':since,'after':after,'limit':100})
                if not isinstance(result,dict) or result.get('ok') is not True or result.get('version')!=1 or not isinstance(result.get('rows'),list):raise ValueError('invalid_export')
                through=through or result.get('server_time')
                for record in result['rows']:
                    if record.get('source')!=source:raise ValueError('invalid_export_source')
                    try:totals[import_record(conn,record,number_id,str(config.get('label') or 'Ventas · 2035'))]+=1
                    except (ValueError,TypeError,OverflowError):totals['invalid']+=1
                cursor=result.get('after')
                if not result.get('more'):break
                if not isinstance(cursor,int) or cursor<=after:raise ValueError('stalled_export')
                after=cursor
            else:raise ValueError('export_page_limit')
            if not isinstance(through,str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}',through):raise ValueError('invalid_export_time')
            invalid=totals['invalid']-invalid_before
            conn.execute("INSERT INTO system_settings(setting_key,setting_value) VALUES(%s,%s::jsonb) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_at=NOW()",('prospects_sync:'+source,json.dumps({'through':through if not invalid else old.get('through','1970-01-01 00:00:00'),'checked_at':through,'ok':not invalid,'invalid':invalid})))
    return totals


if __name__=='__main__':
    try:print(json.dumps(sync()))
    except Exception as exc:
        # Never log customer content or signed transport headers.
        print(json.dumps({'ok':False,'error':type(exc).__name__}))
        raise SystemExit(1)
