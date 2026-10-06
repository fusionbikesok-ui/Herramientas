#!/usr/bin/env node
/**
 * Cierra las preparaciones viejas colgadas (nunca completadas, ni en pendiente_deposito)
 * pasándolas a 'cerrada_sin_evidencia'.
 *
 * NO se marcan 'completada': el usuario decidió explícitamente que la herramienta tiene
 * que poder decir la verdad si entra un reclamo (se cerró sin poder verificar), nunca
 * afirmar una verificación que no ocurrió. Se cierran TODAS las que cumplen el corte,
 * incluidas las que tienen algún escaneo o alguna foto suelta — un rastro parcial no es
 * evidencia completa (decisión de la segunda ronda; en la primera se iba a dejar vivas
 * a las que tuvieran algo, pero el usuario cambió de idea al plantearle el límite).
 *
 * Reversible: 'cerrada_sin_evidencia' se puede reabrir con POST /api/preparacion/:id/reabrir
 * (registra el evento 'reabierta' con usuario y fecha) y volver a trabajarla con el flujo
 * normal.
 *
 * Uso:
 *   node scripts/cerrar-preparaciones-sin-evidencia.mjs [ruta_db]              # dry-run (default)
 *   node scripts/cerrar-preparaciones-sin-evidencia.mjs [ruta_db] --aplicar    # escribe de verdad
 *   node scripts/cerrar-preparaciones-sin-evidencia.mjs [ruta_db] --corte=2026-08-12T00:00:00.000Z
 *
 * Dry-run por default a propósito: esto toca datos de producción (preparaciones reales,
 * algunas con pedidos ya despachados) y el usuario pidió ver la lista antes de tocar nada.
 */
import Database from 'better-sqlite3';

// Corte por defecto: medianoche UTC del día del incidente (2026-08-12), tal como pide el
// plan ("todo lo anterior a hoy"). Exportado aparte para que el test no tenga que
// duplicar el valor.
//
// OJO — dos limitaciones conocidas, dichas acá para que quien lo corra más adelante las
// vea (hallazgo del revisor):
//   1) Es una fecha FIJA, no relativa a "hoy". Corrido más de un día después del incidente,
//      este default deja de significar "todo lo anterior a hoy" — hay que pasar `--corte=`
//      explícito con la fecha que corresponda.
//   2) Es medianoche UTC, no hora local (Argentina, UTC-3): lo creado entre las 21:00 y las
//      23:59 hora local del día anterior al corte queda del lado de "antes del corte" igual
//      que lo esperado, pero lo creado entre 00:00 y 02:59 hora local del día del corte
//      queda del lado de "antes" también (todavía es el día anterior en UTC) — o sea, el
//      corte real en hora local cae ~3 horas más tarde de lo que el valor sugiere a
//      primera vista. Para este uso (cerrar preparaciones de semanas atrás) el desvío de
//      3 horas es irrelevante; para un corte fino (del mismo día) habría que ajustarlo.
export const CORTE_DEFAULT = '2026-08-12T00:00:00.000Z';

// Valida el formato de --corte antes de usarlo en el WHERE: `creado_en < ?` compara TEXTO
// en SQLite (no fechas), así que un valor no-ISO (typo, "hoy", vacío) puede compararse mal
// contra los ISO reales de la tabla y traer de más o de menos. Ejemplo real: con
// `--corte=hoy`, `'2026-08-01T00:00:00.000Z' < 'hoy'` da true (comparación de strings,
// 'h' > '2' en ASCII) para CUALQUIER fecha ISO — cerraría filas que el sector está
// trabajando en ese momento. Exige el prefijo `YYYY-MM-DD` y que además `Date.parse` no dé
// NaN — cubre el caso real (texto libre tipo "hoy" o un typo). No detecta una fecha de
// calendario inexistente con formato válido (ej. "2026-02-30"): `Date.parse` de V8 la
// corre al mes siguiente en vez de devolver NaN, así que esto no es un validador de
// calendario completo — alcanza para lo que hace falta acá (rechazar texto que no es una
// fecha), sin sumar una librería de fechas para un script de mantenimiento.
export function corteEsValido(corte) {
  return /^\d{4}-\d{2}-\d{2}(T.*)?$/.test(String(corte || '')) && Number.isFinite(Date.parse(corte));
}

