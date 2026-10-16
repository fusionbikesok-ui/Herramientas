from __future__ import annotations

import json
import logging
import time
import uuid
from typing import Any

from .availability import channel_bot_available, sanitize_channel_config
from .ai import BotDecision, bike_size_advice_decision, fast_catalog_decision, generate_reply, speed_profile_config
from .clients import RemoteServiceError, search_catalog, search_service_catalog, send_whatsapp_text, wordpress_callback
from .config import get_settings
from .number_controls import number_bot_enabled
from .queueing import promote_due, redis_client, schedule
from .routing import (
    catalog_query_with_context,
    clamp_response_delay,
    conversation_key,
    department_for,
    is_service_question,
    needs_catalog,
)
from .storage import (
    append_message,
    get_conversation,
    get_active_prompt_version,
    get_system_setting,
    init_schema,
    mark_event,
    recent_messages,
    recover_stale_events,
    set_bot_status,
    set_system_setting,
    upsert_conversation,
)


settings = get_settings()
logging.basicConfig(
    level=getattr(logging, settings.log_level, logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("fusion-chatbot.worker")


def _fallback(department: str, reason: str) -> BotDecision:
    return BotDecision(settings.fallback_reply, True, department, reason[:240], "high")


def _callback(
    *,
    event_type: str,
    conversation: dict[str, Any],
    message: dict[str, Any],
    handoff: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return wordpress_callback({
        "event_id": str(uuid.uuid4()),
        "event_type": event_type,
        "conversation": conversation,
        "message": message,
        "handoff": handoff or {"requested": False},
    })


def _decision_for(
    *,
    key: str,
    text: str,
    conversation: dict[str, Any],
    department: str,
    external_id: str = '',
    revision: int | None = None,
) -> BotDecision:
    from .handoff_contact import finalize_handoff
    history = recent_messages(key, 40)
    def finish(decision):
        return finalize_handoff(decision, text, history, conversation)
    from .routing import explicit_handoff
    if explicit_handoff(text):
        return finish(BotDecision('Te derivo con un asesor para continuar con tu consulta.',True,department,'Atención humana solicitada','normal'))
    from .invoice_flow import invoice_decision
    invoice = invoice_decision(text, history, conversation, key)
    if invoice is not None:
        return finish(invoice)
    from .tracking_flow import tracking_decision
    tracking = tracking_decision(text, history, conversation, key)
    if tracking is not None:
        return finish(tracking)
    from .sales_engine import run as sales_reply
    seller=sales_reply(text,history,conversation,key,external_id,revision)
    if seller is not None:
        return finish(seller) if seller.reply else seller
    catalog_lookup_ok = False
    if text.startswith("[") and "recibid" in text.lower():
        return finish(_fallback(department, "El cliente envió un archivo que requiere revisión humana"))
    speed_profile = str(get_system_setting("speed_profile", "fast") or "fast").lower()
    profile = speed_profile_config(speed_profile)

    from .catalog_flow import catalog_decision
    budget_result = catalog_decision(text, history, conversation=conversation)
    if budget_result is not None:
        return finish(budget_result[0])

    from .tire_flow import tire_decision
    tire_reply, _ = tire_decision(text, history)
    if tire_reply is not None:
        return finish(tire_reply)
    sizing = bike_size_advice_decision(text)
    if sizing is not None:
        logger.info("direct_size_advice conversation=%s", key)
        return finish(sizing)
    products: list[dict[str, Any]] = []
    if needs_catalog(text):
        catalog_started = time.monotonic()
        try:
            if is_service_question(text):
                products = search_service_catalog(8)
            else:
                products = search_catalog(
                    catalog_query_with_context(text, history),
                    profile["product_limit"],
                )
            catalog_lookup_ok = True
        except Exception:
            logger.exception("Catalog lookup failed for conversation %s", key)
        finally:
            logger.info(
                "catalog_lookup conversation=%s products=%s elapsed_ms=%s",
                key,
                len(products),
                round((time.monotonic() - catalog_started) * 1000),
            )
    history=[dict(row,body='[Respuesta anterior con importes: consultar cotización actual]') if row.get('sender')=='bot' and any(cue in str(row.get('body','')).lower() for cue in ('$', 'cuotas', 'cbu', 'alias')) else row for row in history]
    try:
        active_prompt = get_active_prompt_version()
        direct = fast_catalog_decision(text, products, department, speed_profile, history=history, catalog_lookup_ok=catalog_lookup_ok)
        if direct is not None:
            logger.info("direct_catalog_reply conversation=%s profile=%s", key, speed_profile)
            return finish(direct)
        ai_started = time.monotonic()
        decision = generate_reply(
            latest_text=text,
            history=history,
            products=products,
            department=department,
            channel_label=str(conversation.get("channel_label") or department),
            prompt_config=active_prompt.get("config"),
            speed_profile=speed_profile,
        )
        logger.info(
            "ai_reply conversation=%s profile=%s elapsed_ms=%s",
            key,
            speed_profile,
            round((time.monotonic() - ai_started) * 1000),
        )
        from .payment_answers import guard_model_reply
        decision=guard_model_reply(decision)
        return finish(decision)
    except Exception as exc:
        logger.exception("AI generation failed for conversation %s", key)
        return finish(_fallback(department, f"La IA no respondió: {type(exc).__name__}"))


def _store_incoming(payload: dict[str, Any]) -> tuple[str, dict[str, Any], dict[str, Any], str, bool]:
    conversation = payload.get("conversation") if isinstance(payload.get("conversation"), dict) else {}
    message = payload.get("message") if isinstance(payload.get("message"), dict) else {}
    text = str(message.get("text") or "").strip()
    department = department_for(conversation, text)
    key = conversation_key(conversation)
    current = upsert_conversation(key, conversation, department)
    external_id = str(message.get("external_id") or payload.get("event_id") or "")
    _, inserted = append_message(
        key=key,
        external_id=external_id,
        sender="customer",
        body=text or "[Mensaje sin texto]",
        metadata={"source_event_id": payload.get("event_id"), "type": message.get("type", "text"),
                  "page_url": str(conversation.get("page_url") or "")[:2000],
                  "page_title": str(conversation.get("page_title") or "")[:500]},
    )
    return key, conversation, message, str(current.get("bot_status") or "active"), inserted


def _channel_bot_enabled(channel: str) -> bool:
    if not bool(get_system_setting("bot_enabled", settings.ai_enabled)):
        return False
    config = get_system_setting("bot_channel_config", {})
    return channel_bot_available(channel, config)


def _whatsapp_number_enabled(conversation: dict[str, Any]) -> bool:
    return number_bot_enabled(
        str(conversation.get("channel_number_id") or ""),
        settings.whatsapp_numbers,
        get_system_setting,
    )


def _bot_is_active(key: str) -> bool:
    current = get_conversation(key) or {}
    return (
        str(current.get("bot_status") or "active") == "active"
        and _channel_bot_enabled(str(current.get("channel") or "web"))
        and (current.get("channel") != "whatsapp" or _whatsapp_number_enabled(current))
    )


def _configured_delay() -> int:
    return clamp_response_delay(get_system_setting("response_delay_seconds", 0))


def _defer_reply(payload: dict[str, Any], delay: int) -> str:
    deferred = dict(payload)
    deferred["_deferred_reply"] = True
    schedule(deferred, delay)
    return "scheduled"


def _reply_web(payload: dict[str, Any], key: str, conversation: dict[str, Any], message: dict[str, Any]) -> None:
    if not _bot_is_active(key):
        return
    text = str(message.get("text") or "").strip()
    department = department_for(conversation, text)
    decision = _decision_for(key=key, text=text, conversation=conversation, department=department)
    if get_system_setting('web_inbox_enabled',False) is True:
        # A cutover during generation must never call the legacy send path.
        process_web_message(dict(payload, _deferred_reply=False))
        return
    if not _bot_is_active(key):
        return
    if decision.contact_phone:
        conversation = dict(conversation, customer_phone=decision.contact_phone)
    external_id = f"bot:{payload.get('event_id')}"
    delivered = _callback(
        event_type="bot_reply",
        conversation=conversation,
        message={
            "external_id": external_id,
            "sender": "bot",
            "agent_name": "Matías IA",
            "text": decision.reply,
            "status": "sent",
        },
        handoff={
            "requested": decision.handoff,
            "department": decision.department,
            "reason": decision.reason,
            "priority": decision.priority,
        },
    )
    if isinstance(delivered, dict) and delivered.get("skipped") == "human_control":
        return
    if decision.contact_phone:
        upsert_conversation(key, {"channel": conversation.get("channel") or "web", "customer_phone": decision.contact_phone}, decision.department)
    append_message(
        key=key,
        external_id=external_id,
        sender="bot",
        agent_name="Matías IA",
        body=decision.reply,
        metadata={"handoff": decision.handoff, "reason": decision.reason},
    )
    if decision.handoff:
        set_bot_status(key, "handoff")


def process_web_message(payload: dict[str, Any]) -> str:
    if get_system_setting('web_inbox_enabled',False) is True:
        from .inbox_web import ingest_web, web_source_id
        from .inbox_events import ai_revision, enqueue_ai
        key, should_reply, external_id = ingest_web(payload)
        if not should_reply:
            return 'done'
        if not payload.get('_deferred_reply'):
            delay = _configured_delay()
            if delay:
                return _defer_reply(payload, delay)
        revision = ai_revision(key, external_id)
        if revision is None:
            return 'done'
        conversation = dict(payload.get('conversation') or {})
        current = get_conversation(key) or {}
        conversation.update(customer_phone=current.get('customer_phone') or '', customer_name=current.get('customer_name') or '')
        message = payload.get('message') or {}
        text = str(message.get('text') or '').strip()
        decision = _decision_for(key=key,text=text,conversation=conversation,department=department_for(conversation,text),external_id=external_id,revision=revision)
        enqueue_ai(key,web_source_id(message),revision,decision)
        return 'done'
    if payload.get("_deferred_reply"):
        conversation = payload.get("conversation") if isinstance(payload.get("conversation"), dict) else {}
        message = payload.get("message") if isinstance(payload.get("message"), dict) else {}
        _reply_web(payload, conversation_key(conversation), conversation, message)
        return "done"
    key, conversation, message, bot_status, _ = _store_incoming(payload)
    if bot_status != "active" or not _channel_bot_enabled("web"):
        return "done"
    delay = _configured_delay()
    if delay:
        return _defer_reply(payload, delay)
    _reply_web(payload, key, conversation, message)
    return "done"


def _reply_whatsapp(payload: dict[str, Any], key: str, conversation: dict[str, Any], message: dict[str, Any]) -> None:
    from .inbox_events import ai_revision, enqueue_ai
    revision = ai_revision(key, str(message.get("external_id") or ""))
    if revision is None:
        return
    text = str(message.get("text") or "").strip()
    department = department_for(conversation, text)
    kind = str(message.get('type') or 'text')
    from .media_context import related_attachment
    linked=related_attachment(key,str(message.get('external_id') or '')) if kind=='text' else None
    target_id=str(message.get('external_id') or '')
    if linked:kind=linked['kind'];target_id=linked['external_id'];text=linked['caption']
    from .routing import explicit_handoff
    if explicit_handoff(text):
        from .handoff_contact import finalize_handoff
        decision=finalize_handoff(BotDecision('Te derivo con un asesor para continuar con tu consulta.',True,department,'Atención humana solicitada','normal'),text,recent_messages(key,40),conversation)
        enqueue_ai(key,'bot:'+str(payload.get('event_id') or ''),revision,decision)
        return
    decision = None
    media_revision = None
    if kind in ('image','audio'):
        from .multimedia import read_attachment,image_decision
        from .multimedia_config import MultimediaError
        try:
            result=read_attachment(key,target_id,revision,kind,**({'anchor_external_id':str(message.get('external_id') or '')} if linked else {}))
            media_revision=result['config_revision']
            if ai_revision(key,str(message.get('external_id') or ''))!=revision:return
            if kind=='audio':
                text=result['text']+('\n'+text if linked else '')
                department=department_for(conversation,text)
            else:decision=image_decision(result,department,text if linked or not text.startswith('[') else '')
        except Exception as exc:
            if isinstance(exc,MultimediaError) and str(exc)=='multimedia_in_progress':
                if linked and int(payload.get('_media_wait',0))<12:
                    _defer_reply(dict(payload,_media_wait=int(payload.get('_media_wait',0))+1),5)
                return
            if isinstance(exc,MultimediaError) and str(exc)=='multimedia_cancelled':return
            if ai_revision(key,str(message.get('external_id') or ''))!=revision:return
            from .handoff_contact import finalize_handoff
            decision=finalize_handoff(_fallback(department,'No se pudo interpretar el archivo; requiere revisión humana'),text,recent_messages(key,40),conversation)
    if decision is None:
        decision = _decision_for(key=key, text=text, conversation=conversation, department=department,external_id=str(message.get('external_id') or ''),revision=revision)
    if media_revision is not None:
        from .multimedia_config import read_config
        if read_config()['revision']!=media_revision:return
    enqueue_ai(key, "bot:" + str(payload.get("event_id") or ""), revision, decision)


def process_whatsapp_inbound(payload: dict[str, Any]) -> str:
    from .inbox_events import ingest
    if payload.get("_deferred_reply"):
        conversation = payload.get("conversation") or {}
        _reply_whatsapp(payload, conversation_key(conversation), conversation, payload.get("message") or {})
        return "done"
    key, should_reply = ingest(payload)
    if not should_reply:
        return "done"
    delay = _configured_delay()
    if delay:
        return _defer_reply(payload, delay)
    _reply_whatsapp(payload, key, payload.get("conversation") or {}, payload.get("message") or {})
    return "done"


def process_status(payload: dict[str, Any]) -> None:
    from .inbox_events import delivery_status
    delivery_status(payload)


def process_control(payload: dict[str, Any]) -> None:
    conversation = payload.get("conversation") if isinstance(payload.get("conversation"), dict) else {}
    control = payload.get("control") if isinstance(payload.get("control"), dict) else {}
    if conversation.get("channel") == "whatsapp" or get_system_setting('web_inbox_enabled',False) is True:
        return
    key = conversation_key(conversation)
    upsert_conversation(key, conversation, department_for(conversation), bot_status="active")
    action = str(control.get("action") or "")
    set_bot_status(key, "paused" if action == "take" else "active")


def process_agent_message(payload: dict[str, Any]) -> None:
    conversation = payload.get("conversation") if isinstance(payload.get("conversation"), dict) else {}
    if conversation.get("channel") == "whatsapp" or get_system_setting('web_inbox_enabled',False) is True:
        return
    message = payload.get("message") if isinstance(payload.get("message"), dict) else {}
    text = str(message.get("text") or "").strip()
    key = conversation_key(conversation)
    upsert_conversation(key, conversation, department_for(conversation, text), bot_status="paused")
    set_bot_status(key, "paused")
    append_message(
        key=key,
        external_id=str(message.get("external_id") or payload.get("event_id") or ""),
        sender="operator",
        agent_name=str(message.get("agent_name") or "Agente"),
        body=text,
        metadata={"source_event_id": payload.get("event_id")},
    )


def process_system_config(payload: dict[str, Any]) -> None:
    config = payload.get("config") if isinstance(payload.get("config"), dict) else {}
    if "bot_enabled" in config:
        set_system_setting("bot_enabled", bool(config.get("bot_enabled")))
    if "bot_channel_config" in config:
        set_system_setting("bot_channel_config", sanitize_channel_config(config.get("bot_channel_config")))
    if "response_delay_seconds" in config:
        set_system_setting("response_delay_seconds", clamp_response_delay(config.get("response_delay_seconds")))
    if "speed_profile" in config:
        profile = str(config.get("speed_profile") or "fast").strip().lower()
        set_system_setting("speed_profile", profile if profile in {"fast", "balanced", "quality"} else "fast")
    if "catalog_mode" in config:
        mode = str(config.get("catalog_mode") or "auto").strip().lower()
        set_system_setting("catalog_mode", mode if mode in {"auto", "xml", "wordpress"} else "auto")
    if "catalog_xml_source" in config:
        set_system_setting("catalog_xml_source", str(config.get("catalog_xml_source") or "").strip()[:1000])
    if "catalog_xml_refresh_seconds" in config:
        try:
            refresh = int(config.get("catalog_xml_refresh_seconds") or 360)
        except (TypeError, ValueError):
            refresh = 360
        set_system_setting("catalog_xml_refresh_seconds", max(60, min(refresh, 3600)))


def process_event(payload: dict[str, Any]) -> str:
    event_type = str(payload.get("event_type") or "")
    if event_type == "web_message":
        return process_web_message(payload)
    elif event_type == "whatsapp_inbound":
        return process_whatsapp_inbound(payload)
    elif event_type == "whatsapp_status":
        process_status(payload)
    elif event_type == "whatsapp_echo":
        from .inbox_events import ingest
        ingest(payload)
    elif event_type == "whatsapp_history_batch":
        from .inbox_webhook import history_events
        from .inbox_events import ingest
        for event in history_events(payload.get("value") or {}, settings):
            ingest(event)
    elif event_type == "conversation_control":
        process_control(payload)
    elif event_type == "agent_message":
        process_agent_message(payload)
    elif event_type == "system_config":
        process_system_config(payload)
    else:
        logger.warning("Ignoring unknown event type %s", event_type)
    return "done"


def run() -> None:
    init_schema()
    redis = redis_client()
    recovered = recover_stale_events(10)
    for payload in recovered:
        redis.rpush(settings.redis_queue, json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    if recovered:
        logger.warning("Recovered %s interrupted events", len(recovered))
    logger.info("Worker started; queue=%s", settings.redis_queue)
    while True:
        promote_due(redis)
        item = redis.blpop(settings.redis_queue, timeout=1)
        if not item:
            continue
        _, raw = item
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            logger.error("Discarding invalid JSON from queue")
            continue
        event_id = str(payload.get("event_id") or "")
        attempt = int(payload.pop("_attempt", 0) or 0)
        try:
            mark_event(event_id, "processing")
            final_status = process_event(payload)
            mark_event(event_id, final_status)
        except Exception as exc:
            logger.exception("Event %s failed on attempt %s", event_id, attempt + 1)
            if attempt < 4:
                payload["_attempt"] = attempt + 1
                time.sleep(min(2 ** attempt, 30))
                redis.rpush(settings.redis_queue, json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
                mark_event(event_id, "retrying", str(exc))
            else:
                mark_event(event_id, "failed", str(exc))


if __name__ == "__main__":
    run()
