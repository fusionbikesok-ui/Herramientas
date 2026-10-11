"""Post-sale dialogue, isolated from product search and pre-purchase shipping."""
import re
from .ai import BotDecision
from .routing import normalize, explicit_handoff

ASK_ORDER='Para consultar el estado y seguimiento, ¿cuál es el número de pedido?'
ASK_EMAIL='¿Qué email usaste al hacer la compra?'
RETRY='No pude validar el pedido con esos datos. ¿Podés revisar el número de pedido y el email de compra?'
OFFER='¿Querés que lo revise un asesor de posventa?'
STATES={'pending':'Pendiente de pago','on-hold':'En espera','processing':'En proceso',
        'completed':'Completado','cancelled':'Cancelado','refunded':'Reembolsado','failed':'Fallido'}


def body(row):return str(row.get('body') or row.get('text') or row.get('content') or '')
def role(row):return str(row.get('sender') or row.get('role') or '')
def answer(text,handoff=False,reason='Consulta de pedido'):
    return BotDecision(text,handoff,'posventa_taller',reason,'normal'),[]


def before_purchase(text):
    return bool(re.search(r'\b(?:todavia no|aun no|no (?:compre|compramos|hice (?:el|un) pedido)|antes de comprar|sin haber comprado)\b',normalize(text)))


def order_number(text, bare=False):
    value=normalize(text)
    match=re.search(r'\b(?:pedido|orden|compra)\s*(?:(?:numero|nro|num|n[°ºo.]|es el|es|el)\s*)?[:#.-]?\s*([1-9]\d{0,17})(?!\d)',value)
    if not match:match=re.search(r'(?<!\w)#([1-9]\d{0,17})(?!\d)',value)
    if not match and bare:match=re.fullmatch(r'\s*(?:es (?:el )?)?#?([1-9]\d{0,17})[.!\s]*',value)
    if not match and bare and email_in(text) and not re.search(r'\b(?:cp|codigo postal)\b',value):
        match=re.match(r'\s*(?:es (?:el )?)?#?([1-9]\d{0,17})(?=[,;\s])',value)
    return match[1] if match else None


def email_in(text):
    values=re.findall(r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}",text)
    values=list(dict.fromkeys(x.rstrip('.,;:').lower() for x in values))
    return values[0] if len(values)==1 and len(values[0])<=254 else None


def order_intent(text):
    v=normalize(text)
    if before_purchase(text):return False
    if re.search(r'\b(?:factura|garantia|devolucion|cancelar|reembolso)\b',v):return False
    tracking=bool(re.search(r'\b(?:seguimiento|tracking|rastrear|rastreo|mi pedido|mi compra|mi envio|estado (?:del|de mi) pedido)\b',v))
    bought=bool(re.search(r'\b(?:compre|compramos|ya compre|hice (?:una compra|un pedido)|compra realizada|realice (?:la compra|un pedido))\b',v))
    shipping=bool(re.search(r'\b(?:envi|entrega|despach|llega|llego|recibi|demora|estado)\w*\b',v))
    return tracking or bool(order_number(text)) or bought and shipping


def is_flow_reply(text):
    return text==ASK_ORDER or text==RETRY or (text.startswith('Para consultar el pedido #') and ASK_EMAIL in text) or text.startswith('Pedido #') or text.endswith(OFFER)


def flow_context(rows):
    """Only reuse credentials from the current uninterrupted order dialogue."""
    start=0
    for i,row in enumerate(rows):
        if role(row) in {'bot','assistant'} and not is_flow_reply(body(row)):start=i+1
    chain=rows[start:];number=None;email=None;last=''
    for row in chain:
        if role(row) in {'bot','assistant'}:last=body(row);continue
        if role(row) not in {'customer','user'}:continue
        given=order_number(body(row),last==ASK_ORDER)
        if given:
            if number and number!=given:email=None
            number=given
        supplied=email_in(body(row))
        if supplied:email=supplied
    return number,email,chain


