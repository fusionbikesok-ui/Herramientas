from __future__ import annotations

import re
import unicodedata
from difflib import get_close_matches
from typing import Any


PRODUCT_TERMS = {
    "bici", "bicicleta", "mtb", "ruta", "gravel", "electrica", "e-bike",
    "trek", "polygon", "zion", "venzo", "volta", "merida", "cube", "twitter",
    "kush", "topmega", "bontrager", "garmin", "wahoo", "talle", "rodado",
    "stock", "precio", "cuota", "modelo", "color", "horquilla", "cubierta",
}

SERVICE_TERMS = {
    "service", "servicio de bicicleta", "servicio de bici", "mantenimiento",
    "puesta a punto",
}

SUPPORT_TERMS = {
    "garantia", "garantía", "devolucion", "devolución", "reclamo", "reparacion",
    "reparación", "pedido", "seguimiento", "posventa", "taller",
}

PRODUCT_BRANDS = {
    "bontrager", "cube", "garmin", "kush", "merida", "polygon", "santini",
    "topmega", "trek", "twitter", "venzo", "volta", "wahoo", "zion",
}

PRODUCT_SYNONYMS = {
    "mountainbike": "mtb",
    "mountain bike": "mtb",
    "bicicleta de montana": "mtb",
    "bici de montana": "mtb",
    "electrica": "e-bike",
    "ebike": "e-bike",
    "rod": "rodado",
}

STOCK_TERMS = {
    "stock", "disponible", "disponibilidad", "hay", "tenes", "tenés",
    "tienen", "queda", "quedan", "conseguir", "consigo",
}

HANDOFF_TERMS = {
    "asesor", "persona", "humano", "vendedor", "reclamo", "queja", "garantia",
    "garantía", "devolucion", "devolución", "pago rechazado", "fondos insuficientes",
    "dos tarjetas", "combinar medios", "no llego", "no llegó", "estafa",
}

STOPWORDS = {
    "hola", "buenas", "quiero", "busco", "tenes", "tenés", "tienen", "una", "uno",
    "para", "con", "sin", "que", "qué", "hay", "del", "las", "los", "por", "favor",
    "precio", "stock", "cuotas", "cuota", "bicicleta", "bici", "modelo", "en",
    "me", "gustaria", "quisiera", "interesa", "necesito", "estoy", "viendo", "buscando",
    "queria", "quería", "saber", "si", "disponible", "disponibilidad", "tienen",
    "bueno", "dale", "dame", "decime", "ensename", "mostrar", "mostra",
    "mostrame", "mostrarme", "pasame", "podrias", "podrías", "podes", "podés",
    "opcion", "opciones", "ver", "yo", "mido", "seria", "sería",
}


def normalize(text: str) -> str:
    value = unicodedata.normalize("NFKD", text or "")
    value = "".join(ch for ch in value if not unicodedata.combining(ch))
    return re.sub(r"\s+", " ", value.lower()).strip()


def normalize_catalog_text(text: str) -> str:
    value = normalize(text)
    for original, replacement in sorted(PRODUCT_SYNONYMS.items(), key=lambda item: -len(item[0])):
        value = re.sub(rf"\b{re.escape(original)}\b", replacement, value)
    words = re.findall(r"[\w\-]+", value, flags=re.UNICODE)
    corrected: list[str] = []
    for word in words:
        if word in PRODUCT_BRANDS:
            corrected.append(word)
            continue
        match = get_close_matches(word, PRODUCT_BRANDS, n=1, cutoff=0.78)
        corrected.append(match[0] if match else word)
    return " ".join(corrected)


def clamp_response_delay(value: Any, maximum: int = 120) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return 0
    return max(0, min(parsed, maximum))


def needs_catalog(text: str) -> bool:
    if is_service_question(text):
        return True
    if is_combined_payment(text) or is_general_payment_question(text):
        return False
    normalized = normalize_catalog_text(text)
    return any(
        re.search(r"\b" + re.escape(normalize(term)) + r"\b", normalized)
        for term in PRODUCT_TERMS
    )


def is_service_question(text: str) -> bool:
    normalized = normalize(text)
    return any(normalize(term) in normalized for term in SERVICE_TERMS)


def is_stock_question(text: str) -> bool:
    normalized = normalize(text)
    words = set(re.findall(r"[\w\-]+", normalized, flags=re.UNICODE))
    return bool(words.intersection({normalize(term) for term in STOCK_TERMS}))


def height_centimeters(text: str) -> int | None:
    """Extract a plausible rider height only when the text presents it as height."""
    value = normalize(text)
    match = re.search(
        r"\b(?:mido|mi altura(?: es)?|altura(?: es)?|estatura(?: es)?)\s*"
        r"(?:de\s*)?(\d{1,3}(?:[\.,]\d{1,2})?)\s*"
        r"(cm|centimetros?|m|metros?)?\b",
        value,
    )
    if not match:
        return None
    try:
        amount = float(match.group(1).replace(",", "."))
    except ValueError:
        return None
    unit = str(match.group(2) or "")
    if unit in {"m", "metro", "metros"} or amount < 3:
        amount *= 100
    centimeters = int(round(amount))
    return centimeters if 100 <= centimeters <= 230 else None


def is_bike_size_advice_question(text: str) -> bool:
    value = normalize(text)
    asks_size = bool(re.search(r"\b(?:talle|tamano|medida|cuadro)\b", value))
    return asks_size and height_centimeters(text) is not None


