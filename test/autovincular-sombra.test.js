import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../db/index.js';

const FILE = path.resolve('./test/tmp-autovincular.sqlite');
const ISO = '2026-10-06T12:00:00.000Z';

function woo(db, id, sku, nombre) {
  db.prepare(`INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,stock,actualizado_en) VALUES (?,?,?,'simple',1,?)`).run(id, nombre, sku, ISO);
}
function ml(db, clave, sku, titulo, status = 'active') {
  const [item, variation = ''] = clave.split('|');
  db.prepare(`INSERT INTO ml_publicaciones_cache (clave,item_id,variation_id,titulo,status,seller_sku,seller_sku_presente,available_quantity,atributos_json,actualizado_en)
    VALUES (?,?,?,?,?,?,1,1,'[]',?)`).run(clave, item, variation, titulo, status, sku, ISO);
}
const correr = (...args) => spawnSync('node', ['scripts/autovincular-sombra.mjs', ...args], { encoding: 'utf8' });
const hash = () => crypto.createHash('sha256').update(fs.readFileSync(FILE)).digest('hex');

describe('auto-vinculación en modo sombra', () => {
  beforeEach(() => {
    const db = openDb(FILE);
    woo(db, 1, 'FB-1', 'Casco Abus Macator');
    woo(db, 2, 'FB-2', 'Cubierta Maxxis Detonator');
    woo(db, 3, 'FB-3', 'Bomba Topeak');
    ml(db, 'MLA1|', 'FB-1', 'Casco Abus Macator');                    // segura
    ml(db, 'MLA2|', 'FB-2', 'Cubierta Maxxis Detonator', 'paused');   // segura, pausada
    ml(db, 'MLA3|', 'FB-3', 'Bomba Topeak');                          // comparte SKU con la siguiente
    ml(db, 'MLA4|', 'FB-3', 'Bomba Topeak Joeblow');
    ml(db, 'MLA5|', 'FB-999', 'SKU que no existe en Woo');            // fuera del universo
    db.close();
  });
  afterEach(() => { for (const s of ['', '-wal', '-shm']) if (fs.existsSync(`${FILE}${s}`)) fs.unlinkSync(`${FILE}${s}`); });

  it('exige --db absoluto', () => {
    expect(correr().status).toBe(2);
    expect(correr('--db', 'relativa.sqlite').status).toBe(2);
  });

  it('clasifica seguras y a revisar, deja fuera lo que no existe en Woo y NO modifica la base', () => {
    const antes = hash();
    const r = correr('--db', FILE);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('| Universo | 4 | 3 | 1 |');
    expect(r.stdout).toContain('| Seguras (sin ninguna señal de riesgo) | 2 | 1 | 1 |');
    expect(r.stdout).toContain('| A revisar | 2 | 2 | 0 |');
    expect(r.stdout).toContain('2 publicaciones de ML comparten este SKU');
    expect(r.stdout).not.toContain('MLA5|');
    expect(hash()).toBe(antes);
    const db = openDb(FILE);
    expect(db.prepare('SELECT COUNT(*) n FROM identidades_canal').get().n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) n FROM identidad_operaciones').get().n).toBe(0);
    db.close();
  });

  it('la muestra sale de las activas por defecto y es reproducible', () => {
    const a = correr('--db', FILE, '--seed', '7').stdout;
    expect(correr('--db', FILE, '--seed', '7').stdout).toBe(a);
    expect(a).not.toContain('| MLA2|');
    expect(correr('--db', FILE, '--incluir-pausadas').stdout).toContain('MLA2|');
  });
});
