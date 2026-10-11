"""Deterministic business FAQs, based only on a published configuration."""
import re
from decimal import Decimal, InvalidOperation
from .routing import normalize, explicit_handoff, is_combined_payment
from .ai import BotDecision

PAYMENTS={'transferencia':'transferencia','efectivo':'efectivo','mercadopago':'Mercado Pago','tarjeta':'tarjetas de crédito'}
TEXT_FIELDS={'address':200,'maps_url':500,'carrier':80,'shipping_exception':300,'weekday_hours':120,'saturday_hours':120,'sunday_hours':120,'assembly_info':600,'delivery_info':600}

def validate_business(value):
    if not isinstance(value,dict):raise ValueError('Información del negocio inválida.')
    result={'enabled':value.get('enabled') is True}
    for key,limit in TEXT_FIELDS.items():
        default='Las bicicletas se envían semiarmadas.' if key=='assembly_info' else ''
        text=str(value.get(key,default) or '').strip()
        if len(text)>limit:raise ValueError('Texto demasiado largo: '+key)
        if '<' in text or '>' in text:raise ValueError('Usá texto simple en la información del negocio.')
        result[key]=text
    if result['maps_url'] and not re.fullmatch(r'https://(?:maps\.app\.goo\.gl|maps\.google\.com|www\.google\.com|google\.com)/[^\s]*',result['maps_url']):
        raise ValueError('Usá un enlace HTTPS de Google Maps.')
    for key in ('shipping_fee','free_shipping_threshold'):
        text=str(value.get(key) or '').strip()
        if text:
            if not re.fullmatch(r'\d{1,9}(?:\.\d{1,2})?',text):raise ValueError('Ingresá importes sin separadores de miles: '+key)
            number=Decimal(text)
            if number<0 or (key=='free_shipping_threshold' and number==0):raise ValueError('Importe inválido: '+key)
        result[key]=text
    policy=value.get('threshold_equal','confirm')
    if policy not in {'confirm','paid','free'}:raise ValueError('Condición del límite inválida.')
    result['threshold_equal']=policy
    methods=value.get('payment_methods',[])
    if not isinstance(methods,list) or any(m not in PAYMENTS for m in methods):raise ValueError('Medios de pago inválidos.')
    result['payment_methods']=list(dict.fromkeys(methods))
    policy=value.get('credit_card_policy','all')
    if policy not in {'all','confirm'}:raise ValueError('Política de tarjetas inválida.')
    result['credit_card_policy']=policy
    result['pickup']=value.get('pickup') is True
    if result['enabled'] and bool(result['shipping_fee'])!=bool(result['free_shipping_threshold']):
        raise ValueError('Completá tanto el costo de envío como el umbral de envío gratis.')
    return result

def _money(raw):
    n=Decimal(raw)
    return '$'+format(n,',.0f' if n==n.to_integral_value() else ',.2f').replace(',','_').replace('.',',').replace('_','.')

def _body(row):return str(row.get('body') or row.get('content') or row.get('text') or '')
def _role(row):return str(row.get('sender') or row.get('role') or '')

def business_intent(text,history=None):
    v=normalize(text)
    if explicit_handoff(text) or is_combined_payment(text):return None
    if re.search(r'\b(?:pedido|seguimiento|tracking|reclamo|garantia|devolucion|rechazad[oa]|cvv|cvc|contrasena|pin)\b',v):return None
    shipping=bool(re.search(r'\b(?:envios?|enviar|envian|mandan|entregas?|despacho)\b',v))
    if shipping and re.search(r'\b(?:usd|dolares?|euros?)\b',v):return None
    if shipping:
        if re.search(r'\b(?:tarda|demora|plazo|dias|cuando|llega)\b',v):return None
        if re.search(r'\b(?:busco|buscando|tenes|tienen)\b',v) and not re.search(r'\b(?:cuanto|costo|sale|valor|cobran)\b',v):return None
        if re.search(r'\b(?:cuanto|costo|cuesta|sale|valor|precio|cobran|gratis)\b',v):return 'shipping_cost'
        if re.search(r'\b(?:hacen|envian|mandan|por donde|empresa|transporte|andreani)\b',v):return 'shipping_method'
    if re.search(r'\b(?:donde (?:estan|queda|quedan|se encuentran|estan ubicados)|ubicacion|direccion(?: del local)?|como llego)\b',v):return 'location'
    if re.search(r'\b(?:horarios?|a que hora (?:abren|cierran)|cuando (?:abren|cierran))\b',v):return 'hours'
    if re.search(r'\b(?:retiro|retirar|buscarlo)\b',v) and (re.search(r'\b(?:local|sucursal|tienda)\b',v) or re.fullmatch(r'[¿?¡!\s]*(?:y )?(?:para |puedo |se puede )?(?:retirar|retiro)[?.!\s]*',v)):return 'pickup'
    if re.search(r'\b(?:cuotas?|interes|financiar|financiacion|dolares?|usd|deposito|cbu|alias|comprobante)\b',v):return None
    if re.search(r'\b(?:como (?:pago|pagar|transfiero)|datos para (?:pagar|transferir))\b',v):return None
    if re.search(r'\b(?:aceptan|aceptas|reciben|medios de pago|formas de pago|puedo pagar|se puede pagar|puedo abonar|se puede abonar)\b',v):
        if re.search(r'\b(?:transferencias?|efectivo|mercado\s*pago|tarjetas?|medios de pago|formas de pago)\b',v):return 'payments'
    # Short follow-ups only when the immediately preceding reply made the topic explicit.
    rows=list(history or [])
    if rows and _role(rows[-1]) in {'customer','user'} and _body(rows[-1]).strip()==text.strip():rows.pop()
    if rows and _role(rows[-1]) in {'bot','assistant'}:
        prev=normalize(_body(rows[-1]))
        if 'horarios de atencion' in prev and re.fullmatch(r'[¿?¡!\s]*(?:y (?:el |los )?)?(?:lunes|martes|miercoles|jueves|viernes|sabados?|domingos?)[¿?.!\s]*',v):return 'hours'
        if 'el costo de envio' in prev and re.fullmatch(r'[¿?¡!\s]*(?:y )?(?:si (?:sale|cuesta|son|es)|para|por)\s*\$?\s*\d[\d.,\s]*(?:pesos)?[¿?.!\s]*',v):return 'shipping_cost'
    return None

