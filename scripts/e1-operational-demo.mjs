#!/usr/bin/env node
// Demo E1 aislada: ejercita el contrato operativo sin tocar la base configurada ni la red.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../db/index.js';
import { ensureTablesJornada } from '../routes/jornada.js';
import {
  iniciarBusqueda, pasarAMesa, asignarUnidadMesa, registrarFaltante, completarRetorno,
  resolverFaltante, cerrarOla, reclamarOla, configurarZona, pedirAyudaZona, recibirAyudaZona, pausarOla, reanudarOla, sincronizarMiniOlas,
} from '../lib/jornada.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fusion-e1-demo-'));
const dbPath = path.join(dir, 'demo.sqlite');
const db = openDb(dbPath);
const now = new Date('2026-09-03T12:00:00.000Z');
try {
  ensureTablesJornada(db);
  db.exec('CREATE TABLE pedidos_cache (clave TEXT PRIMARY KEY, items_json TEXT, estado_envio TEXT, canal TEXT, espejo_ml INTEGER DEFAULT 0, fecha TEXT, fecha_despacho TEXT, fecha_despacho_limite TEXT, estado_despacho TEXT DEFAULT \'activo\')');
  db.prepare('INSERT INTO pedidos_cache (clave,items_json,estado_envio,canal,fecha) VALUES (?,?,?,?,?)').run('web:demo-1', JSON.stringify([{ sku: 'SKU-DEMO', cantidad: 1 }]), 'pendiente', 'web', now.toISOString());
  const day = db.prepare('INSERT INTO operational_days (fecha,estado,abierta_por,abierta_en) VALUES (?,?,?,?)').run('2026-09-03','abierta','demo',now.toISOString()).lastInsertRowid;
  const wave = db.prepare("INSERT INTO pick_waves (operational_day_id,tipo,estado,estado_operativo,creada_en) VALUES (?,'inicial','congelada','disponible',?)").run(day, now.toISOString()).lastInsertRowid;
  db.prepare('INSERT INTO pick_wave_items (pick_wave_id,pedido_clave,agregado_en) VALUES (?,?,?)').run(wave, 'web:demo-1', now.toISOString());
  const claim = reclamarOla(db, wave, 'demo', { operationId:'demo-claim', expectedVersion:1 }, now);
  if (!claim.ok) throw new Error(`claim: ${claim.code}`);
  const paused = pausarOla(db, wave, 'demo', { operationId:'demo-pause', expectedVersion:claim.olaCongelada.expected_version, motivo:'reorganización de mesa' }, now);
  if (!paused.ok) throw new Error(`pause: ${paused.code}`);
  if (!reanudarOla(db, wave, 'demo', { operationId:'demo-resume', expectedVersion:paused.ola.expected_version }, now).ok) throw new Error('resume failed');
  if (!iniciarBusqueda(db, wave, 'demo', { operationId:'demo-search' }, now).ok) throw new Error('search failed');
  db.prepare('INSERT INTO pedidos_cache (clave,items_json,estado_envio,canal,espejo_ml,fecha,fecha_despacho,fecha_despacho_limite) VALUES (?,?,?,?,?,?,?,?)').run('ml:demo-urgent', JSON.stringify([{ sku:'SKU-URGENTE', cantidad:1 }]), 'pendiente', 'ml', 1, now.toISOString(), '2026-09-03', '2026-09-03T12:30:00.000Z');
  const urgent = sincronizarMiniOlas(db, now);
  if (urgent.agregados !== 1 || !db.prepare("SELECT 1 FROM pick_wave_items WHERE pick_wave_id=? AND pedido_clave='ml:demo-urgent'").get(wave)) throw new Error('urgent ML was not incorporated into active wave');
  db.prepare('INSERT INTO pedidos_cache (clave,items_json,estado_envio,canal,fecha) VALUES (?,?,?,?,?)').run('web:demo-normal', JSON.stringify([{ sku:'SKU-NORMAL', cantidad:1 }]), 'pendiente', 'web', now.toISOString());
  sincronizarMiniOlas(db, now);
  const normalWave = db.prepare("SELECT id FROM pick_waves WHERE operational_day_id=? AND tipo='mini' AND id<>? AND estado_operativo='disponible'").get(day, wave);
  if (!normalWave || !db.prepare("SELECT 1 FROM pick_wave_items WHERE pick_wave_id=? AND pedido_clave='web:demo-normal'").get(normalWave.id)) throw new Error('normal order was not isolated in a mini-wave');
  db.prepare("UPDATE pick_waves SET estado='completada', estado_operativo='cerrada' WHERE id=?").run(normalWave.id);
  if (!pasarAMesa(db, wave, 'demo', { operationId:'demo-table' }, now).ok) throw new Error('table failed');
  const unknownCode = asignarUnidadMesa(db, wave, { pedidoClave:'web:demo-1', sku:'CODIGO-DESCONOCIDO', cantidad:1 }, 'demo', { operationId:'demo-unknown-code', expectedVersion:db.prepare('SELECT expected_version FROM pick_waves WHERE id=?').get(wave).expected_version }, now);
  if (unknownCode.ok || unknownCode.code !== 'PRODUCT_CODE_UNKNOWN') throw new Error('unknown product code was not blocked');
  const assigned = asignarUnidadMesa(db, wave, { pedidoClave:'web:demo-1', sku:'SKU-DEMO', cantidad:1 }, 'demo', { operationId:'demo-assign' }, now);
  if (!assigned.ok) throw new Error(`assignment: ${assigned.code}`);
  const urgentAssigned = asignarUnidadMesa(db, wave, { pedidoClave:'ml:demo-urgent', sku:'SKU-URGENTE', cantidad:1 }, 'demo', { operationId:'demo-assign-urgent' }, now);
  if (!urgentAssigned.ok) throw new Error(`urgent assignment: ${urgentAssigned.code}`);
  const retorno = db.prepare("SELECT id FROM pick_wave_returns WHERE pick_wave_id=? AND estado='pendiente'").get(wave);
  if (retorno && !completarRetorno(db, retorno.id, 'demo', { operationId:'demo-return-complete', expectedVersion:db.prepare('SELECT expected_version FROM pick_waves WHERE id=?').get(wave).expected_version }, now).ok) throw new Error('urgent return failed');
  const closed = cerrarOla(db, wave, 'demo', { operationId:'demo-close', derivados:['asignado'] }, now);
  if (!closed.ok) throw new Error(`close: ${closed.code}`);
  const replayClose = cerrarOla(db, wave, 'demo', { operationId:'demo-close', expectedVersion:1, derivados:['asignado'] }, now);
  if (!replayClose.ok || !replayClose.repetido) throw new Error('close replay failed');
  db.prepare('INSERT INTO pedidos_cache (clave,items_json,estado_envio,canal,fecha) VALUES (?,?,?,?,?)').run('web:demo-shortage', JSON.stringify([{ sku: 'SKU-FALTANTE', cantidad: 1 }]), 'pendiente', 'web', now.toISOString());
  const wave2 = db.prepare("INSERT INTO pick_waves (operational_day_id,tipo,estado,estado_operativo,creada_en) VALUES (?,'mini','congelada','disponible',?)").run(day, now.toISOString()).lastInsertRowid;
  db.prepare('INSERT INTO pick_wave_items (pick_wave_id,pedido_clave,agregado_en) VALUES (?,?,?)').run(wave2, 'web:demo-shortage', now.toISOString());
  const shortageClaim = reclamarOla(db, wave2, 'demo2', { operationId:'demo-shortage-claim', expectedVersion:1 }, now);
  if (!shortageClaim.ok) throw new Error(`shortage claim failed: ${shortageClaim.code}`);
  const zone = configurarZona(db, { nombre:'Zona demo' }, 'demo2', { operationId:'demo-zone' }, now);
  const help = pedirAyudaZona(db, wave2, { zonaId:zone.zona.id, ayudante:'ayudante-demo' }, 'demo2', { operationId:'demo-help', expectedVersion:shortageClaim.olaCongelada.expected_version }, now);
  if (!help.ok) throw new Error(`help request: ${help.code}`);
  const received = recibirAyudaZona(db, help.ayuda.id, 'demo2', { operationId:'demo-help-receive', expectedVersion:help.ola.expected_version, entrega:[{ sku:'SKU-FALTANTE', cantidad:1 }] }, now);
  if (!received.ok) throw new Error(`help receive: ${received.code}`);
  if (!iniciarBusqueda(db, wave2, 'demo2', { operationId:'demo-shortage-search' }, now).ok) throw new Error('shortage search failed');
  if (!pasarAMesa(db, wave2, 'demo2', { operationId:'demo-shortage-table' }, now).ok) throw new Error('shortage table failed');
  const shortage = registrarFaltante(db, wave2, { pedidoClave:'web:demo-shortage', sku:'SKU-FALTANTE', motivo:'no_encontrado', nota:'Demo' }, 'demo2', { operationId:'demo-shortage' }, now);
  if (!shortage.ok) throw new Error(`shortage: ${shortage.code}`);
  const incompleteClose = cerrarOla(db, wave2, 'demo2', { expectedVersion:shortage.ola.expected_version, operationId:'demo-incomplete-close', derivados:['faltante_bloqueado'] }, now);
  if (incompleteClose.ok || incompleteClose.code !== 'WAVE_INCOMPLETE') throw new Error('incomplete wave was closed');
  const resolved = resolverFaltante(db, shortage.faltante.id, 'demo', { operationId:'demo-shortage-resolve', allowWithoutClaim:true, resolucion:'diferimiento' }, now);
  if (!resolved.ok) throw new Error(`shortage resolve: ${resolved.code}`);
  const substitution = registrarFaltante(db, wave2, { pedidoClave:'web:demo-shortage', sku:'SKU-FALTANTE', motivo:'sustitucion_requerida' }, 'demo2', { operationId:'demo-substitution-shortage', expectedVersion:resolved.ola.expected_version }, now);
  if (!substitution.ok || !resolverFaltante(db, substitution.faltante.id, 'demo', { operationId:'demo-substitution-resolve', allowWithoutClaim:true, resolucion:'sustitucion' }, now).ok) throw new Error('substitution resolution failed');
  const cancellation = registrarFaltante(db, wave2, { pedidoClave:'web:demo-shortage', sku:'SKU-FALTANTE', motivo:'cancelacion_requerida' }, 'demo2', { operationId:'demo-cancellation-shortage', expectedVersion:db.prepare('SELECT expected_version FROM pick_waves WHERE id=?').get(wave2).expected_version }, now);
  if (!cancellation.ok || !resolverFaltante(db, cancellation.faltante.id, 'demo', { operationId:'demo-cancellation-resolve', allowWithoutClaim:true, resolucion:'cancelacion' }, now).ok) throw new Error('cancellation resolution failed');
  const replayShortage = registrarFaltante(db, wave2, { pedidoClave:'web:demo-shortage', sku:'SKU-FALTANTE', motivo:'otro' }, 'demo', { operationId:'demo-shortage', expectedVersion:1 }, now);
  if (!replayShortage.ok || !replayShortage.repetido) throw new Error('shortage replay failed');
  db.prepare('INSERT INTO pedidos_cache (clave,items_json,estado_envio,canal,fecha) VALUES (?,?,?,?,?)').run('web:demo-change', JSON.stringify([{ sku:'SKU-ORIGINAL', cantidad:1 }]), 'pendiente', 'web', now.toISOString());
  const wave3 = db.prepare("INSERT INTO pick_waves (operational_day_id,tipo,estado,estado_operativo,creada_en) VALUES (?,'mini','en_picking','en_mesa',?)").run(day, now.toISOString()).lastInsertRowid;
  db.prepare('INSERT INTO pick_wave_items (pick_wave_id,pedido_clave,agregado_en,items_json_snapshot,estado_operativo) VALUES (?,?,?,?,?)').run(wave3, 'web:demo-change', now.toISOString(), JSON.stringify([{sku:'SKU-ORIGINAL',cantidad:1}]), 'en_mesa');
  db.prepare('INSERT INTO pick_wave_assignments (pick_wave_id,pedido_clave,sku,cantidad,asignado_por,operation_id,creado_en) VALUES (?,?,?,?,?,?,?)').run(wave3, 'web:demo-change', 'SKU-ORIGINAL', 1, 'demo', 'demo-change-assignment', now.toISOString());
  db.prepare('UPDATE pedidos_cache SET items_json=? WHERE clave=?').run(JSON.stringify([{sku:'SKU-MODIFICADO',cantidad:1}]), 'web:demo-change');
  const externalChange = sincronizarMiniOlas(db, now);
  const changedItem = db.prepare('SELECT estado_operativo,bloqueo_motivo FROM pick_wave_items WHERE pick_wave_id=?').get(wave3);
  const pendingReturn = db.prepare("SELECT 1 FROM pick_wave_returns WHERE pick_wave_id=? AND estado='pendiente'").get(wave3);
  if (!externalChange.ok || changedItem.estado_operativo !== 'bloqueado_cambio_externo' || !pendingReturn) throw new Error('external change was not blocked with a return');
  const oldClaim = db.prepare('SELECT * FROM pick_wave_claims WHERE pick_wave_id=?').get(wave2);
  db.prepare("UPDATE pick_wave_claims SET expires_at=? WHERE pick_wave_id=?").run('2026-09-03T11:59:00.000Z', wave2);
  const recovered = reclamarOla(db, wave2, 'demo-new', { operationId:'demo-recover-claim', expectedVersion:db.prepare('SELECT expected_version FROM pick_waves WHERE id=?').get(wave2).expected_version }, now);
  const stalePause = pausarOla(db, wave2, 'demo2', { operationId:'demo-stale-pause', expectedVersion:db.prepare('SELECT expected_version FROM pick_waves WHERE id=?').get(wave2).expected_version, motivo:'claim vencido' }, now);
  if (!oldClaim || !recovered.ok || stalePause.code !== 'CLAIM_REQUIRED') throw new Error('expired claim was not recovered safely');
  const eventCount = db.prepare('SELECT COUNT(*) AS n FROM operational_day_events WHERE pick_wave_id=?').get(wave).n;
  console.log(JSON.stringify({ ok:true, demo:'E1', jornada_id:day, ola_id:wave, estado:closed.ola.estado_operativo, pausa_reanudada:true, mini_ola_normal_separada:true, claim_vencido_recuperado:true, codigo_desconocido_bloqueado:true, cambio_externo_bloqueado:true, retorno_externo_pendiente:true, cierre_incompleto_rechazado:true, replay_cierre:true, ayuda_recibida:true, faltante_resuelto:true, sustitucion_resuelta:true, cancelacion_resuelta:true, replay_faltante:true, eventos:eventCount }));
} finally {
  db.close();
  fs.rmSync(dir, { recursive:true, force:true });
}
