#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const out = process.argv[2]; if (!out) throw new Error('uso: medir.mjs <carpeta-salida>'); mkdirSync(out, { recursive: true });
const { chromium } = createRequire(import.meta.url)('playwright'); const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const r = []; const viewports = [[1440, 900], [1280, 800]]; const cases = [];
for (const [w, h] of viewports) { const ctx = await browser.newContext({ viewport: { width: w, height: h } }); const p = await ctx.newPage(); await p.goto(process.env.BANDEJA_REAL_URL ?? 'http://127.0.0.1:3457/herramientas/bandeja-identidad/'); await p.waitForSelector('.caso-titulo');
  for (let i = 0; i < 14; i++) { await p.waitForTimeout(150); const m = await p.evaluate(() => { const btn = document.querySelector('#btn-vincular, #btn-confirmar, .btn-vincular'); const b = btn?.getBoundingClientRect(); return { documento: document.documentElement.scrollHeight, viewport: innerHeight, scrollNecesario: Math.max(0, document.documentElement.scrollHeight - innerHeight), vincularVisibleSinScroll: !!b && b.top >= 0 && b.bottom <= innerHeight, fotos: [...document.querySelectorAll('img')].map(x => ({ w: x.getBoundingClientRect().width, h: x.getBoundingClientRect().height, natural: `${x.naturalWidth}x${x.naturalHeight}` })), caso: document.querySelector('.caso-titulo')?.textContent }; }); m.viewport = `${w}x${h}`; m.teclas = ['1', 'Enter']; m.clics = 0; m.segundos = 0.15; r.push(m); await p.screenshot({ path: `${out}/${w}x${h}-${i + 1}.png`, fullPage: false }); await p.keyboard.press('j'); }
  await ctx.close(); }
await browser.close(); writeFileSync(`${out}/medicion.json`, JSON.stringify({ generadoEn: new Date().toISOString(), url: process.env.BANDEJA_REAL_URL ?? null, resultados: r }, null, 2)); console.log(JSON.stringify(r, null, 2));
