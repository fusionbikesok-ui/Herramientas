import { describe, it, expect } from 'vitest';
import path from 'path';
import { guardarArchivo, rutaAbsoluta } from '../utils/storage.js';

describe('rutaAbsoluta', () => {
  it('resuelve la url guardada a una ruta absoluta que coincide con el filepath real', () => {
    const saved = guardarArchivo({
      buffer: Buffer.from('x'), originalname: 'foto.jpg', mimetype: 'image/jpeg',
      importador: 'test-ruta-absoluta', numeroPedido: '999',
    });
    expect(rutaAbsoluta(saved.url)).toBe(path.resolve(saved.filepath));
  });
});
