import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import { revisarDrift } from '../lib/vigiaDrift.js';

const TEST_DB = './test/tmp-vigia-drift.sqlite';
const ESTADO = './test/tmp-vigia-drift-estado.json';
const AHORA = Date.parse('2026-10-16T12:00:00Z');

function escribirEstado(obj) { fs.writeFileSync(ESTADO, typeof obj === 'string' ? obj : JSON.stringify(obj)); }
const activos = db => db.prepare("SELECT * FROM incidentes_operativos WHERE integracion='vps' AND estado='activo'").all();
const estadoBase = (extra = {}) => ({
  ultimo_corrida: '2026-10-16T07:15:30Z', rc: 0, total: 0, por_bloque: {}, imagenes_distintas: 0, muestra: [], ref_sha: 'f6bed3f9', ...extra,
});

describe('lib/vigiaDrift', () => {
  let db;
  beforeEach(() => { db = openDb(TEST_DB); });
  afterEach(() => {
    db.close();
    for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`, ESTADO]) if (fs.existsSync(f)) fs.unlinkSync(f);
  });

  it('rc=1 abre un incidente de deriva con la muestra y por_bloque, deduplicado', () => {
    escribirEstado(estadoBase({
      rc: 1, total: 3,
      por_bloque: { herramientas: { modificados: 1, solo_vps: 2, solo_repo: 0 } },
      muestra: ['[herramientas] MODIFICADO server.js', '[herramientas] SOLO_EN_VPS public/x.js', '[herramientas] SOLO_EN_VPS public/y.js'],
    }));
    revisarDrift(db, { estadoPath: ESTADO, ahora: AHORA });
    revisarDrift(db, { estadoPath: ESTADO, ahora: AHORA });
    const inc = activos(db);
    expect(inc).toHaveLength(1);
    expect(inc[0]).toMatchObject({ proceso: 'deriva_git', tipo_error: 'deriva', severidad: 'advertencia' });
    expect(inc[0].mensaje_humano).toContain('3 archivos del VPS no coinciden con git');
    expect(inc[0].mensaje_humano).toContain('server.js');
    expect(JSON.parse(inc[0].contexto_json).por_bloque.herramientas.solo_vps).toBe(2);
  });

  it('rc=2 abre deriva_sin_medicion', () => {
    escribirEstado(estadoBase({ rc: 2 }));
    revisarDrift(db, { estadoPath: ESTADO, ahora: AHORA });
    const inc = activos(db);
    expect(inc).toHaveLength(1);
    expect(inc[0]).toMatchObject({ proceso: 'deriva_git', tipo_error: 'deriva_sin_medicion', severidad: 'advertencia' });
  });

  it('estado ausente, ilegible o de más de 26 h abre deriva_sin_medicion', () => {
    for (const preparar of [() => {}, () => escribirEstado('{roto'), () => escribirEstado(estadoBase({ ultimo_corrida: '2026-10-15T08:00:00Z' }))]) {
      if (fs.existsSync(ESTADO)) fs.unlinkSync(ESTADO);
      preparar();
      revisarDrift(db, { estadoPath: ESTADO, ahora: AHORA });
      const inc = activos(db);
      expect(inc).toHaveLength(1);
      expect(inc[0].tipo_error).toBe('deriva_sin_medicion');
    }
  });

  it('rc=0 reciente resuelve ambos incidentes', () => {
    escribirEstado(estadoBase({ rc: 1, total: 1, muestra: ['[herramientas] MODIFICADO server.js'] }));
    revisarDrift(db, { estadoPath: ESTADO, ahora: AHORA });
    fs.unlinkSync(ESTADO);
    revisarDrift(db, { estadoPath: ESTADO, ahora: AHORA });
    expect(activos(db).map(i => i.tipo_error)).toEqual(['deriva', 'deriva_sin_medicion']);
    escribirEstado(estadoBase());
    revisarDrift(db, { estadoPath: ESTADO, ahora: AHORA });
    expect(activos(db)).toHaveLength(0);
  });

  it('fetch fallido (rc=2, motivo) y rc no numérico abren deriva_sin_medicion', () => {
    for (const est of [estadoBase({ rc: 2, motivo: 'fetch_fallido' }), estadoBase({ rc: 'x' })]) {
      escribirEstado(est);
      const r = revisarDrift(db, { estadoPath: ESTADO, ahora: AHORA });
      expect(r.medido).toBe(false);
    }
    const inc = activos(db);
    expect(inc).toHaveLength(1);
    expect(inc[0].tipo_error).toBe('deriva_sin_medicion');
    escribirEstado(estadoBase({ rc: 2, motivo: 'fetch_fallido' }));
    expect(revisarDrift(db, { estadoPath: ESTADO, ahora: AHORA }).motivo).toBe('fetch_fallido');
  });

  it('las rutas con pinta de secreto no llegan al mensaje', () => {
    escribirEstado(estadoBase({ rc: 1, total: 2, muestra: ['[herramientas] SOLO_EN_VPS .env.prod', '[herramientas] MODIFICADO config/api_key.json', '[herramientas] MODIFICADO server.js'] }));
    revisarDrift(db, { estadoPath: ESTADO, ahora: AHORA });
    const m = activos(db)[0].mensaje_humano;
    expect(m).not.toMatch(/\.env|api_key/);
    expect(m).toContain('[ruta omitida]');
    expect(m).toContain('server.js');
  });

  it('ultimo_corrida en el futuro es fecha_futura; hasta 15 min de desfase se tolera', () => {
    escribirEstado(estadoBase({ ultimo_corrida: '2026-10-16T14:00:00Z' }));
    expect(revisarDrift(db, { estadoPath: ESTADO, ahora: AHORA }).motivo).toBe('fecha_futura');
    escribirEstado(estadoBase({ ultimo_corrida: '2026-10-16T12:10:00Z' }));
    expect(revisarDrift(db, { estadoPath: ESTADO, ahora: AHORA }).medido).toBe(true);
  });

  it('con más de 10 diferencias el mensaje dice "y N más"', () => {
    const muestra = Array.from({ length: 30 }, (_, i) => `[herramientas] MODIFICADO f${i}.js`);
    escribirEstado(estadoBase({ rc: 1, total: 42, muestra }));
    revisarDrift(db, { estadoPath: ESTADO, ahora: AHORA });
    const m = activos(db).find(i => i.tipo_error === 'deriva').mensaje_humano;
    expect(m).toContain('42 archivos');
    expect(m).toContain('(y 32 más)');
    expect(m).not.toContain('f10.js');
  });

  it('nunca lanza aunque la base falle', () => {
    escribirEstado(estadoBase({ rc: 1, total: 1 }));
    db.close();
    expect(() => revisarDrift(db, { estadoPath: ESTADO, ahora: AHORA })).not.toThrow();
    db = openDb(TEST_DB);
  });
});
