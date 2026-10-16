from __future__ import annotations

import json
import logging
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse, PlainTextResponse
from starlette.concurrency import run_in_threadpool

from . import __version__
from .availability import channel_bot_available
from .ai import bike_size_advice_decision, fast_catalog_decision, generate_reply, speed_profile_config
from .clients import RemoteServiceError, local_catalog_status, search_catalog, search_service_catalog, send_whatsapp_text
from .config import get_settings
from .prompting import sanitize_prompt_config
from .queueing import enqueue, redis_client
from .routing import (
    catalog_query_with_context,
    conversation_key,
    department_for,
    is_service_question,
    needs_catalog,
    normalize_conversation_history,
)
from .security import verify_fusion_request, verify_meta_signature
from .storage import (
    activate_prompt_version,
    append_message,
    connection,
    get_active_prompt_version,
    get_system_setting,
    init_schema,
    list_prompt_versions,
    save_prompt_version,
    set_bot_status,
    upsert_conversation,
)


settings = get_settings()
logging.basicConfig(
    level=getattr(logging, settings.log_level, logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("fusion-chatbot.api")


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_schema()
    redis_client().ping()
    yield


app = FastAPI(
    title="Fusion Bikes Chatbot",
    version=__version__,
    docs_url=None if settings.app_env == "production" else "/docs",
    redoc_url=None,
    lifespan=lifespan,
)


async def authenticated_json(request: Request) -> tuple[bytes, dict[str, Any]]:
    body = await request.body()
    valid, reason = verify_fusion_request(
        expected_api_key=settings.api_key,
        expected_secret=settings.callback_secret,
        supplied_api_key=request.headers.get("x-fusion-api-key", ""),
        supplied_timestamp=request.headers.get("x-fusion-timestamp", ""),
        supplied_signature=request.headers.get("x-fusion-signature", ""),
        body=body,
    )
    if not valid:
        raise HTTPException(status_code=401, detail=reason)
    try:
        payload = json.loads(body)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="invalid_json") from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="json_object_required")
    return body, payload


@app.get("/health")
def health() -> dict[str, Any]:
    checks = {"database": False, "redis": False}
    try:
        with connection() as conn:
            checks["database"] = bool(conn.execute("SELECT 1 AS ok").fetchone())
    except Exception:
        logger.exception("Database health check failed")
    try:
        checks["redis"] = bool(redis_client().ping())
    except Exception:
        logger.exception("Redis health check failed")
    issues = settings.configuration_issues()
    catalog = local_catalog_status()
    checks["catalog_sqlite"] = bool(catalog.get("fresh"))
    master_bot_enabled = bool(get_system_setting("bot_enabled", settings.ai_enabled))
    channel_config = get_system_setting("bot_channel_config", {})
    return {
        "ok": bool(checks["database"] and checks["redis"]),
        "service": "fusion-chatbot",
        "version": __version__,
        "checks": checks,
        "catalog": catalog,
        "bot_channels": {
            "web": master_bot_enabled and channel_bot_available("web", channel_config),
            "whatsapp": master_bot_enabled and channel_bot_available("whatsapp", channel_config),
        },
        "configuration_ready": not issues,
        "missing_configuration": issues,
    }


@app.post("/v1/events", status_code=202)
async def receive_wordpress_event(request: Request) -> dict[str, Any]:
    _, payload = await authenticated_json(request)
    if not payload.get("event_id") or not payload.get("event_type"):
        raise HTTPException(status_code=422, detail="event_id_and_event_type_required")
    inserted = enqueue(payload)
    return {"ok": True, "queued": inserted, "duplicate": not inserted}


@app.post("/v1/prompt/get")
async def get_prompt_configuration(request: Request) -> dict[str, Any]:
    await authenticated_json(request)
    return {
        "ok": True,
        "active": get_active_prompt_version(),
        "versions": list_prompt_versions(10),
    }


@app.post("/v1/prompt/save")
async def save_prompt_configuration(request: Request) -> dict[str, Any]:
    _, payload = await authenticated_json(request)
    config = payload.get("config")
    if not isinstance(config, dict):
        raise HTTPException(status_code=422, detail="prompt_config_required")
    saved = save_prompt_version(
        sanitize_prompt_config(config),
        str(payload.get("updated_by") or "WooCommerce"),
    )
    return {"ok": True, "active": saved, "versions": list_prompt_versions(10)}


@app.post("/v1/prompt/activate")
async def activate_prompt_configuration(request: Request) -> dict[str, Any]:
    _, payload = await authenticated_json(request)
    try:
        revision = int(payload.get("revision"))
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail="valid_revision_required") from exc
    active = activate_prompt_version(revision)
    if not active:
        raise HTTPException(status_code=404, detail="prompt_revision_not_found")
    return {"ok": True, "active": active, "versions": list_prompt_versions(10)}


