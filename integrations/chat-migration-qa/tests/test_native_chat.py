import concurrent.futures
import json
import os
import re
import secrets
import time
import unittest
import uuid

from fastapi.testclient import TestClient

from app import native_store as store
from app.native_main import app, signature
from app.native_worker import process_one, simulated_decision
from app.queueing import redis_client
from app.storage import connection


class NativeChatTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        store.require_sandbox()
        cls.client = TestClient(app, base_url='http://127.0.0.1:8191')
        cls.client.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.client.__exit__(None, None, None)

    def setUp(self):
        store.require_sandbox()
        with connection() as conn:
            conn.execute('TRUNCATE native_audit,native_commands,native_jobs,native_sessions,messages,conversations RESTART IDENTITY CASCADE')
        redis = redis_client()
        for key in redis.scan_iter('native:*'):
            redis.delete(key)
        self.token = secrets.token_hex(32)
        self.session = store.start_session(self.token, 'Persona ficticia', '541123456789', '', '')

    def headers(self, token=None):
        return {'Authorization': 'Bearer ' + (token or self.token)}

    def send(self, text='Consulta ficticia', request_id=None, token=None):
        return self.client.post('/v1/web/messages', headers=self.headers(token),
                                json={'request_id': request_id or str(uuid.uuid4()), 'text': text})

    def signed(self, data, *, path='/v1/internal/chat', nonce=None, timestamp=None):
        body = json.dumps(data, separators=(',', ':')).encode()
        stamp, nonce = str(timestamp or int(time.time())), nonce or str(uuid.uuid4())
        headers = {'Content-Type': 'application/json', 'X-Native-Key': os.environ['NATIVE_INTERNAL_KEY'],
                   'X-Native-Timestamp': stamp, 'X-Native-Nonce': nonce,
                   'X-Native-Signature': signature(os.environ['NATIVE_INTERNAL_SECRET'], stamp, 'POST', path, nonce, body)}
        return body, headers

    def act(self, action, revision, actor='operator-a', request_id=None, text=''):
        return store.operator_action(action, self.session['id'], actor, actor, revision, request_id or str(uuid.uuid4()), text)

    def test_health_explicitly_identifies_simulation(self):
        data = self.client.get('/health').json()
        self.assertTrue(data['ok'])
        self.assertFalse(data['production_traffic'])

    def test_start_is_idempotent_under_concurrency(self):
        token = secrets.token_hex(32)
        with concurrent.futures.ThreadPoolExecutor(8) as executor:
            results = list(executor.map(lambda _: store.start_session(token, 'Otra prueba', '541187654321', '', ''), range(12)))
        self.assertEqual(len({r['id'] for r in results}), 1)

    def test_phone_payload_and_token_validation(self):
        response = self.client.post('/v1/web/session', headers=self.headers(), json={'phone': '111111111111'})
        self.assertEqual(response.status_code, 422)
        self.assertEqual(self.client.get('/v1/web/messages', headers={'Authorization': 'Bearer abc'}).status_code, 401)
        self.assertEqual(self.client.get('/v1/web/messages').status_code, 401)
        response = self.client.post('/v1/web/messages', headers={**self.headers(), 'Content-Type': 'application/json'}, content=b'{' + b'x' * 17000)
        self.assertEqual(response.status_code, 413)
        self.assertEqual(self.send('   ').status_code, 422)

    def test_message_retry_concurrently_creates_one_message_and_one_job(self):
        request_id = str(uuid.uuid4())
        with concurrent.futures.ThreadPoolExecutor(8) as executor:
            results = list(executor.map(lambda _: store.send_customer(self.token, request_id, 'Una sola vez'), range(12)))
        self.assertEqual(len({r['message_id'] for r in results}), 1)
        with connection() as conn:
            self.assertEqual(conn.execute('SELECT count(*) AS n FROM messages').fetchone()['n'], 1)
            self.assertEqual(conn.execute('SELECT count(*) AS n FROM native_jobs').fetchone()['n'], 1)
        self.assertEqual(self.send('Distinto', request_id).status_code, 409)

    def test_tokens_cannot_read_another_conversation(self):
        self.send('Sólo primera sesión')
        other = secrets.token_hex(32)
        store.start_session(other, 'Otra persona', '541198765432', '', '')
        self.send('Sólo segunda sesión', token=other)
        first = self.client.get('/v1/web/messages', headers=self.headers()).json()
        second = self.client.get('/v1/web/messages', headers=self.headers(other)).json()
        self.assertEqual([x['text'] for x in first['messages']], ['Sólo primera sesión'])
        self.assertEqual([x['text'] for x in second['messages']], ['Sólo segunda sesión'])
        self.assertEqual(self.client.get('/v1/web/messages', headers=self.headers(secrets.token_hex(32))).status_code, 404)
        self.assertNotIn('token', json.dumps(first))

    def test_cursor_pagination_has_no_loss_or_duplication(self):
        for i in range(4):
            self.send(f'Mensaje {i}')
        cursor, ids = 0, []
        for i in range(4):
            data = self.client.get(f'/v1/web/messages?after={cursor}&limit=1', headers=self.headers()).json()
            cursor = data['cursor']; ids.append(data['messages'][0]['id'])
            self.assertEqual(data['has_more'], i < 3)
        self.assertEqual(len(set(ids)), 4)
        self.assertEqual(self.client.get(f'/v1/web/messages?after={cursor}', headers=self.headers()).json()['messages'], [])

    def test_internal_signatures_are_bound_to_path_body_and_nonce(self):
        data = {'action': 'list', 'actor_id': 'qa', 'actor_name': 'QA'}
        self.assertEqual(self.client.post('/v1/internal/chat', json=data).status_code, 401)
        body, headers = self.signed(data, path='/some-other-path')
        self.assertEqual(self.client.post('/v1/internal/chat', content=body, headers=headers).status_code, 401)
        body, headers = self.signed(data)
        self.assertEqual(self.client.post('/v1/internal/chat', content=body + b' ', headers=headers).status_code, 401)
        self.assertEqual(self.client.post('/v1/internal/chat', content=body, headers=headers).status_code, 200)
        self.assertEqual(self.client.post('/v1/internal/chat', content=body, headers=headers).status_code, 409)
        body, headers = self.signed(data, timestamp=int(time.time())-90)
        self.assertEqual(self.client.post('/v1/internal/chat', content=body, headers=headers).status_code, 401)

    def test_two_operators_cannot_take_same_revision(self):
        def take(actor):
            try:
                return self.act('take', 1, actor)['session']['agent_id']
            except store.ChatError as exc:
                return exc.status
        with concurrent.futures.ThreadPoolExecutor(2) as executor:
            results = list(executor.map(take, ('a', 'b')))
        self.assertEqual(results.count(409), 1)

    def test_operator_ownership_and_retry(self):
        with self.assertRaises(store.ChatError) as error:
            self.act('reply', 1, text='No debería enviarse')
        self.assertEqual(error.exception.status, 403)
        request_id = str(uuid.uuid4())
        taken = self.act('take', 1, request_id=request_id)
        self.assertEqual(taken, self.act('take', 1, request_id=request_id))
        with self.assertRaises(store.ChatError):
            self.act('reply', 2, actor='operator-b', text='Tampoco')
        response_id = str(uuid.uuid4())
        first = self.act('reply', 2, request_id=response_id, text='Respuesta única')
        self.assertEqual(first, self.act('reply', 2, request_id=response_id, text='Respuesta única'))
        self.assertEqual(len(store.poll(self.token, 0)['messages']), 1)

    def test_inflight_bot_cannot_reply_after_take_and_release(self):
        self.send()
        job = store.claim_job()
        self.act('take', 1)
        self.act('release', 2)
        self.assertFalse(store.finish_job(job, simulated_decision('Hola')))
        self.assertEqual([m['sender'] for m in store.poll(self.token, 0)['messages']], ['customer'])

    def test_newer_customer_message_supersedes_inflight_reply(self):
        self.send('Primero'); old = store.claim_job()
        self.send('Segundo')
        self.assertFalse(store.finish_job(old, simulated_decision('Primero')))
        self.assertTrue(process_one())
        self.assertEqual([m['sender'] for m in store.poll(self.token, 0)['messages']], ['customer', 'customer', 'bot'])

    def test_expired_lease_is_recovered_and_old_worker_cannot_deliver(self):
        self.send(); old = store.claim_job()
        with connection() as conn:
            conn.execute("UPDATE native_jobs SET lease_until=now()-interval '1 second' WHERE id=%s", (old['id'],))
        new = store.claim_job()
        self.assertNotEqual(old['lease'], new['lease'])
        self.assertFalse(store.finish_job(old, simulated_decision('Hola')))
        self.assertTrue(store.finish_job(new, simulated_decision('Hola')))
        self.assertFalse(store.finish_job(new, simulated_decision('Hola')))
        self.assertEqual(len(store.poll(self.token, 0)['messages']), 2)

    def test_full_customer_bot_human_release_flow(self):
        self.send('Quiero hablar con una persona'); self.assertTrue(process_one())
        data = store.poll(self.token, 0)
        self.assertTrue(data['session']['needs_human'])
        self.assertEqual(data['session']['bot_status'], 'handoff')
        taken = self.act('take', data['session']['revision'])['session']
        self.send('El asesor debe responder')
        self.assertFalse(process_one())
        self.act('reply', taken['revision'], text='Estoy atendiendo tu consulta')
        self.act('release', taken['revision'])
        self.send('Nueva consulta'); self.assertTrue(process_one())
        self.assertEqual([m['sender'] for m in store.poll(self.token, 0)['messages']], ['customer','bot','customer','operator','customer','bot'])

    def test_archive_reopens_only_for_new_customer_message(self):
        request_id = str(uuid.uuid4()); self.send('Consulta', request_id)
        self.act('archive', 1)
        self.send('Consulta', request_id)
        self.assertEqual(store.poll(self.token, 0)['session']['status'], 'archived')
        self.send('Consulta nueva')
        self.assertEqual(store.poll(self.token, 0)['session']['status'], 'open')

    def test_failed_jobs_have_bounded_retries(self):
        self.send()
        for _ in range(5):
            job = store.claim_job(); self.assertIsNotNone(job)
            store.fail_job(job, 'SimulatedFailure')
            with connection() as conn:
                conn.execute("UPDATE native_jobs SET available_at=now()-interval '1 second'")
        self.assertIsNone(store.claim_job())
        with connection() as conn:
            self.assertEqual(conn.execute('SELECT status FROM native_jobs').fetchone()['status'], 'failed')

    def test_origin_and_send_rate_limit(self):
        response = self.client.get('/v1/web/messages', headers={**self.headers(), 'Origin': 'https://untrusted.invalid'})
        self.assertEqual(response.status_code, 403)
        for i in range(30):
            self.assertEqual(self.send(f'Prueba límite {i}').status_code, 200)
        self.assertEqual(self.send('Demasiados').status_code, 429)

    def test_private_preview_host_cookie_csrf_and_actor(self):
        self.assertEqual(self.client.get('/qa/', headers={'Host': 'external.invalid'}).status_code, 403)
        self.assertEqual(self.client.get('/qa/', headers={'Sec-Fetch-Site': 'cross-site'}).status_code, 403)
        page = self.client.get('/qa/')
        csrf = re.search(r'name="qa-csrf" content="([a-f0-9]+)"', page.text).group(1)
        self.assertNotIn(os.environ['NATIVE_INTERNAL_KEY'], page.text)
        headers = {'Origin': 'http://127.0.0.1:8191', 'X-QA-CSRF': csrf}
        self.assertEqual(self.client.post('/qa/operator', json={'action': 'list'}).status_code, 403)
        self.assertEqual(self.client.post('/qa/operator', json={'action': 'list'}, headers=headers).status_code, 200)
        self.assertEqual(self.client.post('/qa/operator', json={'action': 'list', 'actor_id': 'admin'}, headers=headers).status_code, 422)

    def test_preview_rejects_production_configuration(self):
        from app.config import get_settings
        previous = os.environ['APP_ENV']
        try:
            os.environ['APP_ENV'] = 'production'; get_settings.cache_clear()
            with self.assertRaises(RuntimeError):
                store.require_sandbox()
        finally:
            os.environ['APP_ENV'] = previous; get_settings.cache_clear()


if __name__ == '__main__':
    unittest.main()
