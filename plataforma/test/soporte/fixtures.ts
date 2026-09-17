/*
 * test/soporte/fixtures.ts — la semilla mínima que exigen las FK del esquema.
 *
 * `audit.audit_events` pide una empresa que exista y un correlation_id uuid; las señales piden una cuenta de
 * canal; `security.users` pide company_id y username (no hay columna `email`: va cifrada con índice ciego).
 * Sin esta semilla, los tests fallan por la FK antes de probar lo que quieren probar.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';

export interface Semilla { companyId: string; cuentaWoo: string; cuentaMl: string; userId: string }

export async function sembrar(pool: pg.Pool): Promise<Semilla> {
  const sufijo = randomUUID().slice(0, 8);
  const empresa = await pool.query<{ id: string }>(
    `INSERT INTO core.companies (legal_name) VALUES ($1) RETURNING id`, [`Prueba ${sufijo}`]);
  const companyId = empresa.rows[0]!.id;
  const cuenta = async (channel: string) => (await pool.query<{ id: string }>(
    `INSERT INTO core.channel_accounts (company_id, channel, external_account, is_primary)
     VALUES ($1, $2, $3, true) RETURNING id`, [companyId, channel, `${channel}-${sufijo}`])).rows[0]!.id;
  const cuentaWoo = await cuenta('woocommerce');
  const cuentaMl = await cuenta('mercadolibre');
  const usuario = await pool.query<{ id: string }>(
    `INSERT INTO security.users (company_id, username, status) VALUES ($1, 'prueba', 'active') RETURNING id`,
    [companyId]);
  return { companyId, cuentaWoo, cuentaMl, userId: usuario.rows[0]!.id };
}

const TABLAS_PERMITIDAS = /^[a-z_]+\.[a-z_]+$/;

export async function limpiar(poolAdmin: pg.Pool, tablas: string[]): Promise<void> {
  for (const t of tablas) if (!TABLAS_PERMITIDAS.test(t)) throw new Error(`limpiar: tabla inválida ${t}`);
  if (tablas.length) await poolAdmin.query(`TRUNCATE ${tablas.join(', ')} CASCADE`);
}
