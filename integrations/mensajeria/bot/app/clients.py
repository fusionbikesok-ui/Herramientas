from __future__ import annotations

import json
import logging
import re
import threading
import time
import unicodedata
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

import httpx

from .catalog_sqlite import catalog_snapshot_status, search_sqlite_catalog, search_sqlite_services
from .config import get_settings
from .security import sign_fusion_payload


class RemoteServiceError(RuntimeError):
    def __init__(self, message, status_code=None):
        super().__init__(message)
        self.status_code = status_code


logger = logging.getLogger("fusion-chatbot.catalog")


_xml_cache_lock = threading.Lock()
_xml_cache: dict[str, Any] = {
    "source": "",
    "loaded_at": 0.0,
    "products": [],
    "error": "",
}

_catalog_brands = {
    "bontrager", "cube", "garmin", "kush", "merida", "polygon", "santini",
    "topmega", "trek", "twitter", "venzo", "volta", "wahoo", "zion",
}
_catalog_qualifiers = {
    "bici", "bicicleta", "producto", "mtb", "ruta", "gravel", "e-bike",
    "rodado", "talle", "color", "stock", "precio", "cuota", "cuotas",
    "disponible", "disponibilidad", "xs", "s", "m", "l", "xl", "xxl",
}


def _runtime_setting(key: str, default: Any) -> Any:
    try:
        from .storage import get_system_setting

        return get_system_setting(key, default)
    except Exception:
        return default


def _normalize_search_text(value: Any) -> str:
    text = unicodedata.normalize("NFKD", str(value or ""))
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    return re.sub(r"\s+", " ", re.sub(r"[^a-zA-Z0-9_-]+", " ", text).lower()).strip()


def _local_name(tag: Any) -> str:
    return str(tag or "").rsplit("}", 1)[-1].lower()


def _xml_value(node: ET.Element, *names: str) -> str:
    wanted = {name.lower() for name in names}
    for child in node.iter():
        if _local_name(child.tag) in wanted and child.text:
            value = child.text.strip()
            if value:
                return value
    return ""


def _parse_price(value: Any) -> str:
    raw = re.sub(r"[^0-9.,-]", "", str(value or ""))
    if not raw:
        return ""
    if "," in raw and "." in raw:
        if raw.rfind(",") > raw.rfind("."):
            raw = raw.replace(".", "").replace(",", ".")
        else:
            raw = raw.replace(",", "")
    elif "," in raw:
        tail = raw.rsplit(",", 1)[-1]
        raw = raw.replace(",", "." if len(tail) <= 2 else "")
    try:
        return f"{float(raw):.2f}"
    except ValueError:
        return ""


def _parse_catalog_xml(data: bytes) -> list[dict[str, Any]]:
    root = ET.fromstring(data)
    nodes = [
        node for node in root.iter()
        if _local_name(node.tag) in {"item", "product", "entry"}
    ]
    products: list[dict[str, Any]] = []
    for node in nodes:
        name = _xml_value(node, "title", "name")
        url = _xml_value(node, "link", "url", "product_url")
        if not name or not url:
            continue
        availability = _normalize_search_text(_xml_value(node, "availability", "stock_status"))
        stock_quantity = _xml_value(node, "quantity", "stock", "stock_quantity")
        in_stock = availability not in {"out of stock", "out_of_stock", "agotado", "sin stock"}
        if stock_quantity.isdigit():
            in_stock = int(stock_quantity) > 0
        brand = _xml_value(node, "brand", "manufacturer", "marca")
        sku = _xml_value(node, "id", "sku", "mpn")
        description = _xml_value(node, "description", "product_type", "category")[:600]
        price = _parse_price(_xml_value(node, "sale_price", "price", "cash_price"))
        currency_text = _xml_value(node, "currency") or _xml_value(node, "price")
        currency = "USD" if "USD" in currency_text.upper() else "ARS"
        product = {
            "id": sku,
            "name": name,
            "sku": sku,
            "cash_price": price,
            "currency": currency,
            "free_shipping": False,
            "in_stock": in_stock,
            "brand": brand,
            "url": url,
            "variations": [],
            "payment_options": [],
            "_search_text": _normalize_search_text(" ".join((name, sku, brand, description))),
        }
        products.append(product)
    return products


