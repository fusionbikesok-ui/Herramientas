"""Catalog-backed spelling suggestions with explicit customer confirmation.

Only a single-letter edit beside an exact brand/model anchor is suggested.
The customer's full query is retained, so confirmation never drops constraints.
"""
import re

from .routing import normalize
from .query_spelling import distance


QUESTION = '¿Te referís al producto «{}»?'
_QUESTION = re.compile(r'^(?:Para (?:confirmar disponibilidad|orientarte con el talle|revisar el equipamiento o dato técnico)\. )?¿Te referís (?:al producto |a )«([^»\n]{1,200})»\?$')
_YES = {'si', 'si por favor', 'si gracias', 'exacto', 'correcto', 'esa', 'ese', 'dale'}
_NO = {'no', 'no gracias', 'otra', 'otro'}
_TOKEN = re.compile(r'https?://\S+|www\.\S+|[\w.+-]+@[\w.-]+|\b[\w.-]+\b', re.I)


def strip_greeting(text):
    """Remove conversational prefixes, never arbitrary words inside a model."""
    value = normalize(str(text)).lstrip(' ¡!¿?.,;:')
    prefix = re.compile(
        r'^(?:hola|buen(?:os)? dias?|buenas(?: tardes| noches)?|'
        r'como (?:estan|estas|andas|andan)|que tal)'
        r'(?=$|[\s¡!¿?.,;:])[\s¡!¿?.,;:]*'
    )
    while True:
        updated = prefix.sub('', value, count=1)
        if updated == value:
            return value
        value = updated


def _tokens(text):
    return [(normalize(m[0]).rstrip('.'), m.start(), m.end()) for m in _TOKEN.finditer(str(text))]


def _edits(text, label):
    tokens = _tokens(text)
    target = [word for word, _, _ in _tokens(label)]
    if len(target) < 2:
        return []
    result = []
    for start in range(len(tokens) - len(target) + 1):
        window = tokens[start:start + len(target)]
        differences = [i for i, ((word, _, _), actual) in enumerate(zip(window, target)) if word != actual]
        if len(differences) != 1:
            continue
        pos = differences[0]
        word, begin, end = window[pos]
        actual = target[pos]
        # Do not correct versions, sizes, SKUs, URLs or short ambiguous tokens.
        if not word.isalpha() or not actual.isalpha() or min(len(word), len(actual)) < 3:
            continue
        if abs(len(word) - len(actual)) > 1 or distance(word, actual) != 1:
            continue
        result.append((begin, end, actual, pos))
    return result


def suggestions(text, products):
    """Return unique possible references; inspect all stock states for ambiguity."""
    from .inquiry_flow import catalog_brands, canonical
    from .catalog_words import TYPES, SUBTYPES, COLORS, NOISE

    brands = catalog_brands(products)
    families = set()
    for product in products:
        name = canonical(product.get('name', ''))
        tokens = name.split()
        declared = canonical(product.get('brand', ''))
        available = [declared] if declared and ' ' + declared + ' ' in ' ' + name + ' ' else [
            brand for brand in brands if brand and ' ' + brand + ' ' in ' ' + name + ' '
        ]
        for brand in available:
            parts = brand.split()
            for i in range(len(tokens) - len(parts)):
                if tokens[i:i + len(parts)] == parts:
                    model = tokens[i + len(parts)]
                    if model.isalpha() and len(model) >= 3:
                        families.add((brand, ' '.join(parts + [model])))
    value = ' ' + canonical(text) + ' '
    # A valid reference must not be replaced just because another label is close.
    if any(' ' + label + ' ' in value for _, label in families):
        return []
    protected = TYPES | SUBTYPES | COLORS | NOISE | {b for b in brands if ' ' not in b}
    found = {}
    for brand, label in sorted(families):
        edits = _edits(text, label)
        for begin, end, replacement, position in edits:
            original = normalize(text[begin:end])
            if position < len(brand.split()) and original in protected:
                continue
            corrected = text[:begin] + replacement + text[end:]
            found[(label, corrected)] = {'label': label, 'query': corrected}
    return list(found.values())


def _body(row):
    return str(row.get('body') or row.get('content') or row.get('text') or '').strip()


def _role(row):
    return str(row.get('sender') or row.get('role') or '').lower()


def _replace_body(row, text):
    for field in ('body', 'content', 'text'):
        if field in row:
            row[field] = text


def confirmed_search(text, history):
    """Replay our own confirmation turns, preserving every other query token.

    Only a immediately preceding bot question plus an explicit yes permits a
    rewrite. Other replies, later topic changes and unrelated yeses are untouched.
    """
    rows = [dict(row) for row in history or [] if isinstance(row, dict)]
    if rows and _role(rows[-1]) in {'customer', 'user'} and _body(rows[-1]) == text.strip():
        rows.pop()
    rows.append({'sender': 'customer', 'body': text})
    pending = None
    customer = None
    action = None
    for index, row in enumerate(rows):
        role = _role(row)
        if role in {'bot', 'assistant'}:
            match = _QUESTION.fullmatch(_body(row))
            pending = (customer, match[1]) if match and customer is not None else None
            continue
        if role not in {'customer', 'user'}:
            pending = None
            continue
        value = normalize(_body(row)).strip(' .,!¡?¿')
        if pending and value in _YES:
            previous, label = pending
            source = _body(rows[previous])
            edits = _edits(source, label)
            if len(edits) == 1:
                begin, end, replacement, _ = edits[0]
                corrected = source[:begin] + replacement + source[end:]
                _replace_body(rows[previous], corrected)
                _replace_body(row, corrected)
            elif index == len(rows) - 1:
                action = 'clarify'
        elif pending and value in _NO and index == len(rows) - 1:
            action = 'rejected'
        pending = None
        customer = index
    return _body(rows[-1]), rows[:-1], action
