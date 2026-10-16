"""Recover an existing invoice using the authenticated WhatsApp sender only."""
from __future__ import annotations
import base64,hashlib,json,os,re
from dataclasses import dataclass,field
from urllib.parse import urlsplit
import httpx
from .ai import BotDecision
from .routing import normalize,explicit_handoff
from .inquiry_flow import previous,role,body
from .inbox_media import validate_media

PROMPT='Pasame el número de pedido de tu compra para buscar la factura emitida.'
MAX_PDF=8*1024*1024
class InvoiceUnavailable(ValueError):pass

@dataclass(frozen=True)
class InvoiceAttachment:
    order_id:int
    invoice_id:int
    recipient:str
    name:str
    content:bytes=field(repr=False)

@dataclass(frozen=True)
class InvoiceDecision(BotDecision):
    invoice_attachment:InvoiceAttachment|None=field(default=None,repr=False)
    invoice_order:int|None=None

def positive_id(value):
    return type(value) is int and 0<value<10**15

def _get(order_id,phone,invoice_id=None):
    if not positive_id(order_id) or invoice_id is not None and not positive_id(invoice_id):raise InvoiceUnavailable('identity')
    if not re.fullmatch(r'[1-9][0-9]{7,14}',phone):raise InvoiceUnavailable('phone')
    u=urlsplit(os.getenv('BOT_COMMERCE_WOO_URL',''))
    if u.scheme!='https' or u.hostname not in {'fusionbikes.com.ar','www.fusionbikes.com.ar'} or u.port or u.username or u.password or u.query or u.fragment:raise InvoiceUnavailable('configuration')
    ck=os.getenv('BOT_COMMERCE_WOO_CK','');cs=os.getenv('BOT_COMMERCE_WOO_CS','')
    if not ck or not cs:raise InvoiceUnavailable('configuration')
    path=f'/wp-json/wc/v3/fusion-herramientas/messaging-orders/{order_id}'
    if invoice_id is not None:path+=f'/invoices/{invoice_id}/pdf'
    limit=12*1024*1024 if invoice_id is not None else 1024*1024
    with httpx.Client(timeout=12,follow_redirects=False) as client:
        with client.stream('GET',f'https://{u.hostname}'+path,headers={'Accept':'application/json','X-Fusion-Contact-Phone':'+'+phone},auth=(ck,cs)) as response:
            if response.status_code!=200:raise InvoiceUnavailable('unavailable')
            if int(response.headers.get('content-length') or 0)>limit:raise InvoiceUnavailable('size')
            data=bytearray()
            for chunk in response.iter_bytes():
                data.extend(chunk)
                if len(data)>limit:raise InvoiceUnavailable('size')
    result=json.loads(data)
    if not isinstance(result,dict) or result.get('schema')!=1 or result.get('read_only') is not True or type(result.get('order_id')) is not int or result['order_id']!=order_id:raise InvoiceUnavailable('identity')
    return result

def authorized(row,order_id):
    return (isinstance(row,dict) and positive_id(row.get('id')) and type(row.get('order_id')) is int and row['order_id']==order_id
            and row.get('status')=='authorized' and row.get('environment')=='production' and type(row.get('type')) is int and row['type'] in {1,6})

