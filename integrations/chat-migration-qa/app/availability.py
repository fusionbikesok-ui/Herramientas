from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone, tzinfo
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


DAY_KEYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")


def _boolean(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _minutes(value: Any) -> int | None:
    match = re.fullmatch(r"([01]\d|2[0-3]):([0-5]\d)", str(value or "").strip())
    if not match:
        return None
    return int(match.group(1)) * 60 + int(match.group(2))


def _timezone(value: Any, fallback_offset_minutes: Any = 0) -> tzinfo:
    name = str(value or "UTC").strip() or "UTC"
    try:
        return ZoneInfo(name)
    except ZoneInfoNotFoundError:
        match = re.fullmatch(r"([+-])(\d{2}):?(\d{2})", name)
        if not match:
            try:
                offset = max(-840, min(840, int(fallback_offset_minutes)))
            except (TypeError, ValueError):
                offset = 0
            return timezone(timedelta(minutes=offset))
        offset = int(match.group(2)) * 60 + int(match.group(3))
        if match.group(1) == "-":
            offset *= -1
        return timezone(timedelta(minutes=offset))


def _window_allows(row: Any, minute_of_day: int, overnight_tail: bool = False) -> bool:
    if not isinstance(row, dict) or not _boolean(row.get("enabled")):
        return False
    start = _minutes(row.get("start"))
    end = _minutes(row.get("end"))
    if start is None or end is None:
        return False
    if start == end:
        return not overnight_tail
    if start < end:
        return not overnight_tail and start <= minute_of_day < end
    return minute_of_day < end if overnight_tail else minute_of_day >= start


def channel_bot_available(
    channel: str,
    config: Any,
    now: datetime | None = None,
) -> bool:
    """Return whether a channel may answer now; missing legacy config stays enabled."""
    if not isinstance(config, dict) or not config:
        return True
    key = "whatsapp" if str(channel).lower() == "whatsapp" else "web"
    channel_config = config.get(key)
    if not isinstance(channel_config, dict):
        return True
    if not _boolean(channel_config.get("enabled"), default=True):
        return False
    if not _boolean(channel_config.get("schedule_enabled")):
        return True

    current_timezone = _timezone(
        config.get("timezone"),
        config.get("timezone_offset_minutes", 0),
    )
    current = now or datetime.now(timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)
    current = current.astimezone(current_timezone)
    minute_of_day = current.hour * 60 + current.minute
    days = channel_config.get("days")
    if not isinstance(days, dict):
        return False

    day_index = current.weekday()
    row = days.get(DAY_KEYS[day_index])
    return (
        _window_allows(row, minute_of_day)
        or _window_allows(row, minute_of_day, overnight_tail=True)
    )


def sanitize_channel_config(value: Any) -> dict[str, Any]:
    """Keep only the channel availability fields accepted from WordPress."""
    source = value if isinstance(value, dict) else {}
    clean: dict[str, Any] = {
        "timezone": str(source.get("timezone") or "UTC").strip()[:100] or "UTC",
    }
    try:
        offset = int(source.get("timezone_offset_minutes") or 0)
    except (TypeError, ValueError):
        offset = 0
    clean["timezone_offset_minutes"] = max(-840, min(840, offset))
    for channel in ("web", "whatsapp"):
        raw_channel = source.get(channel) if isinstance(source.get(channel), dict) else {}
        raw_days = raw_channel.get("days") if isinstance(raw_channel.get("days"), dict) else {}
        days: dict[str, dict[str, Any]] = {}
        for day in DAY_KEYS:
            raw_row = raw_days.get(day) if isinstance(raw_days.get(day), dict) else {}
            start = str(raw_row.get("start") or "09:00").strip()
            end = str(raw_row.get("end") or "18:00").strip()
            days[day] = {
                "enabled": _boolean(raw_row.get("enabled")),
                "start": start if _minutes(start) is not None else "09:00",
                "end": end if _minutes(end) is not None else "18:00",
            }
        clean[channel] = {
            "enabled": _boolean(raw_channel.get("enabled"), default=True),
            "schedule_enabled": _boolean(raw_channel.get("schedule_enabled")),
            "days": days,
        }
    return clean
