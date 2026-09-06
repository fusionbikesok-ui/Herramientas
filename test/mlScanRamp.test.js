import { describe, it, expect } from 'vitest';
import { openDb } from '../db/index.js';
import { estadoRamp, evaluarRamp, tocaScan, frescuraVigenteMs, medirCoberturaWebhook, proyeccionItemsRota, _LIMPIAS_PARA_SUBIR } from '../lib/mlScanRamp.js';

const limpias = (db, n) => db.prepare('UPDATE ml_scan_ramp SET corridas_limpias=? WHERE id=1').run(n);

describe('cadencia adaptativa del scan de ML', () => {
  it('arranca en 15 min con frescura 60', () => {
    const db = openDb(':memory:');
    expect(estadoRamp(db)).toMatchObject({ intervalo_min: 15, frescura_min: 60, congelado: 0 });
    expect(frescuraVigenteMs(db)).toBe(60 * 60 * 1000);
    db.close();
  });

  it('sube un escalón sólo después de las corridas limpias exigidas', () => {
    const db = openDb(':memory:');
    limpias(db, _LIMPIAS_PARA_SUBIR[0] - 2);
    expect(evaluarRamp(db, { cambiosSinAviso: 0, proyeccionRota: false }).accion).toBe('sin_cambio');
    expect(evaluarRamp(db, { cambiosSinAviso: 0, proyeccionRota: false })).toMatchObject({ accion: 'subio', intervalo_min: 20 });
    db.close();
  });

  it('UN solo cambio que ningún webhook anunció basta para bajar', () => {
    const db = openDb(':memory:');
    db.prepare('UPDATE ml_scan_ramp SET intervalo_min=30, frescura_min=60 WHERE id=1').run();
    limpias(db, 999);
    const r = evaluarRamp(db, { cambiosSinAviso: 1, proyeccionRota: false });
    expect(r).toMatchObject({ accion: 'bajo', intervalo_min: 20 });
    expect(estadoRamp(db).corridas_limpias).toBe(0);
    db.close();
  });

  // El intervalo y la frescura se mueven JUNTOS: un scan de 60 con frescura de 60 deja toda
  // observación vieja justo antes de cada corrida y NADA verificaría.
  it('el último escalón sube intervalo y frescura a la vez', () => {
    const db = openDb(':memory:');
    db.prepare('UPDATE ml_scan_ramp SET intervalo_min=30, frescura_min=60 WHERE id=1').run();
    limpias(db, _LIMPIAS_PARA_SUBIR[2] - 1);
    expect(evaluarRamp(db, { cambiosSinAviso: 0, proyeccionRota: false }))
      .toMatchObject({ accion: 'subio', intervalo_min: 60, frescura_min: 120 });
    expect(frescuraVigenteMs(db)).toBe(120 * 60 * 1000);
    db.close();
  });

  it('si la proyección de items falla, congela Y baja', () => {
    const db = openDb(':memory:');
    db.prepare('UPDATE ml_scan_ramp SET intervalo_min=30, frescura_min=60 WHERE id=1').run();
    const r = evaluarRamp(db, { cambiosSinAviso: 0, proyeccionRota: true });
    expect(r).toMatchObject({ accion: 'bajo', intervalo_min: 20, congelado: true });
    expect(estadoRamp(db).congelado).toBe(1);
    db.close();
  });

  it('tocaScan respeta el intervalo vigente', () => {
    const db = openDb(':memory:');
    const ahora = new Date('2026-09-05T12:00:00Z');
    db.prepare('UPDATE ml_scan_ramp SET intervalo_min=30, ultimo_scan_en=? WHERE id=1')
      .run(new Date(ahora.getTime() - 20 * 60 * 1000).toISOString());
    expect(tocaScan(db, ahora)).toBe(false);
    db.prepare('UPDATE ml_scan_ramp SET ultimo_scan_en=? WHERE id=1')
      .run(new Date(ahora.getTime() - 31 * 60 * 1000).toISOString());
    expect(tocaScan(db, ahora)).toBe(true);
    db.close();
  });

  it('no dispara cuando faltan milisegundos, y por eso la cadencia real es un tick más larga', () => {
    // Comportamiento deliberado, no un descuido (decisión del usuario, 2026-09-06).
    // El scan se registra unos ms después del tick que lo lanzó, así que al tick
    // siguiente le faltan esos ms para el umbral y se posterga cinco minutos. Un
    // intervalo de 15 min corre de hecho cada 20.
    //
    // Corregirlo con una tolerancia sube las llamadas a ML un 33% (de 14.184 a
    // 18.912 por día) contra una API que ya nos bloqueó. Si alguna vez se hace,
    // hay que bajar un escalón el ramp en la misma tanda. Este test está para que
    // esa decisión sea consciente: si lo rompés, estás cambiando el consumo.
    const db = openDb(':memory:');
    const tick = new Date('2026-09-06T15:45:00.000Z');
    db.prepare('UPDATE ml_scan_ramp SET intervalo_min=15, ultimo_scan_en=? WHERE id=1')
      .run('2026-09-06T15:30:00.160Z');
    expect(tocaScan(db, tick)).toBe(false);
    // Recién el tick siguiente, cinco minutos después, lo deja pasar.
    expect(tocaScan(db, new Date('2026-09-06T15:50:00.000Z'))).toBe(true);
    db.close();
  });
});

