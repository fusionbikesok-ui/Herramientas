#!/usr/bin/env node
// Fixtures QAFX para la pantalla "Catálogo y vínculos" (Fase D), sembrados en la base de QA.
//
// Uso:
//   node scripts/qa/fixtures/catalogo-vinculos.mjs            # siembra en la base QA (default)
//   node scripts/qa/fixtures/catalogo-vinculos.mjs --limpiar  # borra solo lo sembrado (QAFX-)
//   node scripts/qa/fixtures/catalogo-vinculos.mjs [--limpiar] <ruta.sqlite>
//   node scripts/qa/fixtures/catalogo-vinculos.mjs <copia.sqlite> --permitir-copia   # solo para verificar en copias
//   node scripts/qa/fixtures/catalogo-vinculos.mjs --masivos 70 [<ruta>]   # + N casos abiertos QAFX-M- (cola >50, "Ver más")
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
// --masivos N: casos abiertos extra de identidad (ml_key QAFX-M<i>|), para probar la paginación de la cola.
const MASIVOS_MAX = 500;
const WOO_MASIVO_BASE = 9950000;   // rango distinto del de los 7 productos fijos (9900101..9900107)
const wooMasivoId = (i) => WOO_MASIVO_BASE + i;

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
  // Identificadores: NO se borran (trg_identificadores_sin_borrado aborta el DELETE). Se pasan a 'historico', que ni
  // cuenta como activo (índice único) ni como conflicto (la lista de conflictos mira activo/conflicto).
  db.prepare(`UPDATE identificadores_producto SET estado='historico', actualizado_en=?
    WHERE tipo='gtin' AND valor_normalizado=? AND estado<>'historico'
      AND producto_id IN (SELECT id FROM productos_fusion WHERE creado_por=?)`).run(new Date().toISOString(), GTIN_UNICO_CANONICO, ORIGEN);
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
  // 8: con foto (catalogo_cache.img). Es el único candidato del fixture con imagen: sirve para probar la tecla `f`
  // (agrandar la foto del candidato elegido). Data URI SVG inline: sin red externa, y /productos/buscar la devuelve tal cual.
  { n: 8, nombre: 'QAFX Mochila hidratacion 2L', stock: 3, img: 'data:image/svg+xml;base64,' + Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">' +
    '<rect width="200" height="200" fill="#2b6cb0"/><circle cx="100" cy="90" r="50" fill="#f6ad55"/>' +
    '<text x="100" y="185" font-size="18" text-anchor="middle" fill="#fff">QAFX foto</text></svg>').toString('base64') },
];
const wooId = (n) => 9900100 + n;

// Conflicto de GTIN para probar "No le corresponde" -> permitir_unico (identidadProductos: marcarIdentificadorIncorrecto).
// EAN-13 con dígito de control válido. Producto QAFX-6 lo tiene 'activo' y es su único GTIN activo (la condición de
// permitir_unico); QAFX-7 lo tiene en 'conflicto', así que el valor aparece en conflictosDeIdentificador (>=2 productos).
// No se usa UNIQUE sobre (tipo,valor) sino el índice parcial de 'activo': por eso el par activo+conflicto es válido.
const GTIN_UNICO = '7790000000010';
const GTIN_UNICO_CANONICO = GTIN_UNICO.padStart(14, '0');
const GTIN_ACTIVO_WOO_N = 6;     // QAFX Candado: GTIN activo único -> dispara permitir_unico
const GTIN_CONFLICTO_WOO_N = 7;  // QAFX Pedales: mismo valor en conflicto

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
  // Caso con foto: el título coincide con el Woo 8, así que la búsqueda inicial del panel lo trae primero.
  { clave: 'QAFX-MLA8|', item: 'QAFX-MLA8', variation: '', titulo: 'QAFX Mochila hidratacion 2L', color: null, talle: null, sku: 'QAFX-SKU-8' },
];

