"""Tracking lookup bound to the authenticated WhatsApp sender and a single order."""
import re
from .ai import BotDecision
from .routing import normalize,explicit_handoff
from .inquiry_flow import previous,role,body
from .invoice_flow import _get,lookup_allowed,InvoiceUnavailable
from .order_flow import before_purchase,ASK_ORDER

PROMPT='Pasame el número de pedido de tu compra para buscar el seguimiento del envío.'
BASE='https://www.andreani.com/envio/'

def retrieve_tracking(order_id,phone):
    data=_get(order_id,phone)
    if 'tracking' not in data:raise InvoiceUnavailable('tracking_contract')
    tracking=data['tracking']
    if tracking is None:return None
    if not isinstance(tracking,dict) or tracking.get('carrier')!='Andreani':raise InvoiceUnavailable('tracking_carrier')
    code=tracking.get('number')
    if not isinstance(code,str) or not re.fullmatch(r'[A-Za-z0-9-]{5,64}',code):raise InvoiceUnavailable('tracking_code')
    return code,BASE+code

def tracking_decision(text,history,conversation,key):
    value=normalize(text).strip()
    if explicit_handoff(text) or before_purchase(text):return None
    if re.search(r'\b(?:facturas?|garantia|devolucion|cancelar|cancelado|reembolso|reclamo|roto|danado)\b',value):return None
    if re.search(r'\b(?:cbu|cvu|alias|pagar|pago|abonar|cuotas?|tarjetas?|transferir|transferencia)\b',value):return None
    last=next((body(r) for r in reversed(previous(history,text)) if role(r) in {'bot','assistant'}),'')
    pending=PROMPT in last or last==ASK_ORDER
    requested=bool(re.search(r'\b(?:seguimiento|tracking|rastrear|rastreo|(?:numero|codigo) de (?:guia|envio))\b',value))
    requested=requested or bool(re.search(r'\b(?:pedido|orden|compra|compre|envio)\b',value) and re.search(r'\b(?:estado|donde|cuando|llega|llego|tarda|despacho|despacharon|recibi)\b',value))
    if not requested and not pending:return None
    if pending and not requested and re.search(r'\b(?:pagar|pago|cuotas|precio|stock|busco|talle|color|horario|direccion)\b',value):return None
    def answer(reply,handoff=False):return BotDecision(reply,handoff,'posventa_taller','Consulta de seguimiento','normal')
    if pending and re.search(r'\b(?:no (?:lo )?(?:tengo|se|recuerdo)|no encuentro|perdi|no (?:tengo|encuentro) el (?:numero|pedido))\b',value):
        return answer('Un asesor de posventa te ayuda a identificar el pedido y consultar el envío.',True)
    if pending and re.fullmatch(r'no(?: gracias| por ahora)?[.! ]*',value):return answer('De acuerdo. Cuando tengas el número de pedido, podés volver a consultar el seguimiento.')
    ids=re.findall(r'\b(?:pedido|orden|compra)\s*(?:(?:numero|nro|num|n[°ºo.]|es el|es|el)\s*)?[:#-]?\s*([1-9][0-9]{0,8})\b(?![.,][0-9])',value)
    ids+=re.findall(r'#\s*([1-9][0-9]{0,8})\b(?![.,][0-9])',value)
    if pending and re.fullmatch(r'(?:es\s+(?:el\s+)?)?#?\s*[1-9][0-9]{0,8}[ .!]*',value):ids+=re.findall(r'[1-9][0-9]{0,8}',value)
    ids=list(dict.fromkeys(ids))
    explicit_reference=bool(re.search(r'#|\b(?:pedido|orden|compra)\s+\S',value))
    if not ids and requested and not explicit_reference and not re.search(r'\d|\b(?:otro|otra|nuevo|nueva)\b',value):
        # Only the last actual answer can supply context; never older orders.
        found=re.match(r'(?:Te comparto la factura del pedido|Seguimiento del pedido) #([1-9][0-9]{0,8})[.\n]',last)
        if found:ids=[found[1]]
    if len(ids)!=1:
        if pending and not requested and not ids and not re.fullmatch(r'[\d\s#+().-]+',value):return None
        return answer(PROMPT+' Lo encontrás en el correo de confirmación. Enviame un solo número.')
    order_id=int(ids[0]);phone=str(conversation.get('external_user_id') or '')
    if conversation.get('channel')!='whatsapp' or not re.fullmatch(r'[1-9][0-9]{7,14}',phone):
        return answer(f'Dejo el pedido #{order_id} a posventa para verificar tu identidad y consultar el seguimiento.',True)
    try:
        if not lookup_allowed(key,phone,order_id,purpose='tracking'):
            return answer('Un asesor va a continuar la consulta de tus envíos.',True)
        tracking=retrieve_tracking(order_id,phone)
    except Exception:
        return answer(f'No pude verificar el seguimiento del pedido #{order_id} para este WhatsApp. Un asesor de posventa lo revisa.',True)
    if tracking is None:
        return answer(f'El pedido #{order_id} todavía no tiene un número de seguimiento cargado. Podés volver a consultarlo más adelante; si necesitás ayuda, pedime hablar con un asesor.')
    code,url=tracking
    return answer(f'Seguimiento del pedido #{order_id}\n🚚 Andreani\nNúmero de seguimiento: {code}\n{url}\n\nEn ese enlace podés consultar los movimientos actualizados del envío.')