def _read_xml_source(source: str) -> bytes:
    if source.startswith(("https://", "http://")):
        with httpx.Client(timeout=15.0, follow_redirects=True) as client:
            response = client.get(source, headers={"Accept": "application/xml,text/xml;q=0.9,*/*;q=0.1"})
        response.raise_for_status()
        return response.content
    return Path(source).expanduser().read_bytes()


def _xml_products(source: str, refresh_seconds: int) -> list[dict[str, Any]]:
    now = time.time()
    safe_refresh = max(60, min(int(refresh_seconds), 3600))
    with _xml_cache_lock:
        if (
            _xml_cache.get("source") == source
            and now - float(_xml_cache.get("loaded_at") or 0) < safe_refresh
            and isinstance(_xml_cache.get("products"), list)
        ):
            return list(_xml_cache["products"])
        try:
            products = _parse_catalog_xml(_read_xml_source(source))
            if not products:
                raise ValueError("El XML no contiene productos compatibles")
            _xml_cache.update({
                "source": source,
                "loaded_at": now,
                "products": products,
                "error": "",
            })
            return list(products)
        except Exception as exc:
            _xml_cache.update({"source": source, "loaded_at": now, "error": str(exc)[:240]})
            return []


def _search_xml_catalog(source: str, query: str, limit: int, refresh_seconds: int) -> list[dict[str, Any]]:
    normalized = _normalize_search_text(query)
    tokens = [token for token in normalized.split() if len(token) > 1]
    if not tokens:
        return []
    ranked: list[tuple[int, dict[str, Any]]] = []
    for product in _xml_products(source, refresh_seconds):
        text = str(product.get("_search_text") or "")
        name = _normalize_search_text(product.get("name"))
        sku = _normalize_search_text(product.get("sku"))
        brand = _normalize_search_text(product.get("brand"))
        query_brands = [token for token in tokens if token in _catalog_brands]
        brand_text = f" {name.replace('-', ' ')} {brand.replace('-', ' ')} "
        if query_brands and any(f" {token} " not in brand_text for token in query_brands):
            continue
        identity_tokens = [
            token for token in tokens
            if token not in _catalog_brands
            and token not in _catalog_qualifiers
            and not token.isdigit()
        ]
        identity_text = f"{name} {sku}"
        if identity_tokens and any(token not in identity_text for token in identity_tokens):
            continue
        score = 100 if normalized and normalized in text else 0
        matched = 0
        for token in tokens:
            if token in name:
                score += 24
                matched += 1
            elif token in text:
                score += 7
                matched += 1
        if matched == 0:
            continue
        if product.get("in_stock"):
            score += 5
        ranked.append((score, product))
    ranked.sort(key=lambda item: item[0], reverse=True)
    clean: list[dict[str, Any]] = []
    for _, product in ranked[: max(1, min(limit, 12))]:
        clean.append({key: value for key, value in product.items() if not key.startswith("_")})
    return clean


def _requires_live_variations(query: str) -> bool:
    normalized = _normalize_search_text(query)
    if re.search(r"\b(?:talle|size|tamano|color)\b", normalized):
        return True
    return bool(re.search(r"\b(?:xs|xxl|xl)\b", normalized))


def _requires_live_payment_options(query: str) -> bool:
    normalized = _normalize_search_text(query)
    return bool(re.search(r"\b(?:cuota|cuotas|financiacion|financiar|tarjeta|visa|mastercard|naranja)\b", normalized))


def normalize_whatsapp_recipient(value: Any) -> str:
    recipient = "".join(ch for ch in str(value) if ch.isdigit())
    # Meta puede entregar el wa_id argentino como 549..., mientras que el
    # destinatario autorizado por Cloud API queda registrado como 54...
    # (sin el 9 móvil internacional). Ambos representan el mismo número.
    if recipient.startswith("549") and len(recipient) == 13:
        recipient = "54" + recipient[3:]
    return recipient


