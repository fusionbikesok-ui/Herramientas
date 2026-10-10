#!/usr/bin/env node
// Fixtures QAFX para la pantalla "Catálogo y vínculos" (Fase D), sembrados en la base de QA.
//
// Uso:
//   node scripts/qa/fixtures/catalogo-vinculos.mjs            # siembra en la base QA (default)
//   node scripts/qa/fixtures/catalogo-vinculos.mjs --limpiar  # borra solo lo sembrado (QAFX-)
//   node scripts/qa/fixtures/catalogo-vinculos.mjs [--limpiar] <ruta.sqlite>
//   node scripts/qa/fixtures/catalogo-vinculos.mjs <copia.sqlite> --permitir-copia   # solo para verificar en copias
//
// Garantías (no negociables):
//  - Nunca abre la base de PRODUCCIÓN (/opt/fusionbikes/herramientas/data/...), ni en lectura: la ruta se valida
//    con realpath ANTES de abrir cualquier archivo.
//  - Por defecto solo acepta la base QA exacta (/opt/fusionbikes/qa/data/fusion.sqlite). Otra ruta exige
//    --permitir-copia (pensado para verificar contra una copia temporal) y nunca puede ser de prod.
//  - Respaldo previo (API de backup online) a fusion.sqlite.bak-qafx-<ts> en el mismo directorio, antes de escribir.
//  - Idempotente: cada corrida borra lo sembrado antes (filas con marca QAFX- / qa_fixture) y vuelve a insertar,
//    dentro de una sola transacción. Correr dos veces deja el mismo estado, sin duplicados.
//  - Ninguna fila queda en un estado que el worker de identidad despacha a ML (pendiente/procesando/verificando/
//    shadow): las operaciones usan 'fallida' y 'bloqueada_impacto'. La configuración de identidad no se toca.
//  - Sin llamadas de red: no hay adaptador de ML ni de Woo en este script.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// better-sqlite3 se toma de los node_modules de herramientas (no del worktree).
const require = createRequire('/opt/fusionbikes/herramientas/package.json');
const Database = require('better-sqlite3');

const RUTA_QA = '/opt/fusionbikes/qa/data/fusion.sqlite';
const DIR_PROD = '/opt/fusionbikes/herramientas/data';
const MARCA = 'QAFX-';
const ORIGEN = 'qa_fixture';

// ── Validación de la ruta (antes de abrir nada) ────────────────────────────────────────────────────────────────

