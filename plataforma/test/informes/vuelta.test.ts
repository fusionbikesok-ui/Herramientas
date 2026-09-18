import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crearPool } from '../../src/db/pool.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';
import { vueltaDeInformes, type CfgInformes } from '../../src/informes/vuelta.ts';
import { verificar } from '../../src/informes/firma.ts';
import type { ObjetoB2 } from '../../src/informes/deposito.ts';
import { limpiar, sembrar } from '../soporte/fixtures.ts';

// Un par de claves por archivo: la vuelta firma con la privada y el test verifica con la pública.
const PAR = generateKeyPairSync('ed25519');
const PUBLICAS = { k1: PAR.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('vueltaDeInformes', () => {
  let base: BaseDePrueba; let pool: ReturnType<typeof crearPool>; let admin: ReturnType<typeof crearPool>; let dir: string;
  // B2 de juguete: clave → objeto. `subidas` cuenta cada PUT real.
  let b2: Map<string, ObjetoB2 & { cuerpo: string }>;
  let subidas: Array<{ clave: string; cuerpo: string }>;
  let emails: Array<{ asunto: string }>;
  let reloj: Date;
  let cfg: CfgInformes;

  beforeAll(async () => { base = await crearBaseDePrueba(); pool = crearPool(base.urlApp); admin = crearPool(base.urlAdmin); await sembrar(pool); });
  afterAll(async () => { await pool.end(); await admin.end(); await base.borrar(); });
  beforeEach(async () => {
    // Sin limpiar, el primer caso deja el día cerrado y los siguientes no ejercitan ningún camino.
    await limpiar(admin, ['informes.entregas', 'integrations.reconciliation_signals', 'audit.audit_daily_manifests', 'integrations.daily_shadow_reports']);
    dir = mkdtempSync(join(tmpdir(), 'vuelta-'));
    b2 = new Map(); subidas = []; emails = [];
    cfg = {
      clave: { kid: 'k1', privada: PAR.privateKey },
      reloj: () => reloj,
      deposito: {
        async subir(clave, cuerpo, ahora) {
          subidas.push({ clave, cuerpo });
          const retencion = new Date(ahora.getTime() + 367 * 86400e3).toISOString();
          b2.set(clave, { versionId: `v${subidas.length}`, retencion, modo: 'COMPLIANCE', sha256: sha(cuerpo), cuerpo });
          return { versionId: `v${subidas.length}`, retencion };
        },
        async consultar(clave) { return b2.get(clave) ?? null; },
        async versiones() { return { oculto: false, versionRetenida: 'v1' }; },
        async guardarPendiente() { return join(dir, 'p.json'); },
        async limpiarPendiente() {},
      },
      correo: { async enviar(m) { emails.push(m); } },
      datosClave: { kid: 'k1', huella: 'AAAA', ubicacion: 'docs/superpowers/specs/e1/firma-informes/k1.pub' },
    };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // `ahora` decide qué días se trabajan; el reloj del permiso avanza con él en estos casos.
  const correr = (ahora: string) => { reloj = new Date(ahora); return vueltaDeInformes(pool, cfg, new Date(ahora)); };

  it('genera, firma, sube y avisa los dos artefactos del día', async () => {
    const r = await correr('2026-09-17T10:00:00Z');
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

  it('E1-REC-01 escribe las tablas canónicas del tramo 1 con la versión real', async () => {
    await correr('2026-09-17T10:00:00Z');
    const m = (await pool.query(`SELECT b2_version_id, retention_mode, signing_key_id FROM audit.audit_daily_manifests`)).rows;
    expect(m).toEqual([{ b2_version_id: 'v1', retention_mode: 'compliance', signing_key_id: 'k1' }]);
    const r = (await pool.query(`SELECT b2_version_id, email_sent_at FROM integrations.daily_shadow_reports`)).rows;
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ b2_version_id: 'v2' });
    expect(r[0].email_sent_at).not.toBeNull();
  });

  it('repara la fila canónica si la entrega quedó subida sin registro del tramo 1', async () => {
    // Hallazgo crítico de la revisión del 2026-09-18: marcar `subido` y escribir la tabla canónica son dos
    // escrituras. Un corte entre ellas dejaba la entrega cerrada y avisada, sin registro canónico, y ninguna
    // vuelta posterior la reparaba porque salteaba el depósito. Se simula borrando la fila canónica.
    await correr('2026-09-17T10:00:00Z');
    await admin.query('DELETE FROM audit.audit_daily_manifests');
    await admin.query('DELETE FROM integrations.daily_shadow_reports');
    // La entrega sigue subida y avisada; la vuelta siguiente no sube ni manda, pero tiene que reponer el registro.
    const subidasAntes = subidas.length; const emailsAntes = emails.length;
    await correr('2026-09-17T10:30:00Z');
    expect(subidas).toHaveLength(subidasAntes);
    expect(emails).toHaveLength(emailsAntes);
    const m = (await pool.query(`SELECT b2_version_id FROM audit.audit_daily_manifests`)).rows;
    expect(m).toEqual([{ b2_version_id: 'v1' }]);
    const r = (await pool.query(`SELECT b2_version_id FROM integrations.daily_shadow_reports`)).rows;
    expect(r).toEqual([{ b2_version_id: 'v2' }]);
  });

  it('informa un informe cuyo objeto quedó OCULTO en B2', async () => {
    // Verificado contra B2 real el 2026-09-18: la credencial de escritura puede ocultar un objeto (en B2 el
    // permiso de escritura incluye ocultar). La versión retenida sobrevive, pero un cliente normal recibe 404,
    // así que hay que detectarlo. No se puede prevenir con permisos.
    await correr('2026-09-17T10:00:00Z');
    let ocultar = true;
    cfg.deposito.versiones = async (clave: string) => (ocultar && clave.includes('reportes')
      ? { oculto: true, versionRetenida: 'v2' }
      : { oculto: false, versionRetenida: 'v1' });
    const r = await correr('2026-09-17T10:30:00Z');
    expect(r.ocultos).toEqual([{ tipo: 'reporte', fecha: '2026-09-16', versionRetenida: 'v2' }]);
    ocultar = false;
    expect((await correr('2026-09-17T11:00:00Z')).ocultos).toEqual([]);
  });

  it('correrla dos veces no sube ni manda de nuevo', async () => {
    await correr('2026-09-17T10:00:00Z');
    const r = await correr('2026-09-17T10:05:00Z');
    expect(r.hechos).toEqual([]);
    expect(subidas).toHaveLength(2);
    expect(emails).toHaveLength(1);
  });

  it('E1-REC-01 si el proceso cayó después de que B2 aceptó la subida, la adopta en lugar de subir otra copia', async () => {
    // Primera vuelta: B2 acepta el PUT del manifiesto pero el proceso "se cae" antes de anotarlo.
    // La consulta previa encuentra vacío; después del PUT la red se corta y ya no se puede confirmar.
    const subirReal = cfg.deposito.subir;
    let cortada = false;
    cfg.deposito.subir = async (clave, cuerpo, ahora) => {
      await subirReal(clave, cuerpo, ahora);
      cortada = true;
      throw new Error('caída después del PUT');
    };
    cfg.deposito.consultar = async (clave) => {
      if (cortada) { cortada = false; throw new Error('red caída'); }
      return b2.get(clave) ?? null;
    };
    await correr('2026-09-17T10:00:00Z');
    expect(subidas).toHaveLength(2);
    // Vuelta siguiente, con todo sano: tiene que encontrar lo que ya está y no volver a subir.
    cfg.deposito.subir = subirReal;
    cfg.deposito.consultar = async (clave) => b2.get(clave) ?? null;
    await correr('2026-09-17T11:00:00Z');
    expect(subidas).toHaveLength(2);
    const filas = (await pool.query(`SELECT estado_deposito, b2_version_id FROM informes.entregas ORDER BY tipo`)).rows;
    expect(filas).toEqual([{ estado_deposito: 'subido', b2_version_id: 'v1' }, { estado_deposito: 'subido', b2_version_id: 'v2' }]);
  });

  it('E1-REC-01 si en B2 ya hay OTRO contenido para esa clave, no lo pisa y lo anota', async () => {
    b2.set('e1/manifiestos/2026-09-16.json', { versionId: 'vx', retencion: '2027-12-01T00:00:00Z', modo: 'COMPLIANCE', sha256: sha('otra cosa'), cuerpo: 'otra cosa' });
    const r = await correr('2026-09-17T10:00:00Z');
    expect(r.fallados).toContain('manifiesto:2026-09-16');
    expect(subidas.map((s) => s.clave)).toEqual(['e1/reportes/2026-09-16.json']);
    const fila = (await pool.query(`SELECT estado_deposito, ultimo_error FROM informes.entregas WHERE tipo = 'manifiesto'`)).rows[0];
    expect(fila.estado_deposito).toBe('firmado');
    expect(fila.ultimo_error).toMatch(/no se pisa/);
  });

  it('sin poder consultar B2 no sube a ciegas', async () => {
    cfg.deposito.consultar = async () => { throw new Error('timeout'); };
    const r = await correr('2026-09-17T10:00:00Z');
    expect(subidas).toHaveLength(0);
    expect(r.fallados).toEqual(['manifiesto:2026-09-16', 'reporte:2026-09-16']);
  });

  it('E1-REC-01 si B2 falla, el email igual sale y la subida queda pendiente y reintentable', async () => {
    cfg.deposito.subir = async () => { throw new Error('sin red'); };
    const r = await correr('2026-09-17T10:00:00Z');
    expect(r.fallados).toContain('manifiesto:2026-09-16');
    expect(emails).toHaveLength(1);
    const fila = (await pool.query(`SELECT estado_deposito, estado_aviso, intentos_deposito, ruta_pendiente FROM informes.entregas WHERE tipo='manifiesto'`)).rows[0];
    // El aviso salió, pero la subida sigue en 'firmado': es lo que el plan viejo daba por terminado.
    expect(fila).toMatchObject({ estado_deposito: 'firmado', estado_aviso: 'avisado', intentos_deposito: 1 });
    expect(fila.ruta_pendiente).not.toBeNull();
  });

  it('la vuelta siguiente, con el permiso vencido, reintenta sólo la subida pendiente, sin re-avisar', async () => {
    const subirReal = cfg.deposito.subir;
    cfg.deposito.subir = async () => { throw new Error('sin red'); };
    await correr('2026-09-17T10:00:00Z');
    cfg.deposito.subir = subirReal;
    await correr('2026-09-17T11:00:00Z');
    expect(subidas).toHaveLength(2);
    expect(emails).toHaveLength(1);
    const filas = (await pool.query(`SELECT estado_deposito FROM informes.entregas`)).rows;
    expect(filas.every((f) => f.estado_deposito === 'subido')).toBe(true);
  });

  it('con el permiso todavía vigente, otro proceso no retoma la entrega', async () => {
    cfg.deposito.subir = async () => { throw new Error('sin red'); };
    await correr('2026-09-17T10:00:00Z');
    // Cinco minutos después el permiso de 10 min sigue siendo del primero: nadie más la toca.
    await correr('2026-09-17T10:05:00Z');
    expect((await pool.query(`SELECT intentos_deposito FROM informes.entregas WHERE tipo='manifiesto'`)).rows[0].intentos_deposito).toBe(1);
  });

  it('si otro proceso ya mandó el email del día, el manifiesto se da por avisado sin mandar otro', async () => {
    // Simula un reparto de reclamos: el reporte ya quedó avisado por otro scheduler.
    await correr('2026-09-17T10:00:00Z');
    await admin.query(`UPDATE informes.entregas SET estado_aviso = 'pendiente', avisado_en = NULL, lease_hasta = NULL WHERE tipo = 'manifiesto'`);
    await admin.query(`UPDATE informes.entregas SET lease_hasta = now() + interval '1 day' WHERE tipo = 'reporte'`);
    emails = [];
    await correr('2026-09-17T11:00:00Z');
    expect(emails).toHaveLength(0);
    expect((await pool.query(`SELECT estado_aviso FROM informes.entregas WHERE tipo = 'manifiesto'`)).rows[0].estado_aviso).toBe('avisado');
  });

  it('recupera varios días caídos, del más viejo al más nuevo', async () => {
    await pool.query(`INSERT INTO informes.entregas
      (tipo, fecha, estado_deposito, estado_aviso, hash_contenido, b2_object_key, b2_version_id, retention_until)
      VALUES ('reporte','2026-09-13','subido','avisado', repeat('a',64), 'e1/reportes/2026-09-13.json','v1','2027-09-20T00:00:00Z'),
             ('manifiesto','2026-09-13','subido','avisado', repeat('a',64), 'e1/manifiestos/2026-09-13.json','v1','2027-09-20T00:00:00Z')`);
    const r = await correr('2026-09-17T10:00:00Z');
    expect(r.hechos.filter((h) => h.startsWith('reporte'))).toEqual(['reporte:2026-09-14', 'reporte:2026-09-15', 'reporte:2026-09-16']);
  });

  it('informa las entregas que llevan más de 24 h sin subir', async () => {
    cfg.deposito.subir = async () => { throw new Error('sin red'); };
    await correr('2026-09-17T10:00:00Z');
    await admin.query(`UPDATE informes.entregas SET generado_en = '2026-09-16T04:00:00Z'`);
    const r = await correr('2026-09-17T10:20:00Z');
    // La plataforma no abre incidentes: los expone y el legado los convierte en alerta (tarea 11).
    expect(r.atrasadas.map((a) => `${a.tipo}:${a.fecha}`)).toContain('manifiesto:2026-09-16');
  });
});
