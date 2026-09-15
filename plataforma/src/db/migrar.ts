import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

export class ErrorMigracion extends Error {
  override name = 'ErrorMigracion';
}

const PATRON = /^(\d{4})_[a-z0-9_]+\.sql$/;
const LOCK = "hashtextextended('plataforma.migraciones', 0)";

interface Archivo { nombre: string; numero: number; sql: string; sha256: string }

function leerArchivos(directorio: string): Archivo[] {
  const archivos = readdirSync(directorio).filter((n) => n.endsWith('.sql')).sort().map((nombre) => {
    const m = PATRON.exec(nombre);
    if (!m) throw new ErrorMigracion(`nombre de migración inválido: ${nombre}`);
    const sql = readFileSync(join(directorio, nombre), 'utf8');
    return { nombre, numero: Number(m[1]), sql, sha256: createHash('sha256').update(sql).digest('hex') };
  });
  archivos.forEach((a, i) => {
    if (a.numero !== i + 1) throw new ErrorMigracion(`hueco o repetición en la numeración de migraciones: se esperaba ${String(i + 1).padStart(4, '0')} y está ${a.nombre}`);
  });
  return archivos;
}

export async function migrar(url: string, directorio: string): Promise<string[]> {
  const archivos = leerArchivos(directorio);
  const cliente = new pg.Client({ connectionString: url });
  await cliente.connect();
  try {
    await cliente.query(`SELECT pg_advisory_lock(${LOCK})`);
    await cliente.query('CREATE SCHEMA IF NOT EXISTS core');
    await cliente.query(`CREATE TABLE IF NOT EXISTS core.schema_migrations (
      nombre text PRIMARY KEY, sha256 text NOT NULL, aplicada_en timestamptz NOT NULL DEFAULT now())`);
    const aplicadas = new Map((await cliente.query<{ nombre: string; sha256: string }>('SELECT nombre, sha256 FROM core.schema_migrations')).rows.map((r) => [r.nombre, r.sha256]));
    for (const [nombre] of aplicadas) {
      if (!archivos.some((a) => a.nombre === nombre)) throw new ErrorMigracion(`la migración aplicada ${nombre} ya no existe en el directorio`);
    }
    const nuevas: string[] = [];
    for (const archivo of archivos) {
      const sha = aplicadas.get(archivo.nombre);
      if (sha !== undefined) {
        if (sha !== archivo.sha256) throw new ErrorMigracion(`la migración ${archivo.nombre} cambió después de aplicarse`);
        continue;
      }
      await cliente.query('BEGIN');
      try {
        await cliente.query(archivo.sql);
        await cliente.query('INSERT INTO core.schema_migrations (nombre, sha256) VALUES ($1, $2)', [archivo.nombre, archivo.sha256]);
        await cliente.query('COMMIT');
      } catch (error) {
        await cliente.query('ROLLBACK');
        throw new ErrorMigracion(`falló ${archivo.nombre}: ${(error as Error).message}`);
      }
      nuevas.push(archivo.nombre);
    }
    return nuevas;
  } finally {
    await cliente.query(`SELECT pg_advisory_unlock(${LOCK})`).catch(() => undefined);
    await cliente.end();
  }
}
