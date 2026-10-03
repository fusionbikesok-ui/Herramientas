// Stub de la plataforma para el entorno QA bajo demanda: sólo la API interna de la bandeja de identidad
// (`/internal/v1/identidad/*`), con las mismas respuestas y códigos que plataforma/src/api/identidad-interna.ts.
//
// QUÉ ES: un servicio HTTP en memoria con casos de fixture determinísticos, para poder probar en un
// navegador real la UI y el proxy del legado (routes/bandejaIdentidad.js). QUÉ NO ES: la plataforma. No hay
// Postgres ni motor de identidad; la lógica real de decidir/apartar está cubierta por los tests de plataforma/.
//
// Autenticación: la REAL. Verifica la firma HMAC v1 con lib/internoHmac.js (el mismo módulo que usa el legado
// para sus endpoints internos), con un keyring de QA generado por qa.sh, ventana de 300 s y nonce de un solo
// uso. Los GET firman la ruta con la query completa; los POST/DELETE, sólo el path.
//
// Uso: STUB_KEYRING_FILE=/run/qa/keyring.json [STUB_PORT=3300] node scripts/qa/plataforma-stub.mjs
import http from 'http';
import crypto from 'crypto';
import { pathToFileURL } from 'url';
import Database from 'better-sqlite3';
import { cargarKeyringInterno, crearOrigenesInternos, verificarInterno } from '../../lib/internoHmac.js';

const PREFIJO = '/internal/v1/identidad';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ELECCIONES = ['vincular', 'omitir', 'mantener_omision', 'sin_candidato'];
const LIMITE_POR_DEFECTO = 50;
const LIMITE_MAXIMO = 200;
const ORIGENES_QA = '127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16'; // loopback + redes de docker

// Foto en data: URI: determinística y sin salir a internet.
const FOTO = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="180"><rect width="240" height="180" fill="#2DB8E8"/>'
  + '<text x="120" y="96" font-size="22" text-anchor="middle" fill="#fff" font-family="sans-serif">Foto QA</text></svg>');

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const linkMl = (recurso) => 'https://articulo.mercadolibre.com.ar/' + recurso.replace(/^(ML[A-Z])/, '$1-');
const mk = (nombre, marca, valorMl, valorCandidato) => ({ nombre, marca, valorMl, valorCandidato });

const VARIANTES = [
  { variant_id: id(201), sku: 'FB-1001', titulo: 'Casco Urbano Negro M', foto: FOTO, precio: 45000, moneda: 'ARS', stock: 8, color: 'Negro', talle: 'M' },
  { variant_id: id(202), sku: 'FB-1002', titulo: 'Casco Urbano Negro L', foto: null, precio: 45000, moneda: 'ARS', stock: 3, color: 'Negro', talle: 'L' },
  { variant_id: id(203), sku: 'FB-1003', titulo: 'Casco Urbano Rojo M', foto: null, precio: 46000, moneda: 'ARS', stock: 5, color: 'Rojo', talle: 'M' },
  { variant_id: id(204), sku: 'FB-2001', titulo: 'Cubierta Ruta 700x25', foto: null, precio: 38000, moneda: 'ARS', stock: 12, color: 'Negro', talle: null },
  { variant_id: id(205), sku: 'FB-2002', titulo: 'Cubierta Ruta 700x28', foto: null, precio: 39500, moneda: 'ARS', stock: 0, color: 'Negro', talle: null },
  { variant_id: id(206), sku: 'FB-3001', titulo: 'Luz Delantera Recargable 800 lm', foto: FOTO, precio: 22000, moneda: 'ARS', stock: 20, color: null, talle: null },
];
const variante = (n) => VARIANTES.find((v) => v.variant_id === id(n));

function candidato(rank, v, atributos, otros) {
  return { rank, variant_id: v.variant_id, sku: v.sku, titulo: v.titulo, foto: v.foto, precio: v.precio, moneda: v.moneda, stock: v.stock,
    explicacion: { atributos, otros_atributos: otros } };
}

