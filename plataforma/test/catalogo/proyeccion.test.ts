/*
 * test/catalogo/proyeccion.test.ts — E2 T1 tareas 4 y 5: proyecciones puras de Woo y de ML.
 *
 * Sin base: cada regla del §5.2 del diseño se prueba con un objeto en memoria. Los payloads imitan la
 * forma real de la API (el inbox guarda el producto o el ítem crudo).
 */
import { describe, expect, it } from 'vitest';
import { esRechazo, skuCanonicoDe, type Proyeccion, type ResultadoProyeccion } from '../../src/catalogo/intenciones.ts';
import { proyectarItemMl, skuMl } from '../../src/catalogo/ml.ts';
import { proyectarProductoWoo, skuWoo } from '../../src/catalogo/woo.ts';

function ok(r: ResultadoProyeccion): Proyeccion {
  if (esRechazo(r)) throw new Error(`se esperaba una proyección y vino un rechazo: ${r.rechazo}`);
  return r;
}

describe('E2-PRY-01 proyección de Woo', () => {
  it('un simple da un modelo woo_simple y una vendible con su SKU canónico', () => {
    const p = ok(proyectarProductoWoo({ id: 101, type: 'simple', status: 'publish', name: 'Cadena', sku: 'FB-101' }));
    expect(p.modelo).toEqual({ origen: 'woo_simple', claveOrigen: '101', titulo: 'Cadena' });
    expect(p.representaciones).toEqual([{
      recurso: '101', variacion: '', tipo: 'vendible', sku: { estado: 'canonico', valor: 'FB-101' },
      userProductId: null, estadoRemoto: 'publish', idWoo: '101',
    }]);
    expect(p.archivar).toBeNull();
  });

  it('un variable da un contenedor que no se vende y no lleva SKU', () => {
    const p = ok(proyectarProductoWoo({ id: 200, type: 'variable', status: 'publish', name: 'Cubierta', sku: 'FB-200' }));
    expect(p.modelo.origen).toBe('woo_padre');
    expect(p.representaciones).toHaveLength(1);
    expect(p.representaciones[0]).toMatchObject({ tipo: 'contenedor', recurso: '200', variacion: '', idWoo: null });
    // Aunque el padre tenga un SKU cargado, no identifica nada que se pueda comprar.
    expect(p.representaciones[0]!.sku).toEqual({ estado: 'no_informado' });
  });

  it('una variación cuelga del modelo del padre, con recurso el padre y variación su id', () => {
    const p = ok(proyectarProductoWoo({ id: 201, parent_id: 200, type: 'variation', status: 'publish', name: 'Cubierta - 29', sku: 'FB-201' }));
    expect(p.modelo).toMatchObject({ origen: 'woo_padre', claveOrigen: '200' });
    expect(p.representaciones[0]).toMatchObject({
      recurso: '200', variacion: '201', tipo: 'vendible', idWoo: '201',
      sku: { estado: 'canonico', valor: 'FB-201' },
    });
  });

  it('el canónico es el del que se vende: FB-{id del padre} en una variación no es canónico', () => {
    const p = ok(proyectarProductoWoo({ id: 201, parent_id: 200, type: 'variation', sku: 'FB-200' }));
    expect(p.representaciones[0]!.sku).toEqual({ estado: 'otro', valor: 'FB-200' });
  });

  it('SKU vacío, ausente o distinto del canónico se distinguen', () => {
    expect(skuWoo('', '5')).toEqual({ estado: 'vacio' });
    expect(skuWoo('   ', '5')).toEqual({ estado: 'vacio' });
    expect(skuWoo(undefined, '5')).toEqual({ estado: 'vacio' });
    expect(skuWoo('FB-5', '5')).toEqual({ estado: 'canonico', valor: 'FB-5' });
    expect(skuWoo(' FB-5 ', '5')).toEqual({ estado: 'canonico', valor: 'FB-5' });
    expect(skuWoo('FB-6', '5')).toEqual({ estado: 'otro', valor: 'FB-6' });
    expect(skuWoo('ABC123', '5')).toEqual({ estado: 'otro', valor: 'ABC123' });
    // Woo nunca da 'no_informado': si no hay SKU, es que no lo tiene cargado.
    expect(skuWoo(null, '5').estado).toBe('vacio');
  });

  it('una variación sin parent_id se rechaza con causa, no se adivina el padre', () => {
    const r = proyectarProductoWoo({ id: 300, type: 'variation', sku: 'FB-300' });
    expect(esRechazo(r) && r.rechazo).toMatch(/parent_id/);
    const cero = proyectarProductoWoo({ id: 300, parent_id: 0, type: 'variation' });
    expect(esRechazo(cero)).toBe(true);
  });

  it('agrupados, externos y tipos desconocidos se rechazan con causa', () => {
    for (const type of ['grouped', 'external', 'bundle', undefined]) {
      const r = proyectarProductoWoo({ id: 400, type });
      expect(esRechazo(r)).toBe(true);
    }
  });

  it('un payload roto se rechaza, no revienta', () => {
    expect(esRechazo(proyectarProductoWoo(null))).toBe(true);
    expect(esRechazo(proyectarProductoWoo([]))).toBe(true);
    expect(esRechazo(proyectarProductoWoo({ type: 'simple' }))).toBe(true);
    expect(esRechazo(proyectarProductoWoo({ id: 'abc', type: 'simple' }))).toBe(true);
  });

  it('la papelera archiva con motivo; los demás estados no', () => {
    expect(ok(proyectarProductoWoo({ id: 1, type: 'simple', status: 'trash' })).archivar).toMatch(/papelera/);
    for (const status of ['publish', 'draft', 'private', 'pending']) {
      expect(ok(proyectarProductoWoo({ id: 1, type: 'simple', status })).archivar).toBeNull();
    }
  });
});

