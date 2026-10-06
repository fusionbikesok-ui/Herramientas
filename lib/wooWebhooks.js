/**
 * Vigilancia del estado de los webhooks de WooCommerce.
 *
 * Woo desactiva un webhook por su cuenta tras varias entregas fallidas, y lo hace en silencio:
 * deja de enviar eventos y nada lo anuncia. Al escribir esto (2026-09-06) `order.updated` ya
 * estaba `disabled` en producción sin que nadie se hubiera enterado.
 *
 * Esto sólo LEE Woo y guarda lo observado. Reactivar un webhook es una escritura sobre la
 * configuración de la tienda y una decisión de operación, no algo que deba pasar solo: si el
 * webhook se cayó por entregas fallidas, reactivarlo sin arreglar la causa lo vuelve a caer.
 */
import axios from 'axios';

const now = () => new Date().toISOString();

/** Un webhook es nuestro si entrega contra nuestro propio host. */
export function esPropio(deliveryUrl, hostPropio) {
  const url = String(deliveryUrl || '');
  const host = String(hostPropio || '').trim();
  return !!host && url.includes(host);
}

/**
 * Relee el estado de todos los webhooks y lo persiste.
 *
 * `status_desde` sólo se mueve cuando el estado cambia de verdad: si se reescribiera en cada
 * corrida, un webhook caído hace días parecería recién caído y se perdería justamente el dato
 * que dice cuántos eventos pueden haberse perdido.
 */
export async function refrescarWebhooksWoo(db, cfg, { hostPropio = 'herramientas.fusionbikes.com.ar' } = {}) {
  if (!String(cfg?.url || '').startsWith('https://')) {
    return { ok: false, error: 'WooCommerce URL debe usar HTTPS' };
  }
  const url = `${String(cfg.url).replace(/\/$/, '')}/wp-json/wc/v3/webhooks?per_page=100`;
  const resp = await axios.request({
    url, method: 'get', auth: { username: cfg.ck, password: cfg.cs }, timeout: 20000, validateStatus: () => true,
  });
  if (resp.status < 200 || resp.status >= 300) {
    return { ok: false, error: `Woo respondió ${resp.status}` };
  }
  const lista = Array.isArray(resp.data) ? resp.data : [];
  const ts = now();
  const previos = new Map(db.prepare('SELECT id, status, status_desde FROM woo_webhooks_estado').all().map((r) => [r.id, r]));
  db.transaction(() => {
    for (const w of lista) {
      const previo = previos.get(Number(w.id));
      const cambio = !previo || previo.status !== String(w.status);
      db.prepare(`INSERT INTO woo_webhooks_estado (id,topic,status,delivery_url,propio,visto_en,status_desde)
        VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET topic=excluded.topic, status=excluded.status,
          delivery_url=excluded.delivery_url, propio=excluded.propio, visto_en=excluded.visto_en,
          status_desde=CASE WHEN woo_webhooks_estado.status<>excluded.status THEN excluded.status_desde ELSE woo_webhooks_estado.status_desde END`)
        .run(Number(w.id), String(w.topic || ''), String(w.status || ''), String(w.delivery_url || ''),
          esPropio(w.delivery_url, hostPropio) ? 1 : 0, ts, cambio ? ts : (previo?.status_desde || ts));
    }
    // Un webhook que Woo ya no lista fue borrado en la tienda: dejarlo acá lo haría figurar como
    // vigente para siempre.
    const vivos = lista.map((w) => Number(w.id));
    if (vivos.length) {
      db.prepare(`DELETE FROM woo_webhooks_estado WHERE id NOT IN (${vivos.map(() => '?').join(',')})`).run(...vivos);
    }
  })();
  return { ok: true, total: lista.length, propios: lista.filter((w) => esPropio(w.delivery_url, hostPropio)).length };
}

/**
 * Webhooks propios que no están entregando. `paused` cuenta igual que `disabled`: en los dos
 * casos los eventos no llegan, y la diferencia es sólo quién lo apagó.
 */
export function webhooksWooCaidos(db) {
  return db.prepare(`SELECT id, topic, status, status_desde, visto_en FROM woo_webhooks_estado
    WHERE propio=1 AND status<>'active' ORDER BY status_desde`).all();
}

/**
 * Salud del pipeline de eventos, en los tres números que dicen si algo se está perdiendo.
 *
 * `eventos_sin_job` es el que importa y el que no tenía nadie mirando: un evento que se ingirió
 * y nunca derivó en trabajo desaparece sin dejar rastro —no falla, no reintenta, no aparece en
 * dead letters—. Los otros dos son trabajo que sí existió y terminó mal, que ya era visible.
 *
 * Vive acá y no en `identidadProductos` porque no es identidad: es la cañería por la que entran
 * los avisos de los dos canales.
 */
export function saludPipelineEventos(db) {
  const hay = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
  if (!hay('integration_events') || !hay('integration_jobs')) {
    return { disponible: false, eventos_sin_job: 0, dead_letters: 0, atascados: 0, por_tipo: [] };
  }
  const eventosSinJob = db.prepare(`SELECT COUNT(*) n FROM integration_events e
    WHERE NOT EXISTS (SELECT 1 FROM integration_jobs j WHERE j.event_id = e.event_id)`).get().n;
  const deadLetters = db.prepare("SELECT COUNT(*) n FROM integration_jobs WHERE status='dead_lettered'").get().n;
  // Un job que agotó sus intentos pero no quedó marcado como muerto: ni se reintenta ni se ve.
  const atascados = db.prepare(`SELECT COUNT(*) n FROM integration_jobs
    WHERE status NOT IN ('completed','dead_lettered') AND attempts >= max_attempts`).get().n;
  const porTipo = db.prepare(`SELECT job_type, COUNT(*) n FROM integration_jobs
    WHERE status='dead_lettered' GROUP BY job_type ORDER BY n DESC`).all();
  return { disponible: true, eventos_sin_job: eventosSinJob, dead_letters: deadLetters, atascados, por_tipo: porTipo };
}