def retrieve(order_id,phone):
    listing=_get(order_id,phone)
    rows=listing.get('invoices')
    # Do not guess which document supersedes another, including credit notes.
    if not isinstance(rows,list) or len(rows)!=1 or listing.get('has_more') is not False or not authorized(rows[0],order_id):raise InvoiceUnavailable('selection')
    invoice_id=rows[0]['id'];document=_get(order_id,phone,invoice_id)
    row=document.get('invoice')
    if type(document.get('invoice_id')) is not int or document['invoice_id']!=invoice_id or not authorized(row,order_id) or row['id']!=invoice_id or document.get('mime')!='application/pdf':raise InvoiceUnavailable('identity')
    encoded=document.get('data_base64')
    if not isinstance(encoded,str) or len(encoded)>((MAX_PDF+2)//3)*4:raise InvoiceUnavailable('size')
    content=base64.b64decode(encoded,validate=True)
    if not 16<=len(content)<=MAX_PDF or type(document.get('size')) is not int or document['size']!=len(content) or hashlib.sha256(content).hexdigest()!=document.get('sha256'):raise InvoiceUnavailable('pdf')
    _,name,_=validate_media(content,'application/pdf',str(document.get('filename') or f'Factura-pedido-{order_id}.pdf'))
    return InvoiceAttachment(order_id,invoice_id,phone,name,content)

def lookup_allowed(key,phone,order_id,*,purpose='invoice'):
    if purpose not in {'invoice','tracking'}:raise InvoiceUnavailable('lookup_purpose')
    action=purpose+'_lookup'
    from .storage import connection
    from .inbox import lock_thread,ai_allowed,audit
    with connection() as conn,conn.transaction():
        lock_thread(conn,key)
        row=conn.execute('SELECT * FROM conversations WHERE conversation_key=%s FOR UPDATE',(key,)).fetchone()
        if not row or row['channel']!='whatsapp' or row['external_user_id']!=phone or not ai_allowed(conn,row):return False
        count=conn.execute("SELECT count(*) AS n FROM inbox_audit WHERE conversation_key=%s AND action=%s AND created_at>NOW()-INTERVAL '1 hour'",(key,action)).fetchone()['n']
        if count>=3:return False
        audit(conn,key,{'id':'system:fabri','name':'Matías IA'},action,{'order_id':order_id})
    return True

def invoice_decision(text,history,conversation,key):
    value=normalize(text).strip()
    if explicit_handoff(text):return None
    last=next((body(r) for r in reversed(previous(history,text)) if role(r) in {'bot','assistant'}),'')
    pending=PROMPT in last
    requested=bool(re.search(r'\bfacturas?\b',value))
    pre_purchase=bool(re.search(r'\b(?:hacen|emiten|haces|emitis|tipo de factura|antes de comprar|pueden facturar)\b',value))
    if requested and pre_purchase:return None
    if not requested and not pending:return None
    if pending and not requested and re.search(r'\b(?:envio|seguimiento|tracking|estado|pagar|pago|cuotas|precio|stock|busco|talle|color)\b',value):return None
    def answer(reply,handoff=False,order=None,attachment=None):
        return InvoiceDecision(reply,handoff,'posventa_taller','Recuperación de factura','normal',invoice_attachment=attachment,invoice_order=order)
    if pending and re.search(r'\b(?:no (?:lo )?(?:tengo|se|recuerdo)|no encuentro|perdi|no (?:tengo|encuentro) el (?:numero|pedido))\b',value):
        return answer('Un asesor de posventa te ayuda a identificar el pedido y recuperar la factura.',True)
    ids=re.findall(r'\b(?:pedido|orden|compra)\s*(?:(?:numero|nro|n[°ºo.]|es|numero es)\s*)?[:#-]?\s*([1-9][0-9]{0,8})\b',value)
    if requested or pending:ids+=re.findall(r'#\s*([1-9][0-9]{0,8})\b',value)
    if pending and re.fullmatch(r'(?:es\s+)?#?\s*[1-9][0-9]{0,8}[ .!]*',value):ids+=re.findall(r'[1-9][0-9]{0,8}',value)
    ids=list(dict.fromkeys(ids))
    if len(ids)!=1:
        if pending and not requested and not ids and not re.fullmatch(r'[\d\s#+().-]+',value):return None
        return answer(PROMPT+' Lo encontrás en el correo de confirmación de la compra. Enviame un solo número, por ejemplo: 70704.')
    order_id=int(ids[0]);channel=conversation.get('channel')
    phone=str(conversation.get('external_user_id') or '')
    if channel!='whatsapp' or not re.fullmatch(r'[1-9][0-9]{7,14}',phone):
        return answer(f'Dejo el pedido #{order_id} a posventa para verificar tu identidad y recuperar la factura.',True,order_id)
    try:
        if not lookup_allowed(key,phone,order_id):return answer('Un asesor va a continuar la búsqueda de tus comprobantes.',True,order_id)
        attachment=retrieve(order_id,phone)
    except Exception:
        return answer(f'No pude recuperar automáticamente una única factura emitida para el pedido #{order_id} y este WhatsApp. Un asesor de posventa lo revisa.',True,order_id)
    return answer(f'Te comparto la factura del pedido #{order_id}.',order=order_id,attachment=attachment)

def queue_invoice(conn,row,decision):
    """Called under the existing thread/revision lock; no network or sending here."""
    attachment=getattr(decision,'invoice_attachment',None)
    if attachment is None:return None
    if not isinstance(attachment,InvoiceAttachment) or row.get('channel')!='whatsapp' or row.get('external_user_id')!=attachment.recipient or not positive_id(attachment.order_id) or not positive_id(attachment.invoice_id):raise InvoiceUnavailable('recipient_changed')
    if not 16<=len(attachment.content)<=MAX_PDF:raise InvoiceUnavailable('size')
    mime,name,kind=validate_media(attachment.content,'application/pdf',attachment.name)
    import uuid
    media_id=str(uuid.uuid4())
    conn.execute('INSERT INTO inbox_media(id,conversation_key,actor_id,name,mime,kind,content,number_id,size,is_voice) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,FALSE)',
                 (media_id,row['conversation_key'],'system:fabri',name,mime,kind,attachment.content,row['channel_number_id'],len(attachment.content)))
    return media_id