// Candidatas a cerrar: cualquier preparación que no llegó a un estado final (ni
// 'completada' ni 'pendiente_deposito') y tampoco está ya 'cerrada_sin_evidencia'
// (idempotente: correr el script dos veces no vuelve a listar lo ya cerrado), creada
// antes del corte. `escaneos`/`fotos` son solo informativos para la vista previa — desde
// la segunda ronda de decisiones, NO afectan si se cierra o no (se cierran todas).
export function buscarCandidatas(db, corte = CORTE_DEFAULT) {
  // Validado ACÁ (no solo en el CLI) para que cualquier caller — CLI, test, un futuro
  // endpoint que reuse esta función — quede protegido, no solo el que pasa por argv.
  if (!corteEsValido(corte)) {
    throw new Error(`corte inválido: "${corte}" (esperado YYYY-MM-DD o YYYY-MM-DDTHH:mm:ss.sssZ)`);
  }
  return db.prepare(`
    SELECT id, clave, canal, numero_pedido, comprador, estado, creado_en,
      (SELECT COUNT(*) FROM preparacion_eventos e WHERE e.preparacion_id=p.id AND e.tipo='escaneo') AS escaneos,
      (SELECT COUNT(*) FROM preparacion_fotos f WHERE f.preparacion_id=p.id AND f.borrado_en IS NULL) AS fotos
    FROM preparaciones p
    WHERE p.estado NOT IN ('completada', 'pendiente_deposito', 'cerrada_sin_evidencia')
      AND p.creado_en < ?
    ORDER BY p.creado_en ASC
  `).all(corte);
}

// Aplica el cierre: UPDATE de estado + un evento auditable por preparación (usuario NULL
// porque lo dispara un script, no una sesión — mismo patrón que reintentarColgadosTracking
// y otros procesos de fondo del repo). Transaccional: o se cierran todas las de la lista o
// ninguna, para que la vista previa (buscarCandidatas) siempre sea fiel a lo que terminó
// pasando si algo se corta a mitad de camino.
export function cerrarCandidatas(db, candidatas, { corte = CORTE_DEFAULT, ahora = new Date().toISOString() } = {}) {
  const actualizar = db.prepare("UPDATE preparaciones SET estado='cerrada_sin_evidencia' WHERE id=?");
  const insertarEvento = db.prepare(`
    INSERT INTO preparacion_eventos (preparacion_id, item_id, tipo, usuario, detalle_json, creado_en)
    VALUES (?, NULL, 'cerrada_sin_evidencia', NULL, ?, ?)
  `);
  const tx = db.transaction((filas) => {
    for (const c of filas) {
      actualizar.run(c.id);
      insertarEvento.run(c.id, JSON.stringify({
        motivo: 'preparación vieja sin completar, cerrada por script de mantenimiento',
        escaneos_previos: c.escaneos, fotos_previas: c.fotos, corte,
      }), ahora);
    }
  });
  tx(candidatas);
  return candidatas.length;
}

// ─── CLI ────────────────────────────────────────────────────────────────────────────────
// Solo corre si se invoca directamente (node scripts/...mjs), no cuando el test importa
// las funciones de arriba.
const esCli = process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href;
if (esCli) {
  const args = process.argv.slice(2);
  const aplicar = args.includes('--aplicar');
  const dbPath = args.find(a => !a.startsWith('--')) || './data/fusion.sqlite';
  const corteArg = args.find(a => a.startsWith('--corte='));
  const corte = corteArg ? corteArg.slice('--corte='.length) : CORTE_DEFAULT;

  // Validar ANTES de abrir la DB (aunque buscarCandidatas también valida): un exit(1) con
  // mensaje claro acá, en vez de una excepción sin capturar con stack trace, para quien
  // corre esto a mano contra producción.
  if (!corteEsValido(corte)) {
    console.error(`\nCorte inválido: "${corte}"`);
    console.error('Esperado formato ISO: YYYY-MM-DD o YYYY-MM-DDTHH:mm:ss.sssZ (ej: --corte=2026-08-12T00:00:00.000Z)\n');
    process.exit(1);
  }

  const db = new Database(dbPath, { readonly: !aplicar });
  const candidatas = buscarCandidatas(db, corte);

  console.log(`\nCierre de preparaciones sin evidencia · ${dbPath}`);
  console.log(`Corte: creado_en < ${corte}${aplicar ? ' (APLICANDO CAMBIOS)' : ' (dry-run, no se escribe nada)'}\n`);

  if (!candidatas.length) {
    console.log('Nada para cerrar con este corte.\n');
    db.close();
    process.exit(0);
  }

  for (const c of candidatas) {
    console.log(
      `#${c.id}  ${c.clave.padEnd(14)} estado=${c.estado.padEnd(14)} creado=${c.creado_en}  `
      + `pedido=${c.numero_pedido ?? '-'} comprador=${c.comprador ?? '-'}  `
      + `escaneos=${c.escaneos} fotos=${c.fotos}`
    );
  }
  console.log(`\n${candidatas.length} preparación(es) pasarían a 'cerrada_sin_evidencia'.\n`);

  if (!aplicar) {
    console.log('Dry-run: no se modificó nada. Volvé a correr con --aplicar para escribir.\n');
    db.close();
    process.exit(0);
  }

  const cerradas = cerrarCandidatas(db, candidatas, { corte });
  console.log(`${cerradas} preparación(es) cerradas sin evidencia.\n`);
  db.close();
}