/** Siembra N casos abiertos (identidad_casos urgente, sin responsable) con su producto Woo y publicación ML.
 *  Cada uno tiene su propio item_id, así que no tienen hermanas. Idempotente por el mismo limpiarSembrado (prefijo QAFX-). */
function sembrarMasivos(db, n) {
  if (!n) return 0;
  const ajenos = db.prepare(`SELECT COUNT(*) n FROM productos_fusion WHERE primary_woo_id BETWEEN ? AND ? AND creado_por IS NOT ?`)
    .get(wooMasivoId(1), wooMasivoId(n), ORIGEN).n;
  if (ajenos) throw new Error(`ABORTA: ${ajenos} producto(s) reales ocupan los primary_woo_id masivos (${wooMasivoId(1)}..${wooMasivoId(n)})`);
  const ahora = new Date().toISOString();
  const insWoo = db.prepare('INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,stock,precio,actualizado_en) VALUES (?,?,?,?,?,?,?)');
  const insProd = db.prepare(`INSERT INTO productos_fusion (nombre_canonico,primary_woo_id,estado,creado_por,creado_en,actualizado_en)
    VALUES (?,?,'activo',?,?,?)
    ON CONFLICT(primary_woo_id) DO UPDATE SET nombre_canonico=excluded.nombre_canonico, estado='activo',
      archivado_en=NULL, actualizado_en=excluded.actualizado_en`);
  const insPub = db.prepare(`INSERT INTO ml_publicaciones_cache
    (clave,item_id,variation_id,titulo,status,es_variante,color,talle,seller_sku,variations_texto,available_quantity,precio,actualizado_en)
    VALUES (?,?,?,?,'active',?,?,?,?,?,?,?,?)`);
  const insCaso = db.prepare(`INSERT INTO identidad_casos
    (ml_key,producto_id,clasificacion,estado,severidad,responsable,tomado_en,evidencia_fingerprint,expected_version,primera_deteccion_en,ultima_deteccion_en)
    VALUES (?,?,?,'urgente','urgente',NULL,NULL,?,1,?,?)`);
  const idProd = db.prepare('SELECT id FROM productos_fusion WHERE primary_woo_id=?');
  for (let i = 1; i <= n; i++) {
    const clave = `QAFX-M${i}|`;
    const sku = `QAFX-SKU-M${i}`;
    const wid = wooMasivoId(i);
    insWoo.run(wid, `QAFX Masivo ${i}`, sku, 'simple', 1 + (i % 6), 1000 * i, ahora);
    insProd.run(`QAFX Producto M${i}`, wid, ORIGEN, ahora, ahora);
    insPub.run(clave, `QAFX-MLAM${i}`, null, `QAFX Masivo ${i} publicación`, 0, null, null, sku, null, 2, 1000, ahora);
    // Más viejos primero (i mayor = detectado antes), así el orden de la cola es determinista.
    const detectado = hace(2 + (n - i) / 100);
    insCaso.run(clave, idProd.get(wid).id, i % 2 ? 'sku_inexistente' : 'contradiccion_titulo', `qafx-${clave}`, detectado, detectado);
  }
  return n;
}

/** GTIN de conflicto (ver GTIN_UNICO). Idempotente por (valor, producto): reactiva la fila si existe, si no la inserta.
 *  Aborta si el valor ya lo usa un producto que no es del fixture (no pisa datos reales). */
