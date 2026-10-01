import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { openDb } from '../db/index.js';
import { detectarContradiccion, contradiccionDeClave } from '../lib/contradiccionTitulo.js';

const TEST_DB = './test/tmp-contradiccion-titulo.sqlite';

describe('detectarContradiccion', () => {
  it('detecta transmisión distinta aunque cambien mayúsculas y año', () => {
    expect(detectarContradiccion({
      tituloMl: 'Bicicleta Venzo Gravel 2025 2X8 16v',
      nombreWoo: 'Venzo Gravel 2026 1X8 8 velocidades',
    })).toEqual({
      contradice: true,
      motivos: [
        { campo: 'transmision', ml: '2x8', woo: '1x8' },
        { campo: 'velocidades', ml: '16', woo: '8' },
      ],
    });
  });

  it('detecta velocidades explícitas y no las deriva si falta Nv', () => {
    expect(detectarContradiccion({ tituloMl: 'Gravel 2x8 16v', nombreWoo: 'Gravel 2x8 8v' }).motivos)
      .toContainEqual({ campo: 'velocidades', ml: '16', woo: '8' });
    expect(detectarContradiccion({ tituloMl: 'Gravel 2x8', nombreWoo: 'Gravel 1x8' }).motivos)
      .toEqual([{ campo: 'transmision', ml: '2x8', woo: '1x8' }]);
  });

  it('compara color y talle estructurados, con u como único sin conflicto', () => {
    expect(detectarContradiccion({
      tituloMl: 'Casco rojo talle M',
      nombreWoo: 'Casco azul talle L',
      colorMl: 'Rojo',
      talleMl: 'M',
    }).motivos).toEqual([
      { campo: 'color', ml: 'rojo', woo: 'azul' },
      { campo: 'talle', ml: 'm', woo: 'l' },
    ]);
    expect(detectarContradiccion({ tituloMl: 'Producto U', nombreWoo: 'Producto L', talleMl: 'U' }))
      .toEqual({ contradice: false, motivos: [] });
    expect(detectarContradiccion({ tituloMl: 'Casco rojo', nombreWoo: 'Casco negro/rojo', colorMl: 'Rojo' }))
      .toEqual({ contradice: false, motivos: [] });
  });

  it('es fail-open cuando falta el atributo de un lado y acepta igualdad', () => {
    expect(detectarContradiccion({ tituloMl: 'Bici urbana', nombreWoo: 'Bici 1x8' }))
      .toEqual({ contradice: false, motivos: [] });
    expect(detectarContradiccion({ tituloMl: 'Bici 2x8', nombreWoo: 'Bici 2x8' }))
      .toEqual({ contradice: false, motivos: [] });
  });
});

describe('contradiccionDeClave', () => {
  let db;
  beforeEach(() => { db = openDb(TEST_DB); });
  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('elige el producto Woo de menor stock y luego menor id_woo', () => {
    db.prepare(`INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,stock,actualizado_en)
      VALUES (20,'Venzo Gravel 2X8','SKU-G','simple',5,?)`).run(new Date().toISOString());
    db.prepare(`INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,stock,actualizado_en)
      VALUES (10,'Venzo Gravel 1X8 8v','SKU-G','simple',0,?)`).run(new Date().toISOString());
    db.prepare(`INSERT INTO ml_publicaciones_cache
      (clave,item_id,variation_id,titulo,color,talle,variations_texto,status,actualizado_en)
      VALUES ('MLA1|','MLA1','', 'Bici 2X8 16v', '', '', '', 'active', ?)`).run(new Date().toISOString());

    expect(contradiccionDeClave(db, 'MLA1|', 'SKU-G')).toEqual({
      contradice: true,
      motivos: [{ campo: 'transmision', ml: '2x8', woo: '1x8' }, { campo: 'velocidades', ml: '16', woo: '8' }],
    });
  });

  it('devuelve no contradicción si falta la publicación o el producto', () => {
    expect(contradiccionDeClave(db, 'NO existe', 'SKU')).toEqual({ contradice: false, motivos: [] });
  });
});
