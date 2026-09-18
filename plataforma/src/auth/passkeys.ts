/*
 * src/auth/passkeys.ts — registro, login y reautenticación con passkeys (E1-WA-01).
 *
 * En E1 esto existe pero no se usa: las rutas responden 503 mientras no estén encendidas las DOS llaves
 * (`passkeysHabilitadas`). Se prueba con un autenticador virtual; el uso real llega con E4, junto con el
 * dominio, HTTPS y la prueba en dispositivos.
 *
 * Reglas que no se aflojan:
 * - El desafío vive en la base (`security.webauthn_challenges`), con propósito, vencimiento y un solo uso. Se
 *   consume ANTES de verificar y queda consumido aunque la verificación falle: un desafío no se reintenta.
 * - `rpID` y el origen salen de la configuración, nunca del pedido.
 * - Se exige verificación de usuario (huella, cara o PIN), no sólo presencia.
 * - El contador de firmas sigue la regla de la librería, que sólo exige que avance cuando alguno de los dos
 *   contadores es mayor que cero: hay autenticadores sincronizados que informan siempre 0.
 */
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type AuthenticatorTransport, type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { Consultable } from '../db/pool.ts';

export interface CfgPasskeys { rpID: string; rpNombre: string; origen: string }
export type Proposito = 'registro' | 'login' | 'reautenticacion';

export const VIGENCIA_DESAFIO_MS = 5 * 60_000;

export class ErrorPasskey extends Error { override name = 'ErrorPasskey'; }

/**
 * Las dos llaves: la fila `passkeys.real` en true Y la variable de entorno PASSKEYS_HABILITADAS=1, que en
 * producción no existe. Con una sola, un UPDATE en la base habilitaba autenticación real sin dominio ni HTTPS.
 */
export async function passkeysHabilitadas(db: Consultable, entorno: Record<string, string | undefined>): Promise<boolean> {
  if (entorno.PASSKEYS_HABILITADAS !== '1') return false;
  const r = await db.query<{ enabled: boolean }>(`SELECT enabled FROM security.feature_flags WHERE code = 'passkeys.real'`);
  return r.rows[0]?.enabled === true;
}

const uuidABytes = (uuid: string) => Uint8Array.from(Buffer.from(uuid.replaceAll('-', ''), 'hex'));

async function guardarDesafio(db: Consultable, proposito: Proposito, desafio: string, userId: string | null, ahora: Date) {
  await db.query(
    `INSERT INTO security.webauthn_challenges (proposito, desafio, user_id, creado_en, vence_en) VALUES ($1, $2, $3, $4, $5)`,
    [proposito, desafio, userId, ahora, new Date(ahora.getTime() + VIGENCIA_DESAFIO_MS)],
  );
}

/** Lee el desafío que firmó el autenticador, del clientDataJSON de la respuesta. */
function desafioDe(clientDataJSON: string): string {
  try {
    const datos = JSON.parse(Buffer.from(clientDataJSON, 'base64url').toString('utf8')) as { challenge?: unknown };
    if (typeof datos.challenge === 'string') return datos.challenge;
  } catch { /* cae al error de abajo */ }
  throw new ErrorPasskey('respuesta sin desafío legible');
}

/**
 * Consume el desafío: tiene que existir, ser de este propósito (y usuario, si aplica), no estar usado ni
 * vencido. En la misma sentencia se marca usado, así dos pedidos simultáneos no lo pueden usar los dos.
 */
async function consumir(db: Consultable, desafio: string, proposito: Proposito, userId: string | null, ahora: Date) {
  const r = await db.query<{ user_id: string | null }>(
    `UPDATE security.webauthn_challenges SET usado_en = $4
      WHERE desafio = $1 AND proposito = $2 AND ($3::uuid IS NULL OR user_id = $3::uuid)
        AND usado_en IS NULL AND vence_en > $4
      RETURNING user_id`,
    [desafio, proposito, userId, ahora],
  );
  if (!r.rows[0]) throw new ErrorPasskey('desafío inválido, vencido, ya usado o de otro propósito');
}

