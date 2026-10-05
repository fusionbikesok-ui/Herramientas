import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const html = fs.readFileSync('./public/sync-ml/index.html', 'utf8');

describe('Sincronización: pausadas con stock (UI)', () => {
  it('tiene la caja, el filtro por causa y la reactivación manual por lote ≤50', () => {
    expect(html).toContain('id="pausadas-box"');
    expect(html).toContain('/api/sync/pausadas-con-stock');
    expect(html).toContain('/api/sync/pausadas-con-stock/reactivar');
    expect(html).toMatch(/i\+=50/);
  });
  it('pide confirmación antes de reactivar y arranca sin nada tildado', () => {
    expect(html).toMatch(/function reactivarPausadas[\s\S]*confirm\(/);
    expect(html).toContain('id="btn-react-pausadas" onclick="reactivarPausadas()" disabled');
  });
  it('muestra el contador solo_local y trata los avisos sin pausa como no-error', () => {
    expect(html).toContain('solo local');
    expect(html).toContain('c.nota||c.pausa_error');
  });
  it('ofrece reactivar al cerrar un aviso cuando el backend lo propone', () => {
    expect(html).toContain('d.oferta_reactivar');
  });
});