def business_decision(text,history,business):
    if not business or not business.get('enabled'):return None
    kind=business_intent(text,history)
    if not kind:return None
    b=business;v=normalize(text);reply=''
    if kind=='shipping_cost':
        if not b.get('shipping_fee') or not b.get('free_shipping_threshold'):return None
        fee=_money(b['shipping_fee']);threshold=_money(b['free_shipping_threshold'])
        # Any amount mentioned by the customer is conditional, not a verified order quote.
        raw_amounts=re.findall(r'(?<!\w)\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|(?<!\w)\d{4,}(?:[.,]\d{1,2})?',v)
        at_limit=False
        for raw in raw_amounts:
            value=raw.replace('.','').replace(',','.') if re.fullmatch(r'\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?',raw) else raw.replace(',','.')
            try:at_limit=at_limit or Decimal(value)==Decimal(b['free_shipping_threshold'])
            except InvalidOperation:pass
        if at_limit:
            if b['threshold_equal']=='confirm':reply='Para un importe de exactamente '+threshold+', el costo de envío necesita confirmación de un asesor.'
            elif b['threshold_equal']=='paid':reply='Si el importe es exactamente '+threshold+', el costo de envío es '+fee+'.'
            else:reply='Si el importe es exactamente '+threshold+', el envío es gratis, sujeto a las condiciones aplicables.'
        else:
            paid_limit='hasta '+threshold+' inclusive' if b['threshold_equal']=='paid' else 'menos de '+threshold
            free_limit='desde '+threshold+' inclusive' if b['threshold_equal']=='free' else 'superiores a '+threshold
            reply='El costo de envío es '+fee+' para productos de '+paid_limit+'. En compras '+free_limit+', el envío es gratis cuando se cumplen las condiciones aplicables.'
        if b.get('shipping_exception'):reply+=' '+b['shipping_exception']
        reply+=' Las condiciones verificadas del pedido tienen prioridad.'
    elif kind=='location':
        if not b.get('address'):return None
        reply='Estamos en '+b['address'].rstrip('.')+'.'
        if b.get('maps_url'):reply+='\n'+b['maps_url']
    elif kind=='hours':
        weekday=bool(re.search(r'\b(?:lunes|martes|miercoles|jueves|viernes)\b',v))
        saturday=bool(re.search(r'\bsabados?\b',v));sunday=bool(re.search(r'\bdomingos?\b',v))
        selected=[]
        for label,key,wanted in [('Lunes a viernes','weekday_hours',weekday),('Sábados','saturday_hours',saturday),('Domingos','sunday_hours',sunday)]:
            if (wanted or not any((weekday,saturday,sunday))) and b.get(key):selected.append(label+': '+b[key])
        if not selected:reply='No tengo confirmado ese horario. Necesitamos que un asesor lo revise.'
        else:reply='Horarios de atención:\n'+'\n'.join(selected)
        if re.search(r'\b(?:feriado|feriados|hoy|ahora)\b',v):reply+='\nNo tengo confirmadas excepciones por feriados ni la apertura en este momento.'
    elif kind=='shipping_method':
        if not b.get('carrier'):return None
        reply='Enviamos por '+b['carrier']+'.'
        if b.get('pickup'):reply+=' También podés retirar en sucursal.'
    elif kind=='pickup':
        if not b.get('pickup'):return None
        reply='Sí, podés retirar en sucursal.'
        if b.get('address'):reply+=' Estamos en '+b['address'].rstrip('.')+'.'
        reply+=' La preparación del pedido debe estar confirmada antes de retirarlo.'
    elif kind=='payments':
        if not b.get('payment_methods'):return None
        methods=b['payment_methods'];requested=[]
        for name,pattern in [('transferencia',r'\btransferencias?\b'),('efectivo',r'\befectivo\b'),('mercadopago',r'\bmercado\s*pago\b'),('tarjeta',r'\btarjetas?\b')]:
            if re.search(pattern,v):requested.append(name)
        if re.search(r'\b(?:debito|cheques?|cripto|bitcoin|paypal)\b',v):return None
        if requested and any(m not in methods for m in requested):reply='No tengo confirmado ese medio de pago. Necesitamos que un asesor lo revise.'
        else:reply=('Sí, aceptamos ' if requested else 'Aceptamos ')+', '.join(PAYMENTS[m] for m in (requested or methods))+'.'
    if not reply:return None
    # Greet only when the customer greets and there has been no prior assistant response.
    if not any(_role(r) in {'bot','assistant','agent','human'} for r in history or []) and re.search(r'\b(?:hola|buen dia|buenas)\b',v):reply='¡Hola! '+reply
    return BotDecision(reply,False,'ventas','Información del negocio verificada','normal'),[]
