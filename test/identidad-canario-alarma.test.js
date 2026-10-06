import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { openDb } from '../db/index.js';
import { auditarIdentidadProductos, decidirCasoIdentidad, procesarPasoOperacionIdentidad } from '../lib/identidadProductos.js';
import { encoladasSinEjecutar } from '../lib/identidadAlarmas.js';

const FILE = './test/tmp-identidad-canario.sqlite';
const ISO = '2026-10-06T12:00:00.000Z';

function publicar(db, { id, titulo = 'Bicicleta Rodado 27 Talle M', nombreWoo = 'Bicicleta Rodado 27 Talle M', stock = 5 }) {
  db.prepare(`INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,stock,actualizado_en) VALUES (?,?,?,'simple',?,?)`).run(id, nombreWoo, `FB-${id}`, stock, ISO);
  db.prepare(`INSERT INTO ml_publicaciones_cache (clave,item_id,variation_id,titulo,status,seller_sku,seller_sku_presente,available_quantity,atributos_json,actualizado_en)
    VALUES (?,?,'',?,'active',NULL,0,?,'[]',?)`).run(`MLA${id}|`, `MLA${id}`, titulo, stock, ISO);
  auditarIdentidadProductos(db, 'test', { lecturaConfiable: true, ahora: new Date(ISO) });
  const caso = db.prepare('SELECT * FROM identidad_casos WHERE ml_key=?').get(`MLA${id}|`);
  const producto = db.prepare('SELECT * FROM productos_fusion WHERE primary_woo_id=?').get(id);
  const r = decidirCasoIdentidad(db, caso.id, { tipo: 'vincular', product_id: producto.id, operation_id: `op-${id}`,
    expected_version: caso.expected_version, evidence_fingerprint: caso.evidencia_fingerprint }, 'ana');
  return r.operacion;
}

