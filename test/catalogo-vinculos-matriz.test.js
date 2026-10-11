import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { openDb } from '../db/index.js';
import { matrizAtributos } from '../lib/catalogoVinculos.js';
import { contradiccionDeClave } from '../lib/contradiccionTitulo.js';

const FILE = './test/tmp-catalogo-vinculos-matriz.sqlite';
const ISO = '2026-10-09T12:00:00.000Z';

function pub(db, { clave = 'MLA1|', titulo, sku = null, gtin = null, color = null, talle = null }) {
  const [item, variation = ''] = clave.split('|');
  db.prepare(`INSERT INTO ml_publicaciones_cache (clave,item_id,variation_id,titulo,status,seller_sku,seller_sku_presente,gtin,color,talle,available_quantity,atributos_json,actualizado_en)
    VALUES (?,?,?,?,'active',?,?,?,?,?,1,'[]',?)`).run(clave, item, variation, titulo, sku, sku ? 1 : 0, gtin, color, talle, ISO);
}
function woo(db, { id = 1, sku, nombre, gtin = null }) {
  db.prepare(`INSERT INTO catalogo_cache (id_woo,nombre,sku,gtin,tipo,stock,actualizado_en) VALUES (?,?,?,?,'simple',3,?)`).run(id, nombre, sku, gtin, ISO);
}
const fila = (m, campo) => m.filas.find((f) => f.campo === campo);

describe('matrizAtributos', () => {
  let db;
  beforeEach(() => { db = openDb(FILE); });
  afterEach(() => { try { db.close(); } catch { /* ya cerrada */ } for (const s of ['', '-wal', '-shm']) if (fs.existsSync(FILE + s)) fs.unlinkSync(FILE + s); });

  it('el rojo coincide exactamente con contradiccionDeClave', () => {
    pub(db, { titulo: 'Bicicleta MTB rodado 29 transmision 2x10 Negro' });
    woo(db, { sku: 'FB-1', nombre: 'Bicicleta MTB rodado 27.5 transmision 1x12 Rojo' });
    const veto = contradiccionDeClave(db, 'MLA1|', 'FB-1');
    expect(veto.contradice).toBe(true);
    const m = matrizAtributos(db, 'MLA1|', 'FB-1');
    expect(m.veto).toBe(true);
    const rojos = m.filas.filter((f) => f.semaforo === 'rojo').map((f) => f.campo).sort();
    expect(rojos).toEqual(veto.motivos.map((x) => x.campo).sort());
    for (const f of m.filas.filter((x) => x.semaforo === 'rojo')) expect(f.texto).toBe('Difiere');
  });

  it('verde cuando coincide, ámbar cuando falta un lado, gris cuando ninguno lo declara', () => {
    pub(db, { titulo: 'Casco Rembrandt Negro', sku: 'FB-2' });
    woo(db, { sku: 'FB-2', nombre: 'Casco Rembrandt Negro talle M' });
    const m = matrizAtributos(db, 'MLA1|', 'FB-2');
    expect(m.veto).toBe(false);
    expect(fila(m, 'color')).toMatchObject({ semaforo: 'verde', texto: 'Coincide' });
    expect(fila(m, 'talle')).toMatchObject({ semaforo: 'ambar', texto: 'Falta' });
    expect(fila(m, 'rodado')).toMatchObject({ semaforo: 'gris', texto: 'No aplica' });
    expect(fila(m, 'sku')).toMatchObject({ semaforo: 'verde' });
  });

  it('GTIN se compara aparte: distinto no es veto, es ámbar y marca leve', () => {
    pub(db, { titulo: 'Luz LED', sku: 'FB-3', gtin: '7798366205223' });
    woo(db, { sku: 'FB-3', nombre: 'Luz LED', gtin: '6971606842636' });
    const m = matrizAtributos(db, 'MLA1|', 'FB-3');
    expect(m.veto).toBe(false);
    expect(fila(m, 'gtin')).toMatchObject({ semaforo: 'ambar', texto: 'Difiere' });
    expect(m.leve).toBe(true);
  });

  it('GTIN igual con distinto formato (ceros a la izquierda) coincide', () => {
    pub(db, { titulo: 'Luz', sku: 'FB-4', gtin: '0779123456789' });
    woo(db, { sku: 'FB-4', nombre: 'Luz', gtin: '779123456789' });
    expect(fila(matrizAtributos(db, 'MLA1|', 'FB-4'), 'gtin').semaforo).toBe('verde');
  });

  it('nunca depende solo del color: toda fila trae texto', () => {
    pub(db, { titulo: 'Bici MTB 2x10' }); woo(db, { sku: 'FB-5', nombre: 'Bici MTB 1x12' });
    for (const f of matrizAtributos(db, 'MLA1|', 'FB-5').filas) expect(['Coincide', 'Difiere', 'Falta', 'No aplica']).toContain(f.texto);
  });

  it('sin publicación o sin producto Woo no rompe', () => {
    expect(matrizAtributos(db, 'NOEXISTE|', 'FB-9')).toMatchObject({ veto: false, filas: [] });
  });
});
