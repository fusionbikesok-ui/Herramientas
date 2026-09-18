import { execFileSync } from 'node:child_process';
import type { TestProject } from 'vitest/node';

const IMAGEN = 'postgres@sha256:1c59e2c3c818eaa0f0628f695b36e7c9e362d6b219b36a54a32df645cbd7e1af';
const NOMBRE = `plataforma-test-${process.pid}`;

function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim();
}

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
    pgHostPort: string;
    pgContenedor: string;
  }
}

function eliminarContenedor(): void {
  // Con -v: sin eso, cada corrida dejaba huérfano el volumen anónimo de PostgreSQL (198 volúmenes y 9,7 GB
  // acumulados al 2026-09-18, alerta de disco #36).
  try { docker('rm', '-f', '-v', NOMBRE); } catch { /* ya no existe */ }
}

export default async function setup(project: TestProject): Promise<() => void> {
  docker('run', '-d', '--rm', '--name', NOMBRE, '-e', 'POSTGRES_PASSWORD=admin', '-p', '127.0.0.1::5432', IMAGEN);
  try {
    let listo = false;
    for (let i = 0; i < 60; i++) {
      try { docker('exec', NOMBRE, 'pg_isready', '-U', 'postgres', '-q'); listo = true; break; } catch { await new Promise((r) => setTimeout(r, 1000)); }
    }
    if (!listo) throw new Error('PostgreSQL de prueba no quedó listo en 60 s');
    await new Promise((r) => setTimeout(r, 1500));
    const puerto = docker('port', NOMBRE, '5432/tcp').split(':').pop() ?? '';
    const sql = [
      "CREATE ROLE plataforma_migrador LOGIN PASSWORD 'migrador' NOSUPERUSER NOCREATEDB NOCREATEROLE",
      "CREATE ROLE plataforma_app LOGIN PASSWORD 'app' NOSUPERUSER NOCREATEDB NOCREATEROLE",
    ];
    for (const s of sql) docker('exec', NOMBRE, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-qc', s);
    project.provide('pgAdminUrl', `postgres://postgres:admin@127.0.0.1:${puerto}/postgres`);
    project.provide('pgHostPort', `127.0.0.1:${puerto}`);
    project.provide('pgContenedor', NOMBRE);
  } catch (error) {
    eliminarContenedor();
    throw error;
  }
  return eliminarContenedor;
}
