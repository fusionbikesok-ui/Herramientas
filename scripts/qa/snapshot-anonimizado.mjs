// Snapshot anonimizado de la base de producción para el entorno QA bajo demanda.
// Plan: docs/superpowers/plans/2026-09-13-qa-bajo-demanda.md (paso 1).
//
// Uso: node scripts/qa/snapshot-anonimizado.mjs <origen.sqlite> <destino.sqlite>
//      Clave común de QA: env QA_CLAVE o /root/.config/fusion-qa/clave.
//
// Garantías:
//  - Copia consistente (API de backup online): se puede correr con la app escribiendo.
//  - Lista CERRADA de columnas JSON: si el esquema tiene una columna JSON no clasificada acá, falla.
//  - Antes de anonimizar toma una muestra de datos reales y, al terminar, los busca en TODA la base;
//    si aparece alguno, borra el destino y falla.
//  - VACUUM final: los valores reemplazados no quedan en páginas libres del archivo.
//  - Sesiones: viven en data/sessions.sqlite y nunca se copian.
import fs from 'fs';
import { pathToFileURL } from 'url';
import Database from 'better-sqlite3';
import { hashPassword } from '../../lib/auth.js';

const ANON = '[anonimizado]';

// Toda columna cuyo nombre contiene "json" o "payload" tiene que estar acá. Todas se recorren con
// `limpiarJson`, que sólo toca claves sensibles: los datos de producto quedan intactos.
export const COLUMNAS_JSON = new Set([
  'auditoria_publicacion.problemas_json', 'catalogo_cache.categorias_json', 'catalogo_cache.atributos_json',
  'despacho_horarios_auditoria.valores_anteriores_json', 'despacho_horarios_auditoria.valores_nuevos_json',
  'despacho_lote_eventos.detalle_json', 'gestion_pedido_eventos.datos_json', 'gestion_pedidos.datos_ml_json',
  'gestion_recuperacion_oportunidades.datos_json', 'guardia_ml_eventos.detalle_json',
  'guardia_ml_pedidos_retenidos.items_json', 'identidad_comandos.resultado_json',
  'identidad_eventos_integracion.payload_json', 'identidad_evidencias.contenido_json',
  'identidad_historial.detalle_json', 'identidad_operacion_pasos.solicitud_json',
  'identidad_operacion_pasos.respuesta_json', 'identidad_reglas_familia.atributos_requeridos_json',
  'incidentes_operativos.contexto_json', 'incidentes_operativos_historial.detalle_json',
  'integration_events.metadata_json', 'matcher_candidatos_cache.resultado_json',
  'ml_publicaciones_cache.atributos_json', 'ml_publicaciones_cache.canales_json',
  'operational_day_events.antes_json', 'operational_day_events.despues_json',
  'operational_day_events.detalle_json', 'operational_days.ventana_ml_json',
  'ordenes_ml_procesadas.items_json', 'ordenes_ml_wc_pedidos.comprador_json', 'pedidos_cache.items_json',
  'pick_wave_helpers.entrega_json', 'pick_wave_items.items_json_snapshot', 'preparacion_eventos.detalle_json',
  'preparacion_items.requisitos_json_snapshot', 'preparacion_perfiles.requisitos_json',
  'preparacion_perfiles_eventos.detalle_json', 'preparacion_perfiles_sku.requisitos_json',
  'producto_fusion_atributos.valor_json', 'recepcion_items.ficha_json',
  'stock_exception_events.antes_json', 'stock_exception_events.despues_json',
  'stock_supplier_return_events.antes_json', 'stock_supplier_return_events.despues_json',
]);
// Coinciden por nombre pero no contienen JSON.
export const COLUMNAS_NO_JSON = new Set(['integration_events.payload_version']);

// Claves con datos de personas en payloads de ML/Woo. Valor escalar → texto anónimo; objeto → null.
const CLAVES_SENSIBLES = new Set([
  'first_name', 'last_name', 'nickname', 'email', 'phone', 'alternative_phone', 'telephone',
  'address_line', 'street_name', 'street_number', 'comment', 'doc_number', 'doc_type', 'identification',
  'billing_info', 'billing', 'receiver_name', 'receiver_phone', 'receiver_address', 'customer_note',
  'nombre_receptor', 'comprador', 'nota', 'notas', 'telefono', 'documento', 'direccion_envio',
]);

export const TABLAS_SECRETOS = ['ml_oauth_token', 'device_tokens', 'mobile_refresh_tokens', 'password_reset_tokens'];

export function limpiarJson(valor) {
  if (Array.isArray(valor)) return valor.map(limpiarJson);
  if (!valor || typeof valor !== 'object') return valor;
  const salida = {};
  for (const [k, v] of Object.entries(valor)) {
    if (k === 'buyer' && v && typeof v === 'object') salida[k] = { id: v.id ?? null, nickname: ANON };
    else if (CLAVES_SENSIBLES.has(k)) salida[k] = v && typeof v === 'object' ? null : (v === null || v === '' ? v : ANON);
    else salida[k] = limpiarJson(v);
  }
  return salida;
}

