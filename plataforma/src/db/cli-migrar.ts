import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { migrar } from './migrar.ts';

const clave = readFileSync(process.env.PG_PASSWORD_FILE ?? '', 'utf8').trim();
const url = `postgres://${encodeURIComponent(process.env.PG_USER ?? '')}:${encodeURIComponent(clave)}@${process.env.PG_HOST ?? 'pg'}:${process.env.PG_PORT ?? '5432'}/${process.env.PG_DATABASE ?? 'plataforma'}`;
const dir = fileURLToPath(new URL('../../migrations', import.meta.url));
try {
  const aplicadas = await migrar(url, dir);
  console.log(JSON.stringify({ servicio: 'migrate', aplicadas }));
} catch (error) {
  console.error(JSON.stringify({ servicio: 'migrate', error: (error as Error).message }));
  process.exit(1);
}
