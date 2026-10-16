"""One bounded bicycle search state, reconstructed from customer history."""
import re
from decimal import Decimal, InvalidOperation
from .budget_amounts import amount, budget_range, norm
from .config import get_settings
from .catalog_sqlite import _load_snapshot, _public_product
from .routing import PRODUCT_BRANDS, is_combined_payment, explicit_handoff
from .ai import BotDecision

CATEGORIES = {
    'mtb': r'\b(?:mtb|mountain(?: bike)?|montana)\b',
    'ruta': r'\bruta\b', 'gravel': r'\bgravel\b',
    'ciudad': r'\b(?:ciudad|urban[ao]s?|paseo)\b',
}
BIKE = r'\b(?:bicicletas?|bicis?|mtb|mountain(?: bike)?)\b'
OTHER = r'\b(?:calzas?|camaras?|cubiertas?|lentes?|anteojos?|cascos?|guantes?|zapatillas?|repuestos?|tapones?|tapon|horquillas?|rodillos?|alfombras?)\b'
SIZE = r'(xxxs|xxs|xs|s|m|l|xl|xxl|xxxl)'
YES = {'si', 'si quiero', 'si mostrame', 'dale', 'bueno'}
MORE = {'mas', 'ver mas', 'mostrame mas', 'mostrar mas', 'mostrame otras',
        'otras opciones', 'mas opciones', 'tenes mas', 'tenes otras', 'que otras tenes'}
STOP = set('me gusta interesa quiero la el una un bicicleta bici modelo de marca prefiero mostrame ver tenes en color talle'.split())


def _budget_more(text):
    return norm(text).strip(' .,!¡?¿') in MORE | YES


def _body(row):
    return str(row.get('body') or row.get('content') or row.get('text') or '').strip()


def _role(row):
    return str(row.get('sender') or row.get('role') or '').lower()


def _urls(text):
    return set(re.findall(r'https?://[^\s<>\[\]()]+', text))


def _answer(reply, products=None, handoff=False, reason='Búsqueda guiada de bicicletas'):
    return BotDecision(reply, handoff, 'ventas', reason, 'normal'), products or []


def _replay(text, history):
    rows = [r for r in history or [] if isinstance(r, dict)]
    if rows and _role(rows[-1]) in {'customer', 'user'} and _body(rows[-1]) == text.strip():
        rows.pop()
    rows.append({'sender': 'customer', 'body': text})
    state = None
    last_bot = ''
    intent = ''
    for row in rows:
        if _role(row) in {'bot', 'assistant'}:
            last_bot = _body(row)
            if state:
                urls = _urls(last_bot)
                if urls:
                    state['shown'] = urls
                    state['seen'].update(urls)
            continue
        if _role(row) not in {'customer', 'user'}:
            continue
        raw = _body(row)
        value = norm(raw).strip(' .,!¡?¿')
        intent = 'search'
        categories = [k for k, pattern in CATEGORIES.items() if re.search(pattern, value)]
        bounds = budget_range(raw)
        if re.search(OTHER, value):
            state = None
            continue
        new_bike = bool(re.search(BIKE, value))
        if new_bike and (bounds or state is None or (not categories and re.search(r'\b(?:busco|buscando|quiero|necesito)\b', value))):
            state = {'bounds': None, 'category': None, 'size': None, 'brands': [],
                     'seen': set(), 'shown': set(), 'selection': None, 'color': None}
        if state is None:
            continue
        if explicit_handoff(raw) or is_combined_payment(raw) or re.search(r'\b(?:pago|pagar|cuotas?|transferencia|tarjeta|envio|ubicacion|horario|garantia)\b', value):
            state = None
            continue
        if re.search(r'\b(?:dolares?|usd|rodado|r29|r26|r27|doble|carbono|electrica|suspension|hidraulic[oa]s?|velocidades|tubeless)\b', value):
            state['unsupported'] = True
        if re.search(r'\b(?:entre|hasta|maximo|presupuesto|tengo)\b', value) and bounds is None:
            state['invalid_budget'] = True
        if not bounds and not new_bike and ('presupuesto' in norm(last_bot) or re.search(r'\b(?:millon|millones|mil|k)\b', value)):
            try:
                bounds = (Decimal(0), amount(raw))
            except (ValueError, InvalidOperation):
                pass
        if bounds:
            state.update(bounds=bounds, invalid_budget=False, seen=set(), shown=set(), selection=None)
        if categories:
            if len(categories) != 1:
                state['category'] = None
            elif categories[0] != state['category']:
                state.update(category=categories[0], seen=set(), shown=set(), selection=None)
        size = re.search(r'\b(?:talle|talla)\s+' + SIZE + r'\b', value)
        if not size:
            size = re.fullmatch(r'(?:(?:busco|quiero|necesito|en|soy)\s+)?' + SIZE, value)
        if size and size.group(1).upper() != state['size']:
            state.update(size=size.group(1).upper(), seen=set(), shown=set())
        if value in MORE or (value in YES and last_bot.endswith('¿Querés verlas?')):
            intent = 'more'
            continue
        if value in YES:
            intent = 'clarify'
            continue
        brands = [b for b in PRODUCT_BRANDS if re.search(r'\b' + re.escape(b) + r'\b', value)]
        if brands:
            state.update(brands=brands, seen=set())
        if not any((new_bike, bounds, categories, size, brands)):
            # Only a short explicit choice may select previously displayed products.
            if state['shown'] and len(value.split()) <= 9 and (
                re.search(r'\b(?:gusta|interesa|prefiero|quiero|modelo|color)\b', value)
                or len(value.split()) <= 3
            ):
                state['selection_text'] = raw
                state['seen'] = set()
                intent = 'select'
            elif state.get('invalid_budget') and re.search(r'\b(?:entre|hasta|presupuesto)\b', value):
                pass
            else:
                state = None
    return state, intent


