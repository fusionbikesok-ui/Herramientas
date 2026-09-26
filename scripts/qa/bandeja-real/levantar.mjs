#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import express from 'express';
import pg from '../../../plataforma/node_modules/pg/esm/index.mjs';
import pino from '../../../plataforma/node_modules/pino/pino.js';
import { migrar } from '../../../plataforma/src/db/migrar.ts';
import { crearApi } from '../../../plataforma/src/api/app.ts';
import { crearPool } from '../../../plataforma/src/db/pool.ts';
import { crearOrigenes, firmar } from '../../../plataforma/src/seguridad/interna.ts';
import { bandejaIdentidadRouter } from '../../../routes/bandejaIdentidad.js';
import { cargarKeyringInternoActivo } from '../../../lib/internoHmac.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const image = 'postgres@sha256:1c59e2c3c818eaa0f0628f695b36e7c9e362d6b219b36a54a32df645cbd7e1af';
const name = `bandeja-real-${process.pid}`;
const stateDir = mkdtempSync(path.join(tmpdir(), 'bandeja-real-'));
const pgKey = path.join(stateDir, 'keyring.json');
let container;
let api; let legacy; let pool; let database;

const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const freePort = () => new Promise((resolve, reject) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); s.on('error', reject); });
const sqlIdent = (v) => { if (!/^[a-z0-9_]+$/.test(v)) throw new Error('identificador inválido'); return v; };

