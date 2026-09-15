import pg from 'pg';

export type Consultable = pg.Pool | pg.PoolClient | pg.Client;

export function crearPool(url: string, opciones: { max?: number; statementTimeoutMs?: number } = {}): pg.Pool {
  const config: pg.PoolConfig = {
    connectionString: url,
    max: opciones.max ?? 5,
    connectionTimeoutMillis: 2000,
  };
  if (opciones.statementTimeoutMs !== undefined) config.statement_timeout = opciones.statementTimeoutMs;
  return new pg.Pool(config);
}

export async function enTransaccion<T>(pool: pg.Pool, fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const resultado = await fn(cliente);
    await cliente.query('COMMIT');
    return resultado;
  } catch (error) {
    await cliente.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    cliente.release();
  }
}
