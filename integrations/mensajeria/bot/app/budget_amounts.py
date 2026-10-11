"""Conservative Argentine peso amounts. No exchange rates or inferred currency."""
import re
import unicodedata
from decimal import Decimal, InvalidOperation


def norm(value):
    return ''.join(c for c in unicodedata.normalize('NFKD', str(value).lower())
                   if not unicodedata.combining(c)).strip()

ONES = dict(zip(('cero uno dos tres cuatro cinco seis siete ocho nueve diez once doce trece catorce quince dieciseis diecisiete dieciocho diecinueve veinte').split(), range(21)))
ONES.update({'un': 1, 'una': 1, 'veintiuno': 21, 'veintidos': 22, 'veintitres': 23,
             'veinticuatro': 24, 'veinticinco': 25, 'veintiseis': 26,
             'veintisiete': 27, 'veintiocho': 28, 'veintinueve': 29})
TENS = dict(zip('treinta cuarenta cincuenta sesenta setenta ochenta noventa'.split(), range(30, 100, 10)))
HUNDREDS = dict(zip('cien doscientos trescientos cuatrocientos quinientos seiscientos setecientos ochocientos novecientos'.split(), range(100, 1000, 100)))
UNITS = {'millon': 1000000, 'millones': 1000000, 'mil': 1000, 'k': 1000}
WORDS = set(ONES) | set(TENS) | set(HUNDREDS) | set(UNITS) | {'ciento', 'y', 'medio', 'pesos', 'ars', 'a'}


def small(text):
    text = text.strip()
    if re.fullmatch(r'\d+(?:[.,]\d+)*', text):
        if re.fullmatch(r'\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?', text):
            return Decimal(text.replace('.', '').replace(',', '.'))
        if re.fullmatch(r'\d+(?:[.,]\d{1,2})?', text):
            return Decimal(text.replace(',', '.'))
        raise ValueError('Separadores ambiguos')
    if text in ONES:
        return Decimal(ONES[text])
    if text in TENS:
        return Decimal(TENS[text])
    if text in HUNDREDS:
        return Decimal(HUNDREDS[text])
    parts = text.split()
    if len(parts) == 3 and parts[0] in TENS and parts[1] == 'y' and parts[2] in ONES and 0 < ONES[parts[2]] < 10:
        return Decimal(TENS[parts[0]] + ONES[parts[2]])
    if parts and (parts[0] == 'ciento' or parts[0] in HUNDREDS) and len(parts) > 1:
        tail = small(' '.join(parts[1:]))
        if 0 < tail < 100 and parts[0] != 'cien':
            return Decimal(HUNDREDS.get(parts[0], 100)) + tail
    raise ValueError('Importe no reconocido')


def amount(value, unit=None):
    text = norm(value)
    if unit:
        text += ' ' + norm(unit)
    text = re.sub(r'(?<=\d)(?=[a-z])', ' ', text)
    text = re.sub(r'\b(?:pesos|ars)\b', '', text).replace('$', '').strip(' .,!¡?¿;:')
    found = re.search(r'\b(millones|millon|mil|k)\b', text)
    if not found:
        result = small(text)
    else:
        multiplier = Decimal(UNITS[found.group()])
        head = text[:found.start()].strip()
        result = (small(head) if head else Decimal(1)) * multiplier
        tail = text[found.end():].strip()
        if tail in {'y medio', 'medio'}:
            result += multiplier / 2
        elif tail:
            extra = amount(re.sub(r'^y\s+', '', tail))
            if not 0 < extra < multiplier:
                raise ValueError('Unidad repetida o importe ambiguo')
            result += extra
    if not result.is_finite() or result <= 0:
        raise ValueError('Importe no positivo')
    return result


def _prefix(text):
    """Collect only monetary vocabulary, never consume surrounding product text."""
    text = norm(text)
    glued = re.findall(r'(?<=\d)([a-z]+)', text)
    if any(word not in UNITS and word not in {'pesos', 'ars'} for word in glued):
        return ''
    text = re.sub(r'(?<=\d)(?=[a-z])', ' ', text)
    tokens = re.findall(r'\d+(?:[.,]\d+)*|[a-z]+|[^\w\s]', text)
    result = []
    for token in tokens:
        if token in WORDS or re.fullmatch(r'\d+(?:[.,]\d+)*', token) or token == '$':
            result.append(token)
        elif token in {'.', ',', '!', '?', ';', ':', '¿', '¡'}:
            break
        else:
            break
    return ' '.join(result).strip()


def budget_range(text):
    text = norm(text)
    marker = re.search(r'\b(entre|desde|de|hasta|maximo|presupuesto(?: de)?|tengo)\s+', text)
    if not marker:
        return None
    # "de montaña ... entre ..." must not mask the actual budget marker.
    explicit = re.search(r'\b(entre|desde|hasta|maximo|presupuesto(?: de)?|tengo)\s+', text)
    marker = explicit or marker
    fragment = _prefix(text[marker.end():])
    candidates = []
    for sep in re.finditer(r'\s+(?:y|a)\s+', fragment):
        left, right = fragment[:sep.start()], fragment[sep.end():]
        try:
            # Shared suffix: "entre 1 y 2 millones" (also "un y dos millones").
            right_unit = re.search(r'\b(millon|millones|mil|k)\b', right)
            if right_unit and not re.search(r'\b(millon|millones|mil|k)\b', left):
                if small(left.replace('$', '').strip()) < 1000:
                    left += ' ' + right_unit.group()
            low, high = amount(left), amount(right)
            if low <= high:
                candidates.append((low, high))
        except (ValueError, InvalidOperation):
            pass
    if candidates:
        return candidates[0] if len(set(candidates)) == 1 else None
    if marker.group().strip() not in {'entre', 'desde', 'de'}:
        try:
            return Decimal(0), amount(fragment)
        except (ValueError, InvalidOperation):
            pass
    return None