async function seed(url) {
  const c = new pg.Client({ connectionString: url }); await c.connect();
  try {
    const company = (await c.query("INSERT INTO core.companies(legal_name) VALUES ('QA Bandeja Real') RETURNING id")).rows[0].id;
    const ml = (await c.query("INSERT INTO core.channel_accounts(company_id,channel,external_account,is_primary) VALUES ($1,'mercadolibre','qa-real',true) RETURNING id", [company])).rows[0].id;
    const woo = (await c.query("INSERT INTO core.channel_accounts(company_id,channel,external_account,is_primary) VALUES ($1,'woocommerce','qa-real',true) RETURNING id", [company])).rows[0].id;
    const tipos = ['sin_candidatos','sku_pendiente','atributo_divergente','user_product_divergente','con_3_candidatos','confirmable','conflicto'];
    for (let i = 0; i < 14; i++) {
      const qa = tipos[i % tipos.length]; const titulo = `QA ${qa} ${i + 1}`; const sku = qa === 'confirmable' || i % 3 === 0 ? `FB-${9000 + i}` : null;
      const model = (await c.query("INSERT INTO catalog.product_models(company_id,channel_account_id,origen,clave_origen,titulo) VALUES ($1,$2,'woo_simple',$3,$4) RETURNING id", [company, woo, `QA-${i}`, titulo])).rows[0].id;
      const variant = (await c.query('INSERT INTO catalog.sellable_variants(company_id,model_id,sku) VALUES ($1,$2,$3) RETURNING id', [company, model, sku])).rows[0].id;
      await c.query("INSERT INTO catalog.external_representations(company_id,channel_account_id,canal,tipo,recurso,variacion_normalizada,variant_id,sku_observado,estado_remoto,stock_canal,precio,moneda,titulo_observado,user_product_id) VALUES ($1,$2,'mercadolibre','vendible',$3,'',$4,$5,'active',$6,175000,'ARS',$7,$8)", [company, ml, `MLAQA${i + 1}`, variant, sku ?? `OBS-${i}`, i % 4 === 0 ? 0 : 3, titulo, `UP-${Math.floor(i / 2)}`]);
      const rep = (await c.query('SELECT id FROM catalog.external_representations WHERE recurso=$1', [`MLAQA${i + 1}`])).rows[0].id;
      const tipo = qa === 'conflicto' ? 'decision_en_conflicto' : ['atributo_divergente', 'user_product_divergente'].includes(qa) ? qa : 'sku_pendiente';
      const detalle = { qa_tipo: qa, ...(qa === 'conflicto' ? { conflicto: true } : {}), ...(qa === 'atributo_divergente' ? { atributos: { color: ['azul', 'negro'] } } : {}) };
      const caso = (await c.query('INSERT INTO catalog.identity_cases(company_id,tipo,variant_id,representation_id,estado,detalle,abierto_en) VALUES ($1,$2,$3,$4,$5,$6,now()-($7||\' hours\')::interval) RETURNING id', [company, tipo, variant, rep, qa === 'conflicto' ? 'conflict' : 'actionable', JSON.stringify(detalle), String(i)])).rows[0].id;
      await c.query("INSERT INTO catalog.model_images(model_id,representation_id,url,orden,observado_en) VALUES ($1,$2,$3,1,now())", [model, rep, `/fotos/c${i + 1}-800x${i % 2 ? 600 : 1000}.svg`]).catch(() => {});
      if (qa !== 'sin_candidatos' && qa !== 'confirmable') {
        const n = qa === 'con_3_candidatos' ? 3 : 1;
        const runId = randomUUID();
        for (let rank = 1; rank <= n; rank++) {
          const cm = (await c.query("INSERT INTO catalog.product_models(company_id,channel_account_id,origen,clave_origen,titulo) VALUES ($1,$2,'woo_simple',$3,$4) RETURNING id", [company, woo, `QC-${i}-${rank}`, `${titulo} candidato ${rank}`])).rows[0].id;
          const cv = (await c.query('INSERT INTO catalog.sellable_variants(company_id,model_id,sku) VALUES ($1,$2,$3) RETURNING id', [company, cm, `FB-${10000 + i * 10 + rank}`])).rows[0].id;
          const wrep = (await c.query("INSERT INTO catalog.external_representations(company_id,channel_account_id,canal,tipo,recurso,variacion_normalizada,variant_id,sku_observado,estado_remoto,stock_canal,precio,moneda,titulo_observado) VALUES ($1,$2,'woocommerce','vendible',$3,'',$4,$5,'active',4,169000,'ARS',$6) RETURNING id", [company, woo, `WQA-${i}-${rank}`, cv, `FB-${10000 + i * 10 + rank}`, `QA candidato ${rank}`])).rows[0].id;
          await c.query('INSERT INTO catalog.model_images(model_id,representation_id,url,orden,observado_en) VALUES ($1,$2,$3,1,now())', [cm, wrep, `/fotos/c${i + 1}-800x${rank === 2 ? 400 : 600}.svg`]);
          await c.query('INSERT INTO catalog.identity_candidates(case_id,run_id,variant_id,rank,puntaje,explicacion,engine_version) VALUES ($1,$2,$3,$4,$5,$6,\'qa-real\')', [caso, runId, cv, rank, 0.8 - rank / 10, JSON.stringify({ atributos: [{ nombre: 'marca', estado: rank === 1 ? 'coincide' : 'difiere', valorCandidato: 'Shimano', valorMl: 'Shimano' }] })]);
        }
      }
      await c.query("INSERT INTO catalog.identity_evidence(case_id,fuente,campos) VALUES ($1,'ml',$2)", [caso, JSON.stringify({ qa_tipo: qa, foto: `/fotos/ml-${i + 1}-1200x900.svg` })]);
    }
  } finally { await c.end(); }
}

