/*
 * src/informes/deposito.ts — la evidencia firmada sale del VPS a Backblaze B2, inmutable por 365 días.
 *
 * Object Lock en modo COMPLIANCE y no governance: governance protege contra alguien que entre al VPS, pero
 * una clave administrativa de la cuenta puede acortar la retención, y la evidencia tiene que resistir eso
 * (decisión de José del 2026-09-17, revisa PM-172). Es irreversible: lo subido queda un año.
 *
 * La retención se calcula sobre el momento del PUT, no sobre el día reportado: al recuperar días viejos,
 * contarla desde el día dejaría menos de 365 días reales (hallazgo 3 de la revisión del plan). Por eso vive
 * acá y no dentro del contenido firmado.
 *
 * SigV4 hecho a mano sobre `fetch`: son dos verbos, y el SDK de AWS pesa más que todo el módulo. El firmador
 * se prueba contra el vector publicado en la documentación de AWS, no contra una copia de sí mismo.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { LEASE_MS } from './entregas.ts';

export const RETENCION_DIAS = 365;
export const MARGEN_DIAS = 2;
const MAX_ERROR = 500;
const TIMEOUT_MS = 60_000;
/**
 * Tope duro del timeout de cada pedido a B2: un cuarto del permiso de entrega. Con un pedido que pueda durar
 * más que el permiso, otro proceso puede reclamar la entrega, no ver el objeto todavía y subir una SEGUNDA
 * versión, que en modo compliance queda un año (hallazgo alto de la revisión de T4 del 2026-09-18).
 */
export const TOPE_TIMEOUT_MS = LEASE_MS / 4;

export interface Credencial { id: string; clave: string }

export interface CfgDeposito {
  endpoint: string;
  region: string;
  bucket: string;
  prefijo: string;
  escritura: Credencial;
  lectura: Credencial;
  dirPendientes: string;
  fetch?: typeof fetch;
  /** Tope de cada pedido a B2, en ms. Como máximo `TOPE_TIMEOUT_MS`: un pedido colgado más que el permiso de
   *  entrega deja que otro proceso repita el efecto. */
  timeoutMs?: number;
}

/** Lo que hay en B2 para una clave: su versión, su retención y el SHA-256 del contenido que se subió. */
export interface ObjetoB2 { versionId: string; retencion: string; modo: string; sha256: string | null }

export interface Deposito {
  guardarPendiente(clave: string, cuerpo: string): Promise<string>;
  subir(clave: string, cuerpo: string, ahora: Date): Promise<{ versionId: string; retencion: string }>;
  consultar(clave: string): Promise<ObjetoB2 | null>;
  /** Versiones de una clave: si está oculta por un marcador de borrado y cuál es la versión retenida. */
  versiones(clave: string): Promise<{ oculto: boolean; versionRetenida: string | null }>;
  limpiarPendiente(ruta: string): Promise<void>;
}

const sha256 = (datos: string | Buffer) => createHash('sha256').update(datos).digest('hex');
const hmac = (clave: string | Buffer, datos: string) => createHmac('sha256', clave).update(datos).digest();

/** Codifica una ruta S3 segmento por segmento: `/` separa y no se escapa. */
function codificarRuta(ruta: string): string {
  return ruta.split('/').map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
}

