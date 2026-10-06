"""Private migration preview. Explicit QA guards prevent accidental production activation."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import time
from contextlib import asynccontextmanager
from typing import Literal
from uuid import UUID

from fastapi import FastAPI, Query, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from starlette.concurrency import run_in_threadpool
from starlette.middleware.cors import CORSMiddleware

from . import native_store as store
from .queueing import redis_client
from .storage import connection


ASSETS = Path(__file__).resolve().parent / 'native_preview'
QA_ORIGINS = ('http://127.0.0.1:8191', 'http://localhost:8191')


@asynccontextmanager
async def lifespan(_):
    for name in ('NATIVE_INTERNAL_KEY', 'NATIVE_INTERNAL_SECRET'):
        if len(os.getenv(name, '')) < 32:
            raise RuntimeError('Native QA signing credentials required')
    store.initialize()
    redis_client().ping()
    yield


app = FastAPI(title='Fusion Chat · ensayo privado', docs_url=None, redoc_url=None,
              openapi_url=None, lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=list(QA_ORIGINS),
                   allow_methods=['GET', 'POST'], allow_headers=['Authorization', 'Content-Type'])


@app.middleware('http')
async def privacy(request: Request, call_next):
    try:
        response = await call_next(request)
    except Exception:
        response = JSONResponse({'error': 'service_unavailable'}, status_code=503)
    response.headers['Cache-Control'] = 'private, no-store'
    response.headers['Referrer-Policy'] = 'no-referrer'
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['Content-Security-Policy'] = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'"
    return response


@app.exception_handler(store.ChatError)
async def chat_error(_, exc):
    headers = {'Retry-After': '60'} if exc.status == 429 else {}
    return JSONResponse({'error': exc.code}, status_code=exc.status, headers=headers)


class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)


class Start(StrictModel):
    name: str = Field(default='', max_length=100)
    phone: str = Field(min_length=10, max_length=30)
    page_url: str = Field(default='', max_length=2048)
    page_title: str = Field(default='', max_length=300)


class Send(StrictModel):
    request_id: UUID
    text: str = Field(min_length=1, max_length=4000)


class OperatorCommand(StrictModel):
    action: Literal['list', 'read', 'take', 'release', 'reply', 'archive', 'reopen']
    session_id: UUID | None = None
    revision: int | None = Field(default=None, ge=1, le=2147483647)
    request_id: UUID | None = None
    text: str = Field(default='', max_length=4000)
    after: int = Field(default=0, ge=0, le=9223372036854775807)
    limit: int = Field(default=50, ge=1, le=100)
    offset: int = Field(default=0, ge=0, le=100000)
    status: Literal['open', 'archived'] = 'open'


class SignedOperator(OperatorCommand):
    actor_id: str = Field(min_length=1, max_length=80, pattern=r'^[a-zA-Z0-9:_-]+$')
    actor_name: str = Field(min_length=1, max_length=100)


async def read_body(request: Request) -> bytes:
    if request.headers.get('content-type', '').split(';', 1)[0].lower() != 'application/json':
        raise store.ChatError(415, 'json_required')
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > 16384:
            raise store.ChatError(413, 'body_too_large')
    return bytes(body)


def validate(model, body: bytes):
    try:
        return model.model_validate_json(body)
    except (ValidationError, ValueError):
        raise store.ChatError(422, 'invalid_fields') from None


def bearer(request: Request) -> str:
    header = request.headers.get('authorization', '')
    if not header.startswith('Bearer '):
        raise store.ChatError(401, 'session_required')
    token = header[7:]
    store.token_hash(token)
    return token


def rate_limit(request: Request, bucket: str, limit: int, token: str = '') -> None:
    ip = request.client.host if request.client else 'unknown'
    identity = hashlib.sha256((ip + ':' + token).encode()).hexdigest()
    used = redis_client().eval('''local n=redis.call('INCR',KEYS[1]);
        if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return n''', 1, 'native:rate:' + bucket + ':' + identity)
    if used > limit:
        raise store.ChatError(429, 'rate_limited')


def public_guard(request: Request, bucket: str, limit: int) -> str:
    origin = request.headers.get('origin')
    if origin and origin not in QA_ORIGINS:
        raise store.ChatError(403, 'origin_not_allowed')
    token = bearer(request)
    # Per-IP ceiling also bounds clients rotating session tokens.
    rate_limit(request, 'public_ip', 600)
    if bucket == 'start':
        rate_limit(request, 'start_ip', 12)
    rate_limit(request, bucket, limit, token)
    return token


@app.get('/health')
def health():
    with connection() as conn:
        conn.execute('SELECT 1').fetchone()
    redis_client().ping()
    return {'ok': True, 'mode': 'isolated-migration-test', 'bot': 'simulated', 'production_traffic': False}


@app.post('/v1/web/session')
async def start(request: Request):
    token = public_guard(request, 'start', 12)
    model = validate(Start, await read_body(request))
    return await run_in_threadpool(store.start_session, token, model.name, model.phone, model.page_url, model.page_title)


@app.post('/v1/web/messages')
async def send(request: Request):
    token = public_guard(request, 'send', 30)
    model = validate(Send, await read_body(request))
    return await run_in_threadpool(store.send_customer, token, str(model.request_id), model.text)


@app.get('/v1/web/messages')
def poll(request: Request, after: int = Query(0, ge=0, le=9223372036854775807), limit: int = Query(100, ge=1, le=100)):
    token = public_guard(request, 'poll', 240)
    return store.poll(token, after, limit)


def signature(secret: str, timestamp: str, method: str, path: str, nonce: str, body: bytes) -> str:
    prefix = '\n'.join((timestamp, method, path, nonce)).encode() + b'\n'
    return hmac.new(secret.encode(), prefix + body, hashlib.sha256).hexdigest()


def internal_auth(request: Request, body: bytes) -> None:
    key = os.getenv('NATIVE_INTERNAL_KEY', '')
    secret = os.getenv('NATIVE_INTERNAL_SECRET', '')
    supplied = request.headers.get('x-native-key', '')
    timestamp = request.headers.get('x-native-timestamp', '')
    nonce = request.headers.get('x-native-nonce', '')
    signed = request.headers.get('x-native-signature', '')
    valid = len(key) >= 32 and len(secret) >= 32 and hmac.compare_digest(key, supplied)
    try:
        valid = valid and abs(int(timestamp) - int(time.time())) <= 60 and str(UUID(nonce)) == nonce
    except (ValueError, TypeError):
        valid = False
    if not valid or not hmac.compare_digest(signature(secret, timestamp, request.method, request.url.path, nonce, body), signed):
        raise store.ChatError(401, 'invalid_internal_signature')
    if not redis_client().set('native:nonce:' + nonce, '1', nx=True, ex=121):
        raise store.ChatError(409, 'signature_replayed')


def dispatch(model: OperatorCommand, actor_id: str, actor_name: str):
    if model.action == 'list':
        return store.inbox(model.status, model.offset, model.limit)
    if not model.session_id:
        raise store.ChatError(422, 'session_id_required')
    if model.action == 'read':
        return store.operator_read(str(model.session_id), model.after, model.limit)
    if model.revision is None or not model.request_id:
        raise store.ChatError(422, 'revision_and_request_id_required')
    return store.operator_action(model.action, str(model.session_id), actor_id, actor_name,
                                 model.revision, str(model.request_id), model.text)


@app.post('/v1/internal/chat')
async def operator(request: Request):
    body = await read_body(request)
    internal_auth(request, body)
    model = validate(SignedOperator, body)
    return await run_in_threadpool(dispatch, model, model.actor_id, model.actor_name)


def preview_guard(request: Request, mutation: bool = False):
    store.require_sandbox()
    if 'http://' + request.headers.get('host', '') not in QA_ORIGINS:
        raise store.ChatError(403, 'private_preview_only')
    if request.headers.get('sec-fetch-site', '') not in ('', 'same-origin', 'none'):
        raise store.ChatError(403, 'private_preview_only')
    if mutation:
        if request.headers.get('origin') not in QA_ORIGINS:
            raise store.ChatError(403, 'preview_origin_required')
        cookie = request.cookies.get('native_qa_session', '')
        if not re.fullmatch('[a-f0-9]{64}', cookie):
            raise store.ChatError(401, 'preview_session_required')
        csrf = redis_client().get('native:preview:' + cookie)
        if not csrf or not hmac.compare_digest(csrf, request.headers.get('x-qa-csrf', '')):
            raise store.ChatError(403, 'preview_csrf_required')


@app.get('/')
def home():
    return RedirectResponse('/qa/')


@app.get('/qa/')
def preview(request: Request):
    preview_guard(request)
    cookie, csrf = secrets.token_hex(32), secrets.token_hex(32)
    redis_client().set('native:preview:' + cookie, csrf, ex=7200)
    page = (ASSETS / 'index.html').read_text(encoding='utf-8').replace('__CSRF__', csrf)
    response = HTMLResponse(page)
    response.set_cookie('native_qa_session', cookie, max_age=7200, httponly=True, samesite='strict', path='/qa')
    return response


@app.get('/qa/assets/{name}')
def assets(request: Request, name: str):
    preview_guard(request)
    if name not in {'preview.js', 'preview.css', 'theme.css'}:
        raise store.ChatError(404, 'not_found')
    return FileResponse(ASSETS / name)


@app.post('/qa/operator')
async def preview_operator(request: Request):
    preview_guard(request, mutation=True)
    rate_limit(request, 'qa_operator', 300)
    model = validate(OperatorCommand, await read_body(request))
    return await run_in_threadpool(dispatch, model, 'qa-operator', 'Asesor de prueba')
