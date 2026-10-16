"""Grounded stock explanations, separate from the model's commercial prose."""
import re
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from .catalog_words import words, NOISE, TYPES, SUBTYPES
from .catalog_stock import available_product


def matches(product, query):
    name = words(product.get('name', ''))
    terms = [w for w in words(query) if w not in NOISE]
    return bool(terms) and all(w in name or (len(w) > 4 and w.rstrip('s') in name) for w in terms)


def requested_model(text, products):
    """Recognize a catalog family, retaining an explicit numeric model version.

    Even a version absent from the catalog remains distinct from its siblings.
    Ambiguous references are left to clarification, never silently substituted.
    """
    value = ' '.join(words(text))
    families = {}
    for p in products:
        name = words(p.get('name', '')); brand = words(p.get('brand', ''))
        if not brand:
            from .routing import PRODUCT_BRANDS
            brand = next(([b] for b in name if b in PRODUCT_BRANDS), [])
        for i in range(len(name) - len(brand)) if brand else []:
            if name[i:i + len(brand)] != brand:
                continue
            model = name[i + len(brand)]
            if model.isalpha() and len(model) >= 3 and model not in TYPES | SUBTYPES | NOISE:
                families.setdefault(model, set()).add(' '.join(brand))
            break
    found = []
    for family, brands in families.items():
        match = re.search(r'\b' + re.escape(family) + r'\b(?:\s+(\d+(?:[.]\d+)*))?', value)
        if not match:
            continue
        named = [b for b in brands if ' ' + b + ' ' in ' ' + value + ' ']
        brand = named[0] if len(named) == 1 else next(iter(brands)) if len(brands) == 1 else None
        if brand:
            # An explicitly different known brand must not be silently corrected.
            from .routing import PRODUCT_BRANDS
            mentioned = set(words(value)) & set(PRODUCT_BRANDS)
            if mentioned and not set(words(brand)) & mentioned:
                continue
            found.append({'query': brand + ' ' + family + (' ' + match[1] if match[1] else ''),
                          'family_query': brand + ' ' + family})
    return found[0] if len(found) == 1 else None


def request_from_turn(text, history, products):
    request = requested_model(text, products)
    if request:
        return request
    from .catalog_words import COLORS
    value = ' '.join(words(text))
    version = re.fullmatch(r'(?:(?:la|el|version|modelo|esa|ese)\s+)*(\d+(?:\.\d+)*)', value)
    continuation = NOISE | COLORS | set('talle color si dale esa ese esta este m ml s l xs xxs xxxs xl xxl xxxl mediano mediana'.split())
    if not version and (len(words(text)) > 8 or not words(text) or any(w not in continuation for w in words(text))):
        return None
    for row in reversed(history[-8:]):
        if row.get('sender') not in ('customer', 'user'):
            continue
        previous = str(row.get('body', ''))
        request = requested_model(previous, products)
        if request:
            if version:
                request = dict(request, query=request['family_query'] + ' ' + version[1])
            return request
        # Do not jump past a different product request to older shopping context.
        from .routing import PRODUCT_BRANDS
        if set(words(previous)) & (TYPES | set(PRODUCT_BRANDS)):
            return None
    return None


def variant_matches(row, size='', color=''):
    a = row.get('attributes') or {}
    s = str(a.get('attribute_pa_talle') or a.get('attribute_talle') or a.get('size') or '').upper()
    c = str(a.get('attribute_pa_color') or a.get('attribute_color') or a.get('color') or '')
    return (not size or size.upper() == s) and (not color or all(w in words(c) for w in words(color)))


def stocked_matches(products, query, size='', color=''):
    result = []
    for source in products:
        if not matches(source, query):
            continue
        product = available_product(source)
        if product is None:
            continue
        if size or color:
            if product.get('variations'):
                variants = [v for v in product['variations'] if variant_matches(v, size, color)]
                if not variants:
                    continue
                product = dict(product, variations=variants)
            elif not variant_matches(product, size, color):
                continue
        result.append(product)
    return sorted(result, key=lambda p: (len(words(p['name'])), p['id']))


def zero_stock(row, flag):
    """Missing, backordered or contradictory stock is not proof of exhaustion."""
    try:
        amount = Decimal(str(row.get('stock_quantity')))
    except (InvalidOperation, TypeError, ValueError):
        return False
    return row.get(flag) is False and amount.is_finite() and amount <= 0 and row.get('stock_status') != 'onbackorder'


def restock_text(product_ids, now=None):
    from .storage import get_system_setting
    try:
        settings = get_system_setting('catalog_restock_notices', {}) or {}
        entries = settings.get('entries') or []
        current = now or datetime.now(timezone.utc)
        for entry in entries:
            if set(product_ids) != {entry.get('product_id')}:
                continue
            if current >= datetime.fromisoformat(entry['expires_at'].replace('Z', '+00:00')):
                continue
            start = datetime.fromisoformat(entry['expected_from']).date()
            end = datetime.fromisoformat(entry['expected_until']).date()
            today = (current - timedelta(hours=3)).date()
            if today > end:
                continue
            monday = today - timedelta(days=today.weekday())
            period = 'la próxima semana' if monday + timedelta(days=7) <= start < monday + timedelta(days=14) else 'los próximos días'
            return 'Tenemos prevista reposición para ' + period + '; el día de ingreso y los talles están pendientes de confirmación.'
    except (KeyError, TypeError, ValueError):
        pass
    return ''


def availability(products, query, size='', color=''):
    known = [p for p in products if matches(p, query)]
    report = {'query': query, 'size': size, 'color': color, 'product_ids': [p['id'] for p in known],
              'status': 'not_found', 'answer': ''}
    if not known:
        return report
    scoped = []
    for p in known:
        live = available_product(p)
        if live and any(variant_matches(v, size, color) for v in (live.get('variations') or [live])):
            return dict(report, status='available')
        rows = p.get('variations') or [p]
        scoped.extend((v, 'is_in_stock' if p.get('variations') else 'in_stock') for v in rows if variant_matches(v, size, color))
    # No matching variation is different from a variation whose count is zero.
    if not scoped or not all(zero_stock(v, flag) for v, flag in scoped):
        return dict(report, status='unconfirmed')
    label = query.title()
    suffix = (' en talle ' + size.upper() if size else '') + (' / ' + color if color else '')
    answer = 'Justo estamos sin stock de ' + label + suffix + '.'
    restock = restock_text(report['product_ids'])
    if restock:
        answer += ' ' + restock
    return dict(report, status='out_of_stock', answer=answer)


def intro(report, alternatives=False):
    return report['answer'] + ('\n\nPor el momento, te puedo ofrecer esta alternativa:' if alternatives else '')
