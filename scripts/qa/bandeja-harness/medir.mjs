import { createRequire } from 'node:module';
const require = createRequire('/opt/fusionbikes/herramientas/');
const { chromium } = require('playwright');
const OUT = process.argv[2];
const b = await chromium.launch({ executablePath: '/opt/google/chrome/chrome', args: ['--no-sandbox'] });
const nombres = ['1-sin-candidatos', '2-sku-pendiente', '3-atributo-divergente', '4-user-product-divergente', '5-tres-candidatos'];
const res = [];
for (const [w, h] of [[1440, 900], [1280, 800]]) {
  const ctx = await b.newContext({ viewport: { width: w, height: h } });
  const p = await ctx.newPage();
  await p.goto('http://127.0.0.1:3457/herramientas/bandeja-identidad/');
  await p.waitForSelector('.caso-titulo');
  for (let i = 0; i < 5; i++) {
    await p.waitForTimeout(300);
    const m = await p.evaluate(() => {
      const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height), w: Math.round(b.width) }; };
      const scr = [document.scrollingElement, ...document.querySelectorAll('*')].filter((e) => e.scrollHeight > e.clientHeight + 2 && /(auto|scroll)/.test(getComputedStyle(e).overflowY) || e === document.scrollingElement);
      const cont = document.querySelector('#root').closest('main,.caso') || document.querySelector('#root');
      const imgs = [...document.querySelectorAll('.matriz img')].map((im) => { const b = im.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), nat: im.naturalWidth + 'x' + im.naturalHeight }; });
      const fotoTd = [...document.querySelectorAll('.foto-sin-disponible')].map((e) => e.textContent);
      const btns = {}; ['btn-vincular', 'btn-apartar', 'btn-omitir-ahora', 'btn-buscar', 'btn-no-existe', 'btn-no-vincular'].forEach((id) => { btns[id] = r('#' + id); });
      const cortados = [...document.querySelectorAll('.matriz *, .cand *')].filter((e) => e.children.length === 0 && e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflow !== 'visible').length;
      const barra = [...document.querySelectorAll('header, .topbar, .filtros, #filtros, .chips')].map((e) => Math.round(e.getBoundingClientRect().height));
      return { vh: innerHeight, docH: document.documentElement.scrollHeight, scrollers: scr.map((e) => (e.id || e.className || e.tagName) + ':' + e.scrollHeight + '/' + e.clientHeight), matriz: r('.matriz'), cands: r('.candidatos'), acciones: r('.acciones'), btns, imgs, fotoTd, cortados, barra, filasMatriz: document.querySelectorAll('.matriz .fila').length };
    });
    m.caso = nombres[i]; m.vp = `${w}x${h}`;
    res.push(m);
    await p.screenshot({ path: `${OUT}/${w}x${h}-${nombres[i]}-pliegue.png` });
    // página completa: expandir el contenedor con scroll interno
    const full = await p.evaluate(() => { const s = [...document.querySelectorAll('*')].find((e) => e.scrollHeight > e.clientHeight + 2 && /(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.id !== 'ayuda-dialog'); return s ? { h: s.scrollHeight } : { h: document.documentElement.scrollHeight }; });
    m.fullH = full.h;
    await p.setViewportSize({ width: w, height: Math.max(h, full.h + 200) });
    await p.waitForTimeout(150);
    await p.screenshot({ path: `${OUT}/${w}x${h}-${nombres[i]}-completa.png` });
    await p.setViewportSize({ width: w, height: h });
    await p.waitForTimeout(150);
    await p.keyboard.press('j');
  }
  await ctx.close();
}
await b.close();
console.log(JSON.stringify(res, null, 1));
