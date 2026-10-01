import { describe, expect, it, vi } from 'vitest';
import { resolverTransporteDeCorrida } from '../../src/identidad/transporte-canario.ts';
import type { CuentaRegistrada } from '../../src/reconciliacion/registro.ts';
import type { KeyringSobre } from '../../src/seguridad/sobre.ts';

const keyring: KeyringSobre = { activeKeyId: 'k1', keys: { k1: Buffer.alloc(32) } };
const cuentaA: CuentaRegistrada = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', channel: 'mercadolibre', external_account: 'A',
  base_url: 'http://gateway-a/', seller_id: '111', transporte: 'gateway',
};
const cuentaB: CuentaRegistrada = {
  id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', channel: 'mercadolibre', external_account: 'B',
  base_url: 'http://gateway-b/', seller_id: '222', transporte: 'gateway',
};

describe('resolverTransporteDeCorrida', () => {
  it('usa la cuenta persistida de la corrida, no la primera cuenta ML del registro', () => {
    const crearTransporteGateway = vi.fn(() => ({ get: vi.fn() }));
    const crearClienteCanal = vi.fn(() => ({ get: vi.fn() }));

    resolverTransporteDeCorrida([cuentaA, cuentaB], { channel_account_id: cuentaB.id }, {
      keyring, crearTransporteGateway, crearClienteCanal,
    });

    expect(crearTransporteGateway).toHaveBeenCalledWith({
      url: cuentaB.base_url, keyring, consumidor: 'identidad', sellerId: cuentaB.seller_id,
    });
    expect(crearTransporteGateway).not.toHaveBeenCalledWith(expect.objectContaining({ sellerId: cuentaA.seller_id }));
    expect(crearClienteCanal).not.toHaveBeenCalled();
  });
});
