/*
 * test/reconciliacion/orden-ml.test.ts — el defecto que dejó 35 señales de `ml.orders` muertas.
 *
 * Qué pasó en producción (2026-09-19): órdenes como `2000018533891264` mataban su señal con
 * `terminal:ErrorPaginaInvalida`, sin reintento. La cadena es:
 *
 *   `date_last_updated` ausente o no parseable
 *     → `fechaUtc` devuelve '' (comun.ts:32)
 *     → `ordenMl` arma el recurso con `version: ''`
 *     → `validarRecurso` exige version no vacía y lanza ErrorPaginaInvalida (motor.ts:18)
 *     → `senales.ts:50` lo clasifica como TERMINAL y la señal muere para siempre.
 *
 * El registro de órdenes de la copia en sombra quedó clavado el 2026-09-12 por esto (la operación del
 * negocio no se vio afectada: el legado procesa las ventas por su camino, 397 al día de hoy).
 *
 * Que sea terminal es lo grave: un dato remoto que no entendemos no es culpa del dato, y enterrarlo sin
 * reintento ni rastro deja un hueco silencioso en la copia. `ordenMl` nunca tuvo test; parte del motivo.
 */
import { describe, expect, it } from 'vitest';
import { ordenMl } from '../../src/reconciliacion/adaptadores/ml.ts';
import { ErrorPaginaInvalida, validarRecurso } from '../../src/reconciliacion/motor.ts';

/** Una orden como las que ML devuelve, a la que se le puede quitar o romper un campo. */
const orden = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 2000018533891264,
  status: 'paid',
  date_last_updated: '2026-09-18T14:03:11.000-03:00',
  date_created: '2026-09-18T13:59:02.000-03:00',
  shipping: { id: 44556677 },
  pack_id: null,
  ...extra,
});

describe('E1-ML-ORD ordenMl y la validación del recurso', () => {
  it('una orden normal se proyecta y pasa la validación', () => {
    const r = ordenMl(orden());
    expect(r.id).toBe('2000018533891264');
    expect(r.version).toBe('2026-09-18T17:03:11.000Z');   // normalizada a UTC
    expect(() => validarRecurso(r, 'temporal')).not.toThrow();
  });

  it('sin date_last_updated cae de vuelta a date_created en vez de quedar sin versión', () => {
    // El caso real: ML no siempre manda date_last_updated. Una orden creada y nunca modificada tiene
    // fecha de creación, y ésa es una versión legítima: usarla conserva la orden en la copia.
    const r = ordenMl(orden({ date_last_updated: undefined }));
    expect(r.version).toBe('2026-09-18T16:59:02.000Z');
    expect(() => validarRecurso(r, 'temporal')).not.toThrow();
  });

  it('con date_last_updated nulo también usa la creación', () => {
    const r = ordenMl(orden({ date_last_updated: null }));
    expect(r.version).toBe('2026-09-18T16:59:02.000Z');
    expect(() => validarRecurso(r, 'temporal')).not.toThrow();
  });

  it('con una fecha ilegible usa la creación en vez de morir', () => {
    const r = ordenMl(orden({ date_last_updated: 'no-es-una-fecha' }));
    expect(r.version).toBe('2026-09-18T16:59:02.000Z');
    expect(() => validarRecurso(r, 'temporal')).not.toThrow();
  });

  it('sin ninguna fecha usable el recurso sigue siendo inválido, y eso está bien', () => {
    // Acá sí no hay nada que hacer: sin fecha no hay versión, y sin versión no se puede decidir si una
    // observación es más nueva que otra. Lo que NO corresponde es que eso mate la señal sin reintento;
    // de eso se encarga la clasificación en el worker de señales, no este normalizador.
    const r = ordenMl(orden({ date_last_updated: null, date_created: null }));
    expect(r.version).toBe('');
    expect(() => validarRecurso(r, 'temporal')).toThrow(ErrorPaginaInvalida);
  });

  it('la relación con el envío y el pack se conserva', () => {
    const r = ordenMl(orden({ pack_id: 998877 }));
    expect(r.relations).toEqual([
      { type: 'order_shipment', targetTopic: 'ml.shipments', targetId: '44556677' },
      { type: 'order_pack', targetTopic: 'ml.messages', targetId: '998877' },
    ]);
    // Sin pack, la orden es su propio pack: así lo espera el barrido de mensajes.
    expect(ordenMl(orden()).relations).toEqual([
      { type: 'order_shipment', targetTopic: 'ml.shipments', targetId: '44556677' },
      { type: 'order_pack', targetTopic: 'ml.messages', targetId: '2000018533891264' },
    ]);
  });

  it('la proyección lleva la versión normalizada, no la cruda', () => {
    // La proyección alimenta el hash de convergencia: si llevara la fecha cruda con offset, la misma
    // orden daría dos hashes distintos según cómo vino.
    const r = ordenMl(orden({ date_last_updated: undefined }));
    expect(r.projection).toMatchObject({ date_last_updated: '2026-09-18T16:59:02.000Z' });
  });
});
