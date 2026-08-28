const ZONA = 'America/Argentina/Buenos_Aires';

export const DIAS_SEMANA = [1, 2, 3, 4, 5, 6, 7];

export function horaValida(hora) {
  return typeof hora === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(hora);
}

export function normalizarHorarios(rows = []) {
  const porDia = new Map(rows.map((r) => [Number(r.dia), r]));
  return DIAS_SEMANA.map((dia) => {
    const row = porDia.get(dia);
    return {
      dia,
      habilitado: row ? Number(row.habilitado) === 1 : dia <= 5,
      hora_corte: row?.hora_corte && horaValida(row.hora_corte) ? row.hora_corte : '16:00',
    };
  });
}

function partesBuenosAires(date = new Date()) {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const p = Object.fromEntries(partes.map(({ type, value }) => [type, value]));
  const fecha = `${p.year}-${p.month}-${p.day}`;
  const hora = `${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
  const weekday = Number(new Intl.DateTimeFormat('en-US', { timeZone: ZONA, weekday: 'short' })
    .format(date).replace(/^Sun$/, '7').replace(/^Mon$/, '1').replace(/^Tue$/, '2')
    .replace(/^Wed$/, '3').replace(/^Thu$/, '4').replace(/^Fri$/, '5').replace(/^Sat$/, '6'));
  return { fecha, hora, weekday };
}

function sumarDias(fecha, dias) {
  const d = new Date(`${fecha}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

export function calcularFechaDespacho(rows, ahora = new Date()) {
  const horarios = normalizarHorarios(rows);
  const actual = partesBuenosAires(ahora);
  for (let offset = 0; offset < 8; offset += 1) {
    const dia = ((actual.weekday - 1 + offset) % 7) + 1;
    const horario = horarios.find((h) => h.dia === dia);
    if (!horario?.habilitado) continue;
    if (offset === 0 && actual.hora >= horario.hora_corte) continue;
    return sumarDias(actual.fecha, offset);
  }
  return null;
}

export function fechaEstimadaShipment(shipment) {
  // ML distingue la fecha de entrega de la fecha límite para despachar. Para la cola
  // necesitamos esta última; no usar date_estimated_delivery, que es posterior.
  const candidatos = [shipment?.shipping_option?.estimated_handling_limit?.date,
    shipment?.estimated_handling_limit?.date, shipment?.handling_limit?.date];
  const valor = candidatos.find((v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v));
  return valor ? valor.slice(0, 10) : null;
}

export function sembrarHorarios(db, now = new Date().toISOString()) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO despacho_horarios (dia, habilitado, hora_corte, actualizado_en)
    VALUES (?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    for (const dia of DIAS_SEMANA) insert.run(dia, dia <= 5 ? 1 : 0, '16:00', now);
  });
  tx();
}

export function leerHorarios(db) {
  return normalizarHorarios(db.prepare('SELECT dia, habilitado, hora_corte FROM despacho_horarios ORDER BY dia').all());
}