describe('E2-PRY-02 proyección de ML', () => {
  it('un ítem sin variaciones da un ml_simple con una vendible y su user_product_id', () => {
    const p = ok(proyectarItemMl({ id: 'MLA1', title: 'Casco', status: 'active', user_product_id: 'MLAU9' }));
    expect(p.modelo).toEqual({ origen: 'ml_simple', claveOrigen: 'MLA1', titulo: 'Casco' });
    expect(p.representaciones).toEqual([{
      recurso: 'MLA1', variacion: '', tipo: 'vendible', sku: { estado: 'no_informado' },
      userProductId: 'MLAU9', estadoRemoto: 'active', idWoo: null,
    }]);
  });

  it('un ítem clásico da un contenedor y una vendible por variación, cada una con su user_product_id', () => {
    const p = ok(proyectarItemMl({
      id: 'MLA2', title: 'Remera', status: 'active', user_product_id: 'MLAU-ITEM',
      variations: [{ id: 11, user_product_id: 'MLAU11' }, { id: 12, user_product_id: 'MLAU12' }],
    }));
    expect(p.modelo).toEqual({ origen: 'ml_clasico', claveOrigen: 'MLA2', titulo: 'Remera' });
    expect(p.representaciones.map((r) => [r.tipo, r.recurso, r.variacion, r.userProductId])).toEqual([
      // El contenedor no se vende, así que no lleva user_product_id aunque el ítem traiga uno.
      ['contenedor', 'MLA2', '', null],
      ['vendible', 'MLA2', '11', 'MLAU11'],
      ['vendible', 'MLA2', '12', 'MLAU12'],
    ]);
  });

  it('el mismo user_product_id en dos ítems se conserva tal cual: es la pista para el caso', () => {
    // El caso real del legado: MLAU1158834512 es una variación de un clásico y además un ítem suelto.
    const clasico = ok(proyectarItemMl({ id: 'MLA1401411650', variations: [{ id: 184864981315, user_product_id: 'MLAU1158834512' }] }));
    const suelto = ok(proyectarItemMl({ id: 'MLA1775660825', user_product_id: 'MLAU1158834512' }));
    expect(clasico.representaciones[1]!.userProductId).toBe('MLAU1158834512');
    expect(suelto.representaciones[0]!.userProductId).toBe('MLAU1158834512');
    // Y cada uno mantiene su propio modelo: la proyección no fusiona, eso es trabajo del proyector.
    expect(clasico.modelo.claveOrigen).not.toBe(suelto.modelo.claveOrigen);
  });

  it('el SKU sale de SELLER_SKU o del campo viejo; su ausencia es no_informado, nunca vacío', () => {
    expect(skuMl({ attributes: [{ id: 'SELLER_SKU', value_name: 'FB-77' }] })).toEqual({ estado: 'canonico', valor: 'FB-77' });
    expect(skuMl({ seller_custom_field: 'FB-78' })).toEqual({ estado: 'canonico', valor: 'FB-78' });
    expect(skuMl({ attributes: [{ id: 'SELLER_SKU', value_name: 'XYZ' }] })).toEqual({ estado: 'otro', valor: 'XYZ' });
    // El atributo gana sobre el campo viejo cuando están los dos.
    expect(skuMl({ attributes: [{ id: 'SELLER_SKU', value_name: 'FB-1' }], seller_custom_field: 'FB-2' }))
      .toEqual({ estado: 'canonico', valor: 'FB-1' });
    // Lo que el multiget de variaciones devuelve en la práctica: nada. No es un caso.
    expect(skuMl({})).toEqual({ estado: 'no_informado' });
    expect(skuMl({ attributes: [{ id: 'SELLER_SKU', value_name: '' }] })).toEqual({ estado: 'no_informado' });
    expect(skuMl({ attributes: [{ id: 'COLOR', value_name: 'Rojo' }] })).toEqual({ estado: 'no_informado' });
  });

  it('cerrado archiva con motivo; pausado no', () => {
    expect(ok(proyectarItemMl({ id: 'MLA3', status: 'closed' })).archivar).toMatch(/cerrado/);
    expect(ok(proyectarItemMl({ id: 'MLA3', status: 'paused' })).archivar).toBeNull();
  });

  it('variaciones sin id o repetidas se rechazan enteras, no a medias', () => {
    expect(esRechazo(proyectarItemMl({ id: 'MLA4', variations: [{ id: 1 }, {}] }))).toBe(true);
    expect(esRechazo(proyectarItemMl({ id: 'MLA4', variations: [{ id: 1 }, { id: 1 }] }))).toBe(true);
  });

  it('un payload roto o un id inválido se rechazan', () => {
    expect(esRechazo(proyectarItemMl(null))).toBe(true);
    expect(esRechazo(proyectarItemMl({ title: 'sin id' }))).toBe(true);
    expect(esRechazo(proyectarItemMl({ id: '12345' }))).toBe(true);
  });

  it('un array de variaciones vacío es un ítem simple', () => {
    expect(ok(proyectarItemMl({ id: 'MLA5', variations: [] })).modelo.origen).toBe('ml_simple');
  });
});

describe('E2-PRY-03 SKU canónico', () => {
  it('sólo con un id numérico', () => {
    expect(skuCanonicoDe('123')).toBe('FB-123');
    expect(skuCanonicoDe('')).toBeNull();
    expect(skuCanonicoDe('12a')).toBeNull();
  });
});