function tablaExiste(db, t) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
}

function tablasDeUsuario(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name);
}

function columnas(db, t) {
  return db.prepare(`PRAGMA table_info("${t}")`).all().map(c => c.name);
}

export function verificarListaCerrada(db) {
  const faltan = [];
  for (const t of tablasDeUsuario(db)) {
    for (const c of columnas(db, t)) {
      const id = `${t}.${c}`;
      if (/json|payload/i.test(c) && !COLUMNAS_JSON.has(id) && !COLUMNAS_NO_JSON.has(id)) faltan.push(id);
    }
  }
  if (faltan.length) {
    throw new Error(`Columnas JSON sin clasificar en scripts/qa/snapshot-anonimizado.mjs: ${faltan.join(', ')}`);
  }
}

function valores(db, sql, minimo) {
  try {
    return db.prepare(sql).all().map(r => String(r.v ?? '').trim()).filter(v => v.length >= minimo);
  } catch { return []; }
}

// Muestra de datos reales que no pueden sobrevivir a la anonimización.
export function tomarMuestra(db, limite = 150) {
  const lim = `ORDER BY random() LIMIT ${limite}`;
  const muestra = [
    ...valores(db, `SELECT email v FROM gestion_pedido_clientes WHERE email LIKE '%@%' ${lim}`, 7),
    ...valores(db, `SELECT telefono v FROM gestion_pedido_clientes WHERE length(telefono) >= 8 ${lim}`, 8),
    ...valores(db, `SELECT documento v FROM gestion_pedido_clientes WHERE length(documento) >= 7 ${lim}`, 7),
    ...valores(db, `SELECT nombre v FROM gestion_pedido_clientes WHERE length(nombre) >= 10 ${lim}`, 10),
    ...valores(db, `SELECT nombre_receptor v FROM gestion_pedido_entregas WHERE length(nombre_receptor) >= 10 ${lim}`, 10),
    ...valores(db, `SELECT direccion v FROM gestion_pedido_entregas WHERE length(direccion) >= 10 ${lim}`, 10),
    ...valores(db, `SELECT comprador v FROM preparaciones WHERE length(comprador) >= 10 ${lim}`, 10),
    ...valores(db, `SELECT comprador v FROM pedidos_cache WHERE length(comprador) >= 10 ${lim}`, 10),
    ...valores(db, `SELECT customer_note v FROM pedidos_cache WHERE length(customer_note) >= 12 ${lim}`, 12),
    ...valores(db, `SELECT json_extract(comprador_json,'$.nickname') v FROM ordenes_ml_wc_pedidos ${lim}`, 8),
    ...valores(db, `SELECT json_extract(datos_ml_json,'$.buyer.nickname') v FROM gestion_pedidos WHERE datos_ml_json IS NOT NULL ${lim}`, 8),
    ...valores(db, `SELECT email v FROM users WHERE email LIKE '%@%'`, 7),
  ];
  return [...new Set(muestra)];
}

// Un valor sólo numérico (teléfono, DNI) cuenta únicamente como número completo: medido en
// producción 2026-09-13, teléfonos reales aparecían como parte de números más largos en atributos
// de publicaciones ML (falsos positivos).
function coincide(celda, muestra) {
  if (/^\d+$/.test(muestra)) {
    for (let i = celda.indexOf(muestra); i !== -1; i = celda.indexOf(muestra, i + 1)) {
      const antes = celda[i - 1];
      const despues = celda[i + muestra.length];
      if (!(antes >= '0' && antes <= '9') && !(despues >= '0' && despues <= '9')) return true;
    }
    return false;
  }
  return celda.includes(muestra);
}

// Devuelve el primer hallazgo {tabla, columna, valor} o null. Recorre toda celda de texto.
export function buscarDatosReales(db, muestra) {
  if (!muestra.length) return null;
  const minimo = Math.min(...muestra.map(v => v.length));
  const minus = muestra.map(v => v.toLowerCase());
  for (const t of tablasDeUsuario(db)) {
    const cols = columnas(db, t);
    for (const c of cols) {
      const stmt = db.prepare(`SELECT "${c}" AS v FROM "${t}" WHERE typeof("${c}")='text' AND length("${c}") >= ?`);
      for (const { v } of stmt.iterate(minimo)) {
        const celda = v.toLowerCase();
        const i = minus.findIndex(m => coincide(celda, m));
        if (i !== -1) return { tabla: t, columna: c, valor: muestra[i] };
      }
    }
  }
  return null;
}

function actualizarSi(db, tabla, sql) {
  if (tablaExiste(db, tabla)) db.prepare(sql).run();
}

