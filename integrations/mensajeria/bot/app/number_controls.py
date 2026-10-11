"""Independent bot permission for each business number; manual messaging is separate."""
from __future__ import annotations

import re
from typing import Any, Callable

# Public business numbers selected by the owner. Phone-number IDs come only from
# the server's Meta configuration, never from the visitor or the control form.
MANAGED_NUMBERS = {
    "5493515214819": "+54 9 351 521-4819",
    "5493518752035": "+54 9 351 875-2035",
}


def number_key(number: str) -> str:
    return "whatsapp_bot_number:" + number


def configured_number(phone_number_id: str, numbers: Any) -> str:
    if not phone_number_id or not isinstance(numbers, dict):
        return ""
    row = numbers.get(str(phone_number_id))
    if not isinstance(row, dict) or not str(phone_number_id).isdigit():
        return ""
    number = re.sub(r"[^0-9]", "", str(row.get("display_number") or ""))
    return number if number in MANAGED_NUMBERS else ""


def number_bot_enabled(phone_number_id: str, numbers: Any, read: Callable) -> bool:
    number = configured_number(phone_number_id, numbers)
    # Fail closed on absent, malformed or previously unconfigured numbers.
    return bool(number) and read(number_key(number), False) is True


def control_status(numbers: dict, read: Callable, channel_available: bool) -> dict:
    configured = {configured_number(str(key), numbers) for key in numbers}
    rows = []
    for number, label in MANAGED_NUMBERS.items():
        enabled = read(number_key(number), False) is True
        registered = number in configured
        rows.append({
            "number": number,
            "label": label,
            "configured": registered,
            "enabled": enabled,
            "effective": registered and enabled and channel_available,
        })
    return {"ok": True, "channel_available": channel_available, "numbers": rows}


def save_number_control(number: Any, enabled: Any, numbers: dict, write: Callable) -> None:
    if not isinstance(number, str) or number not in MANAGED_NUMBERS:
        raise ValueError("unknown_number")
    if not isinstance(enabled, bool):
        raise ValueError("boolean_enabled_required")
    if enabled and number not in {configured_number(str(key), numbers) for key in numbers}:
        raise ValueError("number_not_configured")
    # A separate row per number avoids overwriting the other switch concurrently.
    write(number_key(number), enabled)