def _format_catalog_price(value, currency='ARS'):
    price = Decimal(str(value))
    decimals = 0 if price == price.to_integral_value() else 2
    text = format(price, f',.{decimals}f').replace(',', '_').replace('.', ',').replace('_', '.')
    return '$' + text


def _price(value):
    try:
        result = Decimal(str(value))
        return result if result.is_finite() and result > 0 else None
    except (InvalidOperation, ValueError, TypeError):
        return None


def _filter(products, state):
    low, high = state['bounds'] or (Decimal(0), Decimal('Infinity'))
    matches = []
    for p in products:
        name = norm(p.get('name', ''))
        categories = norm(' '.join(c for c in p.get('categories', []) if isinstance(c, str)))
        if not all(re.search(r'\bbicicletas?\b', v) for v in (name, categories)):
            continue
        if not re.search(CATEGORIES[state['category']], name + ' ' + categories):
            continue
        identity = name + ' ' + norm(p.get('brand', ''))
        if any(not re.search(r'\b' + re.escape(b) + r'\b', identity) for b in state['brands']):
            continue
        if str(p.get('currency', '')).upper() != 'ARS':
            continue
        if state.get('selection') and str(p.get('url', '')) != state['selection']:
            continue
        variants = []
        for v in p.get('variations') or []:
            attrs = v.get('attributes') or {}
            if state['size'] and str(attrs.get('attribute_pa_talle', '')).strip().upper() != state['size']:
                continue
            color = norm(attrs.get('attribute_pa_color', ''))
            if state.get('color') and state['color'] != color:
                continue
            price = _price(v.get('display_price'))
            if v.get('is_in_stock') is True and price is not None and low <= price <= high:
                variants.append(v)
        if p.get('variations'):
            if not variants:
                continue
            prices = [Decimal(str(v['display_price'])) for v in variants]
            result = dict(p, variations=variants)
        else:
            price = _price(p.get('cash_price'))
            if state['size'] or state.get('color') or p.get('in_stock') is not True or price is None or not low <= price <= high:
                continue
            prices = [price]
            result = dict(p)
        matches.append((min(prices), result))
    return [p for _, p in sorted(matches, key=lambda pair: (pair[0], str(pair[1].get('name', ''))))]


