import pg from 'pg';

export type Consultable = pg.Pool | pg.PoolClient | pg.Client;

export function crearPool(
  url: string,
  opciones: { max?: number; statementTimeoutMs?: number; alError?: (error: Error) => void } = {},
): pg.Pool {
  const config: pg.PoolConfig = {
    connectionString: url,
    max: opciones.max ?? 5,
    connectionTimeoutMillis: 2000,
  };
  if (opciones.statementTimeoutMs !== undefined) config.statement_timeout = opciones.statementTimeoutMs;
  const pool = new pg.Pool(config);
  // Una conexión ociosa que muere (reinicio de PostgreSQL, corte de red) emite `error` sobre el Pool. Sin
  // manejador, Node lo trata como excepción no capturada y tira el proceso entero; con él, `pg` descarta
  // esa conexión y la próxima consulta abre otra. Sólo el mensaje: nunca la cadena de conexión.
  pool.on('error', (error) => {
    if (opciones.alError) opciones.alError(error);
    else console.error(JSON.stringify({ nivel: 'warn', msg: 'conexión de PostgreSQL perdida en el pool', err: error.message }));
  });
  return pool;
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
