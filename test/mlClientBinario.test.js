// mlFetchBinario (PDF de etiquetas de ML): opciones de axios, Content-Type, errores JSON y tope de tamaño.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';

vi.mock('axios', async () => {
  const actual = await vi.importActual('axios');
  return { default: { ...actual.default, post: vi.fn(), request: vi.fn() } };
});
import axios from 'axios';
import { _resetPresupuestoParaTests } from '../lib/mlRateLimiter.js';

const TEST_DB = `./test/tmp-mlclient-binario.${process.pid}.sqlite`;
const ML_CFG = { clientId: 'c', clientSecret: 's', userId: '999' };
const RUTA = '/shipment_labels?shipment_ids=1&response_type=pdf';
let db;

beforeEach(() => {
  vi.resetModules();
  axios.request.mockReset();
  fs.rmSync(TEST_DB, { force: true });
  db = new Database(TEST_DB);
  db.exec('CREATE TABLE ml_oauth_token (id INTEGER PRIMARY KEY, access_token TEXT, refresh_token TEXT, expires_at TEXT, actualizado_en TEXT)');
  db.prepare("INSERT INTO ml_oauth_token (id, access_token, refresh_token, expires_at, actualizado_en) VALUES (1,'tok','ref',?,?)")
    .run(new Date(Date.now() + 4 * 3600 * 1000).toISOString(), new Date().toISOString());
});
afterEach(() => { _resetPresupuestoParaTests(); db.close(); fs.rmSync(TEST_DB, { force: true }); });

describe('mlFetchBinario', () => {
  it('pide arraybuffer con timeout 20 s y tope 15 MB, mismo token; devuelve el PDF como Buffer', async () => {
    const { mlFetchBinario } = await import('../lib/mlClient.js');
    const pdf = Buffer.from('%PDF-1.4 x');
    axios.request.mockResolvedValue({ status: 200, headers: { 'content-type': 'application/pdf' }, data: pdf });
    const r = await mlFetchBinario(db, ML_CFG, RUTA, { manual: true });
    expect(r.buffer.equals(pdf)).toBe(true);
    const cfg = axios.request.mock.calls[0][0];
    expect(cfg).toMatchObject({ responseType: 'arraybuffer', timeout: 20000, maxContentLength: 15 * 1024 * 1024 });
    expect(cfg.headers.Authorization).toBe('Bearer tok');
  });

  it('exige Content-Type application/pdf: un 200 con otra cosa no devuelve buffer', async () => {
    const { mlFetchBinario } = await import('../lib/mlClient.js');
    axios.request.mockResolvedValue({ status: 200, headers: { 'content-type': 'text/html' }, data: Buffer.from('<html>') });
    const r = await mlFetchBinario(db, ML_CFG, RUTA, { manual: true });
    expect(r.buffer).toBeNull();
    expect(r.error).toBeTruthy();
  });

  it('un error JSON de ML (400) llega como texto en `error`, nunca como buffer', async () => {
    const { mlFetchBinario } = await import('../lib/mlClient.js');
    axios.request.mockResolvedValue({ status: 400, headers: { 'content-type': 'application/json' }, data: Buffer.from('{"error":"not_printable_status"}') });
    const r = await mlFetchBinario(db, ML_CFG, RUTA, { manual: true });
    expect(r).toMatchObject({ status: 400, buffer: null });
    expect(r.error).toContain('not_printable_status');
  });

  it('un PDF por encima del tope no se entrega', async () => {
    const { mlFetchBinario } = await import('../lib/mlClient.js');
    axios.request.mockResolvedValue({ status: 200, headers: { 'content-type': 'application/pdf' }, data: Buffer.alloc(15 * 1024 * 1024 + 1) });
    const r = await mlFetchBinario(db, ML_CFG, RUTA, { manual: true });
    expect(r.buffer).toBeNull();
  });
});
