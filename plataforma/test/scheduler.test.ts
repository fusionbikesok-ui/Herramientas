import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crearLogger } from '../src/comun/logger.ts';
import { tomarExclusion } from '../src/scheduler/exclusion.ts';
import { crearScheduler } from '../src/scheduler/scheduler.ts';
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

describe('scheduler.informes', () => {
  const informes = { clave: {} as never, deposito: {} as never, correo: {} as never, datosClave: {} as never };

  it('sin informes configurados no hace nada', async () => {
    const s = crearScheduler({ db: {} as never });
    expect(await s.informes(new Date('2026-09-17T12:00:00Z'))).toBeNull();
  });

  it('antes de las 07:00 ART no emite', async () => {
    const s = crearScheduler({ db: {} as never, informes });
    // 2026-09-17T09:59Z son las 06:59 ART: todavía no.
    expect(await s.informes(new Date('2026-09-17T09:59:00Z'))).toBeNull();
  });
});
