from __future__ import annotations

import json
import re
import sqlite3
import threading
import time
import unicodedata
from pathlib import Path
from typing import Any


CATALOG_TABLE = "catalog_products"

_BRANDS = {
    "bontrager", "cube", "garmin", "kush", "merida", "polygon", "santini",
    "topmega", "trek", "twitter", "venzo", "volta", "wahoo", "zion",
}
_QUALIFIERS = {
    "bici", "bicicleta", "producto", "mtb", "ruta", "gravel", "e-bike",
    "ebike", "rodado", "talle", "color", "stock", "precio", "cuota",
    "cuotas", "disponible", "disponibilidad", "xs", "s", "m", "l", "xl",
    "xxl", "service", "services", "taller",
}

_cache_lock = threading.Lock()
_cache: dict[str, Any] = {
    "path": "",
    "mtime_ns": -1,
    "products": [],
    "metadata": {},
    "loaded_at": 0.0,
    "error": "",
}


def normalize_catalog_value(value: Any) -> str:
    text = unicodedata.normalize("NFKD", str(value or ""))
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    return re.sub(r"\s+", " ", re.sub(r"[^a-zA-Z0-9_-]+", " ", text).lower()).strip()


def _json_list(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    try:
        parsed = json.loads(str(value or "[]"))
    except (TypeError, ValueError, json.JSONDecodeError):
        return []
    return parsed if isinstance(parsed, list) else []


def _stock(value: Any) -> int:
    try:
        return max(0, int(float(value or 0)))
    except (TypeError, ValueError):
        return 0


def _price(value: Any) -> str:
    try:
        return f"{float(value):.2f}" if value not in (None, "") else ""
    except (TypeError, ValueError):
        return ""


def _attributes(value: Any) -> dict[str, str]:
    result: dict[str, str] = {}
    for item in _json_list(value):
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        option = str(item.get("option") or "").strip()
        if not name or not option:
            continue
        key = normalize_catalog_value(name).replace("-", "_").replace(" ", "_")
        result[f"attribute_pa_{key}"] = option
    return result


def _metadata(connection: sqlite3.Connection) -> dict[str, str]:
    try:
        return {
            str(row[0]): str(row[1])
            for row in connection.execute("SELECT key, value FROM metadata")
        }
    except sqlite3.Error:
        return {}


def _build_products(rows: list[sqlite3.Row], base_url: str) -> list[dict[str, Any]]:
    parents: dict[int, dict[str, Any]] = {}
    variations: dict[int, list[sqlite3.Row]] = {}
    for row in rows:
        row_id = int(row["id_woo"])
        if str(row["tipo"] or "").lower() == "variation" and row["id_padre"] is not None:
            variations.setdefault(int(row["id_padre"]), []).append(row)
        else:
            parents[row_id] = dict(row)

    products: list[dict[str, Any]] = []
    for product_id, row in parents.items():
        product_variations: list[dict[str, Any]] = []
        for variation in variations.get(product_id, []):
            quantity = _stock(variation["stock"])
            product_variations.append({
                "id": int(variation["id_woo"]),
                "sku": str(variation["sku"] or "").strip(),
                "attributes": _attributes(variation["atributos_json"]),
                "display_price": _price(
                    variation["precio"] if variation["precio"] is not None else variation["regular_price"]
                ),
                "is_in_stock": quantity > 0,
                "stock_quantity": quantity,
                "_search_text": normalize_catalog_value(
                    f"{variation['nombre']} {variation['sku']} {variation['atributos_json']}"
                ),
            })
        product_variations.sort(
            key=lambda item: (not bool(item["is_in_stock"]), str(item.get("sku") or ""))
        )

        product_type = str(row.get("tipo") or "simple").lower()
        if product_type == "variable":
            stock_quantity = sum(
                int(item["stock_quantity"])
                for item in product_variations
                if item.get("is_in_stock")
            )
            in_stock = stock_quantity > 0
        else:
            stock_quantity = _stock(row.get("stock"))
            in_stock = stock_quantity > 0

        price = _price(row.get("precio") if row.get("precio") is not None else row.get("regular_price"))
        if not price:
            variation_prices = [
                str(item.get("display_price") or "")
                for item in product_variations
                if str(item.get("display_price") or "")
            ]
            if variation_prices:
                price = min(variation_prices, key=lambda value: float(value))

        categories = [str(item) for item in _json_list(row.get("categorias_json"))]
        name = str(row.get("nombre") or "Producto").strip()
        sku = str(row.get("sku") or "").strip()
        brand = str(row.get("marca") or "").strip()
        search_text = normalize_catalog_value(
            " ".join((name, sku, brand, " ".join(categories)))
        )
        if product_variations:
            search_text += " " + " ".join(
                str(item.get("_search_text") or "") for item in product_variations
            )

        products.append({
            "id": product_id,
            "name": name,
            "sku": sku,
            "cash_price": price,
            "regular_price": _price(row.get("regular_price")),
            "currency": "ARS",
            "free_shipping": False,
            "in_stock": in_stock,
            "stock_quantity": stock_quantity,
            "brand": brand,
            "url": f"{base_url.rstrip('/')}/?p={product_id}",
            "image": str(row.get("img") or "").strip(),
            "variations": product_variations,
            "payment_options": [],
            "categories": categories,
            "updated_at": str(row.get("actualizado_en") or ""),
            "_search_text": search_text.strip(),
            "_name_normalized": normalize_catalog_value(name),
            "_sku_normalized": normalize_catalog_value(sku),
            "_brand_normalized": normalize_catalog_value(brand),
        })
    return products


def _load_snapshot(path: str | Path, base_url: str, max_age_seconds: int) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    source = Path(path)
    now = time.time()
    try:
        stat = source.stat()
    except OSError as exc:
        return [], {"available": False, "fresh": False, "error": str(exc)[:240]}

    age_seconds = max(0, round(now - stat.st_mtime, 3))
    safe_max_age = max(180, int(max_age_seconds))
    if age_seconds > safe_max_age:
        return [], {
            "available": True,
            "fresh": False,
            "age_seconds": age_seconds,
            "error": "catalog_snapshot_stale",
        }

    cache_key = str(source.resolve())
    with _cache_lock:
        if _cache.get("path") == cache_key and _cache.get("mtime_ns") == stat.st_mtime_ns:
            products = list(_cache.get("products") or [])
            metadata = dict(_cache.get("metadata") or {})
            return products, {
                "available": True,
                "fresh": True,
                "age_seconds": age_seconds,
                "rows": len(products),
                "metadata": metadata,
                "error": "",
            }
        try:
            connection = sqlite3.connect(f"file:{source}?mode=ro", uri=True, timeout=5.0)
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA query_only=ON")
            rows = connection.execute(f"SELECT * FROM {CATALOG_TABLE}").fetchall()
            metadata = _metadata(connection)
            connection.close()
            products = _build_products(rows, base_url)
            if not products:
                raise ValueError("catalog_snapshot_empty")
            _cache.update({
                "path": cache_key,
                "mtime_ns": stat.st_mtime_ns,
                "products": products,
                "metadata": metadata,
                "loaded_at": now,
                "error": "",
            })
            return list(products), {
                "available": True,
                "fresh": True,
                "age_seconds": age_seconds,
                "rows": len(products),
                "metadata": dict(metadata),
                "error": "",
            }
        except Exception as exc:
            _cache.update({"path": cache_key, "mtime_ns": stat.st_mtime_ns, "error": str(exc)[:240]})
            return [], {
                "available": True,
                "fresh": False,
                "age_seconds": age_seconds,
                "error": str(exc)[:240],
            }


def catalog_snapshot_status(path: str | Path, base_url: str, max_age_seconds: int = 900) -> dict[str, Any]:
    _, status = _load_snapshot(path, base_url, max_age_seconds)
    return status


def _public_product(product: dict[str, Any], query_tokens: list[str]) -> dict[str, Any]:
    clean = {key: value for key, value in product.items() if not key.startswith("_")}
    variations = list(clean.get("variations") or [])
    def variation_score(item: dict[str, Any]) -> int:
        words = set(normalize_catalog_value(item.get("_search_text")).replace("-", " ").split())
        return sum(1 for token in query_tokens if token in words)
    variations.sort(
        key=lambda item: (
            -variation_score(item),
            not bool(item.get("is_in_stock")),
        )
    )
    clean["variations"] = [
        {key: value for key, value in item.items() if not key.startswith("_")}
        for item in variations[:40]
    ]
    return clean


def search_sqlite_catalog(
    path: str | Path,
    base_url: str,
    query: str,
    limit: int = 6,
    max_age_seconds: int = 900,
) -> list[dict[str, Any]]:
    products, status = _load_snapshot(path, base_url, max_age_seconds)
    if not status.get("fresh"):
        return []
    normalized = normalize_catalog_value(query)
    tokens = [token for token in normalized.split() if len(token) > 1 or token in _QUALIFIERS]
    if not tokens:
        return []
    query_brands = [token for token in tokens if token in _BRANDS]
    identity_tokens = [
        token for token in tokens
        if token not in _BRANDS and token not in _QUALIFIERS and not token.isdigit()
    ]

    ranked: list[tuple[int, dict[str, Any]]] = []
    for product in products:
        name = str(product.get("_name_normalized") or "")
        sku = str(product.get("_sku_normalized") or "")
        brand = str(product.get("_brand_normalized") or "")
        text = str(product.get("_search_text") or "")
        brand_text = f" {name.replace('-', ' ')} {brand.replace('-', ' ')} "
        if query_brands and any(f" {token} " not in brand_text for token in query_brands):
            continue
        identity_text = f"{name} {sku}"
        if identity_tokens and any(token not in identity_text for token in identity_tokens):
            continue
        matched = sum(1 for token in tokens if token in text)
        if matched == 0:
            continue
        score = matched * 10
        if normalized in text:
            score += 100
        score += sum(35 for token in identity_tokens if token in name)
        score += sum(25 for token in query_brands if token in brand_text)
        score += 30 if product.get("in_stock") else -15
        ranked.append((score, product))

    ranked.sort(key=lambda item: (-item[0], str(item[1].get("name") or "")))
    safe_limit = max(1, min(int(limit), 12))
    return [_public_product(product, tokens) for _, product in ranked[:safe_limit]]


def search_sqlite_services(
    path: str | Path,
    base_url: str,
    limit: int = 8,
    max_age_seconds: int = 900,
) -> list[dict[str, Any]]:
    products, status = _load_snapshot(path, base_url, max_age_seconds)
    if not status.get("fresh"):
        return []
    services = []
    for product in products:
        categories = {
            normalize_catalog_value(value)
            for value in product.get("categories", [])
        }
        if not categories.intersection({"service", "services"}) or not product.get("in_stock"):
            continue
        services.append(product)
    services.sort(
        key=lambda product: (
            float(product.get("cash_price") or 0),
            str(product.get("name") or ""),
        )
    )
    return [_public_product(product, []) for product in services[: max(1, min(int(limit), 20))]]
