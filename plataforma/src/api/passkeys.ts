/*
 * src/api/passkeys.ts — rutas de passkeys (E1-WA-01), publicadas pero apagadas.
 *
 * Todas viven bajo `PREFIJO` dentro de un solo plugin, y la guarda de doble llave es un `onRequest` de ese
 * plugin: una ruta nueva del grupo queda cubierta por construcción, no por acordarse de agregarle la guarda.
 * Con cualquiera de las dos llaves apagada, o sin configuración de relying party, responden 503 con motivo.
 * La API sigue escuchando sólo en loopback: exponer esto a un navegador es de E4.
 */
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { Logger } from 'pino';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import type { ProveedorSesion } from '../auth/sesion.ts';
import {
  ErrorPasskey, iniciarAutenticacion, iniciarRegistro, passkeysHabilitadas, terminarAutenticacion, terminarRegistro,
  type CfgPasskeys,
} from '../auth/passkeys.ts';

export const PREFIJO_PASSKEYS = '/api/v2/auth/passkeys';

export const RUTAS_PASSKEYS = [
  'registro/inicio', 'registro/fin', 'login/inicio', 'login/fin', 'reautenticacion/inicio', 'reautenticacion/fin',
].map((r) => `${PREFIJO_PASSKEYS}/${r}`);

export interface OpcionesPasskeys {
  /** Sin esto, aunque las dos llaves estuvieran encendidas, responden 503: no hay a quién atestar. */
  cfg?: CfgPasskeys;
  /** De dónde se lee PASSKEYS_HABILITADAS; en tests se inyecta. */
  entorno?: Record<string, string | undefined>;
  /** Registro y reautenticación de otras tareas (recuperación) cuelgan del mismo plugin y la misma guarda. */
  extra?: (sub: FastifyInstance, cfg: CfgPasskeys) => void;
}

const deshabilitadas = (reply: FastifyReply) =>
  reply.code(503).send({ error: 'passkeys_deshabilitadas', message: 'Las passkeys no están habilitadas en este entorno.' });

export function registrarPasskeys(
  app: FastifyInstance<Server, IncomingMessage, ServerResponse, Logger>, pool: pg.Pool, sesion: ProveedorSesion,
  opciones: OpcionesPasskeys, ahora: () => Date,
): void {
  const entorno = opciones.entorno ?? process.env;
  void app.register(async (sub) => {
    sub.addHook('onRequest', async (_req, reply) => {
      if (!opciones.cfg || !await passkeysHabilitadas(pool, entorno)) return deshabilitadas(reply);
    });
    sub.setErrorHandler((err, _req, reply) => {
      if (err instanceof ErrorPasskey) return reply.code(400).send({ error: 'passkey_rechazada', message: err.message });
      throw err;
    });
    const cfg = () => opciones.cfg!;
    const conSesion = async (req: FastifyRequest, reply: FastifyReply) => {
      const actual = await sesion(req);
      if (!actual) void reply.code(401).send({ error: 'sin_sesion', message: 'Se requiere una sesión.' });
      return actual;
    };

    sub.post('/registro/inicio', async (req, reply) => {
      const actual = await conSesion(req, reply); if (!actual) return reply;
      return iniciarRegistro(pool, cfg(), { id: actual.userId, nombre: actual.userId }, ahora());
    });
    sub.post('/registro/fin', async (req, reply) => {
      const actual = await conSesion(req, reply); if (!actual) return reply;
      return terminarRegistro(pool, cfg(), { id: actual.userId }, req.body as RegistrationResponseJSON, ahora());
    });
    sub.post('/login/inicio', async () => iniciarAutenticacion(pool, cfg(), 'login', null, ahora()));
    sub.post('/login/fin', async (req) =>
      terminarAutenticacion(pool, cfg(), 'login', null, req.body as AuthenticationResponseJSON, ahora()));
    sub.post('/reautenticacion/inicio', async (req, reply) => {
      const actual = await conSesion(req, reply); if (!actual) return reply;
      return iniciarAutenticacion(pool, cfg(), 'reautenticacion', actual.userId, ahora());
    });
    sub.post('/reautenticacion/fin', async (req, reply) => {
      const actual = await conSesion(req, reply); if (!actual) return reply;
      return terminarAutenticacion(pool, cfg(), 'reautenticacion', actual.userId, req.body as AuthenticationResponseJSON, ahora());
    });
    if (opciones.extra && opciones.cfg) opciones.extra(sub, opciones.cfg);
  }, { prefix: PREFIJO_PASSKEYS });
}
