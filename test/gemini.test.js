import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { llamarGemini, geminiRouter } from '../routes/gemini.js';

vi.mock('axios');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('llamarGemini', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

  it('posts payload to Gemini endpoint with key as query param and returns parsed text', async () => {
    axios.post.mockResolvedValue({
      status: 200,
      data: { candidates: [{ content: { parts: [{ text: '[{"ok":true}]' }] } }] }
    });
    const result = await llamarGemini('KEY123', { contents: [] });
    expect(axios.post).toHaveBeenCalledWith(
      expect.stringContaining('key=KEY123'),
      { contents: [], generationConfig: { responseMimeType: 'application/json' } },
      expect.any(Object)
    );
    expect(result).toBe('[{"ok":true}]');
  });

  // BUG5 (piloto Pedalar #205): dos 503 seguidos de Gemini tiraban abajo la extracción entera.
  it('reintenta con backoff ante un 503 y devuelve el resultado del intento que sí funciona', { timeout: 10000 }, async () => {
    axios.post
      .mockResolvedValueOnce({ status: 503, data: {} })
      .mockResolvedValueOnce({ status: 200, data: { candidates: [{ content: { parts: [{ text: 'ok' }] } }] } });
    const p = llamarGemini('KEY123', { contents: [] });
    await vi.runAllTimersAsync();
    const result = await p;
    expect(result).toBe('ok');
    expect(axios.post).toHaveBeenCalledTimes(2);
  });

  it('reintenta 3 veces por modelo, prueba el de respaldo y al agotar todo lanza un error que dice qué hacer', async () => {
    axios.post.mockResolvedValue({ status: 503, data: {} });
    const p = llamarGemini('KEY123', { contents: [] });
    const assertion = expect(p).rejects.toThrow(/Gemini API error 503: .*saturado.*Probá de nuevo en un minuto/);
    await vi.runAllTimersAsync();
    await assertion;
    expect(axios.post).toHaveBeenCalledTimes(6);
    expect(axios.post.mock.calls[0][0]).toContain('gemini-3.1-flash-lite');
    expect(axios.post.mock.calls[3][0]).toContain('gemini-2.5-flash-lite');
  });

  it('reintenta ante un error de red (sin response)', async () => {
    axios.post
      .mockRejectedValueOnce(Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }))
      .mockResolvedValueOnce({ status: 200, data: { candidates: [{ content: { parts: [{ text: 'ok' }] } }] } });
    const p = llamarGemini('KEY123', { contents: [] });
    await vi.runAllTimersAsync();
    const result = await p;
    expect(result).toBe('ok');
    expect(axios.post).toHaveBeenCalledTimes(2);
  });

  it('si el modelo principal sigue con 503, responde el de respaldo', async () => {
    axios.post
      .mockResolvedValueOnce({ status: 503, data: {} }).mockResolvedValueOnce({ status: 503, data: {} }).mockResolvedValueOnce({ status: 503, data: {} })
      .mockResolvedValueOnce({ status: 200, data: { candidates: [{ content: { parts: [{ text: 'respaldo' }] } }] } });
    const p = llamarGemini('KEY123', { contents: [] });
    await vi.runAllTimersAsync();
    expect(await p).toBe('respaldo');
    expect(axios.post.mock.calls[3][0]).toContain('gemini-2.5-flash-lite');
  });

  it('NO reintenta un 400 (error de payload, no transitorio)', async () => {
    axios.post.mockResolvedValue({ status: 400, data: {} });
    await expect(llamarGemini('KEY123', { contents: [] })).rejects.toThrow('Gemini API error 400');
    expect(axios.post).toHaveBeenCalledTimes(1);
  });
});

describe('POST /extraer/archivo', () => {
  const archivosCreados = new Set();

  afterEach(() => vi.resetAllMocks());
  afterEach(() => {
    for (const archivo of archivosCreados) {
      fs.rmSync(archivo, { force: true });
      let directorio = path.dirname(archivo);
      const uploads = path.join(__dirname, '..', 'uploads');
      while (directorio !== uploads && directorio.startsWith(uploads + path.sep)) {
        try {
          fs.rmdirSync(directorio);
        } catch (error) {
          if (!['ENOTEMPTY', 'ENOENT'].includes(error.code)) throw error;
        }
        directorio = path.dirname(directorio);
      }
    }
    archivosCreados.clear();
  });

  it('returns 400 with a clear error when no file is attached', async () => {
    const app = express();
    app.use(express.json());
    app.use('/', geminiRouter('FAKE_KEY'));

    const res = await request(app)
      .post('/extraer/archivo')
      .field('prompt', 'algún prompt');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: 'archivo requerido' });
  });

  it('envía un XML como texto para que pueda extraerse aunque Gemini no acepte su MIME', async () => {
    axios.post.mockResolvedValue({
      status: 200,
      data: { candidates: [{ content: { parts: [{ text: '{"items":[]}' }] } }] },
    });
    const app = express();
    app.use('/', geminiRouter('FAKE_KEY'));

    const res = await request(app)
      .post('/extraer/archivo')
      .field('prompt', 'Extraé los ítems del comprobante')
      .attach('archivo', Buffer.from('<pedido><item sku="ABC-42" cantidad="4"/></pedido>'), {
        filename: 'pedido.xml', contentType: 'application/xml',
      });

    expect(res.status).toBe(200);
    const payload = axios.post.mock.calls[0][1];
    expect(payload.contents[0].parts).toEqual([
      { text: expect.stringContaining('<pedido><item sku="ABC-42" cantidad="4"/></pedido>') },
    ]);
  });

  it('elimina solamente el archivo creado por el test y preserva otros uploads', async () => {
    axios.post.mockResolvedValue({
      status: 200,
      data: { candidates: [{ content: { parts: [{ text: '{"items":[]}' }] } }] },
    });
    const uploads = path.join(__dirname, '..', 'uploads');
    const centinela = path.join(uploads, 'sin_importador', 'preservar.txt');
    fs.mkdirSync(path.dirname(centinela), { recursive: true });
    fs.writeFileSync(centinela, 'no borrar');

    const app = express();
    app.use('/', geminiRouter('FAKE_KEY'));
    const res = await request(app)
      .post('/extraer/archivo')
      .field('prompt', 'Extraé los ítems')
      .attach('archivo', Buffer.from('<pedido/>'), {
        filename: 'pedido.xml', contentType: 'application/xml',
      });

    expect(res.status).toBe(200);
    const archivo = path.join(uploads, res.body.file_url.replace(/^\/uploads\//, ''));
    archivosCreados.add(archivo);
    expect(fs.existsSync(centinela)).toBe(true);
    expect(fs.existsSync(archivo)).toBe(true);
  });
});