def _signed_headers(body: bytes) -> dict[str, str]:
    settings = get_settings()
    timestamp = str(int(time.time()))
    return {
        "Content-Type": "application/json; charset=utf-8",
        "Accept": "application/json",
        "X-Fusion-API-Key": settings.api_key,
        "X-Fusion-Timestamp": timestamp,
        "X-Fusion-Signature": sign_fusion_payload(settings.callback_secret, timestamp, body),
    }


def post_wordpress(url: str, payload: dict[str, Any], timeout: float = 25.0) -> dict[str, Any]:
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    with httpx.Client(timeout=timeout, follow_redirects=False) as client:
        response = client.post(url, content=body, headers=_signed_headers(body))
    if response.status_code < 200 or response.status_code >= 300:
        raise RemoteServiceError(f"WordPress HTTP {response.status_code}: {response.text[:240]}", status_code=response.status_code)
    try:
        data = response.json()
    except ValueError as exc:
        raise RemoteServiceError("WordPress devolvió una respuesta no JSON") from exc
    return data if isinstance(data, dict) else {"ok": True, "data": data}


def wordpress_callback(payload: dict[str, Any]) -> dict[str, Any]:
    return post_wordpress(get_settings().wordpress_inbound_url, payload)


def _search_catalog(query: str, limit: int = 6) -> list[dict[str, Any]]:
    if len(query.strip()) < 2:
        return []
    settings = get_settings()
    mode = str(_runtime_setting("catalog_mode", "auto") or "auto").strip().lower()
    source = str(_runtime_setting("catalog_xml_source", settings.catalog_xml_source) or "").strip()
    refresh = _runtime_setting("catalog_xml_refresh_seconds", settings.catalog_xml_refresh_seconds)
    local_products: list[dict[str, Any]] = []
    if mode != "wordpress" and not _requires_live_payment_options(query):
        local_products = search_sqlite_catalog(
            settings.catalog_sqlite_path,
            settings.wordpress_base_url,
            query,
            limit,
            settings.catalog_sqlite_max_age_seconds,
        )
        if local_products and mode != "xml":
            logger.info("catalog_source=sqlite products=%s", len(local_products))
            return local_products
    if (
        mode != "wordpress"
        and source
        and not _requires_live_variations(query)
        and not _requires_live_payment_options(query)
    ):
        products = _search_xml_catalog(source, query, limit, int(refresh or 360))
        if products:
            logger.info("catalog_source=xml products=%s", len(products))
            return products
    if local_products:
        logger.info("catalog_source=sqlite products=%s", len(local_products))
        return local_products
    result = post_wordpress(
        settings.wordpress_catalog_url,
        {"query": query.strip(), "limit": max(1, min(limit, 12))},
        timeout=30.0,
    )
    products = result.get("products", [])
    logger.info("catalog_source=wordpress products=%s", len(products) if isinstance(products, list) else 0)
    return products if isinstance(products, list) else []


def search_catalog(query: str, limit: int = 6):
    from .commercial_prices import hydrate,untrusted
    return hydrate(untrusted(_search_catalog(query,limit)))


def local_catalog_status() -> dict[str, Any]:
    settings = get_settings()
    return catalog_snapshot_status(
        settings.catalog_sqlite_path,
        settings.wordpress_base_url,
        settings.catalog_sqlite_max_age_seconds,
    )


