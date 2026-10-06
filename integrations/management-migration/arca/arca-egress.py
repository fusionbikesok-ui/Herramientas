"""Authenticated CONNECT tunnel restricted to production ARCA endpoints."""
import base64,hmac,ipaddress,os,select,socket,socketserver,time

HOSTS={'wsaa.afip.gov.ar','servicios1.afip.gov.ar','aws.afip.gov.ar'}
MAX_BYTES=16*1024*1024
def destination(value):
 if value.count(':')!=1:raise ValueError('destination')
 host,port=value.split(':')
 if host not in HOSTS or port!='443':raise ValueError('destination')
 return host,443
class Handler(socketserver.StreamRequestHandler):
 def handle(self):
  self.connection.settimeout(10)
  try:
   line=self.rfile.readline(1025).decode('ascii').strip().split(' ')
   if len(line)!=3 or line[0]!='CONNECT' or line[2] not in ['HTTP/1.0','HTTP/1.1']:return self.reject(405)
   try:host,port=destination(line[1])
   except ValueError:return self.reject(403)
   headers={};size=0
   for _ in range(25):
    raw=self.rfile.readline(2049);size+=len(raw)
    if size>8192:return self.reject(431)
    if raw in [b'\r\n',b'\n']:break
    key,sep,val=raw.decode('ascii').partition(':')
    if not sep or key.lower() in headers:return self.reject(400)
    headers[key.lower()]=val.strip()
   else:return self.reject(431)
   expected='Basic '+base64.b64encode(('arca:'+os.environ['ARCA_PROXY_PASSWORD']).encode()).decode()
   if not hmac.compare_digest(headers.get('proxy-authorization',''),expected):return self.reject(407)
   addresses=socket.getaddrinfo(host,port,socket.AF_INET,socket.SOCK_STREAM)
   if not addresses or any(not ipaddress.ip_address(row[4][0]).is_global for row in addresses):return self.reject(502)
   upstream=socket.create_connection(addresses[0][4],timeout=15)
   with upstream:
    self.wfile.write(b'HTTP/1.0 200 Connection established\r\n\r\n');self.wfile.flush()
    start=time.monotonic();total=0
    while time.monotonic()-start<90:
     ready,_,_=select.select([self.connection,upstream],[],[],10)
     if not ready:continue
     for source in ready:
      data=source.recv(65536)
      if not data:return
      total+=len(data)
      if total>MAX_BYTES:return
      (upstream if source is self.connection else self.connection).sendall(data)
  except (OSError,ValueError,UnicodeError):return
 def reject(self,status):
  self.wfile.write(('HTTP/1.0 '+str(status)+' Denied\r\nContent-Length: 0\r\n\r\n').encode());self.wfile.flush()
class Server(socketserver.ThreadingTCPServer):
 allow_reuse_address=True;daemon_threads=True;request_queue_size=16
if __name__=='__main__':
 assert len(os.environ['ARCA_PROXY_PASSWORD'])>=64
 with Server((os.environ['ARCA_PROXY_BIND'],8215),Handler) as server:server.serve_forever()
