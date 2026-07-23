import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

// public/lib/api.js es un script CLÁSICO (no ESM): se carga con <script src=...>
// y engancha window.Api de forma síncrona. El proyecto corre vitest en entorno
// 'node' (sin jsdom, ver test/scannerZoomState.test.js), así que lo cargamos con
// vm + un objeto `window` falsificado a mano, igual que se hace con scanner.js.
//
// Objetivo: confirmar que installAuth() centraliza el manejo de 401 —
// cualquier fetch que resuelva con status 401 debe redirigir a
// /herramientas/login/?next=... y NO dejar que la promesa original resuelva
// con la respuesta 401 (para que las páginas no muestren un error crudo).

const API_JS_PATH = path.join(process.cwd(), 'public/lib/api.js');
const SOURCE = fs.readFileSync(API_JS_PATH, 'utf8');

function loadApiWithFakeWindow({ fetchImpl, pathname = '/matcher/', search = '' }) {
  const fakeWindow = {
    location: { pathname, search, href: '' },
    fetch: fetchImpl,
  };
  const sandbox = { window: fakeWindow };
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox);
  return { Api: sandbox.window.Api, fakeWindow };
}

describe('public/lib/api.js — installAuth', () => {
  it('redirige a login cuando el fetch responde 401 y no resuelve con la respuesta cruda', async () => {
    const fetchImpl = () => Promise.resolve({ status: 401 });
    const { Api, fakeWindow } = loadApiWithFakeWindow({
      fetchImpl,
      pathname: '/matcher/',
      search: '?foo=1',
    });

    Api.installAuth();

    let resolved = false;
    let timedOut = false;
    const fetchPromise = fakeWindow.fetch('/api/matcher/decisiones').then(() => {
      resolved = true;
    });
    // La promesa de 401 nunca debe resolver (se corta la cadena a propósito).
    await Promise.race([
      fetchPromise,
      new Promise((resolve) => setTimeout(() => {
        timedOut = true;
        resolve();
      }, 20)),
    ]);

    expect(resolved).toBe(false);
    expect(timedOut).toBe(true);
    expect(fakeWindow.location.href).toBe(
      '/herramientas/login/?next=' + encodeURIComponent('/matcher/?foo=1'),
    );
  });

  it('deja pasar respuestas no-401 sin redirigir', async () => {
    const fetchImpl = () => Promise.resolve({ status: 200, body: 'ok' });
    const { Api, fakeWindow } = loadApiWithFakeWindow({ fetchImpl });

    Api.installAuth();
    const res = await fakeWindow.fetch('/api/woo/catalogo');

    expect(res.status).toBe(200);
    expect(fakeWindow.location.href).toBe('');
  });

  it('agrega el header Authorization: Basic cookie-session a cada request', async () => {
    let capturedOpts;
    const fetchImpl = (_url, opts) => {
      capturedOpts = opts;
      return Promise.resolve({ status: 200 });
    };
    const { Api, fakeWindow } = loadApiWithFakeWindow({ fetchImpl });

    Api.installAuth();
    await fakeWindow.fetch('/api/woo/catalogo', {});

    expect(capturedOpts.headers.Authorization).toBe('Basic cookie-session');
  });
});
