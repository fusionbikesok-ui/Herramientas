"""Service menu and contextual replies, shared by preview and live worker."""
import re
from .ai import BotDecision, SERVICE_BOOKING_URL, _format_catalog_price
from .routing import normalize, explicit_handoff
from .clients import search_service_catalog
from .catalog_words import words, TYPES

MENU = '¿Querés reservar un turno o ver los tipos de service y sus precios?'

def body(row):
    return str(row.get('body') or row.get('content') or row.get('text') or '')

def service_decision(text, history):
    value = normalize(text).strip(' .,!¡?¿')
    if explicit_handoff(text):
        return None
    rows = list(history or [])
    if rows and body(rows[-1]).strip() == text.strip():
        rows.pop()
    last_bot = next((body(r) for r in reversed(rows) if str(r.get('sender') or r.get('role') or '') in {'bot','assistant'}), '')
    context = any(x in last_bot for x in (MENU, '¿Querés reservar un turno?', 'El turno queda pendiente', 'services publicados', '¿Qué service te interesa?'))
    explicit = bool(re.search(r'\b(?:services?|servicios?|mantenimiento|taller|tubelizado)\b', value))
    booking = bool(re.search(r'\b(?:reservar|reserva|turno|agendar)\b',value))
    prices = bool(re.search(r'\b(?:precios?|cuanto|cuesta|sale|valor|tipos|opciones|listado|ver)\b',value))
    followup = bool(re.fullmatch(r'(?:si|dale|bueno|quiero reservar|reservar|un turno|turno|ver precios|los precios|precios|ver opciones|ver los precios|control|completo|race)',value))
    if not explicit and any(w in TYPES for w in words(text)):
        return None
    if not explicit and not (context and (followup or booking or prices)):
        return None
    if re.search(r'\b(?:reclamo|garantia|devolucion|rompio|reparacion|ruido)\b',value):
        return None
    greeting = '' if any(str(r.get('sender') or r.get('role') or '') in {'bot','assistant','agent','human'} for r in rows) else '¡Hola! ¿Cómo estás? '
    def answer(reply, products=None, handoff=False):
        return BotDecision(greeting+reply,handoff,'posventa_taller','Atención de service','normal'), products or []
    if context and value in {'si','dale','bueno'}:
        if last_bot.rstrip().endswith('¿Querés reservar un turno?'):
            booking = True
        else:
            return answer(MENU)
    if booking and not prices:
        return answer('Podés solicitar un turno acá:\n'+SERVICE_BOOKING_URL+'\n\nEl turno queda pendiente de confirmación del taller.')
    noise = set('hola buenas buen dia hacen hace tienen tenes ustedes queria saber si que el la los las un una de del para por en y me podes pasar mostrar mostrame ver quiero necesito busco cuanto cuesta sale vale valor precio precios tipos opciones listado service services servicio servicios mantenimiento taller bicicleta bicicletas bici gracias'.split())
    specific = [w for w in re.findall(r'\w+',value) if w not in noise]
    if not specific and not prices:
        return answer('Sí, hacemos service de bicicletas. '+MENU)
    try:
        products = search_service_catalog(20)
    except Exception:
        return answer('No pude consultar los precios de service en este momento. ¿Querés reservar un turno?')
    products = [p for p in products if p.get('in_stock') is True]
    if specific:
        products = [p for p in products if all(w in re.findall(r'\w+',normalize(str(p.get('name') or ''))) for w in specific)]
    if not products:
        return answer('No pude confirmar ese servicio en el listado actualizado. Necesitamos que un asesor lo revise.',handoff=True)
    blocks = ['Te paso los services publicados:']
    for p in products[:8]:
        lines = ['• '+str(p.get('name') or 'Service')]
        price = _format_catalog_price(p.get('cash_price'),str(p.get('currency') or 'ARS'))
        if price: lines.append('Precio publicado: '+price)
        if p.get('url'): lines.append(str(p['url']))
        blocks.append('\n'.join(lines))
    if len(products)>8: blocks.append('Hay más servicios. ¿Qué service te interesa?')
    else: blocks.append('¿Querés reservar un turno?')
    return answer('\n\n'.join(blocks),products[:8])
