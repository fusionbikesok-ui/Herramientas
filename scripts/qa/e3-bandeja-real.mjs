#!/usr/bin/env node
/*
 * scripts/qa/e3-bandeja-real.mjs — QA E3 corte 1: la pantalla de la bandeja contra la plataforma REAL
 * (Fastify + Postgres en Docker), pasando por el proxy firmado del legado. Sin mocks del API.
 * Uso: node --experimental-strip-types scripts/qa/e3-bandeja-real.mjs   (Docker y Playwright instalados)
 * Todo es efímero: el contenedor se borra con `rm -f -v` y se verifica que no queden volúmenes suyos.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { chromium } from 'playwright';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const P = (r) => path.join(RAIZ, 'plataforma', r);
const { default: pg } = await import(P('node_modules/pg/lib/index.js'));
const { crearApi } = await import(P('src/api/app.ts'));
const { crearLogger } = await import(P('src/comun/logger.ts'));
const { crearPool } = await import(P('src/db/pool.ts'));
const { crearOrigenes } = await import(P('src/seguridad/interna.ts'));
const { migrar } = await import(P('src/db/migrar.ts'));
const { bandejaIdentidadRouter } = await import(path.join(RAIZ, 'routes/bandejaIdentidad.js'));

const IMAGEN = 'postgres@sha256:1c59e2c3c818eaa0f0628f695b36e7c9e362d6b219b36a54a32df645cbd7e1af';
const NOMBRE = `qa-e3-${process.pid}`;
const docker = (...a) => execFileSync('docker', a, { encoding: 'utf8' }).trim();
const ok = []; const bad = [];
const chk = (n, c, x = '') => { (c ? ok : bad).push(n); console.log(c ? 'ok   ' : 'FALLA', n, c ? '' : x); };

let volumenes = []; let srvApi; let srvLegado; let pool; let admin; let navegador;
try {
  docker('run', '-d', '--rm', '--name', NOMBRE, '-e', 'POSTGRES_PASSWORD=admin', '-p', '127.0.0.1::5432', IMAGEN);
  volumenes = docker('inspect', '-f', '{{range .Mounts}}{{.Name}} {{end}}', NOMBRE).split(' ').filter(Boolean);
  for (let i = 0; i < 60; i++) { try { docker('exec', NOMBRE, 'pg_isready', '-U', 'postgres', '-q'); break; } catch { await new Promise((r) => setTimeout(r, 1000)); } }
  await new Promise((r) => setTimeout(r, 1500));
  const puerto = docker('port', NOMBRE, '5432/tcp').split(':').pop();
  for (const s of ["CREATE ROLE plataforma_migrador LOGIN PASSWORD 'migrador' NOSUPERUSER", "CREATE ROLE plataforma_app LOGIN PASSWORD 'app' NOSUPERUSER",
    'CREATE DATABASE qa OWNER plataforma_migrador', 'REVOKE ALL ON DATABASE qa FROM PUBLIC', 'GRANT CONNECT ON DATABASE qa TO plataforma_app']) {
    docker('exec', NOMBRE, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-qc', s);
  }
  const url = (u, p) => `postgres://${u}:${p}@127.0.0.1:${puerto}/qa`;
  await migrar(url('plataforma_migrador', 'migrador'), path.join(RAIZ, 'plataforma/migrations'));
  admin = crearPool(url('postgres', 'admin'), { max: 2 }); pool = crearPool(url('plataforma_app', 'app'), { max: 4 });
  const q = async (sql, p = []) => (await admin.query(sql, p)).rows;

  // ── datos ──
  const empresa = (await q("insert into core.companies(legal_name) values ('F') returning id"))[0].id;
  const ml = (await q("insert into core.channel_accounts(company_id,channel,external_account) values ($1,'mercadolibre','x') returning id", [empresa]))[0].id;
  let n = 0;
  const modeloVar = async (titulo, sku, origen = 'ml_simple') => {
    n++;
    const m = (await q(`INSERT INTO catalog.product_models (company_id, channel_account_id, origen, clave_origen, titulo) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [empresa, ml, origen, `c${n}`, titulo]))[0].id;
    const v = (await q('INSERT INTO catalog.sellable_variants (company_id, model_id, sku) VALUES ($1,$2,$3) RETURNING id', [empresa, m, sku]))[0].id;
    return { m, v };
  };
  const destinos = [];
  for (let i = 1; i <= 8; i++) destinos.push((await modeloVar(`Casco Woo ${i}`, `FB-${900 + i}`, 'woo_simple')).v);
  const casos = [];
  for (let i = 1; i <= 4; i++) {
    const { m, v } = await modeloVar(`Casco ML ${i}`, null);
    await q(`INSERT INTO catalog.external_representations (company_id, channel_account_id, canal, tipo, recurso, variacion_normalizada, variant_id, model_id, estado_remoto, stock_canal)
             VALUES ($1,$2,'mercadolibre','vendible',$3,'',$4,$5,'active',3)`, [empresa, ml, `MLA${i}`, v, m]);
    const id = (await q(`INSERT INTO catalog.identity_cases (company_id, tipo, variant_id, estado, abierto_en) VALUES ($1,'sku_pendiente',$2,'actionable', now() - ($3 || ' minutes')::interval) RETURNING id`, [empresa, v, String(10 - i)]))[0].id;
    const run = randomUUID();
    for (let r = 1; r <= 3; r++) await q(`INSERT INTO catalog.identity_candidates (case_id, run_id, variant_id, rank, puntaje, engine_version) VALUES ($1,$2,$3,$4,$5,'qa')`, [id, run, destinos[(i + r) % 8], r, 0.9 - r * 0.2]);
    casos.push({ id, recurso: `MLA${i}`, top1: destinos[(i + 1) % 8] });
  }

  // ── plataforma real + legado real (proxy firmado) ──
  const clave = randomBytes(32); const keyring = { activeKeyId: 'k1', keys: { k1: clave } };
  const api = crearApi({ pool, logger: crearLogger('qa'), estadoPgDir: '/nada', senales: { keyring, origenes: crearOrigenes('127.0.0.1/32'), cuentas: new Map([['mercadolibre', ml]]) }, bandejaCatalogo: true });
  await api.listen({ port: 0, host: '127.0.0.1' }); srvApi = api;
  const urlApi = `http://127.0.0.1:${api.server.address().port}`;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: 'jose', is_admin: false }; next(); });
  app.get('/api/auth/me', (_q, r) => r.json({ ok: true, is_admin: false, permisos: [{ herramienta: 'matcher', nivel: 'escritura' }] }));
  app.use('/api/bandeja-identidad', bandejaIdentidadRouter({ url: urlApi, keyring }));
  app.use(express.static(path.join(RAIZ, 'public')));
  srvLegado = http.createServer(app); await new Promise((r) => srvLegado.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srvLegado.address().port}/bandeja-identidad/`;

  // ── navegador ──
  navegador = await chromium.launch();
  const page = await (await navegador.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const errores = []; page.on('pageerror', (e) => errores.push(e.message)); page.on('console', (m) => m.type() === 'error' && errores.push(m.text()));
  page.on('response', async (r) => { if (r.url().includes('/api/')) console.log('  http', r.status(), r.url().replace(/^https?:\/\/[^/]+/, ''), r.status() >= 400 ? (await r.text()).slice(0, 200) : ''); });
  await page.goto(base);
  await page.waitForSelector('#btn-vincular', { timeout: 10000 }).catch(async () => { console.log((await page.locator('body').innerText()).slice(0, 400)); });
  await page.waitForTimeout(1500);
  const texto = await page.locator('body').innerText();
  chk('carga la cola real y muestra el primer caso', /Casco ML|MLA/.test(texto), texto.slice(0, 200));

  // elegir candidato 1 con la tecla "1" y decidir; luego verificar en la base
  await page.keyboard.press('1'); await page.waitForTimeout(300);
  await page.keyboard.press('Enter'); await page.waitForTimeout(1500);
  let ds = await q("SELECT recurso, eleccion, variant_id, origen, actor FROM catalog.identity_decisions WHERE origen='humano' ORDER BY creado_en");
  chk('la decisión quedó en la base con el actor de la sesión (jose)', ds.length === 1 && ds[0].actor === 'jose' && ds[0].eleccion === 'vincular', JSON.stringify(ds));
  const decidido = (await q("SELECT c.estado, c.version FROM catalog.identity_cases c WHERE c.id = (SELECT case_id FROM catalog.identity_decisions WHERE origen='humano' LIMIT 1)"))[0];
  chk('el caso avanzó de versión y salió de actionable', decidido && decidido.version >= 2 && decidido.estado !== 'actionable', JSON.stringify(decidido));
  const repVinc = (await q("SELECT er.variant_id FROM catalog.external_representations er WHERE er.recurso = $1", [ds[0]?.recurso]))[0];
  chk('la publicación quedó vinculada a la variante elegida', repVinc && repVinc.variant_id === ds[0]?.variant_id, JSON.stringify(repVinc));

  // deshacer dentro de la ventana
  await page.keyboard.press('z'); await page.waitForTimeout(1500);
  ds = await q("SELECT eleccion, supersede_a IS NOT NULL AS rev, superada_en IS NOT NULL AS sup FROM catalog.identity_decisions WHERE origen='humano' ORDER BY creado_en");
  chk('deshacer: la original queda superada y hay una reversión que apunta a ella', ds.length === 2 && ds[0].sup && ds[1].rev, JSON.stringify(ds));

  // omitir el caso siguiente con "o" si existe atajo; si no, botón
  const omitir = page.locator('#btn-omitir');
  if (await omitir.count()) { await omitir.click(); await page.waitForTimeout(1500); }
  ds = await q("SELECT eleccion FROM catalog.identity_decisions WHERE origen='humano' AND supersede_a IS NULL ORDER BY creado_en");
  chk('omitir queda registrado', ds.some((d) => d.eleccion === 'omitir'), JSON.stringify(ds));
  chk('sin errores de consola ni excepciones', errores.length === 0, errores.join(' | '));
  await page.screenshot({ path: '/tmp/claude-0/e3-bandeja-real.png' });
  console.log(`\n${ok.length} ok, ${bad.length} fallas`);
} finally {
  await navegador?.close().catch(() => {});
  await srvApi?.close().catch(() => {}); srvLegado?.close();
  await pool?.end().catch(() => {}); await admin?.end().catch(() => {});
  try { docker('rm', '-f', '-v', NOMBRE); } catch { /* ya no existe */ }
  const vivos = new Set(docker('volume', 'ls', '-q').split('\n'));
  const huerf = volumenes.filter((v) => vivos.has(v));
  if (huerf.length) { console.log('volúmenes huérfanos:', huerf); bad.push('volumen'); }
}
process.exit(bad.length ? 1 : 0);
