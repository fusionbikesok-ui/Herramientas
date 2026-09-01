import { pedidosElegiblesOrdenados } from './preparacion.js';

const ZONA = 'America/Argentina/Buenos_Aires';

export function fechaLocalHoy(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function jornadaDeHoy(db, now = new Date()) {
  const fecha = fechaLocalHoy(now);
  return db.prepare('SELECT * FROM operational_days WHERE fecha=?').get(fecha) || null;
}

export function abrirJornada(db, { usuario, horaCorteWeb = null, ventanaMlJson = null }, now = new Date()) {
  const fecha = fechaLocalHoy(now);
  const existente = db.prepare('SELECT * FROM operational_days WHERE fecha=?').get(fecha);
  if (existente) return { ok: false, code: 'OPERATIONAL_DAY_EXISTS', jornada: existente };

  const ts = now.toISOString();
  const tx = db.transaction(() => {
    const dayInfo = db.prepare(`INSERT INTO operational_days
      (fecha, estado, hora_corte_web, ventana_ml_json, abierta_por, abierta_en)
      VALUES (?,?,?,?,?,?)`).run(fecha, 'abierta', horaCorteWeb, ventanaMlJson, usuario, ts);
    const dayId = dayInfo.lastInsertRowid;

    const waveInfo = db.prepare(`INSERT INTO pick_waves
      (operational_day_id, tipo, estado, creada_en, congelada_en, congelada_por)
      VALUES (?,'inicial','congelada',?,?,?)`).run(dayId, ts, ts, usuario);
    const waveId = waveInfo.lastInsertRowid;

    const elegibles = pedidosElegiblesOrdenados(db);
    const insertItem = db.prepare('INSERT INTO pick_wave_items (pick_wave_id, pedido_clave, agregado_en) VALUES (?,?,?)');
    for (const pedido of elegibles) insertItem.run(waveId, pedido.clave, ts);

    return {
      jornada: db.prepare('SELECT * FROM operational_days WHERE id=?').get(dayId),
      olaInicial: db.prepare('SELECT * FROM pick_waves WHERE id=?').get(waveId),
    };
  });
  const { jornada, olaInicial } = tx();
  return { ok: true, jornada, olaInicial };
}
