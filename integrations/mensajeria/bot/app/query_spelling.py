"""Repair small typos in consultation vocabulary, never guess a product model."""
import re
from functools import lru_cache
from .routing import normalize


VOCABULARY = frozenset('equipamiento componentes especificaciones caracteristicas descripcion tecnica tecnico bicicleta bicicletas horquilla transmision consultar consulta informacion disponible disponibles disponibilidad presupuesto'.split())


def distance(left, right):
    """Edit distance with adjacent transposition (equipameinto -> equipamiento)."""
    rows = [list(range(len(right) + 1))]
    for i, a in enumerate(left, 1):
        row = [i]
        for j, b in enumerate(right, 1):
            value = min(row[j-1] + 1, rows[-1][j] + 1, rows[-1][j-1] + (a != b))
            if i > 1 and j > 1 and a == right[j-2] and left[i-2] == b:
                value = min(value, rows[i-2][j-2] + 1)
            row.append(value)
        rows.append(row)
    return rows[-1][-1]


@lru_cache(maxsize=2048)
def correct_word(word):
    value = normalize(word)
    # Short tokens, numbers, model versions and identifiers remain untouched.
    if value in VOCABULARY or not value.isalpha() or not 5 <= len(value) <= 20:
        return word
    limit = 2 if len(value) >= 9 else 1
    ranked = [(distance(value, candidate), candidate) for candidate in VOCABULARY
              if abs(len(candidate)-len(value)) <= limit]
    best = min((score for score, _ in ranked), default=limit+1)
    matches = [candidate for score, candidate in ranked if score == best]
    return matches[0] if best <= limit and len(matches) == 1 else word


def normalize_query(text):
    # URLs/emails and alphanumeric identifiers are indivisible protected tokens.
    return re.sub(r'https?://[^\s]+|www\.[^\s]+|[\w.+-]+@[\w.-]+|\b[\w.-]+\b',
                  lambda match: correct_word(match[0]), str(text), flags=re.I)


def normalize_history(history):
    result = []
    for row in history or []:
        item = dict(row)
        if (item.get('sender') or item.get('role')) in {'customer', 'user'}:
            for field in ('body', 'content', 'text'):
                if isinstance(item.get(field), str):item[field] = normalize_query(item[field])
        result.append(item)
    return result
