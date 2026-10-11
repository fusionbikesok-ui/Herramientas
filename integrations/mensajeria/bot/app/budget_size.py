import re
from decimal import Decimal, InvalidOperation
from .routing import normalize, PRODUCT_BRANDS
from .config import get_settings
from .catalog_sqlite import _load_snapshot, _public_product
from .ai import BotDecision, _format_catalog_price

def size_budget_decision(text, history):
    from .budget_flow import budget_range, _budget_more

    value = normalize(text).strip(" .,!¡?¿")
    found = re.fullmatch(
        r"(?:(?:busco|quiero|necesito|en|soy)\s+)?"
        r"(?:(?:el|un)\s+)?(?:(?:talle|talla)\s+)?"
        r"(xxs|xs|s|m|l|xl|xxl|xxxl)", value
    )
    if not found:
        return None
    size = found.group(1).upper()

    rows = list(history or [])
    def body(row):
        return str(row.get("body") or row.get("content") or "").strip()
    def role(row):
        return str(row.get("sender") or row.get("role") or "").lower()
    if rows and role(rows[-1]) in {"customer", "user"} and body(rows[-1]) == text.strip():
        rows.pop()

    query = None
    for row in reversed(rows):
        if role(row) not in {"customer", "user"}:
            continue
        message = body(row)
        if _budget_more(message):
            continue
        if budget_range(message) is not None:
            query = message
        break
    if query is None:
        return None

    normalized = normalize(query)
    if not re.search(r"\b(mtb|mountain(?: bike)?|montana)\b", normalized):
        return None
    # No descartar silenciosamente otras condiciones del cliente.
    if re.search(
        r"\b(dolares?|usd|cuotas?|financiar|talle|talla|color|rodado|"
        r"r26|r29|r27|doble|carbono|electrica|transferencia|tarjeta)\b",
        normalized,
    ):
        return None

    low, high = budget_range(query)
    brands = [
        b for b in PRODUCT_BRANDS
        if re.search(r"\b" + re.escape(b) + r"\b", normalized)
    ]
    settings = get_settings()
    try:
        snapshot, status = _load_snapshot(
            settings.catalog_sqlite_path,
            settings.wordpress_base_url,
            settings.catalog_sqlite_max_age_seconds,
        )
    except Exception:
        return BotDecision(
            "No pude consultar las variantes en este momento.",
            False, "ventas", "Error de catálogo", "normal"
        ), []
    if not status.get("fresh"):
        return BotDecision(
            "No pude confirmar los talles con un catálogo actualizado.",
            False, "ventas", "Catálogo desactualizado", "normal"
        ), []

    matches = []
    for internal in snapshot:
        p = _public_product(internal, [])
        name = normalize(str(p.get("name") or ""))
        categories = normalize(" ".join(
            c for c in p.get("categories", []) if isinstance(c, str)
        ))
        if not all(re.search(r"\bbicicletas?\b", v) for v in (name, categories)):
            continue
        if not re.search(r"\b(mtb|mountain(?: bike)?|montana)\b", name + " " + categories):
            continue
        identity = name + " " + normalize(str(p.get("brand") or ""))
        if any(not re.search(r"\b" + re.escape(b) + r"\b", identity) for b in brands):
            continue
        if str(p.get("currency") or "").upper() != "ARS":
            continue
        variants = []
        for v in p.get("variations") or []:
            attrs = v.get("attributes") or {}
            if str(attrs.get("attribute_pa_talle") or "").strip().upper() != size:
                continue
            if v.get("is_in_stock") is not True:
                continue
            try:
                price = Decimal(str(v.get("display_price") or ""))
            except InvalidOperation:
                continue
            if price.is_finite() and low <= price <= high:
                variants.append((price, v))
        if variants:
            variants.sort(key=lambda item: item[0])
            matches.append((variants[0][0], p, variants))

    matches.sort(key=lambda item: (item[0], str(item[1].get("name") or "")))
    if not matches:
        return BotDecision(
            f"No pude confirmar una MTB en talle {size} dentro de ese presupuesto. "
            "Necesitamos que un agente revise si podemos conseguirla.",
            True, "ventas", "Sin variantes verificadas", "normal"
        ), []

    blocks = [f"Sí, en talle {size} encontré estas opciones dentro de tu presupuesto:"]
    selected = []
    for _, p, variants in matches[:3]:
        details = []
        for price, v in variants:
            color = str((v.get("attributes") or {}).get("attribute_pa_color") or "").strip()
            label = (color + ": " if color else "")
            label += _format_catalog_price(price, "ARS")
            if label not in details:
                details.append(label)
        blocks.append(
            "• " + str(p.get("name") or "") + "\n"
            + f"Talle {size} con stock. Precios publicados por variante:\n"
            + "\n".join(details) + "\n" + str(p.get("url") or "")
        )
        selected.append(dict(p, variations=[v for _, v in variants]))
    blocks.append("¿Cuál de estos modelos te interesa?")
    return BotDecision(
        "\n\n".join(blocks), False, "ventas",
        "Variantes por talle y presupuesto", "normal"
    ), selected
