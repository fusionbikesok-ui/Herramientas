import axios from 'axios';
import express from 'express';
import multer from 'multer';

const upload = multer({ storage: multer.memoryStorage() });

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent';

export async function llamarGemini(key, payload) {
  const body = {
    ...payload,
    generationConfig: { ...payload.generationConfig, responseMimeType: 'application/json' }
  };
  const resp = await axios.post(`${GEMINI_URL}?key=${key}`, body, {
    headers: { 'Content-Type': 'application/json' },
    validateStatus: () => true
  });
  if (resp.status !== 200) {
    throw new Error(`Gemini API error ${resp.status}`);
  }
  const candidate = resp.data?.candidates?.[0];
  if (!candidate) {
    throw new Error('Gemini no devolvió candidatos — posible bloqueo por safety filter');
  }
  return candidate.content.parts[0].text;
}

export function parseJsonArrayText(text) {
  const cleaned = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
  const parsed = JSON.parse(cleaned);
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.items)) return parsed.items;
  return parsed;
}

// Retorna el objeto completo incluyendo campos extra (proveedor, numero_pedido, etc.)
function parseJsonFull(text) {
  const cleaned = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
  const parsed = JSON.parse(cleaned);
  const items = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.items) ? parsed.items : []);
  return { items, proveedor: parsed?.proveedor, numero_pedido: parsed?.numero_pedido };
}

export function geminiRouter(geminiKey) {
  const router = express.Router();

  router.post('/extraer/texto', async (req, res) => {
    try {
      const { contenido, prompt } = req.body;
      const text = await llamarGemini(geminiKey, {
        contents: [{ parts: [{ text: `${prompt}\n\n${contenido}` }] }]
      });
      const { items, proveedor, numero_pedido } = parseJsonFull(text);
      res.json({ ok: true, items, proveedor: proveedor || null, numero_pedido: numero_pedido || null });
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
      const { prompt } = req.body;
      const mimeType = req.file.mimetype;
      const base64 = req.file.buffer.toString('base64');
      const text = await llamarGemini(geminiKey, {
        contents: [{ parts: [
          { text: prompt },
          { inline_data: { mime_type: mimeType, data: base64 } }
        ] }]
      });
      const { items, proveedor, numero_pedido } = parseJsonFull(text);
      res.json({ ok: true, items, proveedor: proveedor || null, numero_pedido: numero_pedido || null });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  return router;
}
