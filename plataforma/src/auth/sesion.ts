import type { FastifyRequest } from 'fastify';

export interface Sesion { userId: string; capabilities: readonly string[] }
export type ProveedorSesion = (request: FastifyRequest) => Promise<Sesion | null>;

// E1 no habilita todavía una sesión real. La única vía de inyección es por composición al crear
// la app, reservada a tests; nunca se lee una variable de entorno para abrir este acceso.
export const sinSesion: ProveedorSesion = async () => null;
