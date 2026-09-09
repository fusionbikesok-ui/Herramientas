/**
 * Worker del reloj de escalamiento de la bandeja (E6, tarea 5b).
 *
 * Corre en el VPS por decisión explícita: un teléfono apagado, sin señal o con la app cerrada
 * no puede ser responsable de que una alerta urgente escale. La app solo muestra y reconoce.
 *
 * Hace dos cosas por vuelta:
 *  1. Arranca el reloj de los casos nuevos que todavía no lo tienen.
 *  2. Re-notifica y escala los que vencieron sin reconocimiento.
 *
 * Para casos de Mercado Libre el plazo que manda es el de ML (`due_date` de una acción
 * obligatoria). Este reloj cubre lo demás y nunca contradice al de ellos: solo repite el
 * aviso, no inventa un vencimiento propio.
 */

import {
  barrerEscalamiento, proximaRepeticion, severidadDe, severidadDePrioridad, SEVERIDADES_QUE_REPITEN,
} from './escalamientoAlertas.js';
import { payloadDeCaso } from './pushCasoPayload.js';
import { enviarNotificacion } from './notificacionesPush.js';

function tieneColumnas(db) {
  const columnas = new Set(db.prepare('PRAGMA table_info(inbox_items)').all().map((c) => c.name));
  return columnas.has('next_repeat_at') && columnas.has('severidad');
}

/**
 * Arranca el reloj de los casos que entraron sin él.
 *
 * Se hace acá y no en la ingesta porque los casos llegan por varios caminos —webhook de ML,
 * plugin de chat, reconciliación— y poner el reloj en cada uno garantizaba olvidarse de uno.
 *
 * La consulta EXCLUYE las severidades que no repiten. Antes las traía y las descartaba en el
 * bucle, así que los casos normales —la mayoría— volvían a ocupar los 500 lugares del `LIMIT`
 * en cada vuelta y podían dejar afuera para siempre a un caso urgente nuevo. Se ordena por
 * `inbox_id DESC` para que, si igual se llena, entren primero los más recientes.
 */
export function sembrarRelojes(db, ahora = Date.now()) {
  const repetibles = SEVERIDADES_QUE_REPITEN;
  const marcadores = repetibles.map(() => '?').join(', ');
  const pendientes = db.prepare(`SELECT inbox_id, severidad, priority FROM inbox_items
    WHERE next_repeat_at IS NULL AND acknowledged_at IS NULL
      AND status NOT IN ('resolved', 'archived')
      AND created_at >= ?
      AND (severidad IN (${marcadores})
           OR (severidad IS NULL AND priority IN ('urgent', 'high')))
    ORDER BY inbox_id DESC
    LIMIT 500`).all(new Date(ahora - 24 * 60 * 60 * 1000).toISOString(), ...repetibles);

  let sembrados = 0;
  for (const item of pendientes) {
    // `priority` es la urgencia del aviso y `severidad` la del trabajo. Mientras la segunda
    // no esté cargada se deriva de la primera, con la MISMA traducción que usa la API.
    const severidad = item.severidad ? severidadDe(item.severidad) : severidadDePrioridad(item.priority);
    const proxima = proximaRepeticion(severidad, ahora);
    if (!proxima) continue;
    db.prepare('UPDATE inbox_items SET severidad = COALESCE(severidad, ?), next_repeat_at = ? WHERE inbox_id = ?')
      .run(severidad, proxima, item.inbox_id);
    sembrados += 1;
  }
  if (pendientes.length === 500) {
    console.warn('[escalamiento] la ventana de sembrado se llenó; puede haber casos sin reloj');
  }
  return sembrados;
}

/**
 * A quién avisar.
 *
 * Sin escalamiento va a quien lo tiene asignado. Al ESCALAR se suman los supervisores, que es
 * el punto del escalamiento: avisarle a alguien distinto del que no está respondiendo. Si no
 * hay supervisores cargados se cae a todos los dispositivos, porque no avisarle a nadie es
 * peor que avisarle de más — pero se registra, porque significa que falta configurar el rol.
 */
function dispositivosPara(db, item, escalado) {
  const asignado = item.assigned_user_id
    ? db.prepare('SELECT token, entorno FROM device_tokens WHERE user_id = ? AND revocado_en IS NULL').all(item.assigned_user_id)
    : [];

  if (!escalado && asignado.length) return asignado;

  const supervisores = supervisoresConDispositivo(db);
  if (escalado && supervisores.length) {
    const vistos = new Set();
    return [...asignado, ...supervisores].filter((d) => !vistos.has(d.token) && vistos.add(d.token));
  }
  if (escalado) {
    console.warn(`[escalamiento] caso ${item.inbox_id} escaló y no hay supervisores con dispositivo; se avisa a todos`);
  }
  return db.prepare('SELECT token, entorno FROM device_tokens WHERE revocado_en IS NULL LIMIT 50').all();
}

/**
 * Supervisores con dispositivo activo.
 *
 * Hoy la supervisión es `users.is_admin`: el esquema no tiene un rol de supervisor propio.
 * Cuando exista, este es el único punto a cambiar. Se envuelve en try porque los tests montan
 * bases desnudas sin la tabla `users`.
 */
function supervisoresConDispositivo(db) {
  try {
    return db.prepare(`SELECT DISTINCT d.token, d.entorno FROM device_tokens d
      JOIN users u ON u.id = d.user_id
      WHERE d.revocado_en IS NULL AND u.is_admin = 1 AND u.activo = 1`).all();
  } catch {
    return [];
  }
}

export async function procesarEscalamiento(db, opciones = {}) {
  if (!tieneColumnas(db)) return { sembrados: 0, repetidos: [], escalados: [], revisados: 0 };
  const ahora = opciones.ahora || Date.now();
  const enviar = opciones.enviar || enviarNotificacion;

  const sembrados = sembrarRelojes(db, ahora);

  const aNotificar = [];
  const resultado = barrerEscalamiento(db, {
    ahora,
    // El barrido es síncrono para que la transacción por caso sea atómica; el envío, que es
    // de red y lento, se junta acá y se hace después.
    notificar: (evento) => aNotificar.push(evento),
  });

  for (const { item, escalado, severidad } of aNotificar) {
    const payload = payloadDeCaso({ ...item, severidad }, { repeticion: true, escalado });
    // La clave identifica ESTA repetición, no el instante de envío: con un timestamp cambiaba
    // en cada intento y la deduplicación del proveedor quedaba en nada. `next_repeat_at` es el
    // vencimiento que disparó la vuelta, así que es estable dentro de la repetición.
    const clave = `esc-${item.inbox_id}-${item.next_repeat_at || ahora}`;
    for (const dispositivo of dispositivosPara(db, item, escalado)) {
      try {
        await enviar(dispositivo.token, { ...payload, idempotencia_key: clave }, { entorno: dispositivo.entorno });
      } catch (e) {
        // Un dispositivo que falla no puede frenar la repetición de los demás: el punto del
        // escalamiento es que alguien se entere, y basta con que llegue a uno.
        console.error('[escalamiento] fallo al notificar', item.inbox_id, e?.message || e);
      }
    }
  }

  return { sembrados, ...resultado };
}
