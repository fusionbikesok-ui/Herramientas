import logging
from .tire_context import tire_context, pending_question
from .tire_filter import filter_products
from .routing import explicit_handoff, is_combined_payment, is_service_question
from .clients import search_catalog
from .ai import BotDecision, _grounded_catalog_reply

logger = logging.getLogger(__name__)

def tire_decision(text, history):
    if (
        is_combined_payment(text)
        or explicit_handoff(text)
        or is_service_question(text)
    ):
        return None, []

    state = tire_context(text, history)
    if not state:
        return None, []

    previous_answer = any(
        str(row.get("sender") or row.get("role") or "").lower()
        in {"bot", "assistant", "agent", "human"}
        for row in (history or [])
    )
    greeting = "" if previous_answer else "¡Hola! ¿Cómo estás? "
    question = pending_question(state)

    if question:
        return BotDecision(
            reply=greeting + question,
            handoff=False,
            department="ventas",
            reason="Falta un dato para buscar cubiertas o cámaras",
            priority="normal",
        ), []

    query = state["tipo"] + " " + state["rodado"]
    try:
        # Buscar más candidatos antes de filtrar; mostrar como máximo tres.
        candidates = search_catalog(query, 40)
        matches, pending = filter_products(candidates, state)
    except Exception:
        logger.exception("Error al consultar cubiertas o cámaras")
        return BotDecision(
            reply=greeting + "No pude consultar el catálogo en este momento. Probá nuevamente en unos instantes.",
            handoff=False,
            department="ventas",
            reason="Error de consulta de catálogo",
            priority="normal",
        ), []

    if matches:
        selected = matches[:3]
        return BotDecision(
            reply=_grounded_catalog_reply(selected, text, history),
            handoff=False,
            department="ventas",
            reason="Resultados filtrados por categoría y medidas informadas",
            priority="normal",
        ), selected

    if pending:
        reply = (
            "Encontré opciones, pero faltan datos para confirmar que "
            "correspondan a tu medida. Necesitamos que las revise un asesor."
        )
    else:
        reply = (
            "No pude confirmar una opción con esos datos entre los resultados "
            "de la búsqueda. Un asesor puede ayudarte a revisar otras opciones."
        )

    return BotDecision(
        reply=greeting + reply,
        handoff=True,
        department="ventas",
        reason="No se pudo confirmar una coincidencia con las medidas solicitadas",
        priority="normal",
    ), []