function sembrarGtinConflicto(db, productoDe, ahora) {
  const ajeno = db.prepare(`SELECT COUNT(*) n FROM identificadores_producto
    WHERE tipo='gtin' AND valor_normalizado=? AND producto_id NOT IN (SELECT id FROM productos_fusion WHERE creado_por=?)`)
    .get(GTIN_UNICO_CANONICO, ORIGEN).n;
  if (ajeno) throw new Error(`ABORTA: el GTIN ${GTIN_UNICO} ya lo usa un producto real`);
  const poner = (n, estado) => {
    const pid = productoDe(n);
    const f = db.prepare("SELECT id FROM identificadores_producto WHERE tipo='gtin' AND valor_normalizado=? AND producto_id=?").get(GTIN_UNICO_CANONICO, pid);
    if (f) {
      db.prepare("UPDATE identificadores_producto SET estado=?, actualizado_en=? WHERE id=?").run(estado, ahora, f.id);
    } else {
      db.prepare(`INSERT INTO identificadores_producto
        (tipo,valor_normalizado,valor_crudo,subtipo,fuente,producto_id,estado,creado_en,actualizado_en)
        VALUES ('gtin',?,?,'ean_13','woo',?,?,?,?)`).run(GTIN_UNICO_CANONICO, GTIN_UNICO, pid, estado, ahora, ahora);
    }
  };
  // El activo primero: el índice único de 'activo' se aplica en cada escritura.
  poner(GTIN_ACTIVO_WOO_N, 'activo');
  poner(GTIN_CONFLICTO_WOO_N, 'conflicto');
}

