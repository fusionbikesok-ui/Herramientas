/**
 * Cadencia adaptativa del scan completo de ML.
 *
 * El scan corría fijo cada 15 minutos y era la única forma de enterarse de un cambio en ML:
 * ~34.000 llamadas diarias (172 ciclos × ~197 multiget). Con el webhook de `items` proyectando,
 * la mayoría de los cambios llega en segundos y el scan pasa a ser red de reconciliación.
 *
 * Pero relajar la cadencia se GANA con evidencia, no con calendario (decisión del usuario,
 * 2026-09-05). La regla que aplica este módulo es la que ya pedía el plan maestro: «un cambio
 * descubierto sin webhook genera alerta/métrica de cobertura». Cada vez que el scan encuentra
 * un cambio que ningún webhook anunció, la cobertura falló y se vuelve atrás.
 */

const ESCALONES = [
  { intervalo_min: 15, frescura_min: 60 },
  { intervalo_min: 20, frescura_min: 60 },
  { intervalo_min: 30, frescura_min: 60 },
  // Último escalón: intervalo y frescura se mueven JUNTOS. Un scan de 60 minutos con frescura
  // de 60 es exactamente la combinación rota — justo antes de cada corrida toda observación
  // tendría ~60 minutos y NADA verificaría. Separarlos vaciaría el tablero.
  { intervalo_min: 60, frescura_min: 120 },
];

// Corridas limpias consecutivas para subir un escalón. El último cuesta mucho más porque
// cambia un invariante del programa —«observaciones confiables de menos de 60 minutos»— y no
// sólo un parámetro de cadencia.
const LIMPIAS_PARA_SUBIR = [288, 288, 2900];

const now = () => new Date().toISOString();

export function estadoRamp(db) {
  return db.prepare('SELECT * FROM ml_scan_ramp WHERE id=1').get();
}

/** Índice del escalón actual; -1 si la configuración quedó fuera de la escalera. */
function indiceEscalon(estado) {
  return ESCALONES.findIndex((e) => e.intervalo_min === estado.intervalo_min && e.frescura_min === estado.frescura_min);
}

/**
 * Frescura vigente en minutos. La consume `identidadProductos` para decidir si una observación
 * alcanza para verificar: si sube el intervalo del scan sin subir esto, deja de verificarse
 * todo el universo.
 */
export function frescuraVigenteMs(db) {
  try { return (estadoRamp(db)?.frescura_min ?? 60) * 60 * 1000; }
  catch { return 60 * 60 * 1000; }
}

/** ¿Toca correr el scan completo ahora? El cron tickea fino y esto decide. */
export function tocaScan(db, ahora = new Date()) {
  const e = estadoRamp(db);
  if (!e?.ultimo_scan_en) return true;
  return ahora.getTime() - Date.parse(e.ultimo_scan_en) >= e.intervalo_min * 60 * 1000;
}

function bajarEscalon(db, motivo, ts) {
  const e = estadoRamp(db);
  const i = indiceEscalon(e);
  const destino = ESCALONES[Math.max(0, (i < 0 ? 1 : i) - 1)];
  db.prepare(`UPDATE ml_scan_ramp SET intervalo_min=?,frescura_min=?,corridas_limpias=0,
    motivo=?,ultimo_cambio_en=?,actualizado_en=? WHERE id=1`)
    .run(destino.intervalo_min, destino.frescura_min, motivo, ts, ts);
  return { accion: 'bajo', ...destino, motivo };
}

/**
 * Evalúa una corrida del scan y mueve el ramp.
 *
 * `cambiosSinAviso` es el número que decide: claves cuya identidad o stock cambió y para las
 * que NO llegó un webhook de `items` desde el scan anterior. Uno solo basta para bajar: la
 * premisa de todo esto es que el webhook cubre, y ahí quedó demostrado que no.
 */
