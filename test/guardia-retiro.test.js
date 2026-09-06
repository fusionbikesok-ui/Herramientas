import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { openDb } from '../db/index.js';
import { cerrarCasosFueraDeUniverso } from '../lib/guardiaMl.js';

const FILE = './test/tmp-guardia-retiro.sqlite';
const ISO = '2026-09-06T12:00:00.000Z';

function pub(db, { clave, canales, stock = 5, sku = 'FB-1' }) {
  db.prepare(`INSERT INTO ml_publicaciones_cache
    (clave,item_id,variation_id,titulo,status,seller_sku,seller_sku_presente,available_quantity,canales_json,actualizado_en)
    VALUES (?,?,'','Publicación','active',?,1,?,?,?)`)
    .run(clave, clave.split('|')[0], sku, stock, canales, ISO);
}

function caso(db, clave, estado = 'abierto') {
  db.prepare(`INSERT INTO guardia_ml_casos (clave,estado,severidad,motivo,expected_version,creado_en,actualizado_en)
    VALUES (?,?,'urgente','sin_cobertura',1,?,?)`).run(clave, estado, ISO, ISO);
  return db.prepare('SELECT id FROM guardia_ml_casos WHERE clave=?').get(clave).id;
}

let seq = 0;
function operacion(db, casoId, itemId, estado = 'pendiente') {
  seq += 1;
  db.prepare(`INSERT INTO guardia_ml_operaciones (caso_id,tipo,item_id,estado,intentos,proximo_intento_en,idempotencia,creado_en,actualizado_en)
    VALUES (?,'pausar',?,?,0,?,?,?,?)`).run(casoId, itemId, estado, ISO, `pausar:${casoId}:${itemId}:${seq}`, ISO, ISO);
}

const MP = '["mp-merchants","mp-link"]';
const MKT = '["marketplace"]';

describe('retiro de Guardia: casos fuera del universo', () => {
  let db;
  beforeEach(() => { db = openDb(FILE); });
  afterEach(() => {
    try { db.close(); } catch { /* ya estaba cerrada */ }
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(`${FILE}${s}`)) fs.unlinkSync(`${FILE}${s}`);
  });

  it('cierra los casos de links de pago, que no se venden por el marketplace', () => {
    pub(db, { clave: 'MLA1|', canales: MP });
    caso(db, 'MLA1|');

    expect(cerrarCasosFueraDeUniverso(db, 'ana')).toMatchObject({ casos: 1 });
    expect(db.prepare("SELECT estado FROM guardia_ml_casos WHERE clave='MLA1|'").get().estado).toBe('resuelto');
    expect(db.prepare("SELECT COUNT(*) n FROM guardia_ml_eventos WHERE evento='cerrado_fuera_de_universo'").get().n).toBe(1);
  });

  it('no toca los casos de publicaciones que sí son del marketplace', () => {
    pub(db, { clave: 'MLA2|', canales: MKT });
    caso(db, 'MLA2|');

    expect(cerrarCasosFueraDeUniverso(db)).toMatchObject({ casos: 0, operaciones: 0 });
    expect(db.prepare("SELECT estado FROM guardia_ml_casos WHERE clave='MLA2|'").get().estado).toBe('abierto');
  });

  it('cancela las operaciones de pausar antes de cerrar el caso', () => {
    // Si el worker tomara una entre ambos pasos, pausaría un link de pago activo.
    pub(db, { clave: 'MLA3|', canales: MP });
    const id = caso(db, 'MLA3|');
    operacion(db, id, 'MLA3');
    operacion(db, id, 'MLA3', 'conflicto');

    expect(cerrarCasosFueraDeUniverso(db)).toMatchObject({ casos: 1, operaciones: 2 });
    expect(db.prepare("SELECT COUNT(*) n FROM guardia_ml_operaciones WHERE estado IN ('pendiente','conflicto','procesando')").get().n).toBe(0);
  });

  it('alcanza también la operación huérfana cuyo caso ya estaba resuelto', () => {
    // Encontrada en producción: una `pausar` viva sobre un link de pago con stock, cuyo caso
    // ya figuraba resuelto, así que filtrar por el estado del caso no la veía.
    pub(db, { clave: 'MLA4|', canales: MP });
    const id = caso(db, 'MLA4|', 'resuelto');
    operacion(db, id, 'MLA4', 'conflicto');

    expect(cerrarCasosFueraDeUniverso(db)).toMatchObject({ operaciones: 1 });
    expect(db.prepare('SELECT estado FROM guardia_ml_operaciones').get().estado).toBe('cancelada');
  });

  it('no cancela operaciones de publicaciones del marketplace', () => {
    pub(db, { clave: 'MLA5|', canales: MKT });
    const id = caso(db, 'MLA5|', 'resuelto');
    operacion(db, id, 'MLA5', 'conflicto');

    expect(cerrarCasosFueraDeUniverso(db)).toMatchObject({ casos: 0, operaciones: 0 });
    expect(db.prepare('SELECT estado FROM guardia_ml_operaciones').get().estado).toBe('conflicto');
  });

  it('no borra: el historial es la evidencia de por qué se retiró', () => {
    pub(db, { clave: 'MLA6|', canales: MP });
    const id = caso(db, 'MLA6|');
    operacion(db, id, 'MLA6');
    cerrarCasosFueraDeUniverso(db);

    expect(db.prepare('SELECT COUNT(*) n FROM guardia_ml_casos').get().n).toBe(1);
    expect(db.prepare('SELECT COUNT(*) n FROM guardia_ml_operaciones').get().n).toBe(1);
  });

  it('es idempotente', () => {
    pub(db, { clave: 'MLA7|', canales: MP });
    caso(db, 'MLA7|');
    cerrarCasosFueraDeUniverso(db);
    expect(cerrarCasosFueraDeUniverso(db)).toMatchObject({ casos: 0, operaciones: 0 });
  });
});