describe('canario de identidad', () => {
  let db;
  beforeEach(() => { db = openDb(FILE); });
  afterEach(() => {
    try { db.close(); } catch { /* ya cerrada */ }
    for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(`${FILE}${suffix}`)) fs.unlinkSync(`${FILE}${suffix}`);
  });

  describe('alarma "encoladas sin ejecutar > 2 h"', () => {
    const ahora = new Date('2026-10-06T15:00:00.000Z');

    it('cuenta la pendiente sin intentos ni pasos con más de 2 h, y dice cuántas están fuera del canario', () => {
      const a = publicar(db, { id: 701 });
      const b = publicar(db, { id: 702 });
      db.prepare("UPDATE identidad_operaciones SET estado='pendiente',iniciada_en='2026-10-06T10:00:00.000Z'").run();
      db.prepare("UPDATE identidad_config SET canario_ml_key='MLA701|' WHERE id=1").run();
      const r = encoladasSinEjecutar(db, { ahora });
      expect(r).toMatchObject({ n: 2, mas_vieja_horas: 5, fuera_de_canario: 1 });
      expect(r.ids).toEqual([a.id, b.id]);
    });

    it('no cuenta lo reciente, lo shadow, lo que ya tuvo un intento ni lo que tiene pasos', () => {
      const reciente = publicar(db, { id: 703 });
      const shadow = publicar(db, { id: 704 });
      const intento = publicar(db, { id: 705 });
      const conPaso = publicar(db, { id: 706 });
      db.prepare("UPDATE identidad_operaciones SET estado='pendiente',iniciada_en='2026-10-06T10:00:00.000Z'").run();
      db.prepare('UPDATE identidad_operaciones SET iniciada_en=? WHERE id=?').run('2026-10-06T14:30:00.000Z', reciente.id);
      db.prepare("UPDATE identidad_operaciones SET estado='shadow' WHERE id=?").run(shadow.id);
      db.prepare('UPDATE identidad_operaciones SET intentos=1 WHERE id=?').run(intento.id);
      db.prepare("INSERT INTO identidad_operacion_pasos (operacion_id,paso,estado,intento,iniciado_en) VALUES (?,'zero','confirmado',1,?)").run(conPaso.id, ISO);
      expect(encoladasSinEjecutar(db, { ahora })).toMatchObject({ n: 0, mas_vieja_horas: 0, ids: [] });
    });

    it('cuenta aparte las operaciones en procesando con el claim vencido', () => {
      const vencida = publicar(db, { id: 708 });
      const vigente = publicar(db, { id: 709 });
      db.prepare("UPDATE identidad_operaciones SET estado='procesando',claim_hasta=? WHERE id=?").run('2026-10-06T14:00:00.000Z', vencida.id);
      db.prepare("UPDATE identidad_operaciones SET estado='procesando',claim_hasta=? WHERE id=?").run('2026-10-06T16:00:00.000Z', vigente.id);
      expect(encoladasSinEjecutar(db, { ahora })).toMatchObject({ n: 0, procesando_vencidas: 1 });
    });

    it('sin canario configurado no marca nada como fuera de canario', () => {
      publicar(db, { id: 707 });
      db.prepare("UPDATE identidad_operaciones SET estado='pendiente',iniciada_en='2026-10-06T10:00:00.000Z'").run();
      db.prepare("UPDATE identidad_config SET canario_ml_key=NULL WHERE id=1").run();
      expect(encoladasSinEjecutar(db, { ahora })).toMatchObject({ n: 1, fuera_de_canario: 0 });
    });
  });

  describe('restore que se frena por contradicción de título', () => {
    // La saga bajó el stock a 0 y llegó a `restore`; entre medio el título de ML pasó a contradecir
    // al producto Woo (27 vs 29). Antes: intervención con la publicación en 0. Ahora: el stock vuelve.
    function enRestore(id) {
      const op = publicar(db, { id });
      db.prepare("UPDATE ml_publicaciones_cache SET titulo='Bicicleta Rodado 29 Talle M' WHERE clave=?").run(`MLA${id}|`);
      db.prepare("UPDATE identidad_operaciones SET paso_actual='restore',sin_cero=0,estado='pendiente',stock_objetivo=5 WHERE id=?").run(op.id);
      return op.id;
    }

    it('devuelve el stock, deja la operación en intervención y reabre el caso como urgente', async () => {
      const id = enRestore(801);
      const adapter = { setStock: vi.fn(async () => ({ ok: true })), read: vi.fn(), clearSku: vi.fn(), writeSku: vi.fn() };
      const r = await procesarPasoOperacionIdentidad(db, id, adapter, { allowRemoteWrites: true });
      expect(r).toMatchObject({ ok: false, code: 'CONTRADICCION_TITULO', stock_devuelto: true });
      expect(adapter.setStock).toHaveBeenCalledTimes(1);
      expect(adapter.setStock).toHaveBeenCalledWith('MLA801|', 5);
      expect(db.prepare('SELECT estado FROM identidad_operaciones WHERE id=?').get(id).estado).toBe('intervencion');
      expect(db.prepare("SELECT estado,clasificacion FROM identidad_casos WHERE ml_key='MLA801|'").get())
        .toMatchObject({ estado: 'urgente', clasificacion: 'contradiccion_titulo' });
      expect(db.prepare("SELECT COUNT(*) n FROM identidad_historial WHERE evento='stock_devuelto_por_contradiccion' AND entidad_id=?").get(id).n).toBe(1);
    });

    it('si no se puede devolver el stock, lo dice en el error y en el historial (no lo esconde)', async () => {
      const id = enRestore(802);
      const adapter = { setStock: vi.fn(async () => { throw new Error('ML 503'); }), read: vi.fn(), clearSku: vi.fn(), writeSku: vi.fn() };
      const r = await procesarPasoOperacionIdentidad(db, id, adapter, { allowRemoteWrites: true });
      expect(r).toMatchObject({ ok: false, code: 'CONTRADICCION_TITULO', stock_devuelto: false });
      const op = db.prepare('SELECT estado,ultimo_error FROM identidad_operaciones WHERE id=?').get(id);
      expect(op.estado).toBe('intervencion');
      expect(op.ultimo_error).toContain('NO se pudo devolver el stock');
      expect(db.prepare("SELECT COUNT(*) n FROM identidad_historial WHERE evento='stock_no_devuelto_por_contradiccion' AND entidad_id=?").get(id).n).toBe(1);
    });

    it('si la op ya no estaba procesando (se canceló durante el paso), no devuelve stock', async () => {
      const id = enRestore(804);
      // Simula la cancelación concurrente justo cuando el catch de la contradicción marca el paso como
      // fallido: la op queda `fallida` y el UPDATE a `intervencion` ya no aplica.
      db.exec(`CREATE TEMP TRIGGER cancela_concurrente AFTER UPDATE OF estado ON identidad_operacion_pasos WHEN NEW.estado='fallido' AND NEW.operacion_id=${id}
        BEGIN UPDATE identidad_operaciones SET estado='fallida',ultimo_error='cancelada' WHERE id=${id}; END`);
      const adapter = { setStock: vi.fn(async () => ({ ok: true })), clearSku: vi.fn(), writeSku: vi.fn(), read: vi.fn() };
      const r = await procesarPasoOperacionIdentidad(db, id, adapter, { allowRemoteWrites: true });
      expect(r.ok).toBe(false);
      expect(adapter.setStock).not.toHaveBeenCalled();
      expect(db.prepare('SELECT estado FROM identidad_operaciones WHERE id=?').get(id).estado).toBe('fallida');
      expect(db.prepare("SELECT COUNT(*) n FROM identidad_historial WHERE evento LIKE 'stock_%' AND entidad_id=?").get(id).n).toBe(0);
    });

    it('si la saga nunca bajó el stock (sin_cero=1) no escribe stock', async () => {
      const op = publicar(db, { id: 803 });
      db.prepare("UPDATE ml_publicaciones_cache SET titulo='Bicicleta Rodado 29 Talle M' WHERE clave='MLA803|'").run();
      // En `activate` la contradicción llega con el stock ya intacto: no hay nada que devolver.
      db.prepare("UPDATE identidad_operaciones SET paso_actual='restore',sin_cero=1,estado='pendiente' WHERE id=?").run(op.id);
      const adapter = { setStock: vi.fn(async () => ({ ok: true })), read: vi.fn(), clearSku: vi.fn(), writeSku: vi.fn() };
      const r = await procesarPasoOperacionIdentidad(db, op.id, adapter, { allowRemoteWrites: true });
      expect(r).toMatchObject({ ok: false, code: 'CONTRADICCION_TITULO', stock_devuelto: null });
      expect(adapter.setStock).not.toHaveBeenCalled();
    });
  });
});
