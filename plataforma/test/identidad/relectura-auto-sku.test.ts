/*
 * test/identidad/relectura-auto-sku.test.ts — E3 corte 3 tarea 2: tabla de política de releerParaAutoSku
 * (spec §6), con un Relector falso.
 */
import { describe, expect, it, vi } from 'vitest';
import { releerParaAutoSku } from '../../src/identidad/relectura-auto-sku.ts';
import { estructuraItemMl, hashEstructura } from '../../src/identidad/formato.ts';
import { ErrorBarridoReintentable } from '../../src/worker/barridos.ts';
import { ErrorCanalTerminal } from '../../src/reconciliacion/cliente-http.ts';
import type { Relector, ResultadoRelectura } from '../../src/reconciliacion/relectura.ts';

const itemBase = { id: 'MLA1', title: 'x', status: 'active', seller_custom_field: 'FB-1', attributes: [], variations: [] };

function relectorQueDevuelve(resultado: ResultadoRelectura | (() => ResultadoRelectura)): Relector {
  return {
    topic: 'ml.items', versionKind: 'temporal', id: /.*/,
    releer: vi.fn(async () => (typeof resultado === 'function' ? resultado() : resultado)),
  };
}

function relectorQueLanza(error: unknown): Relector {
  return { topic: 'ml.items', versionKind: 'temporal', id: /.*/, releer: vi.fn(async () => { throw error; }) };
}

const recursoDe = (payload: unknown, lifecycle: 'open' | 'closed' | 'deleted' | 'unknown' = 'open'): ResultadoRelectura => ({
  tipo: 'recursos',
  recursos: [{ id: 'MLA1', version: 'v1', lifecycle, payload, projection: null }],
});

const e = { recurso: 'MLA1', variacion: '', skuCongelado: 'FB-1', hashFormatoPrevio: null as string | null };

