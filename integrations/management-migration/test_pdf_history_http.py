from pathlib import Path
import hashlib,hmac,json,os,socket,subprocess,sys,tempfile,time,unittest,urllib.request,urllib.error

ROOT=Path(__file__).resolve().parent
SECRET='pdf-history-http-test-key-'*4
TOKEN=hmac.new(SECRET.encode(),b'pdf-corrector-worker-v1',hashlib.sha256).hexdigest()

class WorkerHistoryTests(unittest.TestCase):
    def setUp(self):
        scratch=ROOT/'.qa-temp';scratch.mkdir(exist_ok=True)
        self.temp=tempfile.TemporaryDirectory(dir=scratch);self.process=None
        with socket.socket() as sock:sock.bind(('127.0.0.1',0));self.port=sock.getsockname()[1]
        self.start()
    def tearDown(self):
        self.stop();assert Path(self.temp.name).resolve().is_relative_to(ROOT.resolve());self.temp.cleanup()
    def start(self):
        env=os.environ.copy();env.update(FUSION_MANAGEMENT_SIGNING_KEY=SECRET,FUSION_PDF_HISTORY_DIR=self.temp.name,FUSION_PDF_PORT=str(self.port),PYTHONDONTWRITEBYTECODE='1')
        self.process=subprocess.Popen([sys.executable,str(ROOT/'pdf-worker.py')],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
        for _ in range(100):
            try:
                if self.request('/health',auth=False)[0]==200:return
            except OSError:pass
            if self.process.poll() is not None:self.fail('Worker failed to start: '+self.process.stderr.read().decode(errors='replace'))
            time.sleep(.05)
        self.fail('Worker not ready')
    def stop(self):
        if self.process:self.process.terminate();self.process.wait(timeout=10);self.process.stderr.close();self.process=None
    def request(self,path,body=None,auth=True,headers=None,method=None):
        h={'Authorization':'Bearer '+TOKEN} if auth else {}
        if body is not None:h['Content-Type']='application/pdf'
        h.update(headers or {})
        req=urllib.request.Request('http://127.0.0.1:'+str(self.port)+path,data=body,headers=h,method=method)
        try:r=urllib.request.urlopen(req,timeout=45)
        except urllib.error.HTTPError as e:r=e
        with r:return r.status,r.headers,r.read()
    def test_success_commits_before_response_survives_restart_and_download_matches(self):
        source=(ROOT/'tests/labels.pdf').read_bytes()
        status,headers,pdf=self.request('/correct',source,headers={'X-Fusion-Pdf-Filename':'Etiquetas%20C%C3%B3rdoba.pdf','X-Fusion-Pdf-User':'Operador%20QA'})
        self.assertEqual(status,200,pdf[:200]);identifier=headers['X-Fusion-Pdf-Id']
        self.assertTrue(pdf.startswith(b'%PDF-'))
        self.stop();self.start()
        status,_,body=self.request('/history?q=cordoba');data=json.loads(body)
        self.assertEqual(status,200);self.assertEqual(data['total'],1)
        self.assertEqual(data['items'][0]['id'],identifier);self.assertEqual(data['items'][0]['username'],'Operador QA')
        self.assertEqual(data['items'][0]['source_name'],'Etiquetas Córdoba.pdf')
        self.assertEqual(data['items'][0]['rule']['after']['weight'],'15000')
        status,file_headers,stored=self.request('/files/'+identifier)
        self.assertEqual(status,200);self.assertEqual(stored,pdf);self.assertEqual(file_headers['X-Fusion-Pdf-Id'],identifier)
        head_status,head_headers,head_body=self.request('/files/'+identifier,method='HEAD')
        self.assertEqual(head_status,200);self.assertEqual(head_body,b'');self.assertEqual(int(head_headers['Content-Length']),len(pdf))
        self.assertEqual(self.request('/files/'+identifier,auth=False)[0],403)
    def test_private_routes_bad_filters_and_failed_correction_never_save(self):
        for route in ['/history','/files/anything']:
            self.assertEqual(self.request(route,auth=False)[0],403)
        self.assertEqual(self.request('/correct',b'%PDF-bad')[0],422)
        self.assertEqual(json.loads(self.request('/history')[2])['total'],0)
        for route in ['/history?q=a&q=b','/history?unknown=1','/history?from=2026-02-30','/history?page=0']:
            self.assertEqual(self.request(route)[0],400,route)
        for route in ['/files/../../runtime.env','/files/00000000-0000-4000-8000-000000000000']:
            self.assertEqual(self.request(route)[0],404)
    def test_default_client_still_saves_and_same_names_are_separate(self):
        source=(ROOT/'tests/labels.pdf').read_bytes();ids=[]
        for _ in range(2):
            status,headers,_=self.request('/correct',source);self.assertEqual(status,200);ids.append(headers['X-Fusion-Pdf-Id'])
        self.assertNotEqual(*ids);self.assertEqual(json.loads(self.request('/history')[2])['total'],2)

if __name__=='__main__':unittest.main(verbosity=2)
