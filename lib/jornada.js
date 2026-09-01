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

const CLAIM_TTL_DEFAULT_MS = 15 * 60 * 1000;
const AVISO_VENCIMIENTO_MS = 10 * 60 * 1000;

export function anotarVencimiento(claim, ahora = new Date(), avisoMs = AVISO_VENCIMIENTO_MS) {
  const restanteMs = new Date(claim.expires_at).getTime() - ahora.getTime();
  return {
    ...claim,
    segundos_restantes: Math.max(0, Math.round(restanteMs / 1000)),
    por_vencer: restanteMs <= avisoMs,
  };
}

export function reclamarOla(db, pickWaveId, usuario, { ttlMs = CLAIM_TTL_DEFAULT_MS } = {}, now = new Date()) {
  const at = now.toISOString();
  const expires = new Date(now.getTime() + ttlMs).toISOString();

  const tx = db.transaction(() => {
    const ola = db.prepare('SELECT * FROM pick_waves WHERE id=?').get(pickWaveId);
    if (!ola) return { ok: false, code: 'WAVE_NOT_FOUND' };

    const claimActual = db.prepare('SELECT * FROM pick_wave_claims WHERE pick_wave_id=?').get(pickWaveId);
    if (claimActual && claimActual.usuario !== usuario && claimActual.expires_at > at) {
      return { ok: false, code: 'WAVE_CLAIMED', claim: anotarVencimiento(claimActual, now) };
    }

    const claimedAt = claimActual && claimActual.usuario === usuario ? claimActual.claimed_at : at;
    if (claimActual) {
      db.prepare('UPDATE pick_wave_claims SET usuario=?, claimed_at=?, expires_at=?, renovado_en=? WHERE pick_wave_id=?')
        .run(usuario, claimedAt, expires, at, pickWaveId);
    } else {
      db.prepare('INSERT INTO pick_wave_claims (pick_wave_id, usuario, claimed_at, expires_at, renovado_en) VALUES (?,?,?,?,?)')
        .run(pickWaveId, usuario, claimedAt, expires, at);
    }
    const claim = anotarVencimiento({ usuario, claimed_at: claimedAt, expires_at: expires }, now);

    // Freeze solo la primera vez que esta ola pasa de 'abierta' a tomada — un segundo claim
    // del mismo usuario (renovación) sobre una ola ya 'en_picking' no debe volver a congelar
    // ni abrir una tercera ola.
    if (ola.estado !== 'abierta') {
      return { ok: true, claim, olaCongelada: ola };
    }

    db.prepare(`UPDATE pick_waves SET estado='en_picking', congelada_en=?, congelada_por=? WHERE id=?`)
      .run(at, usuario, pickWaveId);
    const olaCongelada = db.prepare('SELECT * FROM pick_waves WHERE id=?').get(pickWaveId);

    let olaNueva = null;
    if (ola.tipo === 'mini') {
      const info = db.prepare(`INSERT INTO pick_waves (operational_day_id, tipo, estado, creada_en) VALUES (?,'mini','abierta',?)`)
        .run(ola.operational_day_id, at);
      olaNueva = db.prepare('SELECT * FROM pick_waves WHERE id=?').get(info.lastInsertRowid);
    }

    return { ok: true, claim, olaCongelada, olaNueva };
  });
  return tx();
}

function pedidoEsMlUrgente(pedido, fechaHoy) {
  const esMl = pedido.canal === 'ml' || Number(pedido.espejo_ml) === 1;
  return esMl && pedido.fecha_despacho === fechaHoy;
}

export function sincronizarMiniOlas(db, now = new Date()) {
  const jornada = jornadaDeHoy(db, now);
  if (!jornada || jornada.estado !== 'abierta') {
    return { ok: true, agregados: 0, motivo: 'sin_jornada_abierta' };
  }
  const at = now.toISOString();
  const fechaHoy = fechaLocalHoy(now);

  const tx = db.transaction(() => {
    const yaAsignados = new Set(
      db.prepare(`SELECT pi.pedido_clave FROM pick_wave_items pi
        JOIN pick_waves pw ON pw.id = pi.pick_wave_id
        WHERE pw.operational_day_id = ?`).all(jornada.id).map(r => r.pedido_clave)
    );
    const pendientes = pedidosElegiblesOrdenados(db).filter(p => !yaAsignados.has(p.clave));
    if (pendientes.length === 0) return 0;

    let miniAbierta = db.prepare(
      "SELECT * FROM pick_waves WHERE operational_day_id=? AND tipo='mini' AND estado='abierta'"
    ).get(jornada.id);

    let agregados = 0;
    for (const pedido of pendientes) {
      if (pedidoEsMlUrgente(pedido, fechaHoy)) {
        const info = db.prepare(`INSERT INTO pick_waves (operational_day_id, tipo, estado, creada_en, congelada_en) VALUES (?,'ml_urgente','congelada',?,?)`)
          .run(jornada.id, at, at);
        db.prepare('INSERT INTO pick_wave_items (pick_wave_id, pedido_clave, agregado_en) VALUES (?,?,?)')
          .run(info.lastInsertRowid, pedido.clave, at);
        agregados += 1;
        continue;
      }
      if (!miniAbierta) {
        const info = db.prepare(`INSERT INTO pick_waves (operational_day_id, tipo, estado, creada_en) VALUES (?,'mini','abierta',?)`)
          .run(jornada.id, at);
        miniAbierta = db.prepare('SELECT * FROM pick_waves WHERE id=?').get(info.lastInsertRowid);
      }
      db.prepare('INSERT INTO pick_wave_items (pick_wave_id, pedido_clave, agregado_en) VALUES (?,?,?)')
        .run(miniAbierta.id, pedido.clave, at);
      agregados += 1;
    }
    return agregados;
  });
  return { ok: true, agregados: tx() };
}
