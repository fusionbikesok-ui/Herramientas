// Regresión: /inventario usaba window.Scanner pero nunca cargaba lib/scanner.js,
// así que el botón de cámara tiraba TypeError y la cámara no abría nunca.
// Este test fija la invariante para cualquier página con cámara, presente o futura.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PUBLIC_DIR = join(process.cwd(), 'public');

function paginasConScanner() {
  return readdirSync(PUBLIC_DIR)
    .map((d) => ({ dir: d, file: join(PUBLIC_DIR, d, 'index.html') }))
    .filter(({ dir, file }) => {
      if (dir === 'lib' || dir === 'vendor') return false;
      try { return statSync(file).isFile(); } catch { return false; }
    })
    .map(({ dir, file }) => ({ dir, html: readFileSync(file, 'utf8') }))
    .filter(({ html }) => /window\.Scanner\b/.test(html));
}

describe('páginas con escaneo por cámara', () => {
  const paginas = paginasConScanner();

  it('hay al menos una página con cámara (si no, el test se volvió inútil)', () => {
    expect(paginas.length).toBeGreaterThan(0);
  });

  it.each(paginas.map((p) => p.dir))('%s carga lib/scanner.js como módulo', (dir) => {
    const { html } = paginas.find((p) => p.dir === dir);
    expect(html).toMatch(/<script[^>]+type="module"[^>]+src="[^"]*lib\/scanner\.js"/);
  });

  it.each(paginas.map((p) => p.dir))('%s tiene el <video> con autoplay/playsinline/muted', (dir) => {
    const { html } = paginas.find((p) => p.dir === dir);
    const tag = html.match(/<video[^>]*id="cam-video"[^>]*>/);
    expect(tag, 'falta <video id="cam-video">').not.toBeNull();
    // playsinline evita que iOS abra el video a pantalla completa; autoplay+muted
    // cubren los navegadores donde el play() programático de scanner.js es rechazado.
    for (const attr of ['autoplay', 'playsinline', 'muted']) {
      expect(tag[0]).toContain(attr);
    }
  });
});
