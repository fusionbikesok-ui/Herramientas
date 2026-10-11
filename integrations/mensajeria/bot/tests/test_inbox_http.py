"""Real ASGI route authentication and JSON error contract, without network/DB."""
import hashlib
import hmac
import json
import os
import time
import unittest
import uuid
from unittest.mock import patch

from fastapi.testclient import TestClient
from app.main import app


class Nonces:
    def __init__(self): self.used=set()
    def set(self,key,value,nx,ex):
        if key in self.used: return False
        self.used.add(key); return True


class InboxHTTPTests(unittest.TestCase):
    def setUp(self):
        env=patch.dict(os.environ,{'INBOX_PROXY_SECRET':'http-test-secret-'*4}); env.start(); self.addCleanup(env.stop)
        redis=patch('app.main.redis_client',return_value=Nonces()); redis.start(); self.addCleanup(redis.stop)
        # No context manager: lifespan/real database/Redis startup is intentionally not run.
        self.client=TestClient(app)
        self.addCleanup(self.client.close)

    def signed(self,payload):
        raw=json.dumps(payload,separators=(',',':')).encode()
        timestamp=str(int(time.time())); nonce=str(uuid.uuid4())
        digest=hmac.new(os.environ['INBOX_PROXY_SECRET'].encode(),(timestamp+'.'+nonce+'.').encode()+raw,hashlib.sha256).hexdigest()
        return raw,{'X-Inbox-Timestamp':timestamp,'X-Inbox-Nonce':nonce,'X-Inbox-Signature':digest,'Content-Type':'application/json'}

    def test_route_signature_and_nonce_contract(self):
        raw,headers=self.signed({'op':'status','actor':{'id':'herramientas:1','name':'Agente','role':'agent'}})
        with patch('app.inbox.handle',return_value={'ok':True}):
            response=self.client.post('/v1/inbox',content=raw,headers=headers)
            self.assertEqual(response.status_code,200)
            self.assertEqual(response.headers['cache-control'],'no-store')
            replay=self.client.post('/v1/inbox',content=raw,headers=headers)
        self.assertEqual(replay.status_code,401)
        self.assertEqual(replay.json(),{'ok':False,'error':'replayed_request','code':'replayed_request'})

    def test_route_reader_cannot_note_send_upload_or_presence(self):
        for fields in ({'op':'command','action':'note'},{'op':'command','action':'send'},{'op':'upload'},{'op':'presence','status':'available'}):
            raw,headers=self.signed(dict(fields,actor={'id':'herramientas:9','name':'Consulta','role':'reader'}))
            result=self.client.post('/v1/inbox',content=raw,headers=headers)
            self.assertEqual(result.status_code,403)
            self.assertEqual(result.json()['code'],'write_required')

    def test_route_unconfigured_is_503_and_missing_signature_is_401(self):
        result=self.client.post('/v1/inbox',json={'op':'status'})
        self.assertEqual(result.status_code,401)
        with patch.dict(os.environ,{'INBOX_PROXY_SECRET':''}):
            result=self.client.post('/v1/inbox',json={'op':'status'})
        self.assertEqual(result.status_code,503)
        self.assertEqual(result.json()['code'],'inbox_not_configured')


if __name__=='__main__': unittest.main()
