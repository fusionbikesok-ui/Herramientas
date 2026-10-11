import re
import unicodedata

RIMS = {"12", "14", "16", "18", "20", "24", "26", "27.5", "28", "29", "650", "700"}
ROAD_WIDTHS = {"23", "25", "28", "30", "32", "33", "35", "38", "40", "42", "45", "47", "50"}

def normalize(value):
    text = unicodedata.normalize("NFKD", str(value or "").lower())
    text = "".join(c for c in text if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", text.replace(",", ".").replace("×", "x")).strip()

def number(value):
    return str(float(value)).rstrip("0").rstrip(".")

def consume(state, text):
    text = normalize(text)
    text = re.sub(r"[?¿!¡]+", "", text).strip()
    state = dict(state)

    # Una consulta por herramientas no es una compra de cubiertas.
    if re.search(r"\b(extractor(?:es)?|sacacubiertas?|desmontables?|parches?)\b", text):
        return {}

    kind = None
    if re.search(r"\bcamaras?\b", text):
        kind = "camara"
    elif re.search(r"\b(cubiertas?|neumaticos?)\b", text):
        kind = "cubierta"

    continuation = bool(re.fullmatch(
        r"(?:si[ .]+)?(?:para |de |en |rodado |r\s*)?"
        r"(?:\d+(?:\.\d+)?(?:\s*x\s*\d+(?:\.\d+)?)?c?"
        r"|mtb|mountain(?: bike)?|montana|ruta|gravel"
        r"|presta|schrader|dunlop|valvula fina|valvula gruesa)",
        text,
    ))

    if kind:
        if state.get("tipo") != kind:
            state = {"tipo": kind}
    elif not state or not continuation:
        return {}

    if re.search(r"\b(mtb|mountain(?: bike)?|montana)\b", text):
        state["categoria"] = "mtb"
    elif re.search(r"\b(ruta|gravel)\b", text):
        state["categoria"] = "ruta_gravel"

    valve = re.search(r"\b(presta|schrader|dunlop)\b", text)
    if valve:
        state["valvula"] = valve.group(1)
    elif "valvula fina" in text:
        state["valvula"] = "presta"
    elif "valvula gruesa" in text:
        state["valvula"] = "schrader"

    measure = re.search(
        r"(?<![\d.])(?:r\s*)?"
        r"(700|650|29|28|27\.5|26|24|20|18|16|14|12)"
        r"\s*x\s*(\d+(?:\.\d+)?)c?\b",
        text,
    )
    if measure:
        state["rodado"] = measure.group(1)
        state["ancho"] = number(measure.group(2))
        state.pop("ambiguo", None)
        return state

    explicit = re.search(
        r"\b(?:rodado\s*|r\s*)(\d+(?:\.\d+)?)\b", text
    )
    rim = explicit.group(1) if explicit else None
    if not rim and re.search(r"\b700c?\b", text):
        rim = "700"
    if rim in RIMS:
        if state.get("rodado") != rim:
            state.pop("ancho", None)
        state["rodado"] = rim
        state.pop("ambiguo", None)
        return state

    bare = re.fullmatch(r"(?:de |en )?(\d+(?:\.\d+)?)", text)
    embedded = re.search(r"\b(29|26|27\.5)\b", text) if kind else None
    value = bare.group(1) if bare else embedded.group(1) if embedded else None

    if value:
        if state.get("rodado") == "700" and value in ROAD_WIDTHS:
            state["ancho"] = number(value)
            state.pop("ambiguo", None)
        elif "." in value and float(value) < 5 and state.get("rodado"):
            state["ancho"] = number(value)
        elif value == "28" and not explicit:
            state["ambiguo"] = "28"
        elif value in RIMS:
            if state.get("rodado") != value:
                state.pop("ancho", None)
            state["rodado"] = value
            state.pop("ambiguo", None)
    return state

def tire_context(text, history):
    messages = []
    for row in history or []:
        role = str(row.get("sender") or row.get("role") or "").lower()
        if role in {"customer", "user"}:
            messages.append(str(
                row.get("body") or row.get("content") or row.get("text") or ""
            ))

    # Algunos recorridos incluyen el mensaje actual dentro del historial.
    if messages and normalize(messages[-1]) == normalize(text):
        messages.pop()

    state = {}
    for message in messages + [text]:
        state = consume(state, message)
    return state

def pending_question(state):
    if not state:
        return None
    if state.get("ambiguo") == "28":
        return "¿Te referís a rodado 28 o a medida 700 × 28?"
    if not state.get("rodado"):
        if state.get("categoria") == "ruta_gravel":
            return "¿Qué medida figura en tu cubierta? Por ejemplo, 700 × 25."
        return "¿Qué rodado buscás?"
    if state["tipo"] == "camara" and not state.get("ancho"):
        return "¿Qué ancho figura en el lateral de tu cubierta?"
    if state["tipo"] == "camara" and not state.get("valvula"):
        return "¿La válvula es fina (Presta) o gruesa (Schrader)?"
    return None
