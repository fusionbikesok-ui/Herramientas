/*
 * src/api/informes.ts — `GET /internal/v1/informes/estado`: el legado pregunta si salieron los informes.
 *
 * Es lo que consulta el vigilante de las 09:00 ART del legado (tarea 11 del tramo 4). La plataforma no abre
 * incidentes propios: expone el estado y el legado alerta con el sistema que ya existe, que es además el único
 * aviso que sobrevive a que la plataforma se caiga entera.
 *
 * Firma HMAC igual que las señales (`seguridad/interna.ts`), con el mismo keyring y los mismos orígenes: el
 * legado ya tiene esa clave para la copia de sombra. No se registran nonces: es una lectura sin efectos, y un
 * replay dentro de la ventana de cinco minutos sólo devuelve lo mismo.
 */
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { Logger } from 'pino';
import { verificarInterna } from '../seguridad/interna.ts';
import { pendientesVencidas } from '../informes/entregas.ts';
import type { OpcionesSenales } from './senales.ts';

export const RUTA_ESTADO_INFORMES = '/internal/v1/informes/estado';

export function registrarEstadoInformes(
  app: FastifyInstance<Server, IncomingMessage, ServerResponse, Logger>, pool: pg.Pool, logger: Logger,
  opciones: Pick<OpcionesSenales, 'keyring' | 'origenes'>, ahora: () => Date,
): void {
  app.get(RUTA_ESTADO_INFORMES, async (req, reply) => {
    const v = verificarInterna({
      keyring: opciones.keyring, origenes: opciones.origenes, direccion: req.socket.remoteAddress,
      headers: req.headers, metodo: 'GET', path: RUTA_ESTADO_INFORMES, cuerpo: Buffer.alloc(0), ahoraMs: ahora().getTime(),
    });
    if (!v.ok) {
      logger.warn({ motivo: v.motivo }, 'consulta de estado de informes rechazada por autenticación');
      return reply.code(401).send({ code: 'unauthorized', message: 'Autenticación interna inválida.' });
    }
    const ultimo = await pool.query<{ fecha: string | null }>(
      `SELECT to_char(max(fecha), 'YYYY-MM-DD') AS fecha FROM informes.entregas
        WHERE tipo = 'reporte' AND estado_aviso = 'avisado'`,
    );
    const atrasadas = (await pendientesVencidas(pool, ahora())).map(({ tipo, fecha }) => ({ tipo, fecha }));
    // Informes cuyo objeto en B2 quedó oculto por un marcador de borrado: la versión retenida sobrevive, pero
    // un cliente normal recibe 404. Lo marca la vuelta diaria; acá se expone para que el legado lo alerte.
    const oc = await pool.query<{ tipo: string; fecha: string }>(
      `SELECT tipo, to_char(fecha, 'YYYY-MM-DD') AS fecha FROM informes.entregas
        WHERE oculto_en IS NOT NULL ORDER BY fecha DESC, tipo`,
    );
    return { ultimo: ultimo.rows[0]?.fecha ?? null, atrasadas, ocultos: oc.rows };
  });
}
