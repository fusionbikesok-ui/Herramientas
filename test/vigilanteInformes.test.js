import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import fs from 'node:fs';
import { openDb } from '../db/index.js';
import { firmarInterno } from '../lib/internoHmac.js';
import { anunciarVigilanteApagado, revisarInformeDelDia, RUTA_ESTADO_INFORMES } from '../lib/vigilanteInformes.js';

const TEST_DB = './test/vigilante-informes.sqlite';
const clave = crypto.randomBytes(32);
const keyring = { activeKeyId: 'k1', keys: { k1: clave } };
const ahora = new Date('2026-09-17T12:30:00Z'); // 09:30 ART: el día esperado es el 16
const responde = (cuerpo) => vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => cuerpo });
const activos = (db, tipo) => db.prepare(
  "SELECT COUNT(*) n FROM incidentes_operativos WHERE proceso='vigilante_informes' AND tipo_error=? AND estado='activo'").get(tipo).n;

describe('revisarInformeDelDia', () => {
  let db;
  beforeEach(() => { db = openDb(TEST_DB); });
  afterEach(() => { db.close(); if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('antes de las 09:00 ART no consulta nada', async () => {
    const f = vi.fn();
    expect(await revisarInformeDelDia(db, { url: 'http://x', keyring, fetch: f, ahora: new Date('2026-09-17T11:59:00Z') }))
      .toEqual({ estado: 'temprano' });
    expect(f).not.toHaveBeenCalled();
  });

  it('firma el GET con el HMAC interno y, con el informe al día, no abre nada', async () => {
    const f = responde({ ultimo: '2026-09-16', atrasadas: [] });
    expect(await revisarInformeDelDia(db, { url: 'http://x', keyring, fetch: f, ahora })).toMatchObject({ estado: 'ok' });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe(`http://x${RUTA_ESTADO_INFORMES}`);
    const h = init.headers;
    // La firma se verifica recalculándola: comparar sólo el formato dejaría pasar una firma mal armada.
    expect(h['x-fusion-signature']).toBe(firmarInterno(clave, h['x-fusion-timestamp'], h['x-fusion-nonce'], 'GET', RUTA_ESTADO_INFORMES, Buffer.alloc(0)));
    expect(db.prepare("SELECT COUNT(*) n FROM incidentes_operativos WHERE proceso='vigilante_informes'").get().n).toBe(0);
  });

  it('sin el informe del día abre un incidente crítico, una sola vez', async () => {
    const f = responde({ ultimo: '2026-09-14', atrasadas: [] });
    expect(await revisarInformeDelDia(db, { url: 'http://x', keyring, fetch: f, ahora })).toMatchObject({ estado: 'falta', esperado: '2026-09-16' });
    await revisarInformeDelDia(db, { url: 'http://x', keyring, fetch: f, ahora });
    expect(activos(db, 'informe_faltante')).toBe(1);
    expect(db.prepare("SELECT severidad FROM incidentes_operativos WHERE tipo_error='informe_faltante'").get().severidad).toBe('critico');
  });

  it('si nunca salió ningún informe también es un faltante', async () => {
    expect(await revisarInformeDelDia(db, { url: 'http://x', keyring, fetch: responde({ ultimo: null, atrasadas: [] }), ahora }))
      .toMatchObject({ estado: 'falta' });
  });

  it('con entregas atrasadas abre incidente aunque el informe del día exista', async () => {
    const f = responde({ ultimo: '2026-09-16', atrasadas: [{ tipo: 'manifiesto', fecha: '2026-09-15' }] });
    expect(await revisarInformeDelDia(db, { url: 'http://x', keyring, fetch: f, ahora })).toMatchObject({ estado: 'atrasadas' });
    expect(activos(db, 'entregas_atrasadas')).toBe(1);
  });

  it('un informe oculto en B2 abre incidente, y se cierra cuando vuelve a estar a la vista', async () => {
    // Verificado contra B2 real el 2026-09-18: la credencial de escritura puede ocultar un objeto. No lo
    // destruye, pero quien lo busque sin pedir la versión recibe 404: la evidencia deja de estar a la vista.
    const oculto = responde({ ultimo: '2026-09-16', atrasadas: [], ocultos: [{ tipo: 'reporte', fecha: '2026-09-15' }] });
    expect(await revisarInformeDelDia(db, { url: 'http://x', keyring, fetch: oculto, ahora })).toMatchObject({ estado: 'ocultos' });
    expect(activos(db, 'informes_ocultos')).toBe(1);
    const visible = responde({ ultimo: '2026-09-16', atrasadas: [], ocultos: [] });
    expect(await revisarInformeDelDia(db, { url: 'http://x', keyring, fetch: visible, ahora })).toMatchObject({ estado: 'ok' });
    expect(activos(db, 'informes_ocultos')).toBe(0);
  });

  it('una plataforma anterior a la migración 0012, sin `ocultos`, se sigue aceptando', async () => {
    const vieja = responde({ ultimo: '2026-09-16', atrasadas: [] });
    expect(await revisarInformeDelDia(db, { url: 'http://x', keyring, fetch: vieja, ahora })).toMatchObject({ estado: 'ok' });
  });

  it('un `ocultos` con forma inválida no se usa: se trata como plataforma sin respuesta', async () => {
    const rota = responde({ ultimo: '2026-09-16', atrasadas: [], ocultos: [{ tipo: 'otro', fecha: 'ayer' }] });
    expect(await revisarInformeDelDia(db, { url: 'http://x', keyring, fetch: rota, ahora })).toMatchObject({ estado: 'sin_respuesta' });
  });

  it('si la plataforma no responde, avisa y no lanza', async () => {
    const f = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await revisarInformeDelDia(db, { url: 'http://x', keyring, fetch: f, ahora })).toMatchObject({ estado: 'sin_respuesta' });
    expect(activos(db, 'plataforma_sin_respuesta')).toBe(1);
  });

  it('cuando todo vuelve a estar bien, cierra los incidentes que había abierto', async () => {
    await revisarInformeDelDia(db, { url: 'http://x', keyring, fetch: responde({ ultimo: '2026-09-14', atrasadas: [] }), ahora });
    expect(activos(db, 'informe_faltante')).toBe(1);
    await revisarInformeDelDia(db, { url: 'http://x', keyring, fetch: responde({ ultimo: '2026-09-16', atrasadas: [] }), ahora });
    expect(activos(db, 'informe_faltante')).toBe(0);
  });
});

describe('revisarInformeDelDia con una respuesta mal formada', () => {
  let db;
  beforeEach(() => { db = openDb(TEST_DB); });
  afterEach(() => { db.close(); if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('no la usa: la trata como una plataforma que no respondió bien', async () => {
    for (const cuerpo of [{ ultimo: 'zzzz', atrasadas: [] }, { ultimo: '2026-09-16', atrasadas: 'x' }, { ultimo: '2026-09-16', atrasadas: [{ tipo: 'otro', fecha: '2026-09-15' }] }]) {
      expect(await revisarInformeDelDia(db, { url: 'http://x', keyring, fetch: responde(cuerpo), ahora }), JSON.stringify(cuerpo))
        .toMatchObject({ estado: 'sin_respuesta' });
    }
  });
  it('si el vigilante no pudo arrancar, abre incidente crítico en lugar de callarse', () => {
    // Hallazgo alto de la revisión de T4: con el keyring ausente o inválido, server.js sólo registraba en
    // consola y abandonaba la instalación. Fallar en silencio es lo peor para el componente que existe para
    // avisar que la plataforma dejó de emitir.
    anunciarVigilanteApagado(db, 'keyring interno inválido: el archivo no existe');
    const inc = db.prepare("SELECT tipo_error, severidad, estado, contexto_json FROM incidentes_operativos WHERE proceso='vigilante_informes' AND tipo_error='vigilante_sin_configuracion'").get();
    expect(inc).toMatchObject({ severidad: 'critico', estado: 'activo' });
    expect(JSON.parse(inc.contexto_json).motivo).toMatch(/keyring interno inválido/);
  });

});