def _store_api_service_catalog(limit: int = 8) -> list[dict[str, Any]]:
    """Read products from the exact WooCommerce category slug `service`."""
    settings = get_settings()
    base = settings.wordpress_base_url.rstrip("/") + "/wp-json/wc/store/v1"
    with httpx.Client(timeout=20.0, follow_redirects=True) as client:
        category_response = client.get(
            base + "/products/categories",
            params={"search": "service", "per_page": 20, "hide_empty": "false"},
            headers={"Accept": "application/json"},
        )
        category_response.raise_for_status()
        categories = category_response.json()
        if not isinstance(categories, list):
            return []
        category = next(
            (
                item for item in categories
                if isinstance(item, dict)
                and (
                    _normalize_search_text(item.get("slug")) == "service"
                    or _normalize_search_text(item.get("name")) == "service"
                )
            ),
            None,
        )
        if not category or not category.get("id"):
            return []
        product_response = client.get(
            base + "/products",
            params={
                "category": int(category["id"]),
                "per_page": max(1, min(int(limit), 20)),
                "orderby": "menu_order",
                "order": "asc",
            },
            headers={"Accept": "application/json"},
        )
        product_response.raise_for_status()
        rows = product_response.json()
    if not isinstance(rows, list):
        return []
    products: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict) or not row.get("is_in_stock"):
            continue
        prices = row.get("prices") if isinstance(row.get("prices"), dict) else {}
        raw_price = str(prices.get("price") or "")
        try:
            minor_unit = max(0, min(int(prices.get("currency_minor_unit") or 0), 6))
            cash_price = f"{int(raw_price) / (10 ** minor_unit):.2f}" if raw_price else ""
        except (TypeError, ValueError):
            cash_price = ""
        images = row.get("images") if isinstance(row.get("images"), list) else []
        image = images[0] if images and isinstance(images[0], dict) else {}
        products.append({
            "id": row.get("id"),
            "name": str(row.get("name") or "Service").strip(),
            "sku": str(row.get("sku") or "").strip(),
            "cash_price": cash_price,
            "currency": str(prices.get("currency_code") or "ARS"),
            "free_shipping": False,
            "in_stock": True,
            "brand": "Fusion Bikes",
            "url": str(row.get("permalink") or "").strip(),
            "image": str(image.get("thumbnail") or image.get("src") or "").strip(),
            "variations": [],
            "payment_options": [],
        })
    return products


def _search_service_catalog(limit: int = 8) -> list[dict[str, Any]]:
    settings = get_settings()
    mode = str(_runtime_setting("catalog_mode", "auto") or "auto").strip().lower()
    if mode != "wordpress":
        products = search_sqlite_services(
            settings.catalog_sqlite_path,
            settings.wordpress_base_url,
            limit,
            settings.catalog_sqlite_max_age_seconds,
        )
        if products:
            logger.info("service_catalog_source=sqlite products=%s", len(products))
            return products
    try:
        products = _store_api_service_catalog(limit)
        if products:
            logger.info("service_catalog_source=wordpress_store_api products=%s", len(products))
            return products
    except Exception:
        # El endpoint firmado existente queda como respaldo para instalaciones
        # que tengan desactivada la Store API pública.
        pass
    return search_catalog("service", limit)


def search_service_catalog(limit: int = 8):
    from .commercial_prices import hydrate,untrusted
    return hydrate(untrusted(_search_service_catalog(limit)))


def send_whatsapp_text(phone_number_id: str, recipient: str, text: str) -> str:
    settings = get_settings()
    if not settings.number(phone_number_id):
        raise RemoteServiceError(f"Phone Number ID no configurado: {phone_number_id}")
    recipient = normalize_whatsapp_recipient(recipient)
    if not recipient:
        raise RemoteServiceError("Destinatario de WhatsApp vacío")

    url = (
        f"https://graph.facebook.com/{settings.meta_graph_version}/"
        f"{phone_number_id}/messages"
    )
    payload = {
        "messaging_product": "whatsapp",
        "recipient_type": "individual",
        "to": recipient,
        "type": "text",
        "text": {"preview_url": True, "body": text[:4096]},
    }
    headers = {
        "Authorization": f"Bearer {settings.whatsapp_access_token}",
        "Content-Type": "application/json",
    }
    with httpx.Client(timeout=30.0) as client:
        response = client.post(url, json=payload, headers=headers)
    if response.status_code < 200 or response.status_code >= 300:
        raise RemoteServiceError(f"Meta HTTP {response.status_code}: {response.text[:320]}")
    data = response.json()
    try:
        return str(data["messages"][0]["id"])
    except (KeyError, IndexError, TypeError) as exc:
        raise RemoteServiceError("Meta aceptó la solicitud pero no devolvió message_id") from exc