def budget_decision(text, history):
    state, intent = _replay(text, history)
    if state is None:
        # A lost history must never turn a bare size into a general catalog query.
        if not history and re.fullmatch(r'(?:(?:busco|en)\s+)?(?:talle\s+)?' + SIZE, norm(text)):
            return _answer('¿Para qué producto buscás ese talle?')
        return None
    if state.get('unsupported'):
        return _answer('Necesitamos que un asesor confirme esas características junto con el presupuesto que indicaste.', handoff=True)
    if state.get('invalid_budget'):
        return _answer('No pude interpretar ese presupuesto con seguridad. ¿Entre qué importes en pesos querés buscar?')
    greeting = '' if any(_role(r) in {'bot', 'assistant'} for r in history or []) else '¡Hola! ¿Cómo estás? '
    if not state['category']:
        return _answer(greeting + ('Con ese presupuesto, ¿buscás' if state['bounds'] else '¿Buscás') + ' una bicicleta para montaña (MTB), ciudad, ruta o gravel?')
    if intent == 'clarify':
        return _answer('¿Qué talle buscás?' if not state['size'] else '¿Cuál de los modelos te interesa?')
    settings = get_settings()
    try:
        internal, status = _load_snapshot(settings.catalog_sqlite_path, settings.wordpress_base_url,
                                          settings.catalog_sqlite_max_age_seconds)
        if not status.get('fresh'):
            return _answer('No pude confirmar la disponibilidad con un catálogo actualizado.', reason='Catálogo desactualizado')
        # Preserve all variants; the general formatter caps them at forty.
        products = [dict(_public_product(p, []), variations=[
            {k: v for k, v in row.items() if not k.startswith('_')}
            for row in p.get('variations') or []]) for p in internal]
    except Exception:
        return _answer('No pude consultar el catálogo en este momento. ¿Querés que lo intente de nuevo?', reason='Error de catálogo')
    if state.get('selection_text'):
        words = [w for w in re.findall(r'[\w]+', norm(state['selection_text'])) if w not in STOP]
        visible = [p for p in products if str(p.get('url', '')) in state['shown']]
        chosen = [p for p in visible if words and all(re.search(r'\b' + re.escape(w) + r'\b', norm(p.get('name', ''))) for w in words)]
        if len(chosen) != 1:
            return _answer('¿Me indicás el nombre del modelo que te interesa?')
        state['selection'] = str(chosen[0]['url'])
    matches = _filter(products, state)
    if not matches:
        return _answer('No pude confirmar una bicicleta con stock que cumpla esos filtros. Necesitamos que un agente revise si podemos conseguirla.', handoff=True)
    remaining = [p for p in matches if str(p.get('url', '')) not in state['seen']] if intent == 'more' else matches
    if not remaining:
        return _answer('Ya te mostré todas las opciones que pude confirmar con esos filtros. ¿Querés cambiar el presupuesto?')
    selected = remaining[:3]
    intro = 'Te paso otras opciones' if intent == 'more' else 'Sí, te paso estas opciones'
    blocks = [greeting + intro + (' dentro de tu presupuesto' if state['bounds'] else '') + (f", en talle {state['size']}" if state['size'] else '') + ':']
    for p in selected:
        block = ['• ' + str(p.get('name', ''))]
        variants = p.get('variations') or []
        if variants:
            if state['size']:
                details = []
                for v in variants:
                    attrs = v.get('attributes') or {}
                    line = str(attrs.get('attribute_pa_color') or 'Color sin especificar') + ': ' + _format_catalog_price(v['display_price'], 'ARS')
                    if line not in details:
                        details.append(line)
                block += [f"Talle {state['size']} con stock. Precios publicados:"] + details
            else:
                prices = [Decimal(str(v['display_price'])) for v in variants]
                block += [('Desde: ' if len(set(prices)) > 1 else 'Precio publicado: ') + _format_catalog_price(min(prices), 'ARS'), 'Con variantes en stock; falta elegir el talle.']
        else:
            block += ['Contado: ' + _format_catalog_price(p['cash_price'], 'ARS'), 'Con stock; talle sin confirmar.']
        block.append(str(p.get('url', '')))
        blocks.append('\n'.join(block))
    if len(remaining) > 3:
        blocks.append('Tengo más opciones con esos filtros. ¿Querés verlas?')
    elif not state['size']:
        blocks.append('¿Qué talle buscás?')
    elif state.get('selection'):
        blocks.append('Podés ver el detalle y continuar la compra en el enlace del producto.')
    else:
        blocks.append('¿Cuál de estos modelos te interesa?')
    return _answer('\n\n'.join(blocks), selected)
