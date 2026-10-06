"""Loopback-only PDF processor. Documents exist only in request/process memory."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import hashlib, hmac, json, os, subprocess, sys, threading

ROOT = Path(__file__).resolve().parent
LIMIT = 10 * 1024 * 1024
SECRET = os.environ['FUSION_MANAGEMENT_SIGNING_KEY']
TOKEN = hmac.new(SECRET.encode(), b'pdf-corrector-worker-v1', hashlib.sha256).hexdigest()
SLOT = threading.BoundedSemaphore(1)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def setup(self):
        super().setup()
        self.connection.settimeout(15)

    def respond(self, status, body, content_type='application/json', headers=None):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        for k,v in (headers or {}).items():self.send_header(k,str(v))
        self.end_headers()
        self.wfile.write(body)

    def error(self, status, message):
        self.respond(status,json.dumps({'message':message},ensure_ascii=False).encode())

    def do_GET(self):
        if self.path == '/health':self.respond(200,b'{"ok":true}')
        else:self.error(404,'Ruta no disponible.')

    def do_POST(self):
        if self.path != '/correct':return self.error(404,'Ruta no disponible.')
        if not hmac.compare_digest(self.headers.get('Authorization',''), 'Bearer '+TOKEN):
            return self.error(403,'Acceso no autorizado.')
        if self.headers.get('Content-Type') != 'application/pdf':
            return self.error(415,'Se requiere un PDF.')
        rule=self.headers.get('X-Fusion-Pdf-Rule')
        if rule is not None:
            try:
                if len(rule)>1024 or not isinstance(json.loads(rule),dict):raise ValueError()
            except (ValueError,TypeError):return self.error(400,'Los valores de reemplazo no son válidos.')
        try:length=int(self.headers.get('Content-Length','0'))
        except ValueError:length=0
        if not 1 <= length <= LIMIT:return self.error(413,'El PDF debe tener hasta 10 MB.')
        if not SLOT.acquire(blocking=False):return self.error(429,'Hay otro PDF en proceso. Volvé a intentar en unos segundos.')
        try:
            payload=self.rfile.read(length)
            if len(payload)!=length:return self.error(400,'La carga del PDF quedó incompleta.')
            child_env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8','PYTHONDONTWRITEBYTECODE':'1'}
            try:
                command=[sys.executable,str(ROOT/'pdf_corrector.py')]
                if rule is not None:command.append(rule)
                run=subprocess.run(command,input=payload,
                    stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=32,env=child_env)
            except subprocess.TimeoutExpired:
                return self.error(422,'El PDF tardó demasiado en procesarse. Probá con menos páginas.')
            if run.returncode!=0 or b'\n' not in run.stdout:
                return self.error(422,'El PDF supera los recursos permitidos o tiene un formato no admitido.')
            raw,_,pdf=run.stdout.partition(b'\n')
            info=json.loads(raw)
            if info.get('ok') is not True:return self.error(info.get('status',422),info['message'])
            if not pdf.startswith(b'%PDF-') or len(pdf)>20*1024*1024:
                return self.error(503,'No se pudo verificar el PDF corregido.')
            self.respond(200,pdf,'application/pdf',{'X-Fusion-Pdf-Total':info['total'],
                'X-Fusion-Pdf-Pages':','.join(map(str,info['pages']))})
        except (BrokenPipeError,ConnectionError,TimeoutError):
            pass
        except Exception:
            self.error(503,'No se pudo corregir el PDF. Volvé a intentar.')
        finally:
            SLOT.release()


if __name__=='__main__':
    ThreadingHTTPServer(('127.0.0.1',8213),Handler).serve_forever()
