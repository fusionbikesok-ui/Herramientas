// public/lib/format.js es un <script> clásico (no ESM: no usa `export`, se
// cuelga de `window` a propósito para poder cargarse en páginas que no son
// módulos). Para testearlo tal cual está, lo evaluamos en un sandbox de
// node:vm con un objeto `window` propio y extraemos las funciones de ahí,
// sin tocar el archivo de producción.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(__dirname, '../public/lib/format.js'), 'utf8');

function loadFmt() {
  const sandbox = {};
  sandbox.window = sandbox; // root = window = sandbox (así root.Fmt/root.esc quedan accesibles como sandbox.Fmt/sandbox.esc)
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'format.js' });
  return sandbox;
}

const { esc, money, fecha, n, pct, mlUrl, nick, Fmt } = loadFmt();

describe('format.js (Fmt)', () => {
  it('expone las funciones también agrupadas en window.Fmt', () => {
    expect(Fmt.esc).toBe(esc);
    expect(Fmt.money).toBe(money);
    expect(Fmt.fecha).toBe(fecha);
    expect(Fmt.n).toBe(n);
    expect(Fmt.pct).toBe(pct);
    expect(Fmt.mlUrl).toBe(mlUrl);
    expect(Fmt.nick).toBe(nick);
  });

  describe('esc', () => {
    it('escapa &, <, > y comillas dobles', () => {
      expect(esc('&<>"')).toBe('&amp;&lt;&gt;&quot;');
    });

    it('escapa comillas dobles dentro de un valor de atributo, evitando quebrar el HTML', () => {
      const valor = 'Bicicleta "Pro" 29"';
      const escapado = esc(valor);
      expect(escapado).toBe('Bicicleta &quot;Pro&quot; 29&quot;');
      expect(escapado).not.toContain('"');
    });

    it('con null devuelve string vacío', () => {
      expect(esc(null)).toBe('');
    });

    it('con undefined devuelve string vacío', () => {
      expect(esc(undefined)).toBe('');
    });

    it('convierte a string valores no-string (números)', () => {
      expect(esc(123)).toBe('123');
    });
  });

  describe('money', () => {
    it('con null devuelve el placeholder —', () => {
      expect(money(null)).toBe('—');
    });

    it('con undefined devuelve el placeholder —', () => {
      expect(money(undefined)).toBe('—');
    });

    it('formatea un número como moneda ARS sin decimales', () => {
      expect(money(1234)).toBe(
        Number(1234).toLocaleString('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 })
      );
    });

    it('formatea 0 como moneda (no como el placeholder, porque 0 !== null)', () => {
      expect(money(0)).toBe(
        Number(0).toLocaleString('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 })
      );
    });
  });

  describe('fecha', () => {
    it('con null devuelve el placeholder —', () => {
      expect(fecha(null)).toBe('—');
    });

    it('con string vacío devuelve el placeholder —', () => {
      expect(fecha('')).toBe('—');
    });

    it('formatea una fecha válida en es-AR (día/mes hora:min)', () => {
      const iso = '2026-03-15T10:30:00Z';
      expect(fecha(iso)).toBe(
        new Date(iso).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
      );
    });
  });

  describe('n', () => {
    it('formatea un número con separador de miles es-AR', () => {
      expect(n(1234567)).toBe((1234567).toLocaleString('es-AR'));
    });

    it('con 0 devuelve "0" (usa el default, pero el resultado es el mismo)', () => {
      expect(n(0)).toBe((0).toLocaleString('es-AR'));
    });

    it('con null/undefined usa 0 por defecto', () => {
      expect(n(null)).toBe((0).toLocaleString('es-AR'));
      expect(n(undefined)).toBe((0).toLocaleString('es-AR'));
    });
  });

  describe('pct', () => {
    it('con null devuelve el placeholder —', () => {
      expect(pct(null)).toBe('—');
    });

    it('con undefined devuelve el placeholder —', () => {
      expect(pct(undefined)).toBe('—');
    });

    it('positivo (suba de precio) muestra signo − (menos, por convención del helper) con 1 decimal', () => {
      // La convención del helper es: x > 0 → '−' (baja), x <= 0 → '+' (sube).
      expect(pct(0.10)).toBe('−10.0%');
    });

    it('negativo muestra signo + con el valor absoluto', () => {
      expect(pct(-0.25)).toBe('+25.0%');
    });

    it('cero se trata como no-positivo → signo +', () => {
      expect(pct(0)).toBe('+0.0%');
    });
  });

  describe('mlUrl', () => {
    it('arma la URL insertando un guión después del prefijo ML (MLA123 → MLA-123)', () => {
      expect(mlUrl('MLA123456789')).toBe('https://articulo.mercadolibre.com.ar/MLA-123456789');
    });

    it('funciona con otros prefijos de país (MLB, MLM, ...)', () => {
      expect(mlUrl('MLB987654321')).toBe('https://articulo.mercadolibre.com.ar/MLB-987654321');
    });

    it('con itemId null/undefined arma la URL con string vacío', () => {
      expect(mlUrl(null)).toBe('https://articulo.mercadolibre.com.ar/');
      expect(mlUrl(undefined)).toBe('https://articulo.mercadolibre.com.ar/');
    });
  });

  describe('nick', () => {
    it('parsea JSON con nickname y lo devuelve tal cual', () => {
      expect(nick('{"nickname":"COMPRADOR123"}')).toBe('COMPRADOR123');
    });

    it('sin nickname pero con id devuelve "ID <id>"', () => {
      expect(nick('{"id":555}')).toBe('ID 555');
    });

    it('con nickname vacío pero con id cae al id (nickname falsy)', () => {
      expect(nick('{"nickname":"","id":42}')).toBe('ID 42');
    });

    it('JSON inválido devuelve el placeholder —', () => {
      expect(nick('esto no es json')).toBe('—');
    });

    it('JSON válido pero sin nickname ni id devuelve el placeholder —', () => {
      expect(nick('{"otraCosa":true}')).toBe('—');
    });

    it('null (JSON.parse(null) => null) devuelve el placeholder —', () => {
      expect(nick(null)).toBe('—');
    });
  });
});