function realOpcional(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

/** Devuelve la ruta real a usar o lanza. No abre el archivo. */
export function validarDestino(entrada, { permitirCopia = false } = {}) {
  const pedida = path.resolve(entrada || RUTA_QA);
  const prodReal = realOpcional(DIR_PROD);
  const real = realOpcional(pedida);
  const esProd = (p) => p === prodReal || p.startsWith(prodReal + path.sep) || p === DIR_PROD || p.startsWith(DIR_PROD + path.sep);
  if (esProd(pedida) || esProd(real)) throw new Error(`REHÚSO: la ruta resuelve a la base de PRODUCCIÓN (${real}). Este script no toca prod.`);
  if (!fs.existsSync(real)) throw new Error(`REHÚSO: no existe ${real}`);
  if (real !== RUTA_QA && !permitirCopia) {
    throw new Error(`REHÚSO: ${real} no es la base QA exacta (${RUTA_QA}). Para una copia de verificación usá --permitir-copia.`);
  }
  if (!fs.statSync(real).isFile()) throw new Error(`REHÚSO: ${real} no es un archivo`);
  return real;
}

// ── Helpers ────────────────────────────────────────────────────────────────────────────────────────────────────

const hace = (horas) => new Date(Date.now() - horas * 3600_000).toISOString();

/** Borra solo lo sembrado. Orden por dependencias de FK. */
function limpiarSembrado(db) {
  const casosQafx = "SELECT id FROM identidad_casos WHERE ml_key LIKE 'QAFX-%'";
  const opsQafx = "SELECT id FROM identidad_operaciones WHERE operation_id LIKE 'QAFX-%' OR caso_id IN (" + casosQafx + ')';
  db.prepare(`DELETE FROM identidad_operacion_pasos WHERE operacion_id IN (${opsQafx})`).run();
  db.prepare(`DELETE FROM identidad_operaciones WHERE id IN (${opsQafx})`).run();
  db.prepare(`DELETE FROM identidad_historial WHERE entidad_tipo='caso' AND entidad_id IN (${casosQafx})`).run();
  db.prepare(`DELETE FROM identidad_decisiones WHERE operation_id LIKE 'QAFX-%' OR caso_id IN (${casosQafx})`).run();
  db.prepare("DELETE FROM identidad_casos WHERE ml_key LIKE 'QAFX-%'").run();
  db.prepare("DELETE FROM sku_matcher_decisiones WHERE clave LIKE 'QAFX-%'").run();
  db.prepare("DELETE FROM guardia_ml_pedidos_retenidos WHERE ml_order_id LIKE 'QAFX-%'").run();
  db.prepare("DELETE FROM ml_publicaciones_cache WHERE clave LIKE 'QAFX-%'").run();
  // productos_fusion NO se borra: el trigger trg_productos_fusion_sin_borrado (082) aborta cualquier DELETE.
  // Se archiva (estado='archivado'); sembrar lo reactiva por upsert sobre primary_woo_id (clave estable).
  db.prepare(`UPDATE productos_fusion SET estado='archivado', archivado_en=?, actualizado_en=?
    WHERE creado_por=? AND estado<>'archivado'`).run(new Date().toISOString(), new Date().toISOString(), ORIGEN);
  db.prepare("DELETE FROM catalogo_cache WHERE sku LIKE 'QAFX-%'").run();
}

// ── Datos ──────────────────────────────────────────────────────────────────────────────────────────────────────

// Productos Woo (catálogo) con SKU QAFX-SKU-n. El 1 tiene nombre que contradice el título ML (color rojo vs azul).
const WOO = [
  { n: 1, nombre: 'QAFX Casco ciclismo talle M color azul', stock: 3 },
  { n: 2, nombre: 'QAFX Bicicleta rodado 29 variante', stock: 4 },
  { n: 3, nombre: 'QAFX Bicicleta rodado 27 variante', stock: 5 },
  { n: 4, nombre: 'QAFX Luz trasera LED', stock: 2 },
  { n: 5, nombre: 'QAFX Guantes ciclismo talle L', stock: 4 },
  { n: 6, nombre: 'QAFX Candado cable 1m', stock: 6 },
  { n: 7, nombre: 'QAFX Pedales plataforma', stock: 1 },
];
const wooId = (n) => 9900100 + n;

// Publicaciones ML (cache). clave = item_id|variation_id ('' si no tiene variación).
const PUBS = [
  { clave: 'QAFX-MLA1|', item: 'QAFX-MLA1', variation: '', titulo: 'QAFX Casco ciclismo talle M color rojo', color: 'rojo', talle: 'M', sku: 'QAFX-SKU-1' },
  { clave: 'QAFX-MLA2|11', item: 'QAFX-MLA2', variation: '11', titulo: 'QAFX Bicicleta rodado 29 variante', color: null, talle: null, sku: 'QAFX-SKU-2' },
  { clave: 'QAFX-MLA2|12', item: 'QAFX-MLA2', variation: '12', titulo: 'QAFX Bicicleta rodado 29 variante', color: null, talle: null, sku: 'QAFX-SKU-2b' },
  { clave: 'QAFX-MLA2|13', item: 'QAFX-MLA2', variation: '13', titulo: 'QAFX Bicicleta rodado 29 variante', color: null, talle: null, sku: 'QAFX-SKU-2c' },
  { clave: 'QAFX-MLA3|21', item: 'QAFX-MLA3', variation: '21', titulo: 'QAFX Bicicleta rodado 27 variante', color: null, talle: null, sku: 'QAFX-SKU-3' },
  { clave: 'QAFX-MLA3|22', item: 'QAFX-MLA3', variation: '22', titulo: 'QAFX Bicicleta rodado 27 variante', color: null, talle: null, sku: 'QAFX-SKU-3b' },
  { clave: 'QAFX-MLA3|23', item: 'QAFX-MLA3', variation: '23', titulo: 'QAFX Bicicleta rodado 27 variante', color: null, talle: null, sku: 'QAFX-SKU-3c' },
  { clave: 'QAFX-MLA4|', item: 'QAFX-MLA4', variation: '', titulo: 'QAFX Luz trasera LED', color: null, talle: null, sku: 'QAFX-SKU-4' },
  { clave: 'QAFX-MLA5|', item: 'QAFX-MLA5', variation: '', titulo: 'QAFX Guantes ciclismo talle L', color: null, talle: 'L', sku: 'QAFX-SKU-5' },
  { clave: 'QAFX-MLA6|', item: 'QAFX-MLA6', variation: '', titulo: 'QAFX Candado cable 1m', color: null, talle: null, sku: 'QAFX-SKU-6' },
  { clave: 'QAFX-MLA7|', item: 'QAFX-MLA7', variation: '', titulo: 'QAFX Pedales plataforma', color: null, talle: null, sku: 'QAFX-SKU-7' },
];

function sembrar(db) {
  // Guardia: los ids Woo de fixture no pueden pisar productos reales (solo se reutilizan los del propio fixture).
  const ajenos = db.prepare(`SELECT COUNT(*) n FROM productos_fusion WHERE primary_woo_id BETWEEN ? AND ? AND creado_por IS NOT ?`)
    .get(wooId(1), wooId(WOO.length), ORIGEN).n;
  if (ajenos) throw new Error(`ABORTA: ${ajenos} producto(s) reales ocupan los primary_woo_id de fixture (${wooId(1)}..${wooId(WOO.length)})`);
  const ahora = new Date().toISOString();
  const insWoo = db.prepare('INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,stock,precio,actualizado_en) VALUES (?,?,?,?,?,?,?)');
  for (const w of WOO) insWoo.run(wooId(w.n), w.nombre, `QAFX-SKU-${w.n}`, 'simple', w.stock, 1000 * w.n, ahora);

  const insProd = db.prepare(`INSERT INTO productos_fusion (nombre_canonico,primary_woo_id,estado,creado_por,creado_en,actualizado_en)
    VALUES (?,?,'activo',?,?,?)
    ON CONFLICT(primary_woo_id) DO UPDATE SET nombre_canonico=excluded.nombre_canonico, estado='activo',
      archivado_en=NULL, actualizado_en=excluded.actualizado_en`);
  for (const w of WOO) insProd.run(`QAFX Producto ${w.n}`, wooId(w.n), ORIGEN, ahora, ahora);
  const productoDe = (n) => db.prepare('SELECT id FROM productos_fusion WHERE primary_woo_id=?').get(wooId(n)).id;

  const insPub = db.prepare(`INSERT INTO ml_publicaciones_cache
    (clave,item_id,variation_id,titulo,status,es_variante,color,talle,seller_sku,variations_texto,available_quantity,precio,actualizado_en)
    VALUES (?,?,?,?,'active',?,?,?,?,?,?,?,?)`);
  for (const p of PUBS) {
    insPub.run(p.clave, p.item, p.variation || null, p.titulo, p.variation ? 1 : 0, p.color, p.talle, p.sku,
      p.variation ? `variante ${p.variation}` : null, 2, 1000, ahora);
  }

  // Casos abiertos (identidad_casos). Uno por clave (UNIQUE direccion+ml_key).
  const insCaso = db.prepare(`INSERT INTO identidad_casos
    (ml_key,producto_id,clasificacion,estado,severidad,responsable,tomado_en,evidencia_fingerprint,expected_version,primera_deteccion_en,ultima_deteccion_en)
    VALUES (?,?,?,?,?,?,?,?,1,?,?)`);
  const casos = {};
  const crear = (k, n, clasif, estado, responsable, horas) => {
    const tomado = responsable ? hace(horas) : null;
    const info = insCaso.run(k, productoDe(n), clasif, estado, 'urgente', responsable, tomado, `qafx-${k}`, hace(horas), hace(horas));
    casos[k] = info.lastInsertRowid;
  };
  crear('QAFX-MLA1|', 1, 'contradiccion_titulo', 'urgente', null, 30);     // 1: veto (título rojo vs woo azul)
  crear('QAFX-MLA2|11', 2, 'sku_inexistente', 'urgente', null, 26);       // 2: hermanas (2 activas más)
  crear('QAFX-MLA3|21', 3, 'decision_no_aplicada', 'tomado', 'Matias', 24); // 3: bloqueada_impacto con 2 hermanas
  crear('QAFX-MLA4|', 4, 'sku_inexistente', 'tomado', 'Matias', 20);      // 4: operación fallida
  crear('QAFX-MLA7|', 7, 'sku_inexistente', 'urgente', null, 4);          // 6: candidato único (Enter = Vincular)

  // Decisiones (la operación exige decision_id NOT NULL).
  const insDec = db.prepare(`INSERT INTO identidad_decisiones
    (caso_id,producto_id,tipo,explicacion,operation_id,expected_version,evidencia_fingerprint,decidida_por,decidida_en)
    VALUES (?,?,'vincular',?,?,1,?,?,?)`);
  const decDe3 = insDec.run(casos['QAFX-MLA3|21'], productoDe(3), 'QAFX fixture: vincular bloqueado por impacto', 'QAFX-dec-3', 'qafx-QAFX-MLA3|21', 'Matias', hace(24)).lastInsertRowid;
  const decDe4 = insDec.run(casos['QAFX-MLA4|'], productoDe(4), 'QAFX fixture: escritura rechazada', 'QAFX-dec-4', 'qafx-QAFX-MLA4|', 'Matias', hace(20)).lastInsertRowid;

  // Operaciones: solo estados que el worker NO despacha (bloqueada_impacto, fallida).
  const insOp = db.prepare(`INSERT INTO identidad_operaciones
    (operation_id,tipo,caso_id,decision_id,producto_id,ml_key,sku_anterior,sku_objetivo,stock_objetivo,estado,intentos,ultimo_error,impacto_hermanas,iniciada_en,actualizada_en)
    VALUES (?,'correccion_sku',?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  insOp.run('QAFX-op-3', casos['QAFX-MLA3|21'], decDe3, productoDe(3), 'QAFX-MLA3|21', null, 'QAFX-SKU-3', 5,
    'bloqueada_impacto', 0, null, 2, hace(24), hace(24));
  insOp.run('QAFX-op-4', casos['QAFX-MLA4|'], decDe4, productoDe(4), 'QAFX-MLA4|', null, 'QAFX-SKU-4', 2,
    'fallida', 3, 'ML rechazó la escritura (PUT /items/QAFX-MLA4): dup', 0, hace(20), hace(1));

  // Ventas retenidas. items_json con item.id, seller_sku, unit_price y quantity.
  const insRet = db.prepare(`INSERT INTO guardia_ml_pedidos_retenidos
    (ml_order_id,motivo,items_json,estado,creado_en,actualizado_en) VALUES (?,?,?,'retenido',?,?)`);
  const item = (id, sku, titulo, precio, cant) => ({ item: { id, variation_id: null, seller_sku: sku, title: titulo },
    unit_price: precio, quantity: cant });
  // Liberable: la clave tiene SKU único en catálogo y no está frenada → liberarPedidoRetenido la suelta a mano.
  insRet.run('QAFX-ORD-1', 'sin_sku_woo', JSON.stringify([item('QAFX-MLA5', 'QAFX-SKU-5', 'QAFX Guantes ciclismo talle L', 1500, 2)]), hace(3), hace(3));
  // No se libera sola: la publicación está marcada no_sincronizar (origen no_sincronizar_a).
  insRet.run('QAFX-ORD-2', 'sin_sku_woo', JSON.stringify([item('QAFX-MLA6', 'QAFX-SKU-6', 'QAFX Candado cable 1m', 2300, 1)]), hace(2), hace(2));
  db.prepare(`INSERT INTO sku_matcher_decisiones (clave,sku,wc_nombre,accion,actualizado_en,origen,confirmado_por)
    VALUES ('QAFX-MLA6|',NULL,'QAFX Candado cable 1m','omitir',?,'no_sincronizar_a','Matias')`).run(hace(2));
  return { casos: Object.keys(casos).length, publicaciones: PUBS.length, operaciones: 2, retenidas: 2 };
}

// ── Main ───────────────────────────────────────────────────────────────────────────────────────────────────────

async function main(argv) {
  const limpiar = argv.includes('--limpiar');
  const permitirCopia = argv.includes('--permitir-copia');
  const posicional = argv.filter((a) => !a.startsWith('--'));
  const destino = validarDestino(posicional[0], { permitirCopia });

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const respaldo = path.join(path.dirname(destino), `${path.basename(destino)}.bak-qafx-${ts}`);
  const db = new Database(destino, { fileMustExist: true });
  try {
    await db.backup(respaldo);   // respaldo antes de escribir
    console.log(`respaldo: ${respaldo}`);
    const tx = db.transaction(() => {
      limpiarSembrado(db);
      return limpiar ? { modo: 'limpiar' } : { modo: 'sembrar', ...sembrar(db) };
    });
    const r = tx();
    console.log(JSON.stringify({ destino, ...r }));
  } finally {
    db.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
}

export { limpiarSembrado, sembrar, WOO, PUBS, MARCA };
