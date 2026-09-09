import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { crearBackupVerificado } from '../lib/gestionPedidosBackup.js';

describe('backup controlado de Gestión de pedidos', () => {
  it('crea una copia verificable y conserva los pedidos', async () => {
    const db = new Database(':memory:');
    db.exec("CREATE TABLE gestion_pedidos (id INTEGER PRIMARY KEY, numero_visible TEXT); INSERT INTO gestion_pedidos VALUES (1, '#GP9');");
    const archivo = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gp9-')), 'gestion.sqlite');
    const resultado = await crearBackupVerificado(db, archivo);
    expect(resultado).toMatchObject({ ok: true, integridad: 'ok', pedidos: 1 });
    expect(fs.existsSync(archivo)).toBe(true); db.close();
  });
});
