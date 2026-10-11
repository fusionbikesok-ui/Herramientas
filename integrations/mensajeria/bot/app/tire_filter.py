import re
from decimal import Decimal
from .tire_context import normalize

RIM = r"(700|650|29|28|27\.5|26|24|20|18|16|14|12)"
TOOLS = r"\b(extractor(?:es)?|sacacubiertas?|desmontables?|parches?|herramientas?)\b"

def dimensions(name):
    text = normalize(name)
    # No interpretar medidas fraccionarias como un ancho decimal.
    fractional = bool(re.search(r"\d+\s+\d+/\d+", text))
    match = re.search(
        r"(?<![\d.])(?:r\s*)?" + RIM
        + r"\s*x\s*(\d+(?:\.\d+)?)"
        + r"(?:\s*[/\-]\s*(\d+(?:\.\d+)?))?",
        text,
    )
    if match:
        rim, low, high = match.groups()
        if fractional:
            return rim, None, None
        low = Decimal(low)
        high = Decimal(high) if high else low
        if high < low:
            return rim, None, None
        return rim, low, high

    match = re.search(r"\b(?:rodado\s*|r\s*)" + RIM + r"\b", text)
    return (match.group(1), None, None) if match else (None, None, None)

def valve(name):
    text = normalize(name)
    if re.search(r"\bpresta\b", text):
        return "presta"
    if re.search(r"\bschrader\b", text) or "valvula de auto" in text:
        return "schrader"
    if re.search(r"\bdunlop\b", text):
        return "dunlop"
    # Abreviaturas sin una equivalencia verificada quedan pendientes.
    return None

def classify(product, state):
    name = str(product.get("name") or "")
    text = normalize(name)
    if re.search(TOOLS, text):
        return "exclude", "Es una herramienta"

    expected = "camaras" if state["tipo"] == "camara" else "cubiertas"
    categories = {
        normalize(c) for c in product.get("categories", [])
        if isinstance(c, str)
    }
    if expected not in categories:
        return "exclude", "Categoría distinta o no confirmada"

    # Hasta verificar los datos de variantes, no usar stock del padre.
    if product.get("variations"):
        return "pending", "Necesita verificar la variante exacta"
    if product.get("in_stock") is not True:
        return "exclude", "No hay stock confirmado"

    rim, low, high = dimensions(name)
    if rim is None:
        return "pending", "Rodado no confirmado"
    if rim != state.get("rodado"):
        return "exclude", "Rodado distinto"

    width = state.get("ancho")
    if width:
        if low is None:
            return "pending", "Ancho o rango no informado"
        requested = Decimal(width)
        if state["tipo"] == "camara":
            if not low <= requested <= high:
                return "exclude", "Ancho fuera del rango"
        elif low != high or requested != low:
            return "exclude", "Ancho distinto"

    if state["tipo"] == "camara":
        actual_valve = valve(name)
        if not actual_valve:
            return "pending", "Válvula no confirmada"
        if actual_valve != state.get("valvula"):
            return "exclude", "Válvula distinta"

    return "match", "Coincide con los datos consultados"

def filter_products(products, state):
    matches, pending = [], []
    for product in products:
        status, reason = classify(product, state)
        if status == "match":
            matches.append(product)
        elif status == "pending":
            pending.append({"product": product, "reason": reason})
    return matches, pending
