import axios from 'axios';
import express from 'express';
import multer from 'multer';
import { guardarArchivo } from '../utils/storage.js';

const upload = multer({ storage: multer.memoryStorage() });

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent';

// BUG5 (piloto Pedalar #205): dos 503 seguidos de Gemini tiraban abajo la extracción entera sin
// reintento. Solo se reintentan errores transitorios (5xx/429 y errores de red sin response, p.
// ej. ECONNRESET) — nunca un 4xx de payload (400/401/403), que es un error real del request.
const ESTADOS_REINTENTABLES = new Set([429, 500, 502, 503, 504]);
const REINTENTOS_GEMINI = [1000, 3000]; // delays entre intentos: 3 intentos en total

function esperar(ms) { return new Promise((r) => setTimeout(r, ms)); }

export async function llamarGemini(key, payload) {
  const body = {
    ...payload,
    generationConfig: { ...payload.generationConfig, responseMimeType: 'application/json' }
  };
  let ultimoError;
  for (let intento = 0; intento <= REINTENTOS_GEMINI.length; intento++) {
    try {
      const resp = await axios.post(`${GEMINI_URL}?key=${key}`, body, {
        headers: { 'Content-Type': 'application/json' },
        validateStatus: () => true
      });
      if (resp.status !== 200) {
        if (ESTADOS_REINTENTABLES.has(resp.status) && intento < REINTENTOS_GEMINI.length) {
          ultimoError = new Error(`Gemini API error ${resp.status}`);
          await esperar(REINTENTOS_GEMINI[intento]);
          continue;
        }
        throw new Error(`Gemini API error ${resp.status}`);
      }
      const candidate = resp.data?.candidates?.[0];
      if (!candidate) {
        throw new Error('Gemini no devolvió candidatos — posible bloqueo por safety filter');
      }
      return candidate.content.parts[0].text;
    } catch (err) {
      const esErrorDeRed = !err.message?.startsWith('Gemini API error') && err.message !== 'Gemini no devolvió candidatos — posible bloqueo por safety filter';
      if (esErrorDeRed && intento < REINTENTOS_GEMINI.length) {
        ultimoError = err;
        await esperar(REINTENTOS_GEMINI[intento]);
        continue;
      }
      throw err;
    }
  }
  throw ultimoError;
}

export function parseJsonArrayText(text) {
  const cleaned = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
  const parsed = JSON.parse(cleaned);
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.items)) return parsed.items;
  return parsed;
}

// Retorna el objeto completo incluyendo campos extra (proveedor, numero_pedido, etc.)
const TIPOS_DOC_VALIDOS = new Set(['factura', 'remito', 'orden_compra', 'otro']);

function parseJsonFull(text) {
  const cleaned = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
  const parsed = JSON.parse(cleaned);
  const items = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.items) ? parsed.items : []);
  const tipo = TIPOS_DOC_VALIDOS.has(parsed?.tipo_documento) ? parsed.tipo_documento : null;
  return { items, proveedor: parsed?.proveedor, numero_pedido: parsed?.numero_pedido, tipo_documento: tipo };
}

export function geminiRouter(geminiKey) {
  const router = express.Router();

  router.post('/extraer/texto', async (req, res) => {
    try {
      const { contenido, prompt } = req.body;
      const text = await llamarGemini(geminiKey, {
        contents: [{ parts: [{ text: `${prompt}\n\n${contenido}` }] }]
      });
      const { items, proveedor, numero_pedido, tipo_documento } = parseJsonFull(text);
      res.json({ ok: true, items, proveedor: proveedor || null, numero_pedido: numero_pedido || null, tipo_documento: tipo_documento || null });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.post('/extraer/archivo', upload.single('archivo'), async (req, res) => {
    if (!req.file) {
      res.status(400).json({ ok: false, error: 'archivo requerido' });
      return;
    }
    try {
      const { prompt, importador, numero_pedido: numPed } = req.body;
      const mimeType = req.file.mimetype;
      const base64 = req.file.buffer.toString('base64');
      const text = await llamarGemini(geminiKey, {
        contents: [{ parts: [
          { text: prompt },
          { inline_data: { mime_type: mimeType, data: base64 } }
        ] }]
      });
      const { items, proveedor, numero_pedido, tipo_documento } = parseJsonFull(text);

      // Guardar archivo en disco
      let file_url = null;
      let nombre_archivo = req.file.originalname;
      try {
        const saved = guardarArchivo({
          buffer: req.file.buffer,
          originalname: req.file.originalname,
          mimetype: mimeType,
          importador: importador || proveedor || 'sin_importador',
          numeroPedido: numPed || numero_pedido || 'sin_pedido'
        });
        file_url = saved.url;
      } catch (saveErr) {
        console.error('Error guardando archivo:', saveErr.message);
      }

      res.json({
        ok: true, items,
        proveedor: proveedor || null,
        numero_pedido: numero_pedido || null,
        tipo_documento: tipo_documento || null,
        file_url,
        nombre_archivo
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  return router;
}