@app.post("/v1/prompt/test")
async def test_prompt_configuration(request: Request) -> dict[str, Any]:
    catalog_lookup_ok = False
    total_started = time.monotonic()
    _, payload = await authenticated_json(request)
    message = str(payload.get("message") or "").strip()
    if not message:
        raise HTTPException(status_code=422, detail="test_message_required")
    config = sanitize_prompt_config(payload.get("config"))
    department = department_for({}, message)
    speed_profile = str(payload.get("speed_profile") or "fast").strip().lower()
    if speed_profile not in {"fast", "balanced", "quality"}:
        speed_profile = "fast"
    profile = speed_profile_config(speed_profile)
    history = normalize_conversation_history(payload.get("conversation_history"), 40)

    budget_started = time.monotonic()
    from .catalog_flow import catalog_decision
    conversation = payload.get("conversation") if isinstance(payload.get("conversation"), dict) else {}
    from .handoff_contact import finalize_handoff
    budget_result = await run_in_threadpool(catalog_decision, message, history, conversation=conversation)
    if budget_result is not None:
        decision, budget_products = budget_result
        decision = finalize_handoff(decision, message, history, conversation)
        return {
            "ok": True,
            "preview": {
                "reply": decision.reply,
                "handoff": decision.handoff,
                "department": decision.department,
                "reason": decision.reason,
                "priority": decision.priority,
                "products_used": len(budget_products),
                "speed_profile": speed_profile,
                "catalog_ms": round((time.monotonic() - budget_started) * 1000),
                "ai_ms": 0,
                "total_ms": round((time.monotonic() - total_started) * 1000),
                "model": settings.ai_model,
                "direct_catalog_reply": True,
            },
        }
    products: list[dict[str, Any]] = []
    catalog_ms = 0
    from .tire_flow import tire_decision
    direct, tire_products = await run_in_threadpool(
        tire_decision, message, history
    )
    if direct is not None:
        products = tire_products
    else:
        direct = bike_size_advice_decision(message)
    if direct is None and needs_catalog(message):
        catalog_started = time.monotonic()
        try:
            if is_service_question(message):
                products = await run_in_threadpool(search_service_catalog, 8)
            else:
                products = await run_in_threadpool(
                    search_catalog,
                    catalog_query_with_context(message, history),
                    profile["product_limit"],
                )
            catalog_lookup_ok = True
        except Exception:
            logger.exception("Catalog lookup failed during prompt preview")
        catalog_ms = round((time.monotonic() - catalog_started) * 1000)
    if direct is None:
        direct = fast_catalog_decision(message, products, department, speed_profile, history=history, catalog_lookup_ok=catalog_lookup_ok)
    if direct is not None:
        decision = direct
        ai_ms = 0
    else:
        ai_started = time.monotonic()
        decision = await run_in_threadpool(
            generate_reply,
            latest_text=message[:3000],
            history=history,
            products=products,
            department=department,
            channel_label="Vista previa",
            prompt_config=config,
            speed_profile=speed_profile,
        )
        ai_ms = round((time.monotonic() - ai_started) * 1000)
    decision = finalize_handoff(decision, message, history, conversation)
    return {
        "ok": True,
        "preview": {
            "reply": decision.reply,
            "handoff": decision.handoff,
            "department": decision.department,
            "reason": decision.reason,
            "priority": decision.priority,
            "products_used": len(products),
            "speed_profile": speed_profile,
            "catalog_ms": catalog_ms,
            "ai_ms": ai_ms,
            "total_ms": round((time.monotonic() - total_started) * 1000),
            "model": settings.ai_model,
            "direct_catalog_reply": direct is not None,
        },
    }


@app.post("/v1/outbound/whatsapp")
async def outbound_whatsapp(request: Request) -> dict[str, Any]:
    _, payload = await authenticated_json(request)
    conversation = payload.get("conversation") if isinstance(payload.get("conversation"), dict) else {}
    message = payload.get("message") if isinstance(payload.get("message"), dict) else {}
    phone_number_id = str(conversation.get("channel_number_id") or "")
    recipient = str(conversation.get("external_user_id") or conversation.get("customer_phone") or "")
    text = str(message.get("text") or "").strip()
    if not phone_number_id or not recipient or not text:
        raise HTTPException(status_code=422, detail="phone_number_id_recipient_and_text_required")

    key = conversation_key(conversation)
    upsert_conversation(key, conversation, department_for(conversation, text), bot_status="paused")
    set_bot_status(key, "paused")
    try:
        message_id = send_whatsapp_text(phone_number_id, recipient, text)
    except RemoteServiceError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    append_message(
        key=key,
        external_id=message_id,
        sender="operator",
        agent_name=str(message.get("agent_name") or "Agente"),
        body=text,
        metadata={"source_event_id": payload.get("event_id")},
    )
    return {"ok": True, "message_id": message_id, "status": "accepted"}


