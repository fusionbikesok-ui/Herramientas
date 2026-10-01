import { crearClienteCanal } from '../reconciliacion/cliente-http.ts';
import type { TransporteCanal } from '../reconciliacion/cliente-http.ts';
import { crearTransporteGateway } from '../reconciliacion/transporte-gateway.ts';
import type { CuentaRegistrada } from '../reconciliacion/registro.ts';
import type { KeyringSobre } from '../seguridad/sobre.ts';

interface CorridaCanario {
  channel_account_id: string | null;
}

interface DependenciasTransporteCanario {
  keyring: KeyringSobre;
  crearTransporteGateway: (opciones: Parameters<typeof crearTransporteGateway>[0]) => TransporteCanal;
  crearClienteCanal: (opciones: Parameters<typeof crearClienteCanal>[0]) => TransporteCanal;
}

/** Resuelve la cuenta congelada y arma el transporte que usa el runner de E3. */
export function resolverTransporteDeCorrida(
  registro: readonly CuentaRegistrada[],
  corrida: CorridaCanario,
  dependencias: DependenciasTransporteCanario,
): TransporteCanal {
  if (!corrida.channel_account_id) throw new Error('canario: la corrida no tiene channel_account_id; no se puede resolver la cuenta ML');
  const cuenta = registro.find((c) => c.channel === 'mercadolibre' && c.id === corrida.channel_account_id);
  if (!cuenta || cuenta.channel !== 'mercadolibre') throw new Error(`canario: la cuenta ${corrida.channel_account_id} de la corrida no está en el registro ML`);
  return cuenta.transporte === 'gateway'
    ? dependencias.crearTransporteGateway({ url: cuenta.base_url, keyring: dependencias.keyring, consumidor: 'identidad', sellerId: cuenta.seller_id })
    : dependencias.crearClienteCanal({ baseUrl: cuenta.base_url });
}