export function anonimizarBase(db, { claveQa }) {
  if (!claveQa || String(claveQa).length < 12) throw new Error('Clave de QA ausente o menor a 12 caracteres');
  verificarListaCerrada(db);
  db.function('hash_qa', { deterministic: false }, () => hashPassword(claveQa));

  const tx = db.transaction(() => {
    for (const t of TABLAS_SECRETOS) if (tablaExiste(db, t)) db.prepare(`DELETE FROM "${t}"`).run();

    // Usuarios internos: se conservan username, roles y permisos (la auditoría los referencia por
    // nombre); se reemplazan email y clave.
    actualizarSi(db, 'users', `UPDATE users SET email = CASE WHEN email IS NULL OR email = '' THEN email ELSE 'usuario' || id || '@qa.invalid' END, pass_hash = hash_qa()`);

    actualizarSi(db, 'gestion_pedido_clientes', `UPDATE gestion_pedido_clientes SET
      nombre = 'Cliente ' || id,
      email = CASE WHEN email IS NULL OR email = '' THEN email ELSE 'cliente' || id || '@qa.invalid' END,
      telefono = CASE WHEN telefono IS NULL OR telefono = '' THEN telefono ELSE 'QA-TEL-' || id END,
      documento = CASE WHEN documento IS NULL OR documento = '' THEN documento ELSE 'QA-DOC-' || id END`);
    actualizarSi(db, 'gestion_pedido_entregas', `UPDATE gestion_pedido_entregas SET
      nombre_receptor = CASE WHEN nombre_receptor IS NULL OR nombre_receptor = '' THEN nombre_receptor ELSE 'Receptor ' || id END,
      direccion = CASE WHEN direccion IS NULL OR direccion = '' THEN direccion ELSE 'Calle QA ' || id END`);
    actualizarSi(db, 'preparaciones', `UPDATE preparaciones SET
      comprador = CASE WHEN comprador IS NULL OR comprador = '' THEN comprador ELSE 'Comprador ' || id END,
      notas = CASE WHEN notas IS NULL OR notas = '' THEN notas ELSE '${ANON}' END`);
    actualizarSi(db, 'pedidos_cache', `UPDATE pedidos_cache SET
      comprador = CASE WHEN comprador IS NULL OR comprador = '' THEN comprador ELSE 'Comprador ' || rowid END,
      customer_note = CASE WHEN customer_note IS NULL OR customer_note = '' THEN customer_note ELSE '${ANON}' END`);
    actualizarSi(db, 'gestion_pedidos', `UPDATE gestion_pedidos SET notas = CASE WHEN notas IS NULL OR notas = '' THEN notas ELSE '${ANON}' END`);
    actualizarSi(db, 'pedidos', `UPDATE pedidos SET notas = CASE WHEN notas IS NULL OR notas = '' THEN notas ELSE '${ANON}' END`);

    for (const id of COLUMNAS_JSON) {
      const [t, c] = id.split('.');
      if (!tablaExiste(db, t) || !columnas(db, t).includes(c)) continue;
      const leer = db.prepare(`SELECT rowid AS r, "${c}" AS v FROM "${t}" WHERE "${c}" IS NOT NULL`);
      const escribir = db.prepare(`UPDATE "${t}" SET "${c}" = ? WHERE rowid = ?`);
      const cambios = [];
      for (const { r, v } of leer.iterate()) {
        let parsed;
        try { parsed = JSON.parse(v); } catch { continue; }
        const limpio = JSON.stringify(limpiarJson(parsed));
        if (limpio !== JSON.stringify(parsed)) cambios.push([limpio, r]);
      }
      for (const [limpio, r] of cambios) escribir.run(limpio, r);
    }
  });
  tx();
}

export async function generarSnapshot(origen, destino, { claveQa }) {
  if (fs.existsSync(destino)) throw new Error(`El destino ya existe: ${destino}`);
  const fuente = new Database(origen, { readonly: true });
  try { await fuente.backup(destino); } finally { fuente.close(); }

  const db = new Database(destino);
  try {
    db.pragma('journal_mode = DELETE');
    const muestra = tomarMuestra(db);
    anonimizarBase(db, { claveQa });
    db.exec('VACUUM');
    const hallazgo = buscarDatosReales(db, muestra);
    if (hallazgo) throw new Error(`Quedó un dato real en ${hallazgo.tabla}.${hallazgo.columna}`);
    return { muestra: muestra.length };
  } catch (e) {
    db.close();
    for (const f of [destino, `${destino}-journal`, `${destino}-wal`, `${destino}-shm`]) fs.rmSync(f, { force: true });
    throw e;
  } finally {
    if (db.open) db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , origen, destino] = process.argv;
  if (!origen || !destino) {
    console.error('Uso: node scripts/qa/snapshot-anonimizado.mjs <origen.sqlite> <destino.sqlite>');
    process.exit(2);
  }
  const claveQa = process.env.QA_CLAVE || (fs.existsSync('/root/.config/fusion-qa/clave')
    ? fs.readFileSync('/root/.config/fusion-qa/clave', 'utf8').trim() : '');
  generarSnapshot(origen, destino, { claveQa })
    .then(r => console.log(`OK snapshot anonimizado -> ${destino} (muestra verificada: ${r.muestra} valores)`))
    .catch(e => { console.error(`ERROR snapshot anonimizado: ${e.message}`); process.exit(1); });
}
