import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crearPool } from '../../src/db/pool.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';
import { vueltaDeInformes } from '../../src/informes/vuelta.ts';
import { verificar } from '../../src/informes/firma.ts';
import { limpiar, sembrar } from '../soporte/fixtures.ts';

// Un par de claves por archivo: la vuelta firma con la privada y el test verifica con la pública.
const PAR = generateKeyPairSync('ed25519');
const crearClaveDePrueba = () => PAR.privateKey;
const PUBLICAS = { k1: PAR.publicKey.export({ type: 'spki', format: 'pem' }).toString() };

describe('vueltaDeInformes', () => {
  let base: BaseDePrueba; let pool: ReturnType<typeof crearPool>; let admin: ReturnType<typeof crearPool>; let dir: string;
  let subidas: Array<{ clave: string; cuerpo: string; retener: Date }>; let emails: Array<{ asunto: string }>;
  let cfg: Parameters<typeof vueltaDeInformes>[1];

  beforeAll(async () => { base = await crearBaseDePrueba(); pool = crearPool(base.urlApp); admin = crearPool(base.urlAdmin); await sembrar(pool); });
  afterAll(async () => { await pool.end(); await admin.end(); await base.borrar(); });
  beforeEach(async () => {
    // Sin limpiar, el primer caso deja el día cerrado y los siguientes no ejercitan ningún camino.
    await limpiar(admin, ['informes.entregas', 'integrations.reconciliation_signals']);
    dir = mkdtempSync(join(tmpdir(), 'vuelta-'));
    subidas = []; emails = [];
    cfg = {
      clave: { kid: 'k1', privada: crearClaveDePrueba() },
      deposito: {
        async subir(clave: string, cuerpo: string, ahora: Date) {
          const retener = new Date(ahora.getTime() + 367 * 86400e3);
          subidas.push({ clave, cuerpo, retener });
          return { versionId: 'v1', retencion: retener.toISOString() };
        },
        async consultar() { return null; },
        async guardarPendiente(_c: string, _b: string) { return join(dir, 'p.json'); },
        async limpiarPendiente() {},
      },
      correo: { async enviar(m) { emails.push(m); } },
      datosClave: { kid: 'k1', huella: 'AAAA', ubicacion: 'docs/.../firma-informes.pub' },
    };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('genera, firma, sube y avisa los dos artefactos del día', async () => {
    const r = await vueltaDeInformes(pool, cfg, new Date('2026-09-17T10:00:00Z'));
    expect(r.hechos).toEqual(['manifiesto:2026-09-16', 'reporte:2026-09-16']);
    expect(subidas.map((s) => s.clave)).toEqual(['e1/manifiestos/2026-09-16.json', 'e1/reportes/2026-09-16.json']);
    expect(emails).toHaveLength(1);
    expect(verificar(JSON.parse(subidas[1]!.cuerpo), PUBLICAS).valido).toBe(true);
    const filas = (await pool.query(`SELECT tipo, estado_deposito, estado_aviso FROM informes.entregas ORDER BY tipo`)).rows;
    expect(filas).toEqual([
      { tipo: 'manifiesto', estado_deposito: 'subido', estado_aviso: 'avisado' },
      { tipo: 'reporte', estado_deposito: 'subido', estado_aviso: 'avisado' },
    ]);
  });

  it('correrla dos veces no sube ni manda de nuevo', async () => {
    await vueltaDeInformes(pool, cfg, new Date('2026-09-17T10:00:00Z'));
    const r = await vueltaDeInformes(pool, cfg, new Date('2026-09-17T10:05:00Z'));
    expect(r.hechos).toEqual([]);
    expect(subidas).toHaveLength(2);
    expect(emails).toHaveLength(1);
  });

  it('si B2 falla, el email igual sale y la subida queda pendiente y reintentable', async () => {
    cfg.deposito.subir = async () => { throw new Error('sin red'); };
    const r = await vueltaDeInformes(pool, cfg, new Date('2026-09-17T10:00:00Z'));
    expect(r.fallados).toContain('manifiesto:2026-09-16');
    expect(emails).toHaveLength(1);
    const fila = (await pool.query(`SELECT estado_deposito, estado_aviso, intentos_deposito, ruta_pendiente FROM informes.entregas WHERE tipo='manifiesto'`)).rows[0];
    // El aviso salió, pero la subida sigue en 'firmado': es lo que el plan viejo daba por terminado.
    expect(fila).toMatchObject({ estado_deposito: 'firmado', estado_aviso: 'avisado', intentos_deposito: 1 });
    expect(fila.ruta_pendiente).not.toBeNull();
  });

  it('la vuelta siguiente reintenta sólo la subida pendiente, sin re-avisar', async () => {
    cfg.deposito.subir = async () => { throw new Error('sin red'); };
    await vueltaDeInformes(pool, cfg, new Date('2026-09-17T10:00:00Z'));
    subidas = [];
    cfg.deposito.subir = async (clave: string, cuerpo: string, ahora: Date) => {
      subidas.push({ clave, cuerpo, retener: ahora }); return { versionId: 'v2', retencion: ahora.toISOString() };
    };
    await vueltaDeInformes(pool, cfg, new Date('2026-09-17T11:00:00Z'));
    expect(subidas).toHaveLength(2);
    expect(emails).toHaveLength(1);
    const filas = (await pool.query(`SELECT estado_deposito FROM informes.entregas`)).rows;
    expect(filas.every((f) => f.estado_deposito === 'subido')).toBe(true);
  });

  it('el pendiente en disco se limpia sólo después de confirmar la subida', async () => {
    const limpiados: string[] = [];
    cfg.deposito.limpiarPendiente = async (ruta: string) => { limpiados.push(ruta); };
    cfg.deposito.subir = async () => { throw new Error('sin red'); };
    await vueltaDeInformes(pool, cfg, new Date('2026-09-17T10:00:00Z'));
    expect(limpiados).toHaveLength(0);
  });

  it('ante una subida en duda consulta en lugar de volver a subir', async () => {
    cfg.deposito.subir = async () => { throw new Error('timeout'); };
    cfg.deposito.consultar = async () => ({ versionId: 'v9', retencion: '2027-09-18T00:00:00Z', modo: 'COMPLIANCE' });
    await vueltaDeInformes(pool, cfg, new Date('2026-09-17T10:00:00Z'));
    const fila = (await pool.query(`SELECT estado_deposito, b2_version_id FROM informes.entregas WHERE tipo='manifiesto'`)).rows[0];
    expect(fila).toMatchObject({ estado_deposito: 'subido', b2_version_id: 'v9' });
  });

  it('recupera varios días caídos, del más viejo al más nuevo', async () => {
    await pool.query(`INSERT INTO informes.entregas
      (tipo, fecha, estado_deposito, estado_aviso, hash_contenido, b2_object_key, b2_version_id, retention_until)
      VALUES ('reporte','2026-09-13','subido','avisado', repeat('a',64), 'e1/reportes/2026-09-13.json','v1','2027-09-20T00:00:00Z'),
             ('manifiesto','2026-09-13','subido','avisado', repeat('a',64), 'e1/manifiestos/2026-09-13.json','v1','2027-09-20T00:00:00Z')`);
    const r = await vueltaDeInformes(pool, cfg, new Date('2026-09-17T10:00:00Z'));
    expect(r.hechos.filter((h) => h.startsWith('reporte'))).toEqual(['reporte:2026-09-14', 'reporte:2026-09-15', 'reporte:2026-09-16']);
  });

  it('informa las entregas que llevan más de 24 h sin subir', async () => {
    cfg.deposito.subir = async () => { throw new Error('sin red'); };
    await vueltaDeInformes(pool, cfg, new Date('2026-09-17T10:00:00Z'));
    await pool.query(`UPDATE informes.entregas SET generado_en = '2026-09-16T04:00:00Z'`);
    const r = await vueltaDeInformes(pool, cfg, new Date('2026-09-17T10:10:00Z'));
    // La plataforma no abre incidentes: los expone y el legado los convierte en alerta (tarea 11).
    expect(r.atrasadas.map((a) => `${a.tipo}:${a.fecha}`)).toContain('manifiesto:2026-09-16');
  });
});