/** `20260917T100000Z`, el formato de fecha de SigV4. */
export function fechaAmz(instante: Date): string {
  return instante.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * Firma SigV4 de un pedido S3. `cabeceras` tiene que incluir `host`, `x-amz-date` y `x-amz-content-sha256`;
 * todas las que se pasen se firman. Devuelve el valor completo de `Authorization`.
 */
export function firmarSigV4(p: {
  metodo: string; ruta: string; consulta: string; cabeceras: Record<string, string>;
  hashCuerpo: string; region: string; credencial: Credencial;
}): string {
  const nombres = Object.keys(p.cabeceras).map((k) => k.toLowerCase()).sort();
  const minusculas = Object.fromEntries(Object.entries(p.cabeceras).map(([k, v]) => [k.toLowerCase(), v.trim()]));
  const canonicas = nombres.map((k) => `${k}:${minusculas[k]}\n`).join('');
  const firmadas = nombres.join(';');
  const pedidoCanonico = [p.metodo, p.ruta, p.consulta, canonicas, firmadas, p.hashCuerpo].join('\n');
  const fechaLarga = minusculas['x-amz-date'];
  if (!fechaLarga) throw new Error('firmarSigV4: falta x-amz-date');
  const dia = fechaLarga.slice(0, 8);
  const alcance = `${dia}/${p.region}/s3/aws4_request`;
  const aFirmar = ['AWS4-HMAC-SHA256', fechaLarga, alcance, sha256(pedidoCanonico)].join('\n');
  const claveFirma = hmac(hmac(hmac(hmac(`AWS4${p.credencial.clave}`, dia), p.region), 's3'), 'aws4_request');
  const firma = createHmac('sha256', claveFirma).update(aFirmar).digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${p.credencial.id}/${alcance}, SignedHeaders=${firmadas}, Signature=${firma}`;
}

async function errorDe(r: Response, accion: string): Promise<Error> {
  // El cuerpo de error de S3 no lleva secretos, pero se recorta: puede ser una página HTML entera.
  const cuerpo = (await r.text().catch(() => '')).slice(0, MAX_ERROR);
  return new Error(`B2 ${accion} falló: ${r.status} ${cuerpo}`);
}

export function crearDeposito(cfg: CfgDeposito): Deposito {
  const timeoutMs = cfg.timeoutMs ?? TIMEOUT_MS;
  if (!(timeoutMs > 0) || timeoutMs > TOPE_TIMEOUT_MS) {
    throw new Error(`timeoutMs de B2 inválido: ${timeoutMs} ms; tiene que estar entre 1 y ${TOPE_TIMEOUT_MS} ms`);
  }
  const hacer = cfg.fetch ?? fetch;
  const host = new URL(cfg.endpoint).host;
  const rutaDe = (clave: string) => `/${cfg.bucket}/${codificarRuta(clave)}`;

  // El depósito sólo escribe dentro de su prefijo: la credencial también está acotada a él, y un error de
  // armado de clave no puede terminar en otra parte del bucket.
  const dentroDelPrefijo = (clave: string) => {
    if (!clave.startsWith(cfg.prefijo) || clave.includes('..')) throw new Error(`clave fuera del prefijo ${cfg.prefijo}: ${clave}`);
  };

  const pedir = async (
    metodo: string, clave: string, consulta: string, extra: Record<string, string>,
    cuerpo: string, credencial: Credencial, ahora: Date,
  ) => {
    dentroDelPrefijo(clave);
    const ruta = rutaDe(clave);
    const hashCuerpo = sha256(cuerpo);
    const cabeceras: Record<string, string> = {
      host, 'x-amz-content-sha256': hashCuerpo, 'x-amz-date': fechaAmz(ahora), ...extra,
    };
    const authorization = firmarSigV4({ metodo, ruta, consulta, cabeceras, hashCuerpo, region: cfg.region, credencial });
    const { host: _host, ...enviar } = cabeceras;
    return hacer(`${cfg.endpoint}${ruta}${consulta ? `?${consulta}` : ''}`, {
      method: metodo,
      headers: { ...enviar, authorization },
      ...(metodo === 'PUT' ? { body: cuerpo } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  };

  const consultar = async (clave: string): Promise<ObjetoB2 | null> => {
    // Con la credencial de LECTURA: si se filtra la de escritura, no sirve para leer, y al revés.
    // Primero HEAD, que da la versión vigente y el hash que se mandó al subir; después la retención de ESA
    // versión: GET ?retention no documenta devolver la versión en B2, así que no se puede confiar en eso.
    const cabeza = await pedir('HEAD', clave, '', {}, '', cfg.lectura, new Date());
    if (cabeza.status === 404) return null;
    if (!cabeza.ok) throw await errorDe(cabeza, 'HEAD');
    const versionId = cabeza.headers.get('x-amz-version-id');
    if (!versionId) throw new Error('B2 HEAD no devolvió x-amz-version-id: ¿el bucket tiene Object Lock?');
    const r = await pedir('GET', clave, `retention=&versionId=${encodeURIComponent(versionId)}`, {}, '', cfg.lectura, new Date());
    if (!r.ok) throw await errorDe(r, 'GET retention');
    const xml = await r.text();
    const modo = /<Mode>([^<]+)<\/Mode>/.exec(xml)?.[1];
    const retencion = /<RetainUntilDate>([^<]+)<\/RetainUntilDate>/.exec(xml)?.[1];
    if (!modo || !retencion) throw new Error('B2 GET retention devolvió una respuesta incompleta');
    return { versionId, retencion, modo, sha256: cabeza.headers.get('x-amz-meta-sha256') };
  };

  /**
   * Verificado contra B2 real el 2026-09-18: la credencial de escritura **puede** hacer un DELETE, porque en B2
   * el permiso de escritura incluye ocultar. En un bucket con versionado eso no destruye nada —crea un marcador
   * y la versión retenida sigue ahí, recuperable pidiéndola por su id— pero un cliente normal recibe 404. O sea
   * que la evidencia es indestructible y aun así se puede volver invisible. Esto lo hace detectable.
   */
  const versiones = async (clave: string): Promise<{ oculto: boolean; versionRetenida: string | null }> => {
    const r = await pedir('GET', '', `versions=&prefix=${encodeURIComponent(clave)}&max-keys=50`, {}, '', cfg.lectura, new Date());
    if (!r.ok) throw await errorDe(r, 'GET versions');
    const xml = await r.text();
    // Se miran sólo las entradas de ESTA clave exacta: el prefijo puede traer vecinas.
    const bloques = [...xml.matchAll(/<(Version|DeleteMarker)>([\s\S]*?)<\/\1>/g)]
      .map((m) => {
        const tipo = m[1] ?? '';
        const bloque = m[2] ?? '';
        return {
          tipo,
          clave: /<Key>([^<]*)<\/Key>/.exec(bloque)?.[1] ?? '',
          id: /<VersionId>([^<]*)<\/VersionId>/.exec(bloque)?.[1] ?? null,
          ultima: /<IsLatest>true<\/IsLatest>/.test(bloque),
        };
      })
      .filter((b) => b.clave === clave);
    const oculto = bloques.some((b) => b.tipo === 'DeleteMarker' && b.ultima);
    const versionRetenida = bloques.find((b) => b.tipo === 'Version')?.id ?? null;
    return { oculto, versionRetenida };
  };

  return {
    async guardarPendiente(clave, cuerpo) {
      // Temporal, fsync y renombre: un corte de luz deja el archivo entero o no lo deja.
      const ruta = join(cfg.dirPendientes, clave.replace(/[^A-Za-z0-9._-]/g, '_'));
      // Temporal con nombre único: con uno fijo, un corte entre crearlo y renombrarlo dejaba un huérfano que
      // hacía fallar con EEXIST todos los reintentos siguientes.
      const tmp = `${ruta}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        const fd = openSync(tmp, 'wx', 0o600);
        try {
          writeSync(fd, cuerpo);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(tmp, ruta);
      } catch (error) {
        try { unlinkSync(tmp); } catch { /* ya no está */ }
        throw error;
      }
      return ruta;
    },

    async subir(clave, cuerpo, ahora) {
      const retener = new Date(ahora.getTime() + (RETENCION_DIAS + MARGEN_DIAS) * 86_400_000);
      const r = await pedir('PUT', clave, '', {
        'x-amz-object-lock-mode': 'COMPLIANCE',
        'x-amz-object-lock-retain-until-date': retener.toISOString(),
        // B2 exige Content-MD5 (o un x-amz-checksum-*) en todo PUT que traiga parámetros de Object Lock, y
        // rechaza con 400 InvalidRequest si falta. Verificado contra B2 real el 2026-09-18: el simulador de los
        // tests no lo exigía, así que esto sólo aparece probando de verdad.
        'content-md5': createHash('md5').update(cuerpo, 'utf8').digest('base64'),
        // El hash viaja como metadato para que un reintento pueda saber si lo que ya está es esto mismo.
        'x-amz-meta-sha256': sha256(cuerpo),
      }, cuerpo, cfg.escritura, ahora);
      if (!r.ok) throw await errorDe(r, 'PUT');
      const versionId = r.headers.get('x-amz-version-id');
      // Sin versión no hay forma de probar después qué se subió: se trata como fallo.
      if (!versionId) throw new Error('B2 PUT no devolvió x-amz-version-id: ¿el bucket tiene Object Lock?');
      // Se relee lo que quedó: que la retención sea COMPLIANCE y llegue a la fecha pedida (diseño §7).
      const leido = await consultar(clave);
      if (!leido || leido.modo !== 'COMPLIANCE' || Date.parse(leido.retencion) < retener.getTime() - 1000) {
        throw new Error(`B2 no confirmó la retención: ${leido ? `${leido.modo} hasta ${leido.retencion}` : 'objeto no encontrado'}`);
      }
      return { versionId, retencion: retener.toISOString() };
    },

    consultar,

    versiones,

    async limpiarPendiente(ruta) {
      unlinkSync(ruta);
    },
  };
}