@app.get("/webhooks/whatsapp")
def verify_whatsapp_webhook(request: Request) -> Response:
    query = request.query_params
    mode = query.get("hub.mode", "")
    token = query.get("hub.verify_token", "")
    challenge = query.get("hub.challenge", "")
    if mode == "subscribe" and token and token == settings.meta_verify_token:
        return PlainTextResponse(challenge, status_code=200)
    raise HTTPException(status_code=403, detail="webhook_verification_failed")


def _text_from_whatsapp(message: dict[str, Any]) -> tuple[str, str]:
    kind = str(message.get("type") or "unknown")
    if kind == "text":
        return str((message.get("text") or {}).get("body") or ""), kind
    if kind == "button":
        return str((message.get("button") or {}).get("text") or ""), kind
    if kind == "interactive":
        interactive = message.get("interactive") or {}
        reply = interactive.get("button_reply") or interactive.get("list_reply") or {}
        return str(reply.get("title") or reply.get("id") or ""), kind
    labels = {
        "image": "[Imagen recibida]",
        "audio": "[Audio recibido]",
        "video": "[Video recibido]",
        "document": "[Documento recibido]",
        "location": "[Ubicación recibida]",
        "contacts": "[Contacto recibido]",
        "sticker": "[Sticker recibido]",
    }
    return labels.get(kind, f"[Mensaje de tipo {kind}]"), kind


def _events_from_meta(payload: dict[str, Any]) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for entry in payload.get("entry", []):
        for change in entry.get("changes", []):
            value = change.get("value") if isinstance(change.get("value"), dict) else {}
            metadata = value.get("metadata") if isinstance(value.get("metadata"), dict) else {}
            phone_number_id = str(metadata.get("phone_number_id") or "")
            number_config = settings.number(phone_number_id)
            contacts = value.get("contacts") if isinstance(value.get("contacts"), list) else []
            contact_by_id: dict[str, dict[str, Any]] = {
                str(contact.get("wa_id") or ""): contact for contact in contacts if isinstance(contact, dict)
            }

            for message in value.get("messages", []):
                if not isinstance(message, dict):
                    continue
                message_id = str(message.get("id") or uuid.uuid4())
                sender = str(message.get("from") or "")
                contact = contact_by_id.get(sender, {})
                profile = contact.get("profile") if isinstance(contact.get("profile"), dict) else {}
                text, message_type = _text_from_whatsapp(message)
                events.append({
                    "event_id": f"wa:{message_id}",
                    "event_type": "whatsapp_inbound",
                    "occurred_at": str(message.get("timestamp") or ""),
                    "conversation": {
                        "channel": "whatsapp",
                        "external_conversation_id": f"{phone_number_id}:{sender}",
                        "external_user_id": sender,
                        "channel_number_id": phone_number_id,
                        "channel_label": number_config.get("label", "WhatsApp"),
                        "customer_name": str(profile.get("name") or "Cliente de WhatsApp"),
                        "customer_phone": sender,
                        "page_title": f"WhatsApp · {number_config.get('label', 'Fusion Bikes')}",
                    },
                    "message": {
                        "external_id": message_id,
                        "sender": "customer",
                        "text": text,
                        "type": message_type,
                        "raw": message,
                    },
                })

            for status in value.get("statuses", []):
                if not isinstance(status, dict):
                    continue
                message_id = str(status.get("id") or "")
                state = str(status.get("status") or "unknown")
                stamp = str(status.get("timestamp") or "")
                events.append({
                    "event_id": f"wa-status:{message_id}:{state}:{stamp}",
                    "event_type": "whatsapp_status",
                    "occurred_at": stamp,
                    "conversation": {
                        "channel": "whatsapp",
                        "channel_number_id": phone_number_id,
                        "channel_label": number_config.get("label", "WhatsApp"),
                        "external_user_id": str(status.get("recipient_id") or ""),
                    },
                    "message": {
                        "external_id": message_id,
                        "status": state,
                        "errors": status.get("errors", []),
                    },
                })
    return events


@app.post("/webhooks/whatsapp")
async def whatsapp_webhook(request: Request) -> JSONResponse:
    body = await request.body()
    if not verify_meta_signature(
        settings.meta_app_secret,
        request.headers.get("x-hub-signature-256", ""),
        body,
    ):
        raise HTTPException(status_code=401, detail="invalid_meta_signature")
    try:
        payload = json.loads(body)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="invalid_json") from exc
    if payload.get("object") != "whatsapp_business_account":
        return JSONResponse({"ok": True, "ignored": True})
    events = _events_from_meta(payload)
    queued = sum(1 for event in events if enqueue(event))
    return JSONResponse({"ok": True, "received": len(events), "queued": queued})


@app.post("/v1/learning/{operation}")
async def learning_console(operation: str, request: Request) -> dict[str, Any]:
    _, payload = await authenticated_json(request)
    from .learning_console import handle
    try:
        return await run_in_threadpool(handle, operation, payload)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
