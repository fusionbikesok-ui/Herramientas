import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crearLogger } from '../src/comun/logger.ts';
import { tomarExclusion } from '../src/scheduler/exclusion.ts';
import { crearBaseDePrueba, type BaseDePrueba } from './soporte/base.ts';

describe('exclusión del scheduler', () => {
  let base: BaseDePrueba;
  beforeAll(async () => { base = await crearBaseDePrueba(); });
  afterAll(async () => { await base.borrar(); });

  it('sólo permite un scheduler y libera la sesión para el siguiente', async () => {
    const logger = crearLogger('test');
    const primero = await tomarExclusion(base.urlApp, logger, () => undefined);
    expect(primero?.tieneLock()).toBe(true);
    const segundoMientras = await tomarExclusion(base.urlApp, logger, () => undefined);
    expect(segundoMientras).toBeNull();
    await primero?.soltar();
    const segundo = await tomarExclusion(base.urlApp, logger, () => undefined);
    expect(segundo?.tieneLock()).toBe(true);
    await segundo?.soltar();
  });
});