def order_decision(text,history):
    rows=list(history or [])
    if rows and role(rows[-1]) in {'customer','user'} and body(rows[-1]).strip()==text.strip():rows.pop()
    last=next((body(row) for row in reversed(rows) if role(row) in {'bot','assistant'}),'')
    value=normalize(text);choice=' '.join(re.findall(r'\w+',value))
    active=is_flow_reply(last)
    if last.endswith(OFFER):
        if choice in {'si','si por favor','si gracias','dale','ok','por favor'}:
            return answer('Te derivo a posventa para revisar el pedido con los datos que ya nos pasaste.',True,'Cliente solicita revisión de pedido')
        if choice in {'no','no gracias','no por ahora'}:return answer('De acuerdo. Si necesitás volver a consultar el seguimiento, avisame.')
    if before_purchase(text):return None
    delay_complaint=bool(re.search(r'\b(?:no llego|no recibi)\b',value)) and not re.search(r'\b(?:humano|asesor|persona|operador|agente|reclamo|estafa|denuncia)\b',value)
    if explicit_handoff(text) and not delay_complaint:
        return answer('Te derivo a posventa para continuar con tu consulta.',True) if active or order_intent(text) else None
    if re.search(r'\b(?:factura|garantia|devolucion|cancelar|reembolso)\b',value):return None
    initial=order_intent(text)
    if re.search(r'\b(?:ya compre|ya hice (?:la compra|el pedido))\b',value) and any(cue in normalize(last) for cue in ['envio','compra ya realizada']):initial=True
    waiting=last in {ASK_ORDER,RETRY} or (last.startswith('Para consultar el pedido #') and ASK_EMAIL in last)
    follow=active and bool(re.search(r'\b(?:cuando|llega|llego|demora|despacho|actualiz|seguimiento|estado|no recibi)\w*\b',value))
    if not (initial or waiting or follow):return None
    # A new unrelated question leaves the credential collection flow.
    if waiting and not initial and not email_in(text) and not order_number(text,last==ASK_ORDER):
        if re.search(r'\b(?:talle|equipamiento|componentes|precio|costo|cuanto sale|horario|direccion|busco|bicicleta)\b',value):return None
    if re.search(r'\b(?:no (?:tengo|recuerdo|encuentro|se)|no quiero (?:dar|pasar)|prefiero no|me olvide|no lo tengo|compre en (?:el local|mercado libre|mercadolibre))\b',value):
        return answer('Un asesor de posventa te ayuda a ubicar la compra. Te derivo con la información que ya nos pasaste.',True,'Pedido requiere búsqueda manual')
    number,email,chain=flow_context(rows) if active else (None,None,[])
    current=order_number(text,last==ASK_ORDER)
    if current:
        if number and current!=number:email=None
        number=current
    email=email_in(text) or email
    if not number:return answer(ASK_ORDER)
    if not email:return answer('Para consultar el pedido #'+number+', '+ASK_EMAIL[0].lower()+ASK_EMAIL[1:])
    from .order_status import fetch_order_status
    try:detail=fetch_order_status(number,email)
    except Exception:
        return answer('No pude consultar el sistema de pedidos en este momento. Te derivo a posventa con los datos que ya nos pasaste.',True,'Consulta de pedidos no disponible')
    if detail is None:
        if any(body(row)==RETRY for row in chain if role(row) in {'bot','assistant'}):
            return answer('No pude validar el pedido con los datos enviados. Te derivo a posventa para que lo revisen.',True,'Validación de pedido requiere asesor')
        return answer(RETRY,reason='Revisar datos del pedido')
    status=detail['status'];label=STATES.get(status,'Requiere revisión de posventa')
    reply='Pedido #'+number+' · Estado registrado: '+label+'.'
    if detail['tracking_url']:
        reply+='\n\nSeguimiento de Andreani:\n'+detail['tracking_url']+'\nEn ese enlace podés consultar los movimientos actualizados del envío.'
    else:reply+='\n\nTodavía no hay un código de seguimiento cargado en el pedido.'
    complaint=any(re.search(r'\b(?:no llego|no recibi|figura entregado|figura como entregado|llego roto|llego danado|demora excesiva)\b',normalize(body(row))) for row in chain+[{'sender':'customer','body':text}] if role(row) in {'customer','user'})
    if complaint or status in {'cancelled','refunded','failed'} or status not in STATES:
        return answer(reply+'\n\nTe derivo a posventa para revisar tu consulta.',True,'Revisión de pedido en posventa')
    return answer(reply+'\n\n'+OFFER,reason='Estado y seguimiento verificados')
