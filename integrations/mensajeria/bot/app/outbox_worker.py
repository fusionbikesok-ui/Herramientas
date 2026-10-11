"""Persistent outgoing queue. Run separately: python -m app.outbox_worker.

The sending marker commits BEFORE the HTTP call. A process crash or ambiguous
response is unknown, never automatically retried. The session advisory lock
serializes the final permission check and send against every inbox mutation.
"""
from __future__ import annotations
import logging
import time

from .config import get_settings
from .storage import connection, init_schema
from .inbox import lock_thread, send_blocked, ai_allowed
from .inbox_media import CloudTransport, SendRejected

logger = logging.getLogger('fusion-chatbot.outbox')


def finish(conn, out, state, error=None, remote_id=None):
    with conn.transaction():
        conn.execute('UPDATE inbox_outbox SET state=%s,error_code=%s,remote_id=%s,updated_at=NOW() WHERE id=%s',
                     (state, error, remote_id, out['id']))
        conn.execute('UPDATE messages SET delivery_status=%s,external_id=COALESCE(%s,external_id) WHERE id=%s',
                     (state, remote_id, out['message_id']))
        conn.execute('UPDATE conversations SET updated_at=NOW() WHERE conversation_key=%s', (out['conversation_key'],))
        if state == 'sent' and out['is_ai']:
            message = conn.execute('SELECT metadata FROM messages WHERE id=%s',(out['message_id'],)).fetchone()
            handoff = (message.get('metadata') or {}).get('handoff') is True
            changed = conn.execute("UPDATE conversations SET revision=revision+1,bot_status=CASE WHEN %s THEN 'handoff' ELSE bot_status END WHERE conversation_key=%s RETURNING *", (handoff, out['conversation_key'])).fetchone()
            if changed['channel']=='web':
                from .inbox_web import queue_web_sync
                queue_web_sync(conn,changed)


def recover_interrupted():
    with connection() as conn:
        stale = conn.execute("SELECT * FROM inbox_outbox WHERE state='sending' AND updated_at<NOW()-INTERVAL '5 minutes' ORDER BY created_at LIMIT 100").fetchall()
        for out in stale:
            acquired = conn.execute('SELECT pg_try_advisory_lock(hashtextextended(%s,171717)) AS held', (out['conversation_key'],)).fetchone()['held']
            if not acquired:
                continue
            try:
                current = conn.execute('SELECT * FROM inbox_outbox WHERE id=%s', (out['id'],)).fetchone()
                if current['state'] == 'sending':
                    finish(conn, current, 'unknown', 'worker_interrupted_no_retry')
            finally:
                conn.execute('SELECT pg_advisory_unlock(hashtextextended(%s,171717))', (out['conversation_key'],))


def run_once(transport=None):
    with connection() as conn:
        candidates = conn.execute("SELECT id,conversation_key FROM inbox_outbox WHERE state='queued' ORDER BY created_at,id LIMIT 25").fetchall()
        for candidate in candidates:
            acquired = conn.execute('SELECT pg_try_advisory_lock(hashtextextended(%s,171717)) AS held', (candidate['conversation_key'],)).fetchone()['held']
            if not acquired:
                continue
            try:
                with conn.transaction():
                    out = conn.execute("SELECT * FROM inbox_outbox WHERE id=%s AND state='queued' FOR UPDATE", (candidate['id'],)).fetchone()
                    if not out:
                        continue
                    row = conn.execute('SELECT * FROM conversations WHERE conversation_key=%s FOR UPDATE', (out['conversation_key'],)).fetchone()
                    message = conn.execute('SELECT * FROM messages WHERE id=%s', (out['message_id'],)).fetchone()
                    meta = message.get('metadata') or {}
                    is_template = message.get('kind') == 'template' and isinstance(meta.get('template'),dict) and meta.get('opt_in') is True and not out['is_ai'] and row['channel'] == 'whatsapp'
                    reason = send_blocked(row, conn=conn, template=is_template)
                    if message.get('kind') == 'template' and not is_template:
                        reason = 'invalid_template_message'
                    if out['is_ai'] and (not ai_allowed(conn, row) or row['revision'] != out['expected_revision']):
                        reason = 'ai_control_changed'
                    if not out['is_ai'] and (row.get('owner_id') != (message.get('metadata') or {}).get('owner_id') or row.get('bot_status') == 'active'):
                        reason = 'owner_changed'
                    if reason:
                        finish(conn, out, 'cancelled', reason)
                        return True
                    media = conn.execute('SELECT * FROM inbox_media WHERE id=%s', (message['media_id'],)).fetchone() if message['media_id'] else None
                    conn.execute("UPDATE inbox_outbox SET state='sending',updated_at=NOW() WHERE id=%s", (out['id'],))
                    conn.execute("UPDATE messages SET delivery_status='sending' WHERE id=%s", (out['message_id'],))
                # No automatic transport retries, even on 429 or 5xx.
                try:
                    from .inbox_web import WebTransport
                    sender = transport or (WebTransport() if row['channel']=='web' else CloudTransport(get_settings()))
                    remote_id = sender.send(row, message, media, str(out['id']))
                    if not isinstance(remote_id, str) or not remote_id:
                        raise ValueError('missing_message_id')
                except SendRejected as exc:
                    finish(conn, out, 'failed', str(exc)[:100])
                except Exception:
                    # Do not persist tokens, remote response bodies, or exception text.
                    finish(conn, out, 'unknown', 'delivery_ambiguous_no_retry')
                else:
                    finish(conn, out, 'sent', remote_id=remote_id)
                return True
            finally:
                conn.execute('SELECT pg_advisory_unlock(hashtextextended(%s,171717))', (candidate['conversation_key'],))
    return False


def run():
    init_schema()
    logging.basicConfig(level=logging.INFO)
    last_recovery = 0.0
    last_presence = 0.0
    while True:
        try:
            if time.monotonic() - last_recovery >= 60:
                recover_interrupted()
                last_recovery = time.monotonic()
            from .inbox_web import flush_web_sync, sync_web_presence
            if time.monotonic() - last_presence >= 30:
                last_presence = time.monotonic()
                try:
                    sync_web_presence()
                except Exception:
                    logger.warning('Web presence sync failed; retry on next heartbeat')
            synced = flush_web_sync()
            if not run_once() and not synced:
                time.sleep(2)
        except Exception:
            logger.exception('Outbox iteration failed; persisted sending rows are never retried')
            time.sleep(2)


if __name__ == '__main__':
    run()
