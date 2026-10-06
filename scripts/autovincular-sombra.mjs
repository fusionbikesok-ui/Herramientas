#!/usr/bin/env node
/**
 * Auto-vinculación en MODO SOMBRA: arma la propuesta de publicaciones de ML cuyo `seller_sku`
 * (FB-…) existe en Woo y todavía no tienen una identidad activa. NO escribe nada:
 *  - abre la base en solo lectura (`readonly: true`), así que ni por error puede escribir;
 *  - no crea vínculos, decisiones, casos ni operaciones.
 * Produce un Markdown con el resumen, la clasificación (segura / revisar) y una muestra
 * reproducible de N filas para que una persona la revise.
 *
 * `--db` es obligatorio y absoluto (un data/fusion.sqlite relativo depende del cwd y ya nos mordió).
 *
 * Uso: node scripts/autovincular-sombra.mjs --db /ruta/absoluta/fusion.sqlite [--muestra 20] [--seed 20261006] [--incluir-pausadas] [--out informe.md]
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { contradiccionDeClave } from '../lib/contradiccionTitulo.js';

const args = process.argv.slice(2);
const valor = (flag) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null; };
const salir = (msg) => { console.error(`${msg} No se hizo nada.`); process.exit(2); };

const ruta = valor('--db');
if (!ruta) salir('--db es obligatorio (ruta absoluta de la base).');
if (!path.isAbsolute(ruta)) salir(`--db debe ser una ruta absoluta (recibí "${ruta}").`);
const tamMuestra = Number(valor('--muestra') ?? 20);
const seed = Number(valor('--seed') ?? 20261006);
if (!Number.isInteger(tamMuestra) || tamMuestra < 1) salir('--muestra inválida.');

// Generador determinista (mulberry32): la misma semilla da la misma muestra.
function rng(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const db = new Database(ruta, { readonly: true, fileMustExist: true });

const filas = db.prepare(`SELECT p.clave, p.item_id, p.status, p.titulo, p.seller_sku, p.gtin, p.available_quantity AS stock_ml
  FROM ml_publicaciones_cache p
  WHERE p.seller_sku LIKE 'FB-%'
    AND EXISTS (SELECT 1 FROM catalogo_cache w WHERE w.sku = p.seller_sku)
    AND NOT EXISTS (SELECT 1 FROM identidades_canal i WHERE i.external_key = p.clave AND i.activa = 1)
    AND NOT EXISTS (SELECT 1 FROM sku_matcher_decisiones d WHERE d.clave = p.clave AND d.accion = 'omitir')
  ORDER BY p.clave`).all();

const wooPorSku = db.prepare('SELECT id_woo, nombre, stock, gtin FROM catalogo_cache WHERE sku=? ORDER BY stock ASC, id_woo ASC');
const pubsConSku = db.prepare("SELECT COUNT(*) n FROM ml_publicaciones_cache WHERE seller_sku=? AND status IN ('active','paused')");
const caso = db.prepare("SELECT clasificacion, estado FROM identidad_casos WHERE ml_key=? AND estado<>'resuelto' ORDER BY id DESC LIMIT 1");
const decision = db.prepare("SELECT sku, accion FROM sku_matcher_decisiones WHERE clave=? AND accion='confirmar'");

const norm = (g) => String(g ?? '').replace(/\D/g, '');
const propuesta = filas.map((f) => {
  const woo = wooPorSku.all(f.seller_sku);
  const w = woo[0];
  const motivos = [];
  const contra = contradiccionDeClave(db, f.clave, f.seller_sku);
  if (contra.contradice) motivos.push(`título contradice a Woo (${(contra.motivos || []).join(', ') || 'sin detalle'})`);
  if (woo.length > 1) motivos.push(`el SKU está en ${woo.length} productos de Woo`);
  const gMl = norm(f.gtin); const gWoo = norm(w.gtin);
  if (gMl && gWoo && gMl !== gWoo) motivos.push('GTIN de ML distinto al de Woo');
  const nPubs = pubsConSku.get(f.seller_sku).n;
  if (nPubs > 1) motivos.push(`${nPubs} publicaciones de ML comparten este SKU`);
  const c = caso.get(f.clave);
  if (c) motivos.push(`caso de identidad abierto (${c.clasificacion}/${c.estado})`);
  const d = decision.get(f.clave);
  if (d && d.sku !== f.seller_sku) motivos.push(`decisión previa confirmada con otro SKU (${d.sku})`);
  return { ...f, woo_id: w.id_woo, woo_nombre: w.nombre, woo_stock: w.stock, categoria: motivos.length ? 'revisar' : 'segura', motivos };
});

const segura = propuesta.filter((p) => p.categoria === 'segura');
const revisar = propuesta.filter((p) => p.categoria === 'revisar');
const porEstado = (arr, st) => arr.filter((p) => p.status === st).length;

// Muestra estratificada y reproducible: mitad de seguras, mitad de a revisar (si alcanzan).
// Por defecto sale de las ACTIVAS (son las que hoy venden); --incluir-pausadas suma las pausadas.
const incluirPausadas = args.includes('--incluir-pausadas');
const candidatas = (arr) => arr.filter((p) => incluirPausadas || p.status === 'active');
function elegir(arr, n, azar) {
  const copia = [...arr];
  for (let i = copia.length - 1; i > 0; i--) { const j = Math.floor(azar() * (i + 1)); [copia[i], copia[j]] = [copia[j], copia[i]]; }
  return copia.slice(0, n);
}
const azar = rng(seed);
const nRevisar = Math.min(candidatas(revisar).length, Math.floor(tamMuestra / 2));
const muestra = [...elegir(candidatas(segura), tamMuestra - nRevisar, azar), ...elegir(candidatas(revisar), nRevisar, azar)];

const esc = (t) => String(t ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const lineas = [];
lineas.push('# Auto-vinculación en modo sombra: propuesta', '');
lineas.push(`Generado en solo lectura desde \`${path.basename(ruta)}\`. **No se escribió ningún vínculo, decisión, caso ni operación.**`, '');
lineas.push('Universo: publicaciones de ML con `seller_sku` FB-… que existe en Woo, sin identidad activa y sin decisión «omitir».', '');
lineas.push('| | Total | Activas | Pausadas |', '|---|---:|---:|---:|');
lineas.push(`| Universo | ${propuesta.length} | ${porEstado(propuesta, 'active')} | ${porEstado(propuesta, 'paused')} |`);
lineas.push(`| Seguras (sin ninguna señal de riesgo) | ${segura.length} | ${porEstado(segura, 'active')} | ${porEstado(segura, 'paused')} |`);
lineas.push(`| A revisar | ${revisar.length} | ${porEstado(revisar, 'active')} | ${porEstado(revisar, 'paused')} |`, '');
const conteoMotivos = new Map();
for (const p of revisar) for (const m of p.motivos) { const k = m.replace(/\(.*\)/, '').replace(/\d+/g, 'N').trim(); conteoMotivos.set(k, (conteoMotivos.get(k) || 0) + 1); }
if (conteoMotivos.size) {
  lineas.push('Motivos para revisar (una fila puede tener varios):', '');
  for (const [k, n] of [...conteoMotivos].sort((a, b) => b[1] - a[1])) lineas.push(`- ${k}: ${n}`);
  lineas.push('');
}
lineas.push(`## Muestra de ${muestra.length} para revisar (semilla ${seed}, reproducible, ${incluirPausadas ? 'activas y pausadas' : 'solo activas'})`, '');
lineas.push('| # | Estado | Clave ML | Título en ML | SKU | Producto en Woo | Stock ML / Woo | Veredicto |', '|---:|---|---|---|---|---|---|---|');
muestra.forEach((p, i) => {
  lineas.push(`| ${i + 1} | ${p.status} | ${p.clave} | ${esc(p.titulo)} | ${p.seller_sku} | ${esc(p.woo_nombre)} (Woo ${p.woo_id}) | ${p.stock_ml ?? '?'} / ${p.woo_stock ?? '?'} | ${p.categoria === 'segura' ? 'segura' : 'revisar: ' + esc(p.motivos.join('; '))} |`);
});
lineas.push('', '## Qué falta para vincular de verdad', '- Que alguien revise la muestra y confirme el criterio de «segura».',
  '- La vinculación real va por Identidad (decisión con dueño, caso y operación), nunca desde este script.');
const texto = lineas.join('\n') + '\n';
const out = valor('--out');
if (out) { fs.writeFileSync(out, texto); console.log(`escrito ${out}: universo ${propuesta.length}, seguras ${segura.length}, a revisar ${revisar.length}`); }
else process.stdout.write(texto);
db.close();
