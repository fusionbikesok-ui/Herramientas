import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';

vi.mock('../lib/mlClient.js', () => ({ mlFetch: vi.fn(), estadoCooldownMl: () => ({ activo: false }), categorizarErrorMl: () => 'interno' }));
import { mlFetch } from '../lib/mlClient.js';
import { openDb } from '../db/index.js';
import { pausarPublicacionMl } from '../lib/matcherPush.js';
import { ultimaPausaMl } from '../lib/pausasMl.js';

const FILE = './test/tmp-pausas-ml-log.sqlite';

describe('pausarPublicacionMl registra quién y desde dónde', () => {
  let db;
  beforeEach(() => { db = openDb(FILE); vi.clearAllMocks(); });
  afterEach(() => { db.close(); for (const s of ['', '-wal', '-shm']) if (fs.existsSync(FILE + s)) fs.unlinkSync(FILE + s); });

  it('al pausar con éxito asienta actor y origen', async () => {
    mlFetch.mockResolvedValue({ status: 200, data: {} });
    expect((await pausarPublicacionMl(db, {}, 'MLA1', { actor: 'ana', origen: 'cobertura' })).ok).toBe(true);
    expect(ultimaPausaMl(db, 'MLA1')).toMatchObject({ actor: 'ana', origen: 'cobertura' });
  });

  it('sin actor ni origen queda como desconocido, no se omite el registro', async () => {
    mlFetch.mockResolvedValue({ status: 200, data: {} });
    await pausarPublicacionMl(db, {}, 'MLA2');
    expect(ultimaPausaMl(db, 'MLA2')).toMatchObject({ actor: 'desconocido', origen: 'matcher_push' });
  });

  it('si ML no confirma, no hay registro (fail-closed)', async () => {
    mlFetch.mockResolvedValue({ status: 500, data: {} });
    expect((await pausarPublicacionMl(db, {}, 'MLA3', { actor: 'ana', origen: 'cobertura' })).ok).toBe(false);
    expect(ultimaPausaMl(db, 'MLA3')).toBeUndefined();
  });
});
