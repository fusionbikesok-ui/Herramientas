import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import { openDb } from '../db/index.js';
import { coberturaRouter, computarCruce } from '../routes/cobertura.js';

const TEST_DB = './test/tmp-cobertura-cruce.sqlite';

function buildTestApp(db) {
  const app = express();
  app.use(express.json());
  app.use('/api/cobertura', coberturaRouter(db));
  return app;
}

let claveSeq = 0;
function insWc(db, row) {
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, stock, categorias_json, actualizado_en) VALUES (?,?,?,?,?,?,?)'
  ).run(row.id_woo, row.nombre, row.sku, row.tipo || 'simple', row.stock, row.categorias_json ?? null, now);
}
function insMl(db, row) {
  const now = new Date().toISOString();
  const clave = row.clave || `ITEM${++claveSeq}${row.variation_id ? '|' + row.variation_id : ''}`;
  db.prepare(
    'INSERT INTO ml_publicaciones_cache (clave, item_id, variation_id, titulo, status, es_variante, seller_sku, variations_texto, actualizado_en) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(clave, row.item_id, row.variation_id ?? null, row.titulo ?? null, row.status ?? 'active', row.es_variante ?? 0, row.seller_sku ?? null, row.variations_texto ?? null, now);
}

describe('computarCruce — cruce WC × ML en el backend', () => {
  afterEach(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  function seedBase(db) {
    // WC: cubierto (en ML), faltante (stock>0 sin ML), servicio, sin stock, multi-pub
    insWc(db, { id_woo: 1, nombre: 'Cubierta cubierta', sku: 'FB-CUB', stock: 5, categorias_json: '["CUBIERTAS"]' });
    insWc(db, { id_woo: 2, nombre: 'Casco faltante', sku: 'FB-FALT', stock: 3, categorias_json: '["CASCOS"]' });
    insWc(db, { id_woo: 3, nombre: 'Armado', sku: 'FB-SERV', stock: 4, categorias_json: '["SERVICES"]' });
    insWc(db, { id_woo: 4, nombre: 'Sin stock', sku: 'FB-NOSTK', stock: 0, categorias_json: null });
    insWc(db, { id_woo: 5, nombre: 'Multi', sku: 'FB-MULTI', stock: 2, categorias_json: null });

    // ML: FB-CUB activo, FB-MULTI con 3 publicaciones (una pausada), un SKU sin WC
    insMl(db, { item_id: 'MLA1', seller_sku: 'FB-CUB', status: 'active', titulo: 'Cubierta ML' });
    insMl(db, { item_id: 'MLA2', seller_sku: 'FB-MULTI', status: 'active', titulo: 'Multi 1' });
    insMl(db, { item_id: 'MLA3', seller_sku: 'FB-MULTI', status: 'active', titulo: 'Multi 2' });
    insMl(db, { item_id: 'MLA4', seller_sku: 'FB-MULTI', status: 'paused', titulo: 'Multi 3' });
    insMl(db, { item_id: 'MLA5', seller_sku: 'SIN-WC', status: 'active', titulo: 'Huérfana' });
    insMl(db, { item_id: 'MLA6', seller_sku: '', status: 'active', titulo: 'Sin SKU' });
  }

  it('clasifica faltantes, multi-publicación, pausadas, en_ambos y solo_ml', () => {
    const db = openDb(TEST_DB);
    seedBase(db);
    const r = computarCruce(db);

    // Faltante: solo FB-FALT (FB-CUB cubierto, FB-SERV servicio, FB-NOSTK sin stock,
    // FB-MULTI está en ML)
    expect(r.faltantes.map((f) => f.sku).sort()).toEqual(['FB-FALT']);

    // Multi-publicación: FB-MULTI con 3 publicaciones (>2)
    expect(r.multiPub).toHaveLength(1);
    expect(r.multiPub[0].sku).toBe('FB-MULTI');
    expect(r.multiPub[0].conteo).toBe(3);
    expect(r.multiPub[0].publicaciones).toHaveLength(3);

    // Pausadas: la publicación pausada de FB-MULTI (está en ambos y no activa)
    expect(r.pausadas).toHaveLength(1);
    expect(r.pausadas[0].sku).toBe('FB-MULTI');
    expect(r.pausadas[0].ml_status).toBe('paused');

    // Solo ML: SIN-WC y la sin SKU
    expect(r.solo_ml).toHaveLength(2);

    // En ambos: FB-CUB (1) + FB-MULTI (3 publicaciones que matchean) = 4
    expect(r.en_ambos).toHaveLength(4);

    db.close();
  });

  it('SKU con stock>0 y única publicación ML pausada se considera cubierto (no aparece en faltantes)', () => {
    const db = openDb(TEST_DB);
    insWc(db, { id_woo: 10, nombre: 'Solo pausada', sku: 'FB-SOLOPAUSADA', stock: 4, categorias_json: null });
    insMl(db, { item_id: 'MLA20', seller_sku: 'FB-SOLOPAUSADA', status: 'paused', titulo: 'Única pausada' });

    const r = computarCruce(db);
    expect(r.faltantes.map((f) => f.sku)).not.toContain('FB-SOLOPAUSADA');
    // Sigue registrada en "pausadas" para que se pueda reactivar manualmente.
    expect(r.pausadas.map((p) => p.sku)).toContain('FB-SOLOPAUSADA');
    // No es multi-publicación: es una sola publicación (aunque esté pausada).
    expect(r.multiPub.map((m) => m.sku)).not.toContain('FB-SOLOPAUSADA');
    db.close();
  });

  it('multi-publicación cuenta también las pausadas: 2 activas + 1 pausada = 3', () => {
    const db = openDb(TEST_DB);
    insWc(db, { id_woo: 11, nombre: 'Multi con pausada', sku: 'FB-MULTIPAUS', stock: 6, categorias_json: null });
    insMl(db, { item_id: 'MLA30', seller_sku: 'FB-MULTIPAUS', status: 'active', titulo: 'Activa 1' });
    insMl(db, { item_id: 'MLA31', seller_sku: 'FB-MULTIPAUS', status: 'active', titulo: 'Activa 2' });
    insMl(db, { item_id: 'MLA32', seller_sku: 'FB-MULTIPAUS', status: 'paused', titulo: 'Pausada' });

    const r = computarCruce(db);
    const multi = r.multiPub.find((m) => m.sku === 'FB-MULTIPAUS');
    expect(multi).toBeTruthy();
    expect(multi.conteo).toBe(3);
    expect(multi.publicaciones).toHaveLength(3);
    db.close();
  });

  it('una exclusión "solo local" saca al producto de faltantes y multi-pub', () => {
    const db = openDb(TEST_DB);
    seedBase(db);
    db.prepare('INSERT INTO cobertura_exclusiones (id_woo, sku, nombre, motivo, creado_en) VALUES (?,?,?,?,?)')
      .run(2, 'FB-FALT', 'Casco faltante', 'solo_local', new Date().toISOString());
    db.prepare('INSERT INTO cobertura_exclusiones (id_woo, sku, nombre, motivo, creado_en) VALUES (?,?,?,?,?)')
      .run(5, 'FB-MULTI', 'Multi', 'solo_local', new Date().toISOString());

    const r = computarCruce(db);
    expect(r.faltantes).toHaveLength(0);
    expect(r.multiPub).toHaveLength(0);
    expect(r.excluidos.map((e) => e.id_woo).sort()).toEqual([2, 5]);
    db.close();
  });

  it('GET /cruce y los slices devuelven los mismos datos procesados', async () => {
    const db = openDb(TEST_DB);
    seedBase(db);
    const app = buildTestApp(db);

    const cruce = await request(app).get('/api/cobertura/cruce');
    expect(cruce.status).toBe(200);
    expect(cruce.body.ok).toBe(true);
    expect(cruce.body.resumen.total_ml_pubs).toBe(6);

    const falt = await request(app).get('/api/cobertura/faltantes');
    expect(falt.body.data.map((f) => f.sku)).toEqual(['FB-FALT']);

    const multi = await request(app).get('/api/cobertura/multi-publicacion');
    expect(multi.body.data).toHaveLength(1);
    expect(multi.body.data[0].sku).toBe('FB-MULTI');

    const paus = await request(app).get('/api/cobertura/pausadas');
    expect(paus.body.data).toHaveLength(1);
    db.close();
  });
});
