"""Authenticate and query production ARCA. Never request a CAE."""
from pathlib import Path
import base64,datetime,json,os,ssl,subprocess,tempfile,time,urllib.request,urllib.error
import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape

private=Path('/etc/fusion-arca-private');os.umask(0o077)
config=json.loads((private/'issuer.json').read_text());cuit=config['cuit'];point=int(config['point'])
SOAP='http://schemas.xmlsoap.org/soap/envelope/';NS='http://ar.gov.afip.dif.FEV1/'
def soap(url,action,body):
 context=ssl.create_default_context();context.set_ciphers('DEFAULT:!DH');context.minimum_version=ssl.TLSVersion.TLSv1_2
 payload=('<?xml version="1.0" encoding="UTF-8"?><soap:Envelope xmlns:soap="'+SOAP+'"><soap:Body>'+body+'</soap:Body></soap:Envelope>').encode()
 request=urllib.request.Request(url,data=payload,headers={'Content-Type':'text/xml; charset=utf-8','SOAPAction':action})
 try:
  with urllib.request.urlopen(request,context=context,timeout=30) as r:raw=r.read(2_000_001)
 except urllib.error.HTTPError as error:raw=error.read(100_001)
 assert len(raw)<=2_000_000,'Unexpected response size'
 doc=ET.fromstring(raw)
 fault=doc.find('.//{'+SOAP+'}Fault')
 if fault is not None:
  message=fault.findtext('faultstring') or 'ARCA SOAP fault'
  raise RuntimeError(message[:500])
 return doc
def authenticate(service):
 path=private/('ta-'+service+'.json')
 if path.exists():
  cached=json.loads(path.read_text())
  if cached['expires_at']>time.time()+120:return cached
 now=datetime.datetime.now(datetime.timezone.utc)
 tra=('<?xml version="1.0" encoding="UTF-8"?><loginTicketRequest version="1.0"><header><uniqueId>'+str(int(time.time()))+'</uniqueId><generationTime>'+(now-datetime.timedelta(minutes=5)).isoformat()+'</generationTime><expirationTime>'+(now+datetime.timedelta(hours=1)).isoformat()+'</expirationTime></header><service>'+service+'</service></loginTicketRequest>')
 with tempfile.TemporaryDirectory(prefix='arca-probe-') as directory:
  inp=Path(directory)/'request.xml';out=Path(directory)/'signed.der';inp.write_text(tra);inp.chmod(0o600)
  result=subprocess.run(['openssl','smime','-sign','-in',str(inp),'-out',str(out),'-signer',str(private/'produccion.crt'),'-inkey',str(private/'produccion.key'),'-nodetach','-outform','DER'],capture_output=True)
  assert result.returncode==0,'Cannot sign ARCA authentication request'
  cms=base64.b64encode(out.read_bytes()).decode()
 doc=soap('https://wsaa.afip.gov.ar/ws/services/LoginCms','', '<loginCms xmlns="http://wsaa.view.sua.dvadac.desein.afip.gov"><in0>'+cms+'</in0></loginCms>')
 reply=next((n.text for n in doc.iter() if n.tag.split('}')[-1]=='loginCmsReturn'),None)
 assert reply,'ARCA did not return an access ticket'
 ta=ET.fromstring(reply)
 data={'Token':ta.findtext('credentials/token'),'Sign':ta.findtext('credentials/sign'),'expires_at':datetime.datetime.fromisoformat(ta.findtext('header/expirationTime')).timestamp()}
 assert data['Token'] and data['Sign'],'Incomplete ARCA access ticket'
 path.write_text(json.dumps(data));path.chmod(0o600)
 return data
def call(method,fields=''):
 assert method in ['FEParamGetPtosVenta','FECompUltimoAutorizado'],'Read-only probe'
 auth=authenticate('wsfe')
 body='<'+method+' xmlns="'+NS+'"><Auth><Token>'+escape(auth['Token'])+'</Token><Sign>'+escape(auth['Sign'])+'</Sign><Cuit>'+cuit+'</Cuit></Auth>'+fields+'</'+method+'>'
 doc=soap('https://servicios1.afip.gov.ar/wsfev1/service.asmx',NS+method,body)
 errors=doc.findall('.//{'+NS+'}Err')
 if errors:raise RuntimeError('; '.join((e.findtext('{'+NS+'}Code') or '')+': '+(e.findtext('{'+NS+'}Msg') or '') for e in errors)[:500])
 return doc
result={'environment':'production','point':point,'issued_invoices':0}
try:
 points=call('FEParamGetPtosVenta')
 rows=[{n.tag.split('}')[-1]:n.text for n in p} for p in points.findall('.//{'+NS+'}PtoVenta')]
 selected=[p for p in rows if int(p['Nro'])==point]
 result['points']=rows;result['selected_point']=selected
 assert len(selected)==1,'Configured point is absent from ARCA'
 assert selected[0].get('Bloqueado')=='N' and selected[0].get('EmisionTipo','').upper() in ['CAE','CAE - RI IVA'] and (selected[0].get('FchBaja') in [None,'','NULL']),'Configured point is not active for CAE'
 last={}
 for type_,label in [(1,'A'),(6,'B'),(3,'NC_A'),(8,'NC_B')]:
  doc=call('FECompUltimoAutorizado','<PtoVta>'+str(point)+'</PtoVta><CbteTipo>'+str(type_)+'</CbteTipo>')
  last[label]=int(doc.findtext('.//{'+NS+'}CbteNro'))
 result.update({'connected':True,'point_ready':True,'last_numbers':last})
except Exception as error:
 result.update({'connected':False,'error':str(error)[:500]})
(private/'connection-result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(result,ensure_ascii=False))