/** Casos de fixture. Cada uno cubre un escenario que la UI tiene que poder mostrar. */
export function crearFixture() {
  const ts = '2026-10-01T12:00:00.000000Z';
  return [
    { // Normal: con título, activa con stock, tres candidatos (grupo 3).
      id: id(1), tipo: 'sku_pendiente', estado: 'open', prioridad: 50, version: 1, abierto_en: ts, d5: false, grupo: 3, apartado: false,
      confirmar: null, detalle: {},
      publicacion: { recurso: 'MLA1000001', variacion: '', titulo: 'Casco Urbano Negro Talle M', sku_observado: null, estado: 'active', stock: 4, precio: 45500, moneda: 'ARS',
        foto: null, atributos: { color: 'Negro', talle: 'M', marca: 'Fusion' } },
      candidatos: [
        candidato(1, variante(201), [mk('color', 'coincide', 'Negro', 'Negro'), mk('talle', 'coincide', 'M', 'M')], [mk('marca', 'coincide', 'Fusion', 'Fusion')]),
        candidato(2, variante(202), [mk('color', 'coincide', 'Negro', 'Negro'), mk('talle', 'difiere', 'M', 'L')], [mk('marca', 'coincide', 'Fusion', 'Fusion')]),
        candidato(3, variante(203), [mk('color', 'difiere', 'Negro', 'Rojo'), mk('talle', 'coincide', 'M', 'M')], [mk('marca', 'coincide', 'Fusion', 'Fusion')]),
      ],
    },
    { // Posible duplicado (D5, grupo 1): dos candidatos casi idénticos.
      id: id(2), tipo: 'woo_sku_duplicado', estado: 'open', prioridad: 90, version: 1, abierto_en: '2026-10-01T11:00:00.000000Z', d5: true, grupo: 1, apartado: false,
      confirmar: null, detalle: { d5: true },
      publicacion: { recurso: 'MLA1000002', variacion: '', titulo: 'Cubierta Ruta 700x25 Negra', sku_observado: 'FB-2001', estado: 'active', stock: 6, precio: 38500, moneda: 'ARS',
        foto: null, atributos: { color: 'Negro', medida: '700x25' } },
      candidatos: [
        candidato(1, variante(204), [mk('color', 'coincide', 'Negro', 'Negro')], [mk('medida', 'coincide', '700x25', '700x25')]),
        candidato(2, variante(205), [mk('color', 'coincide', 'Negro', 'Negro')], [mk('medida', 'difiere', '700x25', '700x28')]),
      ],
    },
    { // Sin atributos ML (grupo 4): la publicación no declara nada; todo se marca "falta".
      id: id(3), tipo: 'atributo_divergente', estado: 'open', prioridad: 40, version: 1, abierto_en: '2026-10-01T13:00:00.000000Z', d5: false, grupo: 4, apartado: false,
      confirmar: null, detalle: {},
      publicacion: { recurso: 'MLA1000003', variacion: '', titulo: 'Casco Urbano', sku_observado: null, estado: 'paused', stock: 0, precio: 44000, moneda: 'ARS',
        foto: null, atributos: {} },
      candidatos: [
        candidato(1, variante(201), [mk('color', 'falta', '', 'Negro'), mk('talle', 'falta', '', 'M')], [mk('marca', 'falta', '', 'Fusion')]),
        candidato(2, variante(203), [mk('color', 'falta', '', 'Rojo'), mk('talle', 'falta', '', 'M')], [mk('marca', 'falta', '', 'Fusion')]),
      ],
    },
    { // Con foto en caché (detalle y candidato con foto), activa con stock.
      id: id(4), tipo: 'sku_pendiente', estado: 'open', prioridad: 55, version: 1, abierto_en: '2026-10-01T14:00:00.000000Z', d5: false, grupo: 3, apartado: false,
      confirmar: null, detalle: {},
      publicacion: { recurso: 'MLA1000004', variacion: '', titulo: 'Luz Delantera Recargable 800 Lumens', sku_observado: null, estado: 'active', stock: 10, precio: 22500, moneda: 'ARS',
        foto: FOTO, atributos: { potencia: '800 lm', bateria: 'USB' } },
      candidatos: [
        candidato(1, variante(206), [], [mk('potencia', 'coincide', '800 lm', '800 lm'), mk('bateria', 'difiere', 'USB', 'USB-C')]),
      ],
    },
    { // Confirmable (grupo 5): ya vinculado, sin candidatos que buscar.
      id: id(5), tipo: 'identidad_legado', estado: 'open', prioridad: 30, version: 1, abierto_en: '2026-10-01T15:00:00.000000Z', d5: false, grupo: 5, apartado: false,
      confirmar: { variant_id: variante(206).variant_id, sku: variante(206).sku }, detalle: {},
      publicacion: { recurso: 'MLA1000005', variacion: '', titulo: 'Luz Delantera Recargable', sku_observado: 'FB-3001', estado: 'active', stock: 7, precio: 22000, moneda: 'ARS',
        foto: null, atributos: { potencia: '800 lm' } },
      candidatos: [],
    },
    { // Sin título (grupo 6).
      id: id(6), tipo: 'sku_pendiente', estado: 'open', prioridad: 20, version: 1, abierto_en: '2026-10-01T16:00:00.000000Z', d5: false, grupo: 6, apartado: false,
      confirmar: null, detalle: {},
      publicacion: { recurso: 'MLA1000006', variacion: '', titulo: null, sku_observado: null, estado: 'active', stock: 2, precio: 15000, moneda: 'ARS',
        foto: null, atributos: {} },
      candidatos: [],
    },
    { // Posible duplicado de otra publicación ya vinculada (grupo 3): prueba el aviso del encabezado.
      id: id(7), tipo: 'sku_pendiente', estado: 'open', prioridad: 45, version: 1, abierto_en: '2026-10-01T17:00:00.000000Z', d5: false, grupo: 3, apartado: false,
      confirmar: null, detalle: {},
      publicacion: { recurso: 'MLA1000007', variacion: '', titulo: 'Cubierta Ruta 700x25 Negra Oferta', sku_observado: null, estado: 'active', stock: 3, precio: 37000, moneda: 'ARS',
        foto: null, atributos: { color: 'Negro', medida: '700x25' },
        posible_duplicado: { recurso: 'MLA1000002', sku: 'FB-2001' } },
      candidatos: [
        candidato(1, variante(204), [mk('color', 'coincide', 'Negro', 'Negro')], [mk('medida', 'coincide', '700x25', '700x25')]),
      ],
    },
  ];
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}
const falla = (res, status, code, message, extra = {}) => json(res, status, { code, message, ...extra });

