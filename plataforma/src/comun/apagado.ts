import type pino from 'pino';

export function alApagar(logger: pino.Logger, fn: () => Promise<void>, limiteMs = 10_000): void {
  let apagando = false;
  const manejar = (senal: string) => {
    if (apagando) return;
    apagando = true;
    logger.info({ senal }, 'apagando');
    const limite = setTimeout(() => { logger.error('apagado excedió el límite; se fuerza la salida'); process.exit(1); }, limiteMs);
    fn().then(() => { clearTimeout(limite); process.exit(0); }, (error: unknown) => {
      clearTimeout(limite); logger.error({ err: (error as Error).message }, 'error al apagar'); process.exit(1);
    });
  };
  process.once('SIGTERM', () => manejar('SIGTERM'));
  process.once('SIGINT', () => manejar('SIGINT'));
}