def normalize_conversation_history(value: Any, limit: int = 12) -> list[dict[str, str]]:
    """Convert the WordPress laboratory history to the internal message shape."""
    if not isinstance(value, list):
        return []
    rows: list[dict[str, str]] = []
    for item in value[-max(1, min(int(limit), 60)):]:
        if not isinstance(item, dict):
            continue
        role = str(item.get("role") or "").strip().lower()
        body = str(item.get("text") or item.get("body") or "").strip()
        if role not in {"user", "assistant"} or not body:
            continue
        rows.append({
            "sender": "customer" if role == "user" else "bot",
            "body": body[:6000],
        })
    return rows


def explicit_handoff(text: str) -> bool:
    normalized = normalize(text)
    return is_combined_payment(text) or any(
        normalize(term) in normalized for term in HANDOFF_TERMS
    )


def catalog_query(text: str, max_words: int = 7) -> str:
    words = re.findall(r"[\w\-]+", normalize_catalog_text(text), flags=re.UNICODE)
    sizes = {"s", "m", "l", "xl", "xxl", "xs"}
    selected = [word for word in words if word not in STOPWORDS and (len(word) > 1 or word in sizes)]
    return " ".join(selected[:max_words]) or " ".join(words[:max_words])


def catalog_query_with_context(
    text: str,
    history: list[dict[str, Any]],
    max_words: int = 10,
) -> str:
    current = catalog_query(text, max_words=max_words)
    normalized = normalize_catalog_text(text)
    followup_cues = {"talle", "rodado", "color", "cuota", "cuotas", "precio", "stock"}
    current_words = set(normalized.split())
    if current_words.intersection(PRODUCT_BRANDS) or not current_words.intersection(followup_cues):
        return current

    previous_rows = history[:-1] if history and str(history[-1].get("body") or "").strip() == text.strip() else history
    for row in reversed(previous_rows):
        if str(row.get("sender") or "") != "customer":
            continue
        previous_text = str(row.get("body") or "").strip()
        if not previous_text or not needs_catalog(previous_text):
            continue
        combined: list[str] = []
        for word in (catalog_query(previous_text, max_words=max_words) + " " + current).split():
            if word not in combined:
                combined.append(word)
        return " ".join(combined[:max_words])
    return current


def conversation_key(conversation: dict[str, Any]) -> str:
    channel = str(conversation.get("channel") or "web")
    if channel == "whatsapp":
        return "whatsapp:{number}:{user}".format(
            number=conversation.get("channel_number_id") or "unknown",
            user=conversation.get("external_user_id") or "unknown",
        )
    token = conversation.get("token") or conversation.get("id") or "unknown"
    return f"web:{token}"


def department_for(conversation: dict[str, Any], text: str = "") -> str:
    content = normalize(text)
    if is_service_question(content) or any(normalize(term) in content for term in SUPPORT_TERMS):
        return "posventa_taller"
    return "ventas"


def is_combined_payment(text: str) -> bool:
    value = normalize(text)
    methods = [
        bool(re.search(r"\btransferencia\b", value)),
        bool(re.search(r"\befectivo\b", value)),
        bool(re.search(r"\btarjetas?\b", value)),
    ]
    if sum(methods) >= 2:
        return True
    split = re.search(
        r"\b(mitad|resto|restante|una parte|otra parte|saldo|anticipo)\b",
        value,
    )
    financing = re.search(
        r"\b(cuotas?|financiar|financiacion|financiado|tarjetas?)\b",
        value,
    )
    explicit = re.search(
        r"\b(combinar medios|combinar pagos|pago combinado|pagos combinados|dos tarjetas)\b",
        value,
    )
    return bool(explicit or (split and financing))


def is_general_payment_question(text: str) -> bool:
    value = normalize_catalog_text(text)
    payment = re.search(
        r"\b(pagar|pagos?|cuotas?|tarjetas?|transferencia|efectivo|financiar|financiacion)\b",
        value,
    )
    if not payment:
        return False
    anchors = set(PRODUCT_TERMS) | set(PRODUCT_BRANDS)
    anchors -= {"cuota", "cuotas", "precio", "stock", "talle", "rodado", "color", "modelo"}
    return not any(
        re.search(r"\b" + re.escape(normalize(term)) + r"\b", value)
        for term in anchors
    )


# FUSION: deteccion de indumentaria v1
PRODUCT_TERMS.update({
    "indumentaria", "ropa",
    "calza", "calzas", "calz a",
    "calza larga", "calzas largas",
    "culotte", "culottes", "culote", "culotes",
    "jersey", "jerseys", "maillot", "maillots",
    "campera", "camperas", "chaqueta", "chaquetas",
    "chaleco", "chalecos", "rompeviento", "rompevientos",
    "guante", "guantes", "media", "medias",
    "zapatilla", "zapatillas", "calzado",
    "manga", "mangas", "pernera", "perneras",
    "remera", "remeras", "buzo", "buzos",
    "short", "shorts", "badana", "badanas",
})
STOPWORDS.update({"tiene", "de", "un", "alguna", "algunas", "algun", "algunos"})

# FUSION: lentes y anteojos
PRODUCT_TERMS.update({"lente", "lentes", "anteojo", "anteojos", "gafa", "gafas"})


# FUSION: plurales de productos v1
PRODUCT_TERMS.update({
    "camara", "neumatico", "repuesto", "accesorio",
    "cadena", "freno", "disco", "pastilla",
    "pedal", "pedales", "casco", "asiento",
    "sillin", "sillines", "manubrio",
})
PRODUCT_TERMS.discard("calz a")

# Ampliar palabras simples terminadas en vocal.
# No cambiar marcas, frases, plurales ya escritos ni abreviaturas.
for _product_term in tuple(PRODUCT_TERMS):
    if (
        _product_term not in PRODUCT_BRANDS
        and re.fullmatch(r"[a-z]+", _product_term)
        and _product_term.endswith(("a", "e", "i", "o", "u"))
    ):
        PRODUCT_TERMS.add(_product_term + "s")
