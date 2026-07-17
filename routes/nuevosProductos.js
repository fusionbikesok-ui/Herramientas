import express from 'express';
import { llamarGemini, parseJsonArrayText } from './gemini.js';
import { CATEGORIAS_FB, PROMPT_BATCH } from '../lib/categorias.js';

export function tituloCase(palabra) {
  if (!palabra) return '';
  return palabra.charAt(0).toUpperCase() + palabra.slice(1).toLowerCase();
}

export function armarTitulo(tipo, marca, modelo, dato) {
  return [tipo, marca, modelo, dato].filter(Boolean).join(' ').trim();
}

export async function analizarProductosNuevosBatch(geminiKey, productos) {
  const text = await llamarGemini(geminiKey, {
    contents: [{ parts: [{ text: `${PROMPT_BATCH}\n\nProductos:\n${JSON.stringify(productos)}` }] }]
  });
  return parseJsonArrayText(text);
}

export function nuevosProductosRouter(geminiKey) {
  const router = express.Router();

  router.get('/categorias', (req, res) => {
    res.json({ ok: true, categorias: CATEGORIAS_FB });
  });

  router.post('/analizar', async (req, res) => {
    try {
      const fichas = await analizarProductosNuevosBatch(geminiKey, req.body.productos);
      const conTitulo = fichas.map(f => ({ ...f, titulo: armarTitulo(f.ti, f.m, f.mo, f.da) }));
      res.json({ ok: true, fichas: conTitulo });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  return router;
}
