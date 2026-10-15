/**
 * Fase E-3: avisos de ML que nunca recibieron HTTP 200 (`GET /missed_feeds`), reinyectados como recibos.
 *
 * Contrato verificado contra la doc oficial de ML ("Productos: recibe notificaciones", sección Historial de notificaciones):
 *  - `GET /missed_feeds?app_id=<APP_ID>&topic=<TOPIC>&offset=&limit=`; `app_id` va en cada consulta (= ML_CLIENT_ID);
 *  - para el tópico `items`, `site_id` es OBLIGATORIO (sin él, HTTP 400); una llamada por sitio;
 *  - solo conserva dos días; son los avisos que tras 8 intentos (1 h) no recibieron 200.
 * La URL la arma `construirOperacion('ml.missed_feeds')` del gateway (misma fuente que usa la plataforma, con tests propios).
 * ML no ofrece un cursor estable: SIEMPRE se pagina desde offset 0 y se deduplica por `_id`.
 *
 * Cada faltante entra por `registrarWebhookMl`, el MISMO camino que un webhook real: recibo durable + trabajo por recurso
 * (`order.ml`, `item.project`…). Es idempotente: el fingerprint incluye el `_id`, así que repetir la ronda cada hora no duplica
 * nada, y un aviso que ya habíamos recibido por otra vía queda como duplicado. Es un suplemento, no una garantía: lo que se
 * pierda igual lo repara el barrido.
 *
 * Volumen: una ronda por hora, una página por tópico en el caso normal (vacío), sin reintentos: ante un 429 o un error se corta
 * la ronda y se espera a la siguiente.
 */
import { construirOperacion } from './gatewayCanal.js';
import { mlFetch } from './mlClient.js';
import { registrarWebhookMl } from './workerIntegrationJobs.js';
import { abrirOActualizarIncidente, confirmarCicloSano } from './incidentes.js';

export const TOPICOS_MISSED_FEEDS = Object.freeze(['orders_v2', 'items', 'questions', 'claims']);
const MAX_PAGINAS = 20;
const POR_PAGINA = 50;

const RECURSO_VALIDO = {
  orders_v2: /^\/orders\/\d{1,20}$/,
  items: /^\/items\/[A-Z]{3}\d{1,15}$/,
  questions: /^\/questions\/\d{1,20}$/,
  claims: /^\/(?:post-purchase\/v1\/)?claims\/[A-Za-z0-9_-]{1,40}$/,
};
const TOPIC_DEL_AVISO = { orders_v2: ['orders_v2', 'orders'], items: ['items'], questions: ['questions'], claims: ['claims', 'post_purchase'] };

const ahora = () => new Date().toISOString();

