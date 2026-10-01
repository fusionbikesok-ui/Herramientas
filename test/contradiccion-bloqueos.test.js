import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { openDb } from '../db/index.js';
import { escanearGuardiaMl } from '../lib/guardiaMl.js';
import { autoVincularPorSellerSku } from '../lib/mlMapeo.js';

const TEST_DB = './test/tmp-contradiccion-bloqueos.sqlite';
const ahora = () => new Date().toISOString();

function catalogo(db, sku, nombre, stock = 1, id = Math.floor(Math.random() * 1000000)) {
  db.prepare(`INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,stock,actualizado_en)
    VALUES (?,?,'${sku}','simple',?,?)`).run(id, nombre, stock, ahora());
}

function publicacion(db, { clave, sku, titulo }) {
  db.prepare(`INSERT INTO ml_publicaciones_cache
    (clave,item_id,variation_id,titulo,status,seller_sku,available_quantity,actualizado_en)
    VALUES (?,?, '', ?, 'active', ?, 1, ?)`).run(clave, clave.split('|')[0], titulo, sku, ahora());
}

describe('bloqueos por contradicción de título', () => {
  let db;
  beforeEach(() => { db = openDb(TEST_DB); });
  afterEach(() => { db.close(); if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('Guardia no auto-vincula y deja evento bloqueado_contradiccion', () => {
    db.prepare("UPDATE guardia_ml_config SET modo='acciones' WHERE id=1").run();
    catalogo(db, 'SKU-1', 'Venzo Gravel 1X8 8v');
    publicacion(db, { clave: 'MLA-G|', sku: 'SKU-1', titulo: 'Venzo Gravel 2X8 16v' });
    escanearGuardiaMl(db);
    expect(db.prepare("SELECT 1 FROM sku_matcher_decisiones WHERE clave='MLA-G|'").get()).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM guardia_ml_eventos WHERE evento='bloqueado_contradiccion'").get()).toBeTruthy();
  });

  it('autoVincularPorSellerSku saltea el vínculo contradictorio', () => {
    catalogo(db, 'SKU-2', 'Venzo Gravel 1X8 8v');
    publicacion(db, { clave: 'MLA-M|', sku: 'SKU-2', titulo: 'Venzo Gravel 2X8 16v' });
    expect(autoVincularPorSellerSku(db)).toBe(0);
    expect(db.prepare("SELECT 1 FROM sku_matcher_decisiones WHERE clave='MLA-M|'").get()).toBeUndefined();
  });
});
