import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { guardarArchivo, rutaAbsoluta } from '../utils/storage.js';

describe('rutaAbsoluta', () => {
  afterAll(() => {
    fs.rmSync(path.join(__dirname, '..', 'uploads', 'test-ruta-absoluta'), { recursive: true, force: true });
  });

  it('resuelve la url guardada a una ruta absoluta que coincide con el filepath real', () => {
    const saved = guardarArchivo({
      buffer: Buffer.from('x'), originalname: 'foto.jpg', mimetype: 'image/jpeg',
      importador: 'test-ruta-absoluta', numeroPedido: '999',
    });
    expect(rutaAbsoluta(saved.url)).toBe(path.resolve(saved.filepath));
  });
});
