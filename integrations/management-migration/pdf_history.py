"""Private, transactional storage of corrected PDFs; no original uploads or automatic purge."""
from contextlib import closing
from datetime import date, datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo
import json, math, os, re, shutil, sqlite3, unicodedata, uuid

ARGENTINA = ZoneInfo('America/Argentina/Buenos_Aires')
PAGE_SIZE = 20
UUID_RE = re.compile(r'^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$')
META = 'id, created_at, day, name, source_name, username, size, total, pages, rule'

class HistoryError(Exception):
    def __init__(self, message, status=503):
        super().__init__(message); self.status=status

def search_key(value):
    return ''.join(c for c in unicodedata.normalize('NFKD', value.casefold()) if not unicodedata.combining(c))

def clean_name(value):
    value = unicodedata.normalize('NFC', str(value or 'etiquetas.pdf'))
    value = re.sub(r'[<>:"/\\|?*\x00-\x1f\x7f]', '_', value)
    value = ''.join(c for c in value if unicodedata.category(c) != 'Cf').strip(' .')[:160]
    if not value: value='etiquetas.pdf'
    if not value.lower().endswith('.pdf'): value+='.pdf'
    return value

def public_record(row):
    item=dict(row); item['pages']=json.loads(item['pages']); item['rule']=json.loads(item['rule'])
    item['changed']=len(item['pages']); return item

class HistoryStore:
    def __init__(self, directory, *, now=None, min_free_bytes=512*1024*1024):
        self.directory=Path(directory); self.directory.mkdir(parents=True,exist_ok=True,mode=0o700)
        self.path=self.directory/'history.sqlite3'; self.now=now or (lambda:datetime.now(timezone.utc))
        self.min_free_bytes=min_free_bytes
        with closing(self.connect()) as db, db:
            db.execute('''CREATE TABLE IF NOT EXISTS documents (
                id TEXT PRIMARY KEY, created_at TEXT NOT NULL, day TEXT NOT NULL,
                name TEXT NOT NULL, source_name TEXT NOT NULL, username TEXT NOT NULL,
                size INTEGER NOT NULL, total INTEGER NOT NULL, pages TEXT NOT NULL,
                rule TEXT NOT NULL, search_text TEXT NOT NULL, pdf BLOB NOT NULL)''')
            db.execute('CREATE INDEX IF NOT EXISTS documents_date ON documents(day DESC, created_at DESC, id DESC)')
        if os.name!='nt': self.path.chmod(0o600)

    def connect(self):
        db=sqlite3.connect(self.path,timeout=3); db.row_factory=sqlite3.Row
        db.execute('PRAGMA synchronous=FULL'); return db

    def save(self, pdf, *, source_name='etiquetas.pdf', user='', rule=None, total, pages):
        if not pdf.startswith(b'%PDF-') or not 1<=len(pdf)<=20*1024*1024:
            raise HistoryError('No se pudo verificar el PDF para guardarlo.',422)
        if type(total)!=int or not 1<=total<=300 or not isinstance(pages,list) or not pages or any(type(n)!=int or not 1<=n<=total for n in pages) or len(set(pages))!=len(pages):
            raise HistoryError('No se pudo verificar el resultado para guardarlo.',422)
        if shutil.disk_usage(self.directory).free < self.min_free_bytes+len(pdf)*3:
            raise HistoryError('No hay espacio suficiente para guardar el PDF. El historial existente sigue disponible.',507)
        instant=self.now()
        if instant.tzinfo is None: raise HistoryError('No se pudo determinar la fecha del archivo.')
        source_name=clean_name(source_name); name=source_name[:-4]+'_corregido.pdf'
        item={'id':str(uuid.uuid4()),'created_at':instant.astimezone(timezone.utc).isoformat(timespec='microseconds'),
              'day':instant.astimezone(ARGENTINA).date().isoformat(),'name':name,'source_name':source_name,
              'username':str(user)[:120],'size':len(pdf),'total':total,'pages':json.dumps(pages),'rule':json.dumps(rule,ensure_ascii=False)}
        try:
            with closing(self.connect()) as db, db:
                db.execute('INSERT INTO documents ('+META+', search_text, pdf) VALUES ('+','.join('?' for _ in range(12))+')',
                    [item[k.strip()] for k in META.split(',')]+[search_key(name+' '+source_name),sqlite3.Binary(pdf)])
        except (sqlite3.Error,OSError) as error:
            raise HistoryError('No se pudo guardar el PDF en el historial. Volvé a intentar.') from error
        return public_record(item)

    def list(self, *, q='', date_from='', date_to='', page=1):
        if not isinstance(q,str) or len(q)>160:raise HistoryError('La búsqueda debe tener hasta 160 caracteres.',400)
        for value in [date_from,date_to]:
            if not isinstance(value,str):raise HistoryError('Ingresá una fecha válida.',400)
            if value:
                try:
                    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}',value):raise ValueError()
                    date.fromisoformat(value)
                except (ValueError,TypeError):raise HistoryError('Ingresá una fecha válida.',400)
        if date_from and date_to and date_from>date_to:raise HistoryError('La fecha Desde no puede ser posterior a Hasta.',400)
        if isinstance(page,bool) or not re.fullmatch(r'[1-9]\d{0,6}',str(page)):raise HistoryError('Página no válida.',400)
        page=int(page); where=[]; params=[]
        for expression,value in [('instr(search_text,?)>0',search_key(q.strip())),('day>=?',date_from),('day<=?',date_to)]:
            if value:where.append(expression);params.append(value)
        clause=' WHERE '+' AND '.join(where) if where else ''
        with closing(self.connect()) as db:
            total=db.execute('SELECT count(*) FROM documents'+clause,params).fetchone()[0]
            rows=db.execute('SELECT '+META+' FROM documents'+clause+' ORDER BY day DESC,created_at DESC,id DESC LIMIT ? OFFSET ?',params+[PAGE_SIZE,(page-1)*PAGE_SIZE]).fetchall()
        return {'items':[public_record(row) for row in rows],'total':total,'page':page,'pages':max(1,math.ceil(total/PAGE_SIZE)),'page_size':PAGE_SIZE}

    def get(self, identifier, *, include_pdf=True):
        if not isinstance(identifier,str) or not UUID_RE.fullmatch(identifier):raise HistoryError('Archivo no encontrado.',404)
        with closing(self.connect()) as db:
            row=db.execute('SELECT '+META+(', pdf' if include_pdf else '')+' FROM documents WHERE id=?',(identifier,)).fetchone()
        if row is None:raise HistoryError('Archivo no encontrado.',404)
        data=dict(row); pdf=data.pop('pdf',b''); return pdf,public_record(data)
