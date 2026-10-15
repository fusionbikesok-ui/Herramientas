"""Conversation and audio share one allowance; images have their own."""
import json
from .storage import connection,get_system_setting
from .multimedia_config import read_config
from .ai_budget import usage

MODEL='gpt-6.1-sol'
DEFAULT={'enabled':False,'monthly_usd':0,'revision':0}
MONTH="date_trunc('month',NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'"
class SalesError(Exception):pass

def config():
    raw=get_system_setting('sales_openai',DEFAULT)
    return {**DEFAULT,**raw} if isinstance(raw,dict) else dict(DEFAULT)

def public_config():
    c=config()
    with connection() as conn:
        used=usage(conn)['conversation_audio']
    return {'ok':True,**c,'model':MODEL,'configured':bool(read_config()['key']),'used_usd':float(used)/1_000_000,'budget_scope':'conversation_audio'}

def save_config(payload):
    if type(payload.get('enabled')) is not bool or type(payload.get('monthly_usd')) is not int or not 0<=payload['monthly_usd']<=200:
        raise SalesError('sales_invalid_config')
    if payload['enabled'] and (not payload['monthly_usd'] or not read_config()['key']):raise SalesError('sales_setup_required')
    with connection() as conn,conn.transaction():
        conn.execute('SELECT pg_advisory_xact_lock(80261008)')
        row=conn.execute("SELECT setting_value FROM system_settings WHERE setting_key='sales_openai' FOR UPDATE").fetchone()
        old={**DEFAULT,**row['setting_value']} if row else DEFAULT
        if type(payload.get('revision')) is not int or payload['revision']!=old['revision']:raise SalesError('sales_config_changed')
        data={k:payload[k] for k in ['enabled','monthly_usd']};data['revision']=old['revision']+1
        conn.execute("INSERT INTO system_settings(setting_key,setting_value) VALUES('sales_openai',%s::jsonb) ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value,updated_at=NOW()",(json.dumps(data),))
    return public_config()

def reserve(message_id,key,step,microusd,revision):
    with connection() as conn,conn.transaction():
        conn.execute('SELECT pg_advisory_xact_lock(80261008)')
        row=conn.execute("SELECT setting_value FROM system_settings WHERE setting_key='sales_openai'").fetchone()
        c={**DEFAULT,**row['setting_value']} if row else DEFAULT
        if not c['enabled'] or c['revision']!=revision:raise SalesError('sales_cancelled')
        if conn.execute('SELECT 1 FROM sales_ai_calls WHERE message_id=%s AND step=%s',(message_id,step)).fetchone():raise SalesError('sales_already_attempted')
        used=usage(conn)['conversation_audio']
        if used+microusd>c['monthly_usd']*1_000_000:raise SalesError('sales_budget_reached')
        n=conn.execute("SELECT count(*) AS n FROM sales_ai_calls WHERE conversation_key=%s AND step=0 AND created_at>NOW()-INTERVAL '1 hour'",(key,)).fetchone()['n']
        if step==0 and n>=40:raise SalesError('sales_rate_limit')
        return conn.execute("INSERT INTO sales_ai_calls(message_id,conversation_key,step,state,reserved_microusd) VALUES(%s,%s,%s,'processing',%s) RETURNING id",(message_id,key,step,microusd)).fetchone()['id']

def settle(identifier,usage):
    if not isinstance(usage,dict) or any(type(usage.get(k)) is not int or usage[k]<0 for k in ['input_tokens','output_tokens']):return
    cost=max(1,usage['input_tokens']*2+usage['output_tokens']*10)
    with connection() as conn:conn.execute("UPDATE sales_ai_calls SET state='done',reserved_microusd=%s WHERE id=%s",(cost,identifier))

def fail(identifier):
    with connection() as conn:conn.execute("UPDATE sales_ai_calls SET state='failed' WHERE id=%s",(identifier,))
