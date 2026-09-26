import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const PUB = '/opt/fusionbikes/worktrees/bandeja-auditoria/public';
const PORT = 3457;
const foto = (bg, txt, w, h) => `/fotos/${bg}-${w}x${h}.svg?t=${encodeURIComponent(txt)}`;
const at = (nombre, marca, vc, vm) => ({ nombre, marca, valorCandidato: vc, valorMl: vm });
const pub = (t, sku, extra = {}) => ({ titulo: t, sku_observado: sku, precio: 189900, moneda: 'ARS', stock: 3, link_ml: 'https://articulo.mercadolibre.com.ar/MLA-1', atributos: { color: 'Negro', talle: 'M', rodado: '29', marca: 'Shimano', modelo: 'Deore' }, ...extra });
const cand = (n, sku, titulo, atrs, extra = {}) => ({ variant_id: 'v' + n, sku, titulo, foto: foto('c' + n, titulo, 800, 600), precio: 175000, stock: 2, explicacion: { atributos: atrs, otros_atributos: [] }, ...extra });
const iguales = () => [at('marca', 'coincide', 'Shimano', 'Shimano'), at('modelo', 'coincide', 'Deore', 'Deore'), at('rodado', 'coincide', '29', '29'), at('material', 'coincide', 'Aluminio', 'Aluminio')];
const T = 'Bicicleta Mountain Bike Rodado 29 Shimano Deore 12 Velocidades Frenos Hidraulicos Suspension Bloqueo Aro Doble Pared Negro';
const casos = [
 { id: '00000000-0000-4000-8000-000000000001', grupo: 4, tipo_caso: 'sin_candidatos', version: 1, pub: pub(T, ''), cands: [] },
 { id: '00000000-0000-4000-8000-000000000002', grupo: 2, tipo_caso: 'sku_pendiente', version: 1, pub: pub('Cubierta Maxxis Minion DHF 29 x 2.5 Tubeless Ready Plegable', 'MX-DHF-29'), cands: [cand(1, 'MX-DHF-29-25', 'Cubierta Maxxis Minion DHF 29x2.5 Plegable TR', [...iguales(), at('talle', 'falta', '', '')])], sombra: { sku: 'MX-DHF-29-25' } },
 { id: '00000000-0000-4000-8000-000000000003', grupo: 0, tipo_caso: 'atributo_divergente', version: 2, pub: pub(T, 'MTB-DEORE-29-N'), cands: [cand(1, 'MTB-DEORE-29-N-M', 'Bicicleta MTB Deore 29 Negra Talle M', [...iguales(), at('color', 'difiere', 'Azul', 'Negro'), at('talle', 'difiere', 'L', 'M')])] },
 { id: '00000000-0000-4000-8000-000000000004', grupo: 0, tipo_caso: 'user_product_divergente', version: 3, pub: pub('Casco Bell Super Air R MIPS Talle L Matte Black', 'BELL-SAR-L-MB'), cands: [cand(1, 'BELL-SAR-M-MB', 'Casco Bell Super Air R MIPS Talle M Matte Black', [...iguales(), at('talle', 'difiere', 'M', 'L'), at('color', 'equivalente', 'Matte Black', 'Negro Mate')]) ], detalle: { d5: false } },
 { id: '00000000-0000-4000-8000-000000000005', grupo: 3, tipo_caso: 'con_3_candidatos', version: 1, pub: pub('Cadena Shimano Deore CN-M6100 12 Velocidades 126 Eslabones', 'CN-M6100-126'), cands: [
   cand(1, 'CN-M6100-126', 'Cadena Shimano Deore CN-M6100 12v 126 eslabones', [...iguales(), at('velocidades', 'coincide', '12', '12')]),
   cand(2, 'CN-M6100-116', 'Cadena Shimano Deore CN-M6100 12v 116 eslabones', [...iguales(), at('velocidades', 'coincide', '12', '12'), at('eslabones', 'difiere', '116', '126')]),
   cand(3, 'CN-M7100-126', 'Cadena Shimano SLX CN-M7100 12v 126 eslabones', [...iguales(), at('velocidades', 'coincide', '12', '12'), at('modelo', 'difiere', 'SLX', 'Deore')])] },
];
casos.forEach((c, i) => { c.pub.foto_ml = foto('ml', 'ML ' + c.tipo_caso, 1200, 1200); });
const contadores = { conflictos: 2, d5: 0, sku_exacto: 1, activas_con_stock: 1, resto: 1, confirmable: 0, sin_titulo: 0, apartados: 0 };
const json = (res, s, o) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); const p = u.pathname;
  if (p === '/api/auth/me') return json(res, 200, { ok: true, is_admin: true, permisos: [], usuario: 'qa' });
  if (p === '/api/bandeja-identidad/casos' && req.method === 'GET') return json(res, 200, { casos: casos.map((c) => ({ id: c.id, grupo: c.grupo, tipo_caso: c.tipo_caso, titulo: c.pub.titulo })), siguiente: null, contadores });
  let m = p.match(/^\/api\/bandeja-identidad\/casos\/([^/]+)$/);
  if (m) { const c = casos.find((x) => x.id === m[1]); if (!c) return json(res, 404, { code: 'caso_inexistente' });
    return json(res, 200, { id: c.id, version: c.version, tipo_caso: c.tipo_caso, cerrado_en: null, publicacion: c.pub, candidatos: c.cands, auto_sku_en_sombra: c.sombra || null, detalle: c.detalle || {}, historial: [{ actor: 'motor', origen: 'motor', efecto: 'sugerir', eleccion: 'vincular', sku: c.cands[0]?.sku, creado_en: '2026-09-20T10:00:00Z' }], evidencia: [{ fuente: 'ml', observado_en: '2026-09-25T09:00:00Z', campos: { item: 'MLA1' } }] }); }
  if (p.endsWith('/decisiones') || p.endsWith('/apartar')) { let b = ''; req.on('data', (d) => b += d); req.on('end', () => { console.log('POST', p, b); json(res, 200, { decision_id: 'd-' + Date.now(), version: 9 }); }); return; }
  if (p === '/api/bandeja-identidad/variantes') return json(res, 200, { variantes: [] });
  m = p.match(/^\/fotos\/(.+)-(\d+)x(\d+)\.svg$/);
  if (m) { const [, bg, w, h] = m; const col = { ml: '#f5c518', c1: '#7fb3d5', c2: '#a9dfbf', c3: '#f5b7b1' }[bg] || '#ccc';
    res.writeHead(200, { 'content-type': 'image/svg+xml' });
    return res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="${col}"/><circle cx="${w / 2}" cy="${h / 2}" r="${Math.min(w, h) / 4}" fill="#333"/><text x="20" y="40" font-size="28" font-family="sans-serif">${bg} ${w}x${h}</text></svg>`); }
  let f = p.replace(/^\/herramientas\//, '/'); if (f.endsWith('/')) f += 'index.html';
  const fp = path.join(PUB, f);
  if (fp.startsWith(PUB) && fs.existsSync(fp) && fs.statSync(fp).isFile()) { res.writeHead(200, { 'content-type': MIME[path.extname(fp)] || 'application/octet-stream' }); return fs.createReadStream(fp).pipe(res); }
  res.writeHead(404); res.end('nf');
}).listen(PORT, '127.0.0.1', () => console.log('listo', PORT));
