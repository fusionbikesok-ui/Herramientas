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
import { createHash, createHmac } from 'node:crypto';
import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export const RETENCION_DIAS = 365;
export const MARGEN_DIAS = 2;
const MAX_ERROR = 500;

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
}

export interface Deposito {
  guardarPendiente(clave: string, cuerpo: string): Promise<string>;
  subir(clave: string, cuerpo: string, ahora: Date): Promise<{ versionId: string; retencion: string }>;
  consultar(clave: string): Promise<{ versionId: string; retencion: string; modo: string } | null>;
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
  const hacer = cfg.fetch ?? fetch;
  const host = new URL(cfg.endpoint).host;
  const rutaDe = (clave: string) => `/${cfg.bucket}/${codificarRuta(clave)}`;

  const pedir = async (
    metodo: string, clave: string, consulta: string, extra: Record<string, string>,
    cuerpo: string, credencial: Credencial, ahora: Date,
  ) => {
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
    });
  };

  return {
    async guardarPendiente(clave, cuerpo) {
      // Temporal, fsync y renombre: un corte de luz deja el archivo entero o no lo deja.
      const ruta = join(cfg.dirPendientes, clave.replace(/[^A-Za-z0-9._-]/g, '_'));
      const tmp = `${ruta}.tmp`;
      const fd = openSync(tmp, 'wx', 0o600);
      try {
        writeSync(fd, cuerpo);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, ruta);
      return ruta;
    },

    async subir(clave, cuerpo, ahora) {
      const retener = new Date(ahora.getTime() + (RETENCION_DIAS + MARGEN_DIAS) * 86_400_000);
      const r = await pedir('PUT', clave, '', {
        'x-amz-object-lock-mode': 'COMPLIANCE',
        'x-amz-object-lock-retain-until-date': retener.toISOString(),
      }, cuerpo, cfg.escritura, ahora);
      if (!r.ok) throw await errorDe(r, 'PUT');
      const versionId = r.headers.get('x-amz-version-id');
      // Sin versión no hay forma de probar después qué se subió: se trata como fallo.
      if (!versionId) throw new Error('B2 PUT no devolvió x-amz-version-id: ¿el bucket tiene Object Lock?');
      return { versionId, retencion: retener.toISOString() };
    },

    async consultar(clave) {
      // Con la credencial de LECTURA: si se filtra la de escritura, no sirve para leer, y al revés.
      const r = await pedir('GET', clave, 'retention=', {}, '', cfg.lectura, new Date());
      if (r.status === 404) return null;
      if (!r.ok) throw await errorDe(r, 'GET retention');
      const xml = await r.text();
      const modo = /<Mode>([^<]+)<\/Mode>/.exec(xml)?.[1];
      const retencion = /<RetainUntilDate>([^<]+)<\/RetainUntilDate>/.exec(xml)?.[1];
      const versionId = r.headers.get('x-amz-version-id');
      if (!modo || !retencion || !versionId) throw new Error('B2 GET retention devolvió una respuesta incompleta');
      return { versionId, retencion, modo };
    },

    async limpiarPendiente(ruta) {
      unlinkSync(ruta);
    },
  };
}
