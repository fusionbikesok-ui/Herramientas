from __future__ import annotations

import re
from typing import Any


DEFAULT_PROMPT_CONFIG: dict[str, str] = {
    "assistant_name": "Fabri IA",
    "tone": (
        "Español de Argentina, claro, directo y cordial. Usar podés, tenés y querés. "
        "Emojis moderados y respuestas breves, orientadas a resolver o avanzar la compra."
    ),
    "sales_instructions": (
        "Ayudar a elegir bicicletas, accesorios y repuestos haciendo preguntas concretas sobre uso, "
        "presupuesto, talle y preferencias. Cuando haya productos verificados, resumir las mejores "
        "opciones y conservar sus enlaces completos. Si se orienta un talle desde la altura, aclarar "
        "que es aproximado y depende de la marca, el modelo y la geometría; pedir el modelo exacto y, "
        "cuando haga falta, la medida de entrepierna."
    ),
    "support_instructions": (
        "Para taller, garantías, devoluciones y seguimiento de pedidos, reunir solamente el dato mínimo "
        "necesario y derivar a Posventa/Taller sin prometer resoluciones ni plazos exactos."
    ),
    "handoff_instructions": (
        "Derivar cuando el cliente pida una persona, exista un reclamo, garantía, devolución, pago "
        "rechazado, combinación de medios o falte información verificada para responder con seguridad."
    ),
    "business_notes": (
        "Priorizar una atención útil y comercial sin presionar. Si la consulta no está clara, hacer una "
        "sola pregunta concreta por vez."
    ),
}


FIELD_LIMITS = {
    "assistant_name": 80,
    "tone": 2500,
    "sales_instructions": 6000,
    "support_instructions": 6000,
    "handoff_instructions": 6000,
    "business_notes": 15000,
}


def _compact_multiline_text(value: str) -> str:
    """Remove formatting noise without changing prompt wording or line order."""
    lines = [line.rstrip() for line in value.splitlines()]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def sanitize_prompt_config(value: Any) -> dict[str, str]:
    source = value if isinstance(value, dict) else {}
    clean: dict[str, str] = {}
    for key, default in DEFAULT_PROMPT_CONFIG.items():
        raw = source.get(key, default)
        text = _compact_multiline_text(
            str(raw or "").replace("\r\n", "\n").replace("\r", "\n")
        )
        if not text:
            text = default
        if key == "assistant_name":
            text = " ".join(text.splitlines()).strip()
        clean[key] = text[: FIELD_LIMITS[key]]
    return clean


def editable_prompt_section(
    value: Any,
    field_limit: int | None = None,
    business_notes_limit: int | None = None,
) -> str:
    config = sanitize_prompt_config(value)
    if field_limit is not None:
        limit = max(120, int(field_limit))
        notes_limit = max(limit, int(business_notes_limit or limit))
        config = {
            key: (
                text
                if key == "assistant_name"
                else text[:notes_limit]
                if key == "business_notes"
                else text[:limit]
            )
            for key, text in config.items()
        }
    return f"""
PROMPT GENERAL ÚNICO DE {config['assistant_name']}:
{config['business_notes']}
""".strip()
