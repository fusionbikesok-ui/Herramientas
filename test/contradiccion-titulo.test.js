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

  it('no confunde talle M con rodado 29 y compara un talle numérico contra ambos atributos', () => {
    expect(detectarContradiccion({
      tituloMl: 'Bicicleta urbana rodado 29 talle M',
      nombreWoo: 'Bicicleta urbana Rodado 29 Talle M',
      talleMl: 'M',
    })).toEqual({ contradice: false, motivos: [] });
    expect(detectarContradiccion({ talleMl: '29', tituloMl: 'Bici', nombreWoo: 'Bici Rodado 29 Talle M' }))
      .toEqual({ contradice: false, motivos: [] });
    expect(detectarContradiccion({ talleMl: '29', tituloMl: 'Bici', nombreWoo: 'Bici Rodado 27 Talle M' }))
      .toEqual({ contradice: false, motivos: [] });
  });

  it('acepta transmisión con espacios y colores compuestos con solapamiento', () => {
    expect(detectarContradiccion({ tituloMl: 'Bici 2 x 8 Negro/Azul', nombreWoo: 'Bici 2x 8 Negro/Rojo' }))
      .toEqual({ contradice: false, motivos: [] });
    expect(detectarContradiccion({ tituloMl: 'Bici Negro/Azul', nombreWoo: 'Bici Negro/Rojo' }))
      .toEqual({ contradice: false, motivos: [] });
    expect(detectarContradiccion({ tituloMl: 'Bici Marrón Turquesa', nombreWoo: 'Bici Beige Bordó' }).motivos)
      .toContainEqual({ campo: 'color', ml: 'marron/turquesa', woo: 'beige/bordo' });
  });

  it('no confunde talle de cuadro numérico con rodado', () => {
    expect(detectarContradiccion({
      tituloMl: 'Bicicleta R29',
      talleMl: '20',
      nombreWoo: 'Bicicleta R29 cuadro 20"',
    })).toEqual({ contradice: false, motivos: [] });
  });

  it('no interpreta medidas de cámaras ni cajas como transmisión', () => {
    expect(detectarContradiccion({
      tituloMl: 'Cámara 29x2.10',
      nombreWoo: 'Cámara 29 x 2.125',
    })).toEqual({ contradice: false, motivos: [] });
    expect(detectarContradiccion({
      tituloMl: 'Caja 32 x 41',
      nombreWoo: 'Caja 32 x 42',
    })).toEqual({ contradice: false, motivos: [] });
  });

  it('no interpreta voltajes como velocidades', () => {
    expect(detectarContradiccion({ tituloMl: 'Luz 12v batería', nombreWoo: 'Luz 24v batería' }))
      .toEqual({ contradice: false, motivos: [] });
  });

  it('solo contradice transmisión, velocidades, rodado y talle en contextos válidos', () => {
    expect(detectarContradiccion({ tituloMl: 'Venzo Gravel 2X8 16v', nombreWoo: 'Venzo Gravel 1X8 8v' }).motivos)
      .toEqual([
        { campo: 'transmision', ml: '2x8', woo: '1x8' },
        { campo: 'velocidades', ml: '16', woo: '8' },
      ]);
    expect(detectarContradiccion({ tituloMl: 'Campera talle M', nombreWoo: 'Campera talle L' }).motivos)
      .toEqual([{ campo: 'talle', ml: 'm', woo: 'l' }]);
    expect(detectarContradiccion({ tituloMl: 'Zapatilla talle 42', nombreWoo: 'Zapatilla talle 41' }).motivos)
      .toEqual([{ campo: 'talle', ml: '42', woo: '41' }]);
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

describe('velocidades como conjunto (listas y rangos)', () => {
  const c = (tituloMl, nombreWoo) => detectarContradiccion({ tituloMl, nombreWoo }).contradice;

  it('una velocidad contenida en la lista del otro lado no contradice (casos reales FB-1550, FB-6490, FB-61159)', () => {
    expect(c('Cassette 8V Shimano', 'Cassette 6V/7V/8V Shimano')).toBe(false);
    expect(c('Cassette 7/8V Shimano', 'Cassette 6V/7V/8V Shimano')).toBe(false);
    expect(c('Cadena 11V/12V Sram', 'Cadena 12V Sram')).toBe(false);
  });
  it('un rango cuenta todas sus velocidades', () => {
    expect(c('Cassette 6-8 velocidades', 'Cassette 7 velocidades')).toBe(false);
  });
  it('conjuntos disjuntos sí contradicen', () => {
    expect(c('Cassette 9V Shimano', 'Cassette 11V Shimano')).toBe(true);
    expect(c('Cassette 6V/7V Shimano', 'Cassette 10V/11V Shimano')).toBe(true);
  });
  it('en un producto eléctrico la tensión no se lee como velocidades, aunque esté lejos de la palabra volt', () => {
    expect(c('Bicicleta eléctrica ruta 12v/24v batería 10Ah', 'Bicicleta eléctrica ruta 36v 10 velocidades')).toBe(false);
  });
  it('velocidades explícitas siguen contradiciendo en un producto eléctrico', () => {
    expect(c('Bicicleta eléctrica ruta 7 velocidades', 'Bicicleta eléctrica ruta 21 velocidades')).toBe(true);
  });
});
