from __future__ import annotations

import hashlib
import hmac
import time


def sign_fusion_payload(secret: str, timestamp: str, body: bytes) -> str:
    message = timestamp.encode("utf-8") + b"." + body
    return hmac.new(secret.encode("utf-8"), message, hashlib.sha256).hexdigest()


def verify_fusion_request(
    *,
    expected_api_key: str,
    expected_secret: str,
    supplied_api_key: str,
    supplied_timestamp: str,
    supplied_signature: str,
    body: bytes,
    now: int | None = None,
    tolerance_seconds: int = 300,
) -> tuple[bool, str]:
    if not expected_api_key or not expected_secret:
        return False, "server_not_configured"
    if not supplied_api_key or not hmac.compare_digest(expected_api_key, supplied_api_key):
        return False, "invalid_api_key"
    try:
        timestamp = int(supplied_timestamp)
    except (TypeError, ValueError):
        return False, "invalid_timestamp"
    current = int(time.time()) if now is None else int(now)
    if abs(current - timestamp) > tolerance_seconds:
        return False, "expired_timestamp"
    expected = sign_fusion_payload(expected_secret, str(timestamp), body)
    if not supplied_signature or not hmac.compare_digest(expected, supplied_signature):
        return False, "invalid_signature"
    return True, "ok"


def verify_meta_signature(app_secret: str, supplied_signature: str, body: bytes) -> bool:
    if not app_secret or not supplied_signature.startswith("sha256="):
        return False
    expected = hmac.new(app_secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, supplied_signature.split("=", 1)[1])