function sembrar(db, { masivos = 0 } = {}) {
  // Guardia: los ids Woo de fixture no pueden pisar productos reales (solo se reutilizan los del propio fixture).
  const ajenos = db.prepare(`SELECT COUNT(*) n FROM productos_fusion WHERE primary_woo_id BETWEEN ? AND ? AND creado_por IS NOT ?`)
    .get(wooId(1), wooId(WOO.length), ORIGEN).n;
  if (ajenos) throw new Error(`ABORTA: ${ajenos} producto(s) reales ocupan los primary_woo_id de fixture (${wooId(1)}..${wooId(WOO.length)})`);
  const ahora = new Date().toISOString();
  const insWoo = db.prepare('INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,stock,precio,img,actualizado_en) VALUES (?,?,?,?,?,?,?,?)');
  for (const w of WOO) insWoo.run(wooId(w.n), w.nombre, `QAFX-SKU-${w.n}`, 'simple', w.stock, 1000 * w.n, w.img ?? null, ahora);

  const insProd = db.prepare(`INSERT INTO productos_fusion (nombre_canonico,primary_woo_id,estado,creado_por,creado_en,actualizado_en)
    VALUES (?,?,'activo',?,?,?)
    ON CONFLICT(primary_woo_id) DO UPDATE SET nombre_canonico=excluded.nombre_canonico, estado='activo',
      archivado_en=NULL, actualizado_en=excluded.actualizado_en`);
  // El producto con foto usa su nombre Woo como canónico: la búsqueda del panel puntúa sobre nombre_canonico.
  for (const w of WOO) insProd.run(w.img ? w.nombre : `QAFX Producto ${w.n}`, wooId(w.n), ORIGEN, ahora, ahora);
  const productoDe = (n) => db.prepare('SELECT id FROM productos_fusion WHERE primary_woo_id=?').get(wooId(n)).id;
  sembrarGtinConflicto(db, productoDe, ahora);

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
  crear('QAFX-MLA8|', 8, 'sku_inexistente', 'urgente', null, 3);          // 8: candidato con foto (1 = elegir, f = agrandar)
  crear('QAFX-MLA5|', 5, 'sku_inexistente', 'intervencion', 'Matias', 10); // 7: operación en intervención para Destrabar

  // Decisiones (la operación exige decision_id NOT NULL).
  const insDec = db.prepare(`INSERT INTO identidad_decisiones
    (caso_id,producto_id,tipo,explicacion,operation_id,expected_version,evidencia_fingerprint,decidida_por,decidida_en)
    VALUES (?,?,'vincular',?,?,1,?,?,?)`);
  const decDe3 = insDec.run(casos['QAFX-MLA3|21'], productoDe(3), 'QAFX fixture: vincular bloqueado por impacto', 'QAFX-dec-3', 'qafx-QAFX-MLA3|21', 'Matias', hace(24)).lastInsertRowid;
  const decDe4 = insDec.run(casos['QAFX-MLA4|'], productoDe(4), 'QAFX fixture: escritura rechazada', 'QAFX-dec-4', 'qafx-QAFX-MLA4|', 'Matias', hace(20)).lastInsertRowid;
  const decDe5 = insDec.run(casos['QAFX-MLA5|'], productoDe(5), 'QAFX fixture: intervención por reintentos agotados', 'QAFX-dec-5', 'qafx-QAFX-MLA5|', 'Matias', hace(10)).lastInsertRowid;

  // Operaciones: solo estados que el worker NO despacha (bloqueada_impacto, fallida, intervencion).
  const insOp = db.prepare(`INSERT INTO identidad_operaciones
    (operation_id,tipo,caso_id,decision_id,producto_id,ml_key,sku_anterior,sku_objetivo,stock_objetivo,estado,intentos,ultimo_error,impacto_hermanas,iniciada_en,actualizada_en)
    VALUES (?,'correccion_sku',?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  insOp.run('QAFX-op-3', casos['QAFX-MLA3|21'], decDe3, productoDe(3), 'QAFX-MLA3|21', null, 'QAFX-SKU-3', 5,
    'bloqueada_impacto', 0, null, 2, hace(24), hace(24));
  insOp.run('QAFX-op-4', casos['QAFX-MLA4|'], decDe4, productoDe(4), 'QAFX-MLA4|', null, 'QAFX-SKU-4', 2,
    'fallida', 3, 'ML rechazó la escritura (PUT /items/QAFX-MLA4): dup', 0, hace(20), hace(1));
  // Destrabable: 'intervencion' con su caso en 'intervencion'. destrabarOperacionIdentidad exige expected_version
  // y evidence_fingerprint del caso (qafx-QAFX-MLA5|) y un motivo; en QA (shadow) la operación vuelve a 'shadow'.
  insOp.run('QAFX-op-5', casos['QAFX-MLA5|'], decDe5, productoDe(5), 'QAFX-MLA5|', null, 'QAFX-SKU-5', 2,
    'intervencion', 3, 'QAFX: reintentos agotados, requiere intervención humana', 0, hace(10), hace(10));

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
  const extra = sembrarMasivos(db, masivos);
  return { casos: Object.keys(casos).length + extra, publicaciones: PUBS.length + extra, operaciones: 3, retenidas: 2, masivos: extra, conFoto: 'QAFX-MLA8|', gtinConflicto: GTIN_UNICO };
}

/** Separa flags, la ruta y --masivos (valor con espacio o con '='). Valida el entero aquí, antes de abrir nada. */
export function parsearArgs(argv) {
  let masivos = 0;
  const posicional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--masivos') masivos = validarMasivos(argv[++i]);
    else if (a.startsWith('--masivos=')) masivos = validarMasivos(a.slice('--masivos='.length));
    else if (!a.startsWith('--')) posicional.push(a);
  }
  return { masivos, posicional };
}

function validarMasivos(v) {
  const s = String(v ?? '');
  if (!/^\d+$/.test(s) || Number(s) > MASIVOS_MAX) throw new Error(`REHÚSO: --masivos debe ser un entero entre 0 y ${MASIVOS_MAX}`);
  return Number(s);
}

// ── Main ───────────────────────────────────────────────────────────────────────────────────────────────────────

async function main(argv) {
  const limpiar = argv.includes('--limpiar');
  const permitirCopia = argv.includes('--permitir-copia');
  const { masivos, posicional } = parsearArgs(argv);
  const destino = validarDestino(posicional[0], { permitirCopia });

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const respaldo = path.join(path.dirname(destino), `${path.basename(destino)}.bak-qafx-${ts}`);
  const db = new Database(destino, { fileMustExist: true });
  try {
    await db.backup(respaldo);   // respaldo antes de escribir
    console.log(`respaldo: ${respaldo}`);
    const tx = db.transaction(() => {
      limpiarSembrado(db);
      return limpiar ? { modo: 'limpiar' } : { modo: 'sembrar', ...sembrar(db, { masivos }) };
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

export { limpiarSembrado, sembrar, sembrarMasivos, WOO, PUBS, MARCA, MASIVOS_MAX, wooMasivoId };