describe('E3-RAS-01 tabla de política de releerParaAutoSku', () => {
  it('200, SKU y formato iguales (formato previo null) → ok', async () => {
    const r = await releerParaAutoSku(relectorQueDevuelve(recursoDe(itemBase)), e);
    expect(r.tipo).toBe('ok');
  });

  it('200, SKU y formato iguales (con formato previo IGUAL al observado) → ok', async () => {
    const hashPrevio = hashEstructura(estructuraItemMl(itemBase));
    const r = await releerParaAutoSku(relectorQueDevuelve(recursoDe(itemBase)), { ...e, hashFormatoPrevio: hashPrevio });
    expect(r.tipo).toBe('ok');
  });

  it('200, publicación paused → ok (sigue elegible)', async () => {
    const r = await releerParaAutoSku(relectorQueDevuelve(recursoDe({ ...itemBase, status: 'paused' })), e);
    expect(r.tipo).toBe('ok');
  });

  it('200, closed → no_disponible', async () => {
    const r = await releerParaAutoSku(relectorQueDevuelve(recursoDe(itemBase, 'closed')), e);
    expect(r).toEqual({ tipo: 'no_disponible', motivo: 'closed' });
  });

  it('200, deleted → no_disponible', async () => {
    const r = await releerParaAutoSku(relectorQueDevuelve(recursoDe(itemBase, 'deleted')), e);
    expect(r).toEqual({ tipo: 'no_disponible', motivo: 'deleted' });
  });

  it('404 (sin_baja) → no_disponible (not_found)', async () => {
    const r = await releerParaAutoSku(relectorQueDevuelve({ tipo: 'sin_baja', motivo: 'not_found' }), e);
    expect(r).toEqual({ tipo: 'no_disponible', motivo: 'not_found' });
  });

  it('200 con SKU normalizado distinto → cambio/sku', async () => {
    const r = await releerParaAutoSku(relectorQueDevuelve(recursoDe({ ...itemBase, seller_custom_field: 'FB-999' })), e);
    expect(r.tipo).toBe('cambio');
    expect((r as { que: string }).que).toBe('sku');
  });

  it('200 con hash de formato distinto del previo → cambio/formato', async () => {
    const r = await releerParaAutoSku(relectorQueDevuelve(recursoDe(itemBase)), { ...e, hashFormatoPrevio: 'un-hash-distinto' });
    expect(r).toEqual(expect.objectContaining({ tipo: 'cambio', que: 'formato' }));
  });

  it('200 con SKU Y hash de formato distintos a la vez → cambio/sku (misma precedencia que registrarFormato)', async () => {
    const r = await releerParaAutoSku(
      relectorQueDevuelve(recursoDe({ ...itemBase, seller_custom_field: 'FB-999' })),
      { ...e, hashFormatoPrevio: 'un-hash-distinto' },
    );
    expect(r).toEqual(expect.objectContaining({ tipo: 'cambio', que: 'sku' }));
  });

  it('ErrorBarridoReintentable 3 veces → parked, con 2 esperas antes (backoff, respeta retryAfter)', async () => {
    const esperas: number[] = [];
    const relector = relectorQueLanza(new ErrorBarridoReintentable('BULK_503', 5));
    const r = await releerParaAutoSku(relector, e, {
      esperar: async (ms) => { esperas.push(ms); },
      azar: () => 0.5,
    });
    expect(r.tipo).toBe('parked');
    expect(esperas).toHaveLength(2);
    expect(esperas[0]).toBe(5000); // primera espera respeta retryAfter=5s
  });

  it('respuesta sin id/status o SKU no legible → parked (incompleta)', async () => {
    const r1 = await releerParaAutoSku(relectorQueDevuelve(recursoDe(null)), e);
    expect(r1).toEqual({ tipo: 'parked', motivo: 'incompleta' });
    const r2 = await releerParaAutoSku(relectorQueDevuelve(recursoDe({ ...itemBase, seller_custom_field: undefined, attributes: [] })), e);
    expect(r2).toEqual({ tipo: 'parked', motivo: 'incompleta' });
    // Hallazgo Alto de la segunda opinión de Codex, 2026-09-25: sin `status`, cicloPorEstado del relector
    // real trata el recurso como 'open' — sin esta validación explícita, un payload incompleto se
    // procesaba igual que uno completo.
    const { status: _status, ...sinStatus } = itemBase;
    const r3 = await releerParaAutoSku(relectorQueDevuelve(recursoDe(sinStatus)), e);
    expect(r3).toEqual({ tipo: 'parked', motivo: 'incompleta' });
  });

  it('ErrorCanalTerminal 401/403 → abortar', async () => {
    const r401 = await releerParaAutoSku(relectorQueLanza(new ErrorCanalTerminal('no autorizado', 401)), e);
    expect(r401).toEqual({ tipo: 'abortar', status: 401 });
    const r403 = await releerParaAutoSku(relectorQueLanza(new ErrorCanalTerminal('prohibido', 403)), e);
    expect(r403).toEqual({ tipo: 'abortar', status: 403 });
  });

  it('otro ErrorCanalTerminal (no 401/403) → parked', async () => {
    const r = await releerParaAutoSku(relectorQueLanza(new ErrorCanalTerminal('BULK_400', 400)), e);
    expect(r.tipo).toBe('parked');
  });

  it('relee la variación correcta cuando variacion no es vacío', async () => {
    const conVariaciones = {
      ...itemBase, seller_custom_field: undefined,
      variations: [{ id: '10', attributes: [{ id: 'SELLER_SKU', value_name: 'FB-1' }] }, { id: '20', attributes: [{ id: 'SELLER_SKU', value_name: 'FB-2' }] }],
    };
    const r = await releerParaAutoSku(relectorQueDevuelve(recursoDe(conVariaciones)), { ...e, variacion: '20', skuCongelado: 'FB-2' });
    expect(r.tipo).toBe('ok');
  });
});