describe('métrica de cobertura del webhook', () => {
  function pub(db, clave, sku, stock) {
    db.prepare(`INSERT INTO ml_publicaciones_cache (clave,item_id,variation_id,titulo,status,seller_sku,available_quantity,actualizado_en)
      VALUES (?,?,'','t','active',?,?,?) ON CONFLICT(clave) DO UPDATE SET seller_sku=excluded.seller_sku, available_quantity=excluded.available_quantity`)
      .run(clave, clave.split('|')[0], sku, stock, new Date().toISOString());
  }

  it('la primera corrida no castiga: no hay con qué comparar', () => {
    const db = openDb(':memory:');
    pub(db, 'MLA1|', 'FB-1', 3);
    expect(medirCoberturaWebhook(db, '1970-01-01')).toMatchObject({ cambiosSinAviso: 0 });
    db.close();
  });

  it('un cambio SIN webhook previo cuenta como cobertura fallida', () => {
    const db = openDb(':memory:');
    pub(db, 'MLA1|', 'FB-1', 3);
    medirCoberturaWebhook(db, '1970-01-01');
    pub(db, 'MLA1|', 'FB-1', 9);
    expect(medirCoberturaWebhook(db, '1970-01-01')).toMatchObject({ cambios: 1, cambiosSinAviso: 1 });
    db.close();
  });

  it('el mismo cambio CON webhook previo no cuenta', () => {
    const db = openDb(':memory:');
    pub(db, 'MLA1|', 'FB-1', 3);
    medirCoberturaWebhook(db, '1970-01-01');
    pub(db, 'MLA1|', 'FB-1', 9);
    db.prepare(`INSERT INTO integration_events (event_id,event_type,channel,source,resource_id,received_at,correlation_id,dedupe_key)
      VALUES ('e1','webhook.received','ml','mercadolibre','/items/MLA1',?,'c1','d1')`).run(new Date().toISOString());
    expect(medirCoberturaWebhook(db, '1970-01-01')).toMatchObject({ cambios: 1, cambiosSinAviso: 0 });
    db.close();
  });

  it('una clave nueva no es un cambio no anunciado', () => {
    const db = openDb(':memory:');
    pub(db, 'MLA1|', 'FB-1', 3);
    medirCoberturaWebhook(db, '1970-01-01');
    pub(db, 'MLA2|', 'FB-2', 1);
    expect(medirCoberturaWebhook(db, '1970-01-01')).toMatchObject({ cambios: 0, cambiosSinAviso: 0 });
    db.close();
  });

  it('detecta la proyección rota por jobs muertos recientes', () => {
    const db = openDb(':memory:');
    expect(proyeccionItemsRota(db)).toBe(false);
    db.prepare(`INSERT INTO integration_events (event_id,event_type,channel,source,resource_id,received_at,correlation_id,dedupe_key)
      VALUES ('e2','webhook.received','ml','mercadolibre','/items/MLA5',?,'c2','d2')`).run(new Date().toISOString());
    db.prepare(`INSERT INTO integration_jobs (event_id,job_type,available_at,status)
      VALUES ('e2','item.project',?, 'dead_lettered')`).run(new Date().toISOString());
    expect(proyeccionItemsRota(db)).toBe(true);
    db.close();
  });
});
