from __future__ import annotations

import json
import time
from typing import Any

from redis import Redis

from .config import get_settings
from .storage import event_status, mark_event, record_event


def redis_client() -> Redis:
    return Redis.from_url(get_settings().redis_url, decode_responses=True)


def scheduled_queue_name() -> str:
    return get_settings().redis_queue + ":scheduled"


def schedule(payload: dict[str, Any], delay_seconds: int) -> None:
    serialized = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    redis_client().zadd(
        scheduled_queue_name(),
        {serialized: time.time() + max(0, int(delay_seconds))},
    )


def promote_due(redis: Redis, limit: int = 50) -> int:
    due = redis.zrangebyscore(scheduled_queue_name(), "-inf", time.time(), start=0, num=limit)
    if not due:
        return 0
    promoted = 0
    for serialized in due:
        moved = redis.eval(
            """
            if redis.call('ZREM', KEYS[1], ARGV[1]) == 1 then
                redis.call('RPUSH', KEYS[2], ARGV[1])
                return 1
            end
            return 0
            """,
            2,
            scheduled_queue_name(),
            get_settings().redis_queue,
            serialized,
        )
        if moved:
            promoted += 1
    return promoted


def enqueue(payload: dict[str, Any]) -> bool:
    inserted = record_event(payload)
    event_id = str(payload.get("event_id") or "")
    should_queue = inserted or event_status(event_id) in {"queue_error", "failed"}
    if not should_queue:
        return False
    try:
        redis_client().rpush(
            get_settings().redis_queue,
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        )
    except Exception as exc:
        mark_event(event_id, "queue_error", str(exc))
        raise
    if not inserted:
        mark_event(event_id, "queued")
    return True
