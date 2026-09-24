import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { crearPool } from '../../src/db/pool.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';
import { sembrar } from '../soporte/fixtures.ts';
import { verificar } from '../../src/informes/firma.ts';
import { publicarCorreccion, COMMIT_FIX } from '../../src/informes/correccion.ts';
import type { Deposito } from '../../src/informes/deposito.ts';

const PAR = generateKeyPairSync('ed25519');
const PUBLICAS = { k1: PAR.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('publicarCorreccion', () => {
  // audit.audit_events es append-only (TRUNCATE rechazado a propósito): cada test arranca con una
  // base de prueba propia, no se comparte ni se limpia entre casos.
  let base: BaseDePrueba; let pool: ReturnType<typeof crearPool>; let admin: ReturnType<typeof crearPool>;
  let companyId: string;
  let b2: Map<string, { cuerpo: string; versionId: string; retencion: string }>;
  let subidas: Array<{ clave: string; cuerpo: string }>;
  let deposito: Deposito;
  let reloj: Date;

  beforeEach(async () => {
    base = await crearBaseDePrueba(); pool = crearPool(base.urlApp); admin = crearPool(base.urlAdmin);
    companyId = (await sembrar(pool)).companyId;
    b2 = new Map(); subidas = [];
    reloj = new Date('2026-09-24T12:00:00Z');
    deposito = {
      async guardarPendiente(clave, cuerpo) { return `/tmp/${clave.replace(/\//g, '_')}`; },
      async subir(clave, cuerpo) {
        subidas.push({ clave, cuerpo });
        const versionId = `v${b2.size + 1}`;
        const retencion = new Date(reloj.getTime() + 367 * 86_400_000).toISOString();
        b2.set(clave, { cuerpo, versionId, retencion });
        return { versionId, retencion };
      },
      async consultar(clave) {
        const o = b2.get(clave);
        return o ? { versionId: o.versionId, retencion: o.retencion, modo: 'COMPLIANCE', sha256: sha256(o.cuerpo) } : null;
      },
      async versiones() { return { oculto: false, versionRetenida: null }; },
      async limpiarPendiente() {},
    };
  });
  afterEach(async () => { await pool.end(); await admin.end(); await base.borrar(); });

  // Inserta una fila de manifiesto con un last_hash EXPLÍCITO (correcto o deliberadamente incorrecto), sin
  // pasar por armarManifiesto: lo que importa acá es la reconciliación contra audit_events, no rearmar el día.
  async function insertarEvento(fecha: string): Promise<{ chainSeq: string; hash: string }> {
    const r = await pool.query<{ chain_seq: string; hash: string }>(
      `INSERT INTO audit.audit_events
         (company_id, actor_type, actor_id, action, aggregate_type, aggregate_id, correlation_id, occurred_at)
       VALUES ($1, 'system', 'test', 'prueba.a', 'prueba', '1', gen_random_uuid(), $2)
       RETURNING chain_seq, encode(hash, 'hex') AS hash`,
      [companyId, `${fecha}T15:00:00Z`],
    );
    return { chainSeq: r.rows[0]!.chain_seq, hash: r.rows[0]!.hash };
  }

  async function insertarManifiesto(fecha: string, lastChainSeq: string, lastHashHex: string, objectKey = `e1/manifiestos/${fecha}.json`) {
    await pool.query(
      `INSERT INTO audit.audit_daily_manifests
         (manifest_date, first_chain_seq, last_chain_seq, last_hash, event_count, signature, signing_key_id,
          b2_object_key, b2_version_id, retention_mode, retention_until)
       VALUES ($1, $2, $2, decode($3,'hex'), 1, '\\x00', 'k1', $4, 'v-original', 'compliance', now() + interval '1 year')`,
      [fecha, lastChainSeq, lastHashHex, objectKey],
    );
  }

  it('incluye sólo los días donde el hash declarado no coincide con el correcto', async () => {
    const e1 = await insertarEvento('2026-09-19');
    await insertarManifiesto('2026-09-19', e1.chainSeq, e1.hash); // declarado = correcto: no debe aparecer
    const e2 = await insertarEvento('2026-09-20');
    await insertarManifiesto('2026-09-20', e2.chainSeq, sha256('otra-cosa')); // declarado ≠ correcto: sí aparece

    const r = await publicarCorreccion(pool, {
      fechas: ['2026-09-19', '2026-09-20'], clave: { kid: 'k1', privada: PAR.privateKey }, deposito, reloj: () => reloj, companyId,
      dryRun: false,
    });

    expect(r.publicado).toBe(true);
    expect(r.dias.map((d) => d.fecha)).toEqual(['2026-09-20']);
    expect(r.dias[0]!.hash_declarado).toBe(sha256('otra-cosa'));
    expect(r.dias[0]!.hash_correcto).toBe(e2.hash);
    expect(r.dias[0]!.b2_object_key_original).toBe('e1/manifiestos/2026-09-20.json');
  });

  it('si todos los días declarados coinciden con el correcto, no publica nada', async () => {
    const e1 = await insertarEvento('2026-09-19');
    await insertarManifiesto('2026-09-19', e1.chainSeq, e1.hash);

    const r = await publicarCorreccion(pool, {
      fechas: ['2026-09-19'], clave: { kid: 'k1', privada: PAR.privateKey }, deposito, reloj: () => reloj, companyId, dryRun: false,
    });

    expect(r.publicado).toBe(false);
    expect(r.dias).toEqual([]);
    expect(subidas).toEqual([]);
  });

  it('nunca escribe sobre la clave de un manifiesto original: sube bajo correcciones/<fecha-emisión>-manifiestos.json', async () => {
    const e1 = await insertarEvento('2026-09-19');
    await insertarManifiesto('2026-09-19', e1.chainSeq, sha256('mal'));

    await publicarCorreccion(pool, {
      fechas: ['2026-09-19'], clave: { kid: 'k1', privada: PAR.privateKey }, deposito, reloj: () => reloj, companyId, dryRun: false,
    });

    expect(subidas).toHaveLength(1);
    expect(subidas[0]!.clave).toMatch(/^correcciones\/2026-09-24-manifiestos\.json$/);
    expect(subidas[0]!.clave).not.toBe('e1/manifiestos/2026-09-19.json');
  });

  it('la firma del JSON de corrección verifica con la clave pública', async () => {
    const e1 = await insertarEvento('2026-09-19');
    await insertarManifiesto('2026-09-19', e1.chainSeq, sha256('mal'));

    await publicarCorreccion(pool, {
      fechas: ['2026-09-19'], clave: { kid: 'k1', privada: PAR.privateKey }, deposito, reloj: () => reloj, companyId, dryRun: false,
    });

    const sobre = JSON.parse(subidas[0]!.cuerpo);
    const v = verificar(sobre, PUBLICAS);
    expect(v.valido).toBe(true);
    expect((v.contenido as { tipo: string }).tipo).toBe('correccion_manifiesto');
    expect((v.contenido as { commit_fix: string }).commit_fix).toBe(COMMIT_FIX);
  });

  it('es idempotente: si ya existe una corrección publicada para las mismas fechas, no publica otra', async () => {
    const e1 = await insertarEvento('2026-09-19');
    await insertarManifiesto('2026-09-19', e1.chainSeq, sha256('mal'));

    const r1 = await publicarCorreccion(pool, {
      fechas: ['2026-09-19'], clave: { kid: 'k1', privada: PAR.privateKey }, deposito, reloj: () => reloj, companyId, dryRun: false,
    });
    expect(r1.publicado).toBe(true);
    expect(subidas).toHaveLength(1);

    const r2 = await publicarCorreccion(pool, {
      fechas: ['2026-09-19'], clave: { kid: 'k1', privada: PAR.privateKey }, deposito, reloj: () => reloj, companyId, dryRun: false,
    });
    expect(r2.publicado).toBe(false);
    if (r2.publicado) throw new Error('inalcanzable'); // narrowing para TS
    expect(r2.motivo).toBe('ya_publicada');
    expect(subidas).toHaveLength(1); // no subió una segunda vez
  });

  it('dry-run (por defecto) no firma, no sube ni registra nada, sólo arma el JSON', async () => {
    const e1 = await insertarEvento('2026-09-19');
    await insertarManifiesto('2026-09-19', e1.chainSeq, sha256('mal'));

    const antes = await pool.query('SELECT count(*)::int AS n FROM audit.audit_events');
    const r = await publicarCorreccion(pool, {
      fechas: ['2026-09-19'], clave: { kid: 'k1', privada: PAR.privateKey }, deposito, reloj: () => reloj, companyId,
      dryRun: true,
    });

    expect(r.publicado).toBe(false);
    if (r.publicado) throw new Error('inalcanzable'); // narrowing para TS
    expect(r.motivo).toBe('dry_run');
    expect(r.dias).toHaveLength(1);
    expect(subidas).toEqual([]);
    const despues = await pool.query('SELECT count(*)::int AS n FROM audit.audit_events');
    expect(despues.rows[0]!.n).toBe(antes.rows[0]!.n);
  });
});
