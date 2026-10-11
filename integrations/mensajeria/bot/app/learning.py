"""Validated, versioned corrections; no catalog values or executable expressions."""
import copy
import hashlib
import json
import re
from datetime import datetime, timezone
from .routing import normalize, explicit_handoff, is_combined_payment, is_general_payment_question

KEY='conversation_learning_v1'
EMPTY={'rules':[]}

def canonical(text):
    return ' '.join(re.findall(r'\w+',normalize(str(text))))

def clean(value):
    if not isinstance(value,dict) or not isinstance(value.get('rules'),list):
        raise ValueError('Se necesita una lista de correcciones.')
    if len(value['rules'])>200:raise ValueError('Máximo 200 correcciones por versión.')
    rules=[];seen=set();ids=set()
    for raw in value['rules']:
        if not isinstance(raw,dict):raise ValueError('Corrección inválida.')
        row={k:str(raw.get(k) or '').strip() for k in ('id','kind','source','target','example','expected','note')}
        if row['kind'] not in {'alias','search','ask','handoff'}:raise ValueError('Acción no permitida.')
        if not re.fullmatch(r'[a-zA-Z0-9_-]{1,60}',row['id']) or row['id'] in ids:raise ValueError('Identificador repetido o inválido.')
        ids.add(row['id'])
        for k in ('source','target','example','expected','note'):
            if len(row[k])>1000:raise ValueError('Texto demasiado largo: '+k)
        source=canonical(row['source'])
        if not source:raise ValueError('Completá la pregunta o palabra a corregir.')
        identity=(row['kind']=='alias',source)
        if identity in seen:raise ValueError('Hay dos correcciones para la misma consulta.')
        seen.add(identity)
        if row['kind']!='handoff' and not row['target']:raise ValueError('Completá la interpretación o pregunta.')
        if row['kind']=='alias':
            if len(source.split())>5 or len(canonical(row['target']).split())>5:raise ValueError('Una equivalencia admite hasta cinco palabras.')
            if source==canonical(row['target']):raise ValueError('La equivalencia no cambia el texto.')
        if row['kind']=='ask':
            # Asking for a datum cannot override protected payment collection or commercial facts.
            if not row['target'].endswith('?') or row['target'].count('?')!=1:
                raise ValueError('Escribí una sola pregunta terminada en ?. ')
            if re.search(r'\b(?:tarjeta|cvv|cvc|pin|clave|contrasena|codigo|cuenta|cbu|cuit|dni|vencimiento|stock|precio|cuotas|reserva)\b|\$|https?://',canonical(row['target'])):
                raise ValueError('Esta pregunta necesita un flujo protegido, no una regla personalizada.')
        row['enabled']=raw.get('enabled',True) is True
        rules.append(row)
    result={'rules':rules}
    if 'business' in value:
        from .business_info import validate_business
        result['business']=validate_business(value['business'])
    return result

def fingerprint(config):
    return hashlib.sha256(json.dumps(clean(config),sort_keys=True,ensure_ascii=False).encode()).hexdigest()

def protected(text):
    return explicit_handoff(text) or is_combined_payment(text) or is_general_payment_question(text) or bool(re.search(r'\b(?:reclamo|garantia|devolucion|pago|pagar|tarjeta|transferencia|pedido|cvv|contrasena)\b',canonical(text)))

def interpret(text, config):
    if protected(text):return text,None
    rules=[r for r in config['rules'] if r['enabled']]
    # Explicit question corrections take precedence, not approximate automatic matching.
    for r in rules:
        if r['kind']!='alias' and canonical(text)==canonical(r['source']):
            return (r['target'] if r['kind']=='search' else text),r
    aliases=sorted((r for r in rules if r['kind']=='alias'),key=lambda r:-len(canonical(r['source'])))
    if not aliases:return text,None
    value=normalize(text)
    mapping={canonical(r['source']):r['target'] for r in aliases}
    pattern=r'\b(?:'+ '|'.join(re.escape(k).replace(r'\ ',r'\s+') for k in mapping)+r')\b'
    result=re.sub(pattern,lambda m:mapping[canonical(m.group())],value)
    return result,None

def transform_history(history,config):
    rows=[]
    for row in history or []:
        row=dict(row)
        if str(row.get('sender') or row.get('role') or '') in {'customer','user'}:
            for key in ('body','content','text'):
                if key in row:row[key]=interpret(str(row[key]),config)[0]
        rows.append(row)
    return rows

def initial():
    return {'revision':0,'draft':copy.deepcopy(EMPTY),'active':copy.deepcopy(EMPTY),'versions':[], 'tested':None}

def get_state():
    from .storage import get_system_setting
    return get_system_setting(KEY,None) or initial()

def active_config():
    return get_state()['active']

def transition(state, op, payload):
    state=copy.deepcopy(state)
    if payload.get('revision')!=state['revision']:raise ValueError('Otra edición cambió la versión. Recargá antes de continuar.')
    if op=='save':
        config=payload.get('config')
        if isinstance(config,dict) and 'business' not in config and 'business' in state['draft']:
            config=dict(config,business=state['draft']['business'])
        state['draft']=clean(config);state['tested']=None
    elif op=='tested':
        if fingerprint(state['draft'])!=payload.get('fingerprint'):raise ValueError('Cambió el borrador durante la prueba.')
        state['tested']=payload['fingerprint']
    elif op=='publish':
        if state['tested']!=fingerprint(state['draft']):raise ValueError('Probá el borrador actual antes de publicar.')
        state['versions'].append({'revision':state['revision'],'config':state['active'],'at':datetime.now(timezone.utc).isoformat(),'by':str(payload.get('by') or '')[:100]})
        state['versions']=state['versions'][-20:];state['active']=copy.deepcopy(state['draft'])
    elif op=='restore':
        old=next((v for v in state['versions'] if v['revision']==payload.get('version')),None)
        if old is None:raise ValueError('Versión no encontrada.')
        # Restore as draft so current production stays active until tested and published.
        state['draft']=copy.deepcopy(old['config']);state['tested']=None
    else:raise ValueError('Acción desconocida.')
    state['revision']+=1
    return state

def mutate(op,payload):
    from .storage import connection
    with connection() as conn, conn.transaction():
        conn.execute('SELECT pg_advisory_xact_lock(68168169)')
        row=conn.execute('SELECT setting_value FROM system_settings WHERE setting_key=%s',(KEY,)).fetchone()
        state=transition(row['setting_value'] if row else initial(),op,payload)
        conn.execute('INSERT INTO system_settings(setting_key,setting_value) VALUES (%s,%s::jsonb) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_at=NOW()',(KEY,json.dumps(state,ensure_ascii=False)))
    return state