/** Una ronda de un tópico: enumera desde offset 0, deduplica por `_id` y reinyecta. */
async function rondaTopico(db, mlCfg, topic, { siteId, userId }) {
  const c = { topic, enumerados: 0, nuevos: 0, duplicados: 0, excluidos: 0, error: null, cortar: false };
  const vistos = new Set();
  let offset = 0;
  let terminado = false;
  for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
    const { ruta } = construirOperacion({ op: 'ml.missed_feeds', params: { topic, offset } }, { mlAppId: mlCfg.clientId, mlSiteId: siteId, mlUserId: userId });
    const r = await mlFetch(db, mlCfg, 'get', ruta);
    if (r.status === 429) { c.error = 'HTTP_429'; c.cortar = true; return c; } // sin reintentos agresivos: se espera a la próxima hora
    if (r.status !== 200) { c.error = `HTTP_${r.status}`; return c; }
    const cuerpo = r.data;
    const lista = Array.isArray(cuerpo) ? cuerpo : (cuerpo?.messages === null ? [] : cuerpo?.messages);
    if (!Array.isArray(lista)) { c.error = 'FORMA_MISSED_FEEDS'; return c; }
    for (const aviso of lista) {
      const id = typeof aviso?._id === 'string' ? aviso._id.trim() : '';
      if (id && vistos.has(id)) continue; // la paginación sin cursor puede repetir filas entre páginas
      if (id) vistos.add(id);
      c.enumerados++;
      const topicAviso = String(aviso?.topic || topic);
      const resource = String(aviso?.resource ?? '');
      const usuario = String(aviso?.user_id ?? '');
      if (!id || id.length > 256 || !TOPIC_DEL_AVISO[topic].includes(topicAviso) || !RECURSO_VALIDO[topic].test(resource) || (userId && usuario !== String(userId))) {
        c.excluidos++; // de otra cuenta, sin id de notificación o con recurso ilegible: se cuenta y no se procesa
        continue;
      }
      try {
        const rec = registrarWebhookMl(db, { _id: id, topic: topicAviso, resource, user_id: aviso.user_id, application_id: aviso.application_id, attempts: aviso.attempts, sent: aviso.sent, received: aviso.received });
        if (rec.duplicate) c.duplicados++; else c.nuevos++;
      } catch (e) {
        c.error = `registro: ${String(e.message).slice(0, 120)}`;
        return c;
      }
    }
    offset += lista.length;
    const total = Number(cuerpo?.total ?? cuerpo?.paging?.total);
    if (lista.length === 0 || (Number.isInteger(total) && offset >= total)) { terminado = true; break; }
  }
  // Tope de páginas alcanzado con ML todavía devolviendo avisos: los de más quedan sin reinyectar. No se sube el tope ni se
  // reintenta (volumen de llamadas); se avisa con el conteo para que se vea en vez de perderse en silencio.
  const tipoTope = `ml_missed_feeds_tope_${topic}`;
  if (!terminado) {
    c.tope = true;
    abrirOActualizarIncidente(db, {
      integracion: 'mercadolibre', proceso: 'missed_feeds', tipoError: tipoTope, severidad: 'advertencia',
      mensajeTecnico: `missed_feeds ${topic}: tope de ${MAX_PAGINAS} páginas alcanzado con ${c.enumerados} avisos enumerados`,
      mensajeHumano: `ML tiene más avisos sin entregar de "${topic}" que los que una ronda puede reinyectar (tope ${MAX_PAGINAS} páginas, ${c.enumerados} enumerados). Los restantes siguen sin reinyectar: revisá por qué el endpoint de avisos no responde 200.`,
      contexto: { topic, enumerados: c.enumerados, max_paginas: MAX_PAGINAS },
    });
  } else if (!c.error) {
    confirmarCicloSano(db, { integracion: 'mercadolibre', proceso: 'missed_feeds', tipoError: tipoTope });
  }
  return c;
}

/**
 * Ronda horaria completa. Guarda una fila por tópico en `missed_feeds_corridas` (la alerta diaria suma esas filas).
 * @returns {Promise<{omitido?:boolean, motivo?:string, topicos?:object[]}>}
 */
export async function reinyectarMissedFeeds(db, mlCfg, { topicos = TOPICOS_MISSED_FEEDS, siteId = process.env.ML_SITE_ID || 'MLA' } = {}) {
  if (!mlCfg?.clientId || !mlCfg?.userId) return { omitido: true, motivo: 'ml_sin_configurar' };
  const out = [];
  const ins = db.prepare(`INSERT INTO missed_feeds_corridas (inicio, fin, topic, enumerados, nuevos, duplicados, excluidos, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const topic of topicos) {
    const inicio = ahora();
    let c;
    try { c = await rondaTopico(db, mlCfg, topic, { siteId, userId: mlCfg.userId }); }
    catch (e) { c = { topic, enumerados: 0, nuevos: 0, duplicados: 0, excluidos: 0, error: String(e.message).slice(0, 160), cortar: false }; }
    ins.run(inicio, ahora(), topic, c.enumerados, c.nuevos, c.duplicados, c.excluidos, c.error);
    out.push(c);
    if (c.cortar) break; // 429: no se sigue golpeando a ML esta hora
  }
  return { omitido: false, topicos: out };
}