export function evaluarRamp(db, { cambiosSinAviso, proyeccionRota }, ahora = new Date()) {
  const ts = ahora.toISOString();
  db.prepare('UPDATE ml_scan_ramp SET ultimo_scan_en=?,actualizado_en=? WHERE id=1').run(ts, ts);

  // Sin webhook funcionando no hay nada que gane el derecho a relajar nada: se congela Y se
  // baja un escalón (decisión del usuario: «incluso volvería a bajarla»). Quedarse en un
  // intervalo largo con la proyección rota es quedarse ciego.
  if (proyeccionRota) {
    const r = bajarEscalon(db, 'proyección de items fallando', ts);
    db.prepare('UPDATE ml_scan_ramp SET congelado=1 WHERE id=1').run();
    return { ...r, congelado: true };
  }

  if (cambiosSinAviso > 0) {
    return bajarEscalon(db, `${cambiosSinAviso} cambio(s) que ningún webhook anunció`, ts);
  }

  db.prepare('UPDATE ml_scan_ramp SET congelado=0,motivo=NULL,corridas_limpias=corridas_limpias+1 WHERE id=1').run();
  const e = estadoRamp(db);
  const i = indiceEscalon(e);
  if (i < 0 || i >= ESCALONES.length - 1) return { accion: 'sin_cambio', ...e };
  if (e.corridas_limpias < LIMPIAS_PARA_SUBIR[i]) return { accion: 'sin_cambio', ...e };

  const destino = ESCALONES[i + 1];
  db.prepare(`UPDATE ml_scan_ramp SET intervalo_min=?,frescura_min=?,corridas_limpias=0,
    ultimo_cambio_en=?,actualizado_en=? WHERE id=1`)
    .run(destino.intervalo_min, destino.frescura_min, ts, ts);
  return { accion: 'subio', ...destino };
}

/**
 * Cuántas claves cambiaron sin que ningún webhook de `items` lo anunciara, y refresca la huella.
 *
 * La huella se compara contra la del scan anterior en vez de diffear durante el scan: el scan
 * recorre 6894 filas y no conviene meterle trabajo en el camino caliente.
 */
export function medirCoberturaWebhook(db, desde, ahora = new Date()) {
  const ts = ahora.toISOString();
  const actuales = db.prepare(`SELECT clave, item_id,
      COALESCE(seller_sku,'') || '|' || COALESCE(available_quantity,'') || '|' || COALESCE(status,'') AS huella
    FROM ml_publicaciones_cache`).all();
  const previas = new Map(db.prepare('SELECT clave, huella FROM ml_scan_huella').all().map((r) => [r.clave, r.huella]));
  const primeraVez = previas.size === 0;

  const avisados = new Set(db.prepare(`SELECT DISTINCT replace(resource_id,'/items/','') AS item_id
    FROM integration_events
    WHERE channel='ml' AND resource_id LIKE '/items/%' AND received_at >= ?`).all(desde || '1970-01-01').map((r) => r.item_id));

  let cambios = 0, sinAviso = 0;
  const upsert = db.prepare(`INSERT INTO ml_scan_huella (clave,huella,visto_en) VALUES (?,?,?)
    ON CONFLICT(clave) DO UPDATE SET huella=excluded.huella, visto_en=excluded.visto_en`);
  db.transaction(() => {
    for (const a of actuales) {
      const anterior = previas.get(a.clave);
      // Una clave nueva no es un cambio no anunciado: nunca la habíamos visto.
      if (anterior !== undefined && anterior !== a.huella) {
        cambios += 1;
        if (!avisados.has(a.item_id)) sinAviso += 1;
      }
      upsert.run(a.clave, a.huella, ts);
    }
  })();
  // En la primera corrida no hay con qué comparar: no se castiga al ramp por eso.
  return { cambios, cambiosSinAviso: primeraVez ? 0 : sinAviso, claves: actuales.length };
}

/** ¿La proyección de `items` está fallando? Un job muerto o fallando reciente congela el ramp. */
export function proyeccionItemsRota(db, ahora = new Date()) {
  const desde = new Date(ahora.getTime() - 60 * 60 * 1000).toISOString();
  const n = db.prepare(`SELECT COUNT(*) n FROM integration_jobs
    WHERE job_type='item.project' AND status IN ('dead_lettered','failed') AND available_at >= ?`).get(desde).n;
  return n > 0;
}

export const _ESCALONES = ESCALONES;
export const _LIMPIAS_PARA_SUBIR = LIMPIAS_PARA_SUBIR;
