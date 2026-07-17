import { describe, it, expect, vi, afterEach } from 'vitest';
import axios from 'axios';
import express from 'express';
import request from 'supertest';
import { llamarGemini, geminiRouter } from '../routes/gemini.js';

vi.mock('axios');

describe('llamarGemini', () => {
  afterEach(() => vi.resetAllMocks());

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
});

describe('POST /extraer/archivo', () => {
  afterEach(() => vi.resetAllMocks());

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
});