export async function iniciarRegistro(db: Consultable, cfg: CfgPasskeys, usuario: { id: string; nombre: string }, ahora: Date) {
  const existentes = await db.query<{ credential_id: Buffer; transports: string[] }>(
    `SELECT credential_id, transports FROM security.webauthn_credentials WHERE user_id = $1 AND revoked_at IS NULL`, [usuario.id]);
  const opciones = await generateRegistrationOptions({
    rpName: cfg.rpNombre, rpID: cfg.rpID, userName: usuario.nombre, userID: uuidABytes(usuario.id),
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    // No se deja registrar dos veces el mismo autenticador.
    excludeCredentials: existentes.rows.map((c) => ({
      id: c.credential_id.toString('base64url'), transports: c.transports as AuthenticatorTransport[],
    })),
  });
  await guardarDesafio(db, 'registro', opciones.challenge, usuario.id, ahora);
  return opciones;
}

export async function terminarRegistro(
  db: Consultable, cfg: CfgPasskeys, usuario: { id: string }, respuesta: RegistrationResponseJSON, ahora: Date,
  etiqueta: string | null = null,
): Promise<{ credentialId: string }> {
  const desafio = desafioDe(respuesta.response.clientDataJSON);
  await consumir(db, desafio, 'registro', usuario.id, ahora);
  const v = await verifyRegistrationResponse({
    response: respuesta, expectedChallenge: desafio, expectedOrigin: cfg.origen, expectedRPID: cfg.rpID,
    requireUserVerification: true,
  }).catch((e: Error) => { throw new ErrorPasskey(`registro rechazado: ${e.message}`); });
  if (!v.verified) throw new ErrorPasskey('registro rechazado');
  const { credential, aaguid, credentialBackedUp, credentialDeviceType } = v.registrationInfo;
  await db.query(
    `INSERT INTO security.webauthn_credentials
       (credential_id, user_id, public_key, sign_count, transports, aaguid, backup_eligible, backup_state, device_label, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [Buffer.from(credential.id, 'base64url'), usuario.id, Buffer.from(credential.publicKey), credential.counter,
      credential.transports ?? [], aaguid, credentialDeviceType === 'multiDevice', credentialBackedUp, etiqueta, ahora],
  );
  return { credentialId: credential.id };
}

export async function iniciarAutenticacion(
  db: Consultable, cfg: CfgPasskeys, proposito: 'login' | 'reautenticacion', usuarioId: string | null, ahora: Date,
) {
  if (proposito === 'reautenticacion' && !usuarioId) throw new ErrorPasskey('reautenticar exige una sesión');
  const opciones = await generateAuthenticationOptions({ rpID: cfg.rpID, userVerification: 'required' });
  await guardarDesafio(db, proposito, opciones.challenge, usuarioId, ahora);
  return opciones;
}

export async function terminarAutenticacion(
  db: Consultable, cfg: CfgPasskeys, proposito: 'login' | 'reautenticacion', usuarioId: string | null,
  respuesta: AuthenticationResponseJSON, ahora: Date,
): Promise<{ userId: string }> {
  const desafio = desafioDe(respuesta.response.clientDataJSON);
  await consumir(db, desafio, proposito, proposito === 'reautenticacion' ? usuarioId : null, ahora);
  const fila = (await db.query<{ user_id: string; public_key: Buffer; sign_count: string; transports: string[] }>(
    `SELECT user_id, public_key, sign_count::text, transports FROM security.webauthn_credentials
      WHERE credential_id = $1 AND revoked_at IS NULL`,
    [Buffer.from(respuesta.rawId, 'base64url')],
  )).rows[0];
  if (!fila) throw new ErrorPasskey('credencial desconocida o revocada');
  // Reautenticar confirma que es la MISMA persona de la sesión, no cualquiera con una passkey válida.
  if (proposito === 'reautenticacion' && fila.user_id !== usuarioId) throw new ErrorPasskey('la credencial es de otro usuario');
  const v = await verifyAuthenticationResponse({
    response: respuesta, expectedChallenge: desafio, expectedOrigin: cfg.origen, expectedRPID: cfg.rpID,
    requireUserVerification: true,
    credential: {
      id: respuesta.rawId, publicKey: new Uint8Array(fila.public_key), counter: Number(fila.sign_count),
      transports: fila.transports as AuthenticatorTransport[],
    },
  }).catch((e: Error) => { throw new ErrorPasskey(`autenticación rechazada: ${e.message}`); });
  if (!v.verified) throw new ErrorPasskey('autenticación rechazada');
  await db.query(
    `UPDATE security.webauthn_credentials SET sign_count = $2, backup_state = $3, last_used_at = $4 WHERE credential_id = $1`,
    [Buffer.from(respuesta.rawId, 'base64url'), v.authenticationInfo.newCounter, v.authenticationInfo.credentialBackedUp, ahora],
  );
  return { userId: fila.user_id };
}

