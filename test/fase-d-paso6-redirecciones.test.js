// Fase D, paso 6: las pantallas viejas (Matcher, Identidad de productos, Guardia ML, Bandeja de identidad)
// son stubs de redirección a /catalogo-vinculos/. Ninguna URL vieja da 404 y no quedan enlaces a ellas en public/.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const RAIZ = path.resolve(import.meta.dirname, '..', 'public');
const VIEJAS = ['matcher', 'identidad-productos', 'guardia-ml', 'bandeja-identidad'];

// Ejecuta el <script> de redirección con un `location` falso y devuelve a dónde habría ido.
function destinoDe(html, pathname) {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const script = scripts.find((s) => s.includes('location.replace'));
  let destino = null;
  const location = { pathname, replace: (u) => { destino = u; } };
  vm.runInNewContext(script, { location });
  return destino;
}

describe('Fase D paso 6: stubs de redirección', () => {
  for (const carpeta of VIEJAS) {
    describe(carpeta, () => {
      const archivo = path.join(RAIZ, carpeta, 'index.html');
      const html = fs.existsSync(archivo) ? fs.readFileSync(archivo, 'utf8') : '';

      it('el index.html existe (la URL vieja no da 404)', () => {
        expect(fs.existsSync(archivo)).toBe(true);
      });

      it('es sólo un stub: sin pantalla vieja, sin fetch y con redirección en el <head>', () => {
        expect(html.length).toBeLessThan(2000);
        expect(html).not.toMatch(/fetch\(/);
        expect(html.indexOf('location.replace')).toBeLessThan(html.indexOf('<body'));
        expect(html).toMatch(/<noscript><meta http-equiv="refresh" content="0;url=\.\.\/catalogo-vinculos\/"><\/noscript>/);
      });

      it('redirige a catalogo-vinculos conservando el prefijo, con y sin barra final', () => {
        expect(destinoDe(html, `/herramientas/${carpeta}/`)).toBe('/herramientas/catalogo-vinculos/');
        expect(destinoDe(html, `/herramientas/${carpeta}`)).toBe('/herramientas/catalogo-vinculos/');
        expect(destinoDe(html, `/${carpeta}/`)).toBe('/catalogo-vinculos/');
      });
    });
  }

  it('ningún archivo de public/ enlaza a las URLs viejas (fuera de los stubs y de sus carpetas)', () => {
    const archivos = [];
    const recorrer = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) recorrer(p);
        else if (/\.(html|js|css|json|webmanifest)$/.test(e.name)) archivos.push(p);
      }
    };
    recorrer(RAIZ);
    const viejas = new RegExp(`herramientas/(${VIEJAS.join('|')})/|['"\`(]/?(${VIEJAS.join('|')})/['"\`)]`);
    const hallazgos = [];
    for (const a of archivos) {
      const rel = path.relative(RAIZ, a);
      if (VIEJAS.some((c) => rel.startsWith(c + path.sep))) continue;
      const lineas = fs.readFileSync(a, 'utf8').split('\n');
      lineas.forEach((l, i) => { if (viejas.test(l)) hallazgos.push(`${rel}:${i + 1}`); });
    }
    expect(hallazgos).toEqual([]);
  });
});
