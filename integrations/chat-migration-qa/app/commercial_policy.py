"""Commercial facts confirmed by Fusion Bikes, before probabilistic answers.

Credit-card acceptance does not establish a financing plan. The owner can change
the policy through the published business configuration in WooCommerce.
"""
import re
from .ai import BotDecision
from .routing import normalize, explicit_handoff, is_combined_payment

CARD = r'\b(?:tarjetas?|credito|naranja(?:\s*x)?|visa|master\s*card|mastercard|amex|american express|cabal|cordobesa)\b'
FINANCE = r'\b(?:cuotas?|financiar\w*|financiacion|interes(?:es)?|recargos?|una sola vez|un pago)\b'


def body(row):
    return str(row.get('body') or row.get('text') or row.get('content') or '')


def commercial_decision(text, history, business=None):
    value=normalize(text)
    if explicit_handoff(text) and not is_combined_payment(text):return None
    rows=list(history or [])
    if rows and str(rows[-1].get('sender') or rows[-1].get('role')) in {'customer','user'} and body(rows[-1]).strip()==text.strip():rows.pop()
    last=next((normalize(body(r)) for r in reversed(rows) if str(r.get('sender') or r.get('role')) in {'bot','assistant'}),'')
    plain=' '.join(re.findall(r'\w+',value))
    # A card name as a short answer is financial only in a payment conversation.
    follow=bool(re.fullmatch(CARD,plain) and re.search(r'\b(?:pago|pagar|tarjeta|tarjetas|credito|cuotas)\b',last))
    acceptance=bool(re.match(r'^tarjeta(?: de credito)?\b',plain)) or bool(re.search(r'\b(?:acept\w*|trabaj\w*|recib\w*|tenes|tienen|pagar|abonar|pago|usan|medios de pago|formas de pago)\b',value))
    finance=bool(re.search(FINANCE,value))
    card=bool(re.search(CARD,value))
    # Never mistake orange clothing/parts for the Naranja payment brand.
    if re.search(r'\b(?:lentes?|guantes?|bicicletas?|cascos?|calzas?|punos?)\b',value) and not re.search(r'\b(?:tarjetas?|credito|pagar|abonar|cuotas?)\b',value):return None
    if not card or not (acceptance or finance or follow):return None
    if re.search(r'\b(?:debito|prepaga|prepagas|cript\w*|rechaz\w*|error|no (?:me )?(?:anda|funciona)|cobraron|comprobante|cvv|cvc|pin|vencimiento|numero de tarjeta)\b',value):return None
    if is_combined_payment(text):return None
    if re.search(r'\b(?:euros?|usd|dolares?)\b',value):return None
    policy=(business or {}).get('credit_card_policy','all')
    if policy=='all':
        reply='Sí, aceptamos todas las tarjetas de crédito, bancarizadas y no bancarizadas, incluida Naranja.'
    else:
        return BotDecision('Necesitamos que un asesor confirme la aceptación de esa tarjeta y las condiciones aplicables.',True,'ventas','Tarjeta por confirmar','normal'),[]
    if finance:
        reply+=' Las cuotas, los intereses y el total dependen del plan vigente para el producto y la tarjeta. Un asesor te confirma esas condiciones antes de pagar.'
    else:
        reply+=' Las cuotas y promociones se confirman para cada compra.'
    if not any(str(r.get('sender') or r.get('role')) in {'bot','assistant','agent','human'} for r in rows) and re.search(r'\b(?:hola|buen dia|buenas)\b',value):reply='¡Hola! '+reply
    return BotDecision(reply,finance,'ventas','Política verificada de tarjetas de crédito','normal'),[]


def greeting_decision(text):
    plain=' '.join(re.findall(r'\w+',normalize(text)))
    if re.fullmatch(r'(?:hola(?: buen(?:os)? (?:dia|dias))?|buen(?:os)? (?:dia|dias)|buenas(?: tardes| noches)?)(?: como estas?)?',plain):
        return BotDecision('¡Hola! ¿En qué te puedo ayudar?',False,'ventas','Saludo directo','normal'),[]
    return None