function leerCuerpo(req) {
  return new Promise((resolve, reject) => {
    const partes = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > 64 * 1024) { reject(Object.assign(new Error('grande'), { status: 413 })); req.destroy(); } else partes.push(c); });
    req.on('end', () => resolve(Buffer.concat(partes)));
    req.on('error', reject);
  });
}

const enteroPositivo = (v) => Number.isInteger(v) && v >= 1;
const actorValido = (a) => a && typeof a === 'object' && !Array.isArray(a) && typeof a.usuario === 'string' && a.usuario.length >= 1 && a.usuario.length <= 200
  && typeof a.es_admin === 'boolean' && Object.keys(a).every((k) => k === 'usuario' || k === 'es_admin');
const soloClaves = (o, permitidas) => Object.keys(o).every((k) => permitidas.includes(k));

export function crearPlataformaStub({ claves, ahoraMs = () => Date.now(), origenes = crearOrigenesInternos(ORIGENES_QA), fixture = crearFixture() } = {}) {
  if (!claves || !Object.keys(claves).length) throw new Error('el stub necesita un keyring');
  const nonces = new Database(':memory:');
  nonces.exec('CREATE TABLE internal_nonces (key_id TEXT NOT NULL, nonce TEXT NOT NULL, seen_at TEXT NOT NULL, PRIMARY KEY (key_id, nonce))');
  const casos = new Map(fixture.map((c) => [c.id, structuredClone(c)]));
  const idempotentes = new Map(); // clave de idempotencia -> { huella, status, body }
  let secuencia = 1000;

  const abiertos = () => [...casos.values()].filter((c) => c.estado !== 'closed');
  const grupoDe = (c) => (c.apartado ? 7 : c.grupo);
  const orden = (a, b) => grupoDe(a) - grupoDe(b) || a.abierto_en.localeCompare(b.abierto_en) || a.id.localeCompare(b.id);
  const cursorDe = (c) => Buffer.from(JSON.stringify({ g: grupoDe(c), a: c.abierto_en, id: c.id })).toString('base64url');
  const decodificar = (s) => {
    try {
      const c = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
      return Number.isInteger(c.g) && typeof c.a === 'string' && !Number.isNaN(Date.parse(c.a)) && UUID.test(c.id) ? c : null;
    } catch { return null; }
  };

  function contadores() {
    const en = (g) => abiertos().filter((c) => grupoDe(c) === g).length;
    return { conflictos: en(0), d5: en(1), sku_exacto: en(2), activas_con_stock: en(3), resto: en(4), confirmable: en(5), sin_titulo: en(6), apartados: en(7), no_decidibles: 0 };
  }

  const resumen = (c) => ({
    id: c.id, tipo: c.tipo, estado: c.estado, prioridad: c.prioridad, version: c.version, grupo: grupoDe(c), abierto_en: c.abierto_en, d5: c.d5,
    publicacion: { recurso: c.publicacion.recurso, variacion: c.publicacion.variacion, titulo: c.publicacion.titulo, sku_observado: c.publicacion.sku_observado,
      estado: c.publicacion.estado, stock: c.publicacion.stock, precio: c.publicacion.precio, moneda: c.publicacion.moneda, link_ml: linkMl(c.publicacion.recurso) },
    confirmar: grupoDe(c) === 5 ? c.confirmar : null,
    apartado: grupoDe(c) === 7,
  });

  function detalle(c) {
    return {
      id: c.id, tipo: c.tipo, estado: c.estado, prioridad: c.prioridad, version: c.version, abierto_en: c.abierto_en,
      cerrado_en: c.cerrado_en ?? null, motivo_cierre: c.motivo_cierre ?? null, detalle: c.detalle,
      publicacion: { recurso: c.publicacion.recurso, variacion: c.publicacion.variacion, titulo: c.publicacion.titulo, sku_observado: c.publicacion.sku_observado,
        estado: c.publicacion.estado, stock: c.publicacion.stock, precio: c.publicacion.precio, moneda: c.publicacion.moneda,
        link_ml: linkMl(c.publicacion.recurso), foto: c.publicacion.foto, atributos: c.publicacion.atributos,
        ...(c.publicacion.posible_duplicado ? { posible_duplicado: c.publicacion.posible_duplicado } : {}) },
      candidatos: c.candidatos,
      auto_sku_en_sombra: null,
      historial: c.historial ?? [],
      evidencia: [],
    };
  }

  const huella = (o) => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');
  const claveIdem = (req) => { const k = req.headers['idempotency-key']; return typeof k === 'string' && k.length >= 8 && k.length <= 200 ? k : null; };

  function decidir(c, d, clave) {
    const previa = idempotentes.get(clave);
    const h = huella({ caso: c.id, d });
    if (previa) return previa.huella === h ? previa.respuesta : { status: 422, body: { code: 'idempotency_mismatch', message: 'No se pudo decidir: idempotency_mismatch.' } };
    let respuesta;
    if (c.estado === 'closed') respuesta = { status: 409, body: { code: 'caso_cerrado', message: 'No se pudo decidir: caso_cerrado.' } };
    else if (d.expected_version !== c.version) respuesta = { status: 409, body: { code: 'version_conflict', message: 'No se pudo decidir: version_conflict.' } };
    else if (d.eleccion === 'vincular' && !VARIANTES.some((v) => v.variant_id === d.variant_id)) {
      respuesta = { status: 422, body: { code: 'variante_invalida', message: 'No se pudo decidir: variante_invalida.' } };
    } else {
      c.version += 1; c.estado = 'closed'; c.cerrado_en = new Date().toISOString(); c.motivo_cierre = `decision:${d.eleccion}`; c.apartado = false;
      const decisionId = id(secuencia++);
      (c.historial ??= []).unshift({ id: decisionId, origen: 'humano', efecto: 'vigente', eleccion: d.eleccion, sku: VARIANTES.find((v) => v.variant_id === d.variant_id)?.sku ?? null,
        actor: d.actor.usuario, motivo: d.motivo ?? null, creado_en: c.cerrado_en, superada_en: null, supersede_a: null });
      const vinculo = d.eleccion === 'vincular' ? 'vinculada' : (d.eleccion === 'sin_candidato' ? 'pendiente' : 'omitida');
      respuesta = { status: 200, body: { decision_id: decisionId, version: c.version, vinculo } };
    }
    idempotentes.set(clave, { huella: h, respuesta });
    return respuesta;
  }

  function marca(c, d, clave, apartar) {
    const previa = idempotentes.get(clave);
    const h = huella({ caso: c.id, apartar, d });
    if (previa) return previa.huella === h ? previa.respuesta : { status: 422, body: { code: 'idempotency_mismatch', message: 'No se pudo.' } };
    let respuesta;
    if (c.estado === 'closed') respuesta = { status: 409, body: { code: 'caso_cerrado', message: 'No se pudo: caso_cerrado.' } };
    else if (d.expected_version !== c.version) respuesta = { status: 409, body: { code: 'version_conflict', message: 'No se pudo: version_conflict.' } };
    else if (!apartar && !c.apartado) respuesta = { status: 409, body: { code: 'no_apartado', message: 'No se pudo desapartar: no_apartado.' } };
    else { c.apartado = apartar; c.version += 1; respuesta = { status: 200, body: { version: c.version } }; }
    idempotentes.set(clave, { huella: h, respuesta });
    return respuesta;
  }

  async function manejar(req, res) {
    const url = new URL(req.url, 'http://stub');
    const ruta = url.pathname;
    const metodo = req.method;
    if (ruta === '/healthz') return json(res, 200, { ok: true, stub: true });
    if (!ruta.startsWith(PREFIJO + '/')) return falla(res, 404, 'no_encontrado', 'Ruta inexistente.');
    let cuerpo;
    try { cuerpo = await leerCuerpo(req); } catch (e) { return falla(res, e.status === 413 ? 413 : 400, e.status === 413 ? 'payload_too_large' : 'invalid_body', 'El cuerpo no es válido.'); }
    // Los GET firman la ruta con la query completa; el resto, sólo el path.
    const firmada = metodo === 'GET' ? req.url : ruta;
    const v = verificarInterno({ db: nonces, claves, origenes, direccion: req.socket.remoteAddress, headers: req.headers, metodo, ruta: firmada, cuerpo, ahoraMs: ahoraMs() });
    if (!v.ok) return falla(res, 401, 'unauthorized', 'Autenticación interna inválida.');

    const resto = ruta.slice(PREFIJO.length);
    if (metodo === 'GET' && resto === '/casos') {
      const q = Object.fromEntries(url.searchParams);
      const permitidas = ['tipo', 'estado', 'grupo', 'cursor', 'limit'];
      const limit = q.limit === undefined ? LIMITE_POR_DEFECTO : Number(q.limit);
      const grupo = q.grupo === undefined ? null : Number(q.grupo);
      if (!soloClaves(q, permitidas) || !Number.isInteger(limit) || limit < 1 || limit > LIMITE_MAXIMO
        || (grupo !== null && (!Number.isInteger(grupo) || grupo < 0 || grupo > 7))) return falla(res, 422, 'invalid_query', 'La consulta no es válida.');
      const cur = q.cursor ? decodificar(q.cursor) : null;
      if (q.cursor && !cur) return falla(res, 422, 'invalid_cursor', 'El cursor no es válido.');
      let lista = abiertos().sort(orden);
      if (q.tipo) lista = lista.filter((c) => c.tipo === q.tipo);
      if (q.estado) lista = lista.filter((c) => c.estado === q.estado);
      if (grupo !== null) lista = lista.filter((c) => grupoDe(c) === grupo);
      if (cur) lista = lista.filter((c) => orden(c, { ...c, grupo: cur.g, apartado: false, abierto_en: cur.a, id: cur.id }) > 0 || (grupoDe(c) === cur.g && c.abierto_en === cur.a && c.id > cur.id));
      const hay = lista.length > limit;
      const filas = lista.slice(0, limit);
      return json(res, 200, { casos: filas.map(resumen), contadores: contadores(), siguiente: hay && filas.length ? cursorDe(filas.at(-1)) : null });
    }
    let m = resto.match(/^\/casos\/([^/]+)$/);
    if (metodo === 'GET' && m) {
      if (!UUID.test(m[1])) return falla(res, 404, 'caso_inexistente', 'No existe el caso.');
      const c = casos.get(m[1].toLowerCase());
      return c ? json(res, 200, detalle(c)) : falla(res, 404, 'caso_inexistente', 'No existe el caso.');
    }
    if (metodo === 'GET' && resto === '/variantes') {
      const q = Object.fromEntries(url.searchParams);
      const texto = (q.q ?? '').trim();
      if (!soloClaves(q, ['q', 'caso_id']) || !texto || texto.length > 200 || (q.caso_id && !UUID.test(q.caso_id))) return falla(res, 422, 'invalid_query', 'Falta el texto a buscar.');
      let atributosMl = null;
      if (q.caso_id) {
        const c = casos.get(q.caso_id.toLowerCase());
        if (!c) return falla(res, 404, 'caso_inexistente', 'No existe el caso.');
        atributosMl = c.publicacion.atributos;
      }
      const t = texto.toUpperCase();
      const coincidencias = VARIANTES.filter((x) => x.sku.toUpperCase() === t || x.titulo.toUpperCase().includes(t))
        .sort((a, b) => Number(b.sku.toUpperCase() === t) - Number(a.sku.toUpperCase() === t) || a.titulo.localeCompare(b.titulo) || a.sku.localeCompare(b.sku)).slice(0, 20);
      const variantes = coincidencias.map((x) => {
        const base = { variant_id: x.variant_id, sku: x.sku, titulo: x.titulo, foto: x.foto, precio: x.precio, moneda: x.moneda, stock: x.stock };
        if (!atributosMl) return base;
        // Atributos de la variante contra los de la publicación del caso (color/talle los compara el motor, no esta lista).
        const otros = Object.entries(atributosMl).map(([nombre, valorMl]) => mk(nombre, 'falta', String(valorMl), ''));
        return { ...base, explicacion: { atributos: [], otros_atributos: otros } };
      });
      return json(res, 200, { variantes });
    }
    m = resto.match(/^\/casos\/([^/]+)\/(decisiones|apartar)$/);
    if (m && ((metodo === 'POST' && (m[2] === 'decisiones' || m[2] === 'apartar')) || (metodo === 'DELETE' && m[2] === 'apartar'))) {
      let datos;
      try { datos = JSON.parse(cuerpo.toString('utf8')); } catch { return falla(res, 400, 'invalid_body', 'El cuerpo no es JSON.'); }
      if (m[2] === 'apartar' && !UUID.test(m[1])) return falla(res, 404, 'caso_inexistente', 'No existe el caso.');
      if (!datos || typeof datos !== 'object' || Array.isArray(datos)) return falla(res, 422, 'invalid_body', 'El pedido no es válido.');
      if (m[2] === 'decisiones') {
        const ok = soloClaves(datos, ['expected_version', 'eleccion', 'variant_id', 'motivo', 'revierte', 'actor', 'confirmar'])
          && enteroPositivo(datos.expected_version) && ELECCIONES.includes(datos.eleccion) && actorValido(datos.actor)
          && (datos.variant_id === undefined || UUID.test(datos.variant_id)) && (datos.revierte === undefined || UUID.test(datos.revierte))
          && (datos.motivo === undefined || (typeof datos.motivo === 'string' && datos.motivo.length <= 2000))
          && (datos.confirmar === undefined || typeof datos.confirmar === 'boolean') && UUID.test(m[1]);
        if (!ok) return falla(res, 422, 'invalid_body', 'La decisión no es válida.');
      } else {
        const ok = soloClaves(datos, ['expected_version', 'actor', 'motivo']) && enteroPositivo(datos.expected_version) && actorValido(datos.actor)
          && (datos.motivo === undefined || (typeof datos.motivo === 'string' && datos.motivo.length <= 2000));
        if (!ok) return falla(res, 422, 'invalid_body', 'El pedido no es válido.');
      }
      const clave = claveIdem(req);
      if (!clave) return falla(res, 422, 'idempotency_key_requerida', 'Falta la cabecera Idempotency-Key.');
      const c = casos.get(m[1].toLowerCase());
      if (!c) return falla(res, 404, 'caso_inexistente', 'No existe el caso.');
      if (m[2] === 'decisiones' && datos.confirmar) {
        if (datos.eleccion !== 'vincular') return falla(res, 422, 'confirmar_invalido', 'Confirmar sólo aplica a eleccion vincular.');
        if (!c.confirmar || c.confirmar.variant_id !== datos.variant_id) return falla(res, 422, 'confirmar_invalido', 'La variante a confirmar no coincide con la ya vinculada al caso.');
      }
      const r = m[2] === 'decisiones' ? decidir(c, datos, clave) : marca(c, datos, clave, metodo === 'POST');
      return json(res, r.status, r.body);
    }
    return falla(res, 404, 'no_encontrado', 'Ruta inexistente.');
  }

  const servidor = http.createServer((req, res) => {
    manejar(req, res).catch(() => { if (!res.headersSent) falla(res, 500, 'internal_error', 'Error interno.'); });
  });
  servidor.on('close', () => nonces.close());
  return { servidor, casos, reiniciar() { casos.clear(); for (const c of fixture) casos.set(c.id, structuredClone(c)); idempotentes.clear(); } };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const claves = cargarKeyringInterno(process.env.STUB_KEYRING_FILE ?? '/run/qa/keyring.json');
  const { servidor } = crearPlataformaStub({ claves });
  const puerto = Number(process.env.STUB_PORT ?? 3300);
  servidor.listen(puerto, '0.0.0.0', () => console.log(`[plataforma-stub] escuchando en :${puerto}`));
}
