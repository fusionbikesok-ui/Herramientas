/**
 * Guardia de los webhooks de WooCommerce (Fase E-1a). Fail-closed:
 *  1. sin `WOO_WEBHOOK_SECRET` → 503 + incidente crítico (nunca se procesa un aviso sin poder autenticarlo);
 *  2. firma HMAC-SHA256 del cuerpo crudo → 401 si falta o no coincide;
 *  3. ping de Woo (`webhook_id=<n>`, form-urlencoded) → 200 sin procesar;
 *  4. `X-WC-Webhook-ID` debe ser un webhook nuestro: lista de `GET /webhooks` cacheada 1 h y refrescada ante un ID
 *     desconocido (o override `WOO_WEBHOOK_IDS`). Desconocido tras refrescar → 401 + incidente;
 *  5. el topic debe corresponder al endpoint (`order.*` / `product.*`) → 400.
 * Si la lista no se puede obtener, un aviso con firma válida se acepta y se abre un incidente (no se corta la entrega).
 */
import crypto from 'node:crypto';
import { abrirOActualizarIncidente } from './incidentes.js';

const VIGENCIA_LISTA_MS = 60 * 60 * 1000;
let _cache = { ids: null, en: 0 };
export function _resetWooWebhookAuth() { _cache = { ids: null, en: 0 }; }

const incidente = (db, tipoError, severidad, tecnico, humano, contexto = {}) => {
  try { abrirOActualizarIncidente(db, { integracion: 'woocommerce', proceso: 'webhook_firma', tipoError, severidad, mensajeTecnico: tecnico, mensajeHumano: humano, contexto }); }
  catch { /* un incidente que no se puede abrir no debe cambiar la respuesta */ }
};

function firmaValida(secreto, cuerpo, firma) {
  if (!firma) return false;
  const esperado = Buffer.from(crypto.createHmac('sha256', secreto).update(cuerpo).digest('base64'));
  const recibido = Buffer.from(String(firma));
  return recibido.length === esperado.length && crypto.timingSafeEqual(recibido, esperado);
}

async function idsConocidos(wooCfg, listar, { forzar = false } = {}) {
  const override = String(process.env.WOO_WEBHOOK_IDS || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (override.length) return new Set(override);
  if (!forzar && _cache.ids && Date.now() - _cache.en < VIGENCIA_LISTA_MS) return _cache.ids;
  const lista = await listar(wooCfg);
  _cache = { ids: new Set(lista.map(String)), en: Date.now() };
  return _cache.ids;
}

async function listarWebhooksWoo(wooCfg) {
  const { wooFetch } = await import('../routes/woo.js');
  const r = await wooFetch(wooCfg, '/webhooks?per_page=100');
  if (r?.status !== 200 || !Array.isArray(r.data)) throw new Error(`Woo /webhooks respondió ${r?.status}`);
  return r.data.filter((w) => w.status === 'active').map((w) => w.id);
}

/**
 * @param {object} req  petición con `req.body` Buffer (express.raw)
 * @param {'order'|'product'} recurso  endpoint que recibe el aviso
 * @returns {Promise<{ok:true, ping?:boolean}|{ok:false, status:number, error:string}>}
 */
export async function verificarWebhookWoo(db, wooCfg, req, recurso, { listar = listarWebhooksWoo } = {}) {
  const secreto = process.env.WOO_WEBHOOK_SECRET || '';
  if (!secreto) {
    incidente(db, 'secreto_webhook_ausente', 'critico', 'WOO_WEBHOOK_SECRET no está configurado: se rechazan los webhooks de Woo.',
      'Los avisos de la web (pedidos y productos) se están rechazando porque falta el secreto de firma. Hay que configurar WOO_WEBHOOK_SECRET.');
    return { ok: false, status: 503, error: 'secreto de webhook no configurado' };
  }
  const cuerpo = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!req.headers['x-wc-webhook-signature']) return { ok: false, status: 401, error: 'sin firma' };
  if (!firmaValida(secreto, cuerpo, req.headers['x-wc-webhook-signature'])) return { ok: false, status: 401, error: 'firma inválida' };
  if (/^webhook_id=\d+$/.test(cuerpo.toString('utf8').trim())) return { ok: true, ping: true };

  const topic = String(req.headers['x-wc-webhook-topic'] || '').trim().toLowerCase();
  if (!new RegExp(`^${recurso}\\.[a-z_]+$`).test(topic)) return { ok: false, status: 400, error: `topic inválido para ${recurso}` };

  const id = String(req.headers['x-wc-webhook-id'] || '').trim();
  if (!/^\d+$/.test(id)) return { ok: false, status: 401, error: 'webhook sin id' };
  try {
    let ids = await idsConocidos(wooCfg, listar);
    if (!ids.has(id)) ids = await idsConocidos(wooCfg, listar, { forzar: true });
    if (!ids.has(id)) {
      incidente(db, 'webhook_id_desconocido', 'critico', `Aviso de Woo con X-WC-Webhook-ID ${id}, que no figura entre los webhooks activos.`,
        'Llegó un aviso firmado desde un webhook de Woo que no es ninguno de los nuestros. Se rechazó. Revisá los webhooks en WooCommerce.', { id });
      return { ok: false, status: 401, error: 'webhook desconocido' };
    }
  } catch (e) {
    incidente(db, 'webhook_lista_no_disponible', 'advertencia', `No se pudo obtener la lista de webhooks de Woo: ${String(e.message).slice(0, 200)}`,
      'No se pudo verificar la lista de webhooks de Woo; se aceptan los avisos con firma válida mientras tanto.', { id });
  }
  return { ok: true };
}
