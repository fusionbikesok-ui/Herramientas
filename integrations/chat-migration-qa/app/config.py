from __future__ import annotations

import json
import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any


def _bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on", "si", "sí"}


def _float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except ValueError:
        return default


def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except ValueError:
        return default


def _json_object(name: str) -> dict[str, Any]:
    raw = os.getenv(name, "{}").strip()
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return value if isinstance(value, dict) else {}


@dataclass(frozen=True)
class Settings:
    app_env: str
    log_level: str
    api_key: str
    callback_secret: str
    wordpress_base_url: str
    database_url: str
    redis_url: str
    redis_queue: str
    meta_graph_version: str
    meta_app_secret: str
    meta_verify_token: str
    whatsapp_access_token: str
    whatsapp_numbers: dict[str, dict[str, str]]
    ai_enabled: bool
    ai_base_url: str
    ai_api_key: str
    ai_model: str
    ai_timeout_seconds: int
    ai_temperature: float
    fallback_reply: str
    knowledge_path: Path
    catalog_sqlite_path: Path
    catalog_sqlite_max_age_seconds: int
    catalog_xml_source: str
    catalog_xml_refresh_seconds: int

    @property
    def wordpress_inbound_url(self) -> str:
        return self.wordpress_base_url.rstrip("/") + "/wp-json/fusion-chat/v1/inbound"

    @property
    def wordpress_catalog_url(self) -> str:
        return self.wordpress_base_url.rstrip("/") + "/wp-json/fusion-chat/v1/catalog/search"

    def number(self, phone_number_id: str) -> dict[str, str]:
        value = self.whatsapp_numbers.get(str(phone_number_id), {})
        return value if isinstance(value, dict) else {}

    def configuration_issues(self) -> list[str]:
        issues: list[str] = []
        required = {
            "FUSION_API_KEY": self.api_key,
            "FUSION_CALLBACK_SECRET": self.callback_secret,
            "WORDPRESS_BASE_URL": self.wordpress_base_url,
            "DATABASE_URL": self.database_url,
            "META_APP_SECRET": self.meta_app_secret,
            "META_VERIFY_TOKEN": self.meta_verify_token,
            "WHATSAPP_ACCESS_TOKEN": self.whatsapp_access_token,
        }
        for name, value in required.items():
            if not value or "REEMPLAZAR" in value or value.startswith("PEGAR_"):
                issues.append(name)
        if not self.whatsapp_numbers or any(key.startswith("PHONE_NUMBER_ID_") for key in self.whatsapp_numbers):
            issues.append("WHATSAPP_NUMBERS_JSON")
        if self.ai_enabled and (not self.ai_model or "REEMPLAZAR" in self.ai_model):
            issues.append("AI_MODEL")
        return issues


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    root = Path(__file__).resolve().parents[1]
    return Settings(
        app_env=os.getenv("APP_ENV", "production"),
        log_level=os.getenv("LOG_LEVEL", "INFO").upper(),
        api_key=os.getenv("FUSION_API_KEY", ""),
        callback_secret=os.getenv("FUSION_CALLBACK_SECRET", ""),
        wordpress_base_url=os.getenv("WORDPRESS_BASE_URL", "https://fusionbikes.com.ar"),
        database_url=os.getenv("DATABASE_URL", "postgresql://fusion_chatbot:change-me@postgres:5432/fusion_chatbot"),
        redis_url=os.getenv("REDIS_URL", "redis://redis:6379/0"),
        redis_queue=os.getenv("REDIS_QUEUE", "fusion:chatbot:events"),
        meta_graph_version=os.getenv("META_GRAPH_VERSION", "v26.0"),
        meta_app_secret=os.getenv("META_APP_SECRET", ""),
        meta_verify_token=os.getenv("META_VERIFY_TOKEN", ""),
        whatsapp_access_token=os.getenv("WHATSAPP_ACCESS_TOKEN", ""),
        whatsapp_numbers=_json_object("WHATSAPP_NUMBERS_JSON"),
        ai_enabled=_bool("AI_ENABLED", True),
        ai_base_url=os.getenv("AI_BASE_URL", "http://host.docker.internal:11434/v1"),
        ai_api_key=os.getenv("AI_API_KEY", "ollama"),
        ai_model=os.getenv("AI_MODEL", ""),
        ai_timeout_seconds=_int("AI_TIMEOUT_SECONDS", 90),
        ai_temperature=_float("AI_TEMPERATURE", 0.2),
        fallback_reply=os.getenv(
            "FALLBACK_REPLY",
            "En este momento necesito derivarte con un asesor de Fusion Bikes para responderte correctamente.",
        ),
        knowledge_path=Path(os.getenv("KNOWLEDGE_PATH", str(root / "knowledge" / "fusion-bikes.md"))),
        catalog_sqlite_path=Path(os.getenv("CATALOG_SQLITE_PATH", "/catalog/catalog.sqlite")),
        catalog_sqlite_max_age_seconds=max(180, _int("CATALOG_SQLITE_MAX_AGE_SECONDS", 900)),
        catalog_xml_source=os.getenv("CATALOG_XML_SOURCE", "").strip(),
        catalog_xml_refresh_seconds=max(60, _int("CATALOG_XML_REFRESH_SECONDS", 360)),
    )