async function levantar() {
  container = name; docker('run', '-d', '--rm', '--name', name, '-e', 'POSTGRES_PASSWORD=admin', '-p', '127.0.0.1::5432', image);
  for (let i = 0; i < 60; i++) { try { docker('exec', name, 'pg_isready', '-U', 'postgres', '-q'); break; } catch { await new Promise(r => setTimeout(r, 1000)); } }
  await new Promise(r => setTimeout(r, 2500));
  const port = docker('port', name, '5432/tcp').split(':').pop(); const adminUrl = `postgres://postgres:admin@127.0.0.1:${port}/postgres`;
  const a = new pg.Client({ connectionString: adminUrl }); await a.connect();
  await a.query("CREATE ROLE plataforma_migrador LOGIN PASSWORD 'migrador' NOSUPERUSER NOCREATEDB NOCREATEROLE"); await a.query("CREATE ROLE plataforma_app LOGIN PASSWORD 'app' NOSUPERUSER NOCREATEDB NOCREATEROLE");
  database = `bandeja_${process.pid}`; sqlIdent(database); await a.query(`CREATE DATABASE ${database} OWNER plataforma_migrador`); await a.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`); await a.query(`GRANT CONNECT ON DATABASE ${database} TO plataforma_app`); await a.end();
  const migratorUrl = `postgres://plataforma_migrador:migrador@127.0.0.1:${port}/${database}`; const appUrl = `postgres://plataforma_app:app@127.0.0.1:${port}/${database}`;
  await migrar(migratorUrl, path.join(root, 'plataforma/migrations')); await seed(migratorUrl);
  const key = randomBytes(32); const keyring = { activeKeyId: 'qa', keys: { qa: key } }; writeFileSync(pgKey, JSON.stringify({ activeKeyId: 'qa', keys: { qa: key.toString('base64') } })); chmodSync(pgKey, 0o600);
  pool = crearPool(appUrl); const apiPort = await freePort(); api = crearApi({ pool, logger: pino({ level: 'warn' }), estadoPgDir: stateDir, senales: { keyring, origenes: crearOrigenes('127.0.0.1/32'), cuentas: new Map([['mercadolibre', (await pool.query("SELECT id FROM core.channel_accounts WHERE channel='mercadolibre'")).rows[0].id]]) }, bandejaCatalogo: true }); await api.listen({ host: '127.0.0.1', port: apiPort });
  const legacyPort = await freePort(); const app = express(); app.use(express.json()); app.get('/api/auth/me', (_q, r) => r.json({ ok: true, is_admin: true, usuario: 'qa-real', permisos: ['matcher'] })); app.use('/api/bandeja-identidad', bandejaIdentidadRouter({ url: `http://127.0.0.1:${apiPort}`, keyring: cargarKeyringInternoActivo(pgKey) }));
  app.get('/fotos/:archivo', (req, res) => { const m = req.params.archivo.match(/^(?:c\d+|ml-\d+)-(\d+)x(\d+)\.svg$/); if (!m) return res.sendStatus(404); const [, w, h] = m; res.type('image/svg+xml').send(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#9cc"/><circle cx="50%" cy="50%" r="25%" fill="#345"/></svg>`); });
  app.use('/herramientas', express.static(path.join(root, 'public'))); legacy = app.listen(legacyPort, '127.0.0.1', () => console.log(`Bandeja real: http://127.0.0.1:${legacyPort}/herramientas/bandeja-identidad/`));
  writeFileSync(path.join(stateDir, 'estado.json'), JSON.stringify({ legacyPort, apiPort, pgPort: port, container: name, keyring: pgKey }));
  console.log(JSON.stringify({ url: `http://127.0.0.1:${legacyPort}/herramientas/bandeja-identidad/`, state: path.join(stateDir, 'estado.json') }));
}

async function apagar() { try { if (legacy) legacy.close(); if (api) await api.close(); if (pool) await pool.end(); } finally { try { docker('rm', '-f', '-v', name); } catch {} } }
process.on('SIGINT', () => apagar().finally(() => process.exit(0))); process.on('SIGTERM', () => apagar().finally(() => process.exit(0)));
if (process.argv[2] === 'apagar') { for (const n of docker('ps', '-a', '--format', '{{.Names}}').split('\n').filter((x) => x.startsWith('bandeja-real-'))) docker('rm', '-f', '-v', n); } else { await levantar(); }
