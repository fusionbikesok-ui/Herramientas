/*
 * src/informes/correo.ts — el aviso diario a José: semáforo, lo que necesita acción, y el sobre firmado
 * adjunto (E1-REC-01).
 *
 * El email es el aviso; la fuente de verdad es el objeto en B2 (PM-171). Por eso el cuerpo no repite el
 * reporte: en verde dice que no hay nada que hacer, y en amarillo o rojo muestra sólo lo accionable.
 *
 * La clave pública NO va pegada en el mensaje: quien falsifica el mensaje también pega su clave. Va el `kid`,
 * la huella y dónde está la pública, que es un canal independiente (el repositorio).
 *
 * El envío usa `nodemailer`, la misma librería del legado: EHLO, STARTTLS, AUTH, dot-stuffing y MIME ya
 * están resueltos ahí, y escribirlos a mano era riesgo gratis (hallazgo 22 de la revisión del plan).
 */
import nodemailer from 'nodemailer';
import type { Reporte } from './reporte.ts';

export interface DatosClave { kid: string; huella: string; ubicacion: string }

export interface Transporte { sendMail(opciones: Record<string, unknown>): Promise<unknown> }

export interface CfgCorreo {
  host: string;
  puerto: number;
  seguro: boolean;
  usuario: string;
  clave: string;
  desde: string;
  para: string;
  timeoutMs?: number;
  tamanoMaxBytes?: number;
  /** Para los tests: si no se pasa, se crea el transporte SMTP real. */
  transporte?: Transporte;
}

export interface Mensaje {
  asunto: string;
  texto: string;
  adjuntos: Array<{ nombre: string; contenido: string }>;
  /**
   * Identidad del mensaje, para que el receptor pueda descartar un duplicado. El envío es "al menos una vez"
   * a propósito (un día sin aviso es peor que un aviso repetido), pero si el servidor acepta y el proceso cae
   * antes de anotarlo, el reenvío llega como un mensaje nuevo salvo que lleve el mismo `Message-ID`. Se arma con
   * el día y el hash del contenido firmado, así el reenvío del MISMO informe se deduplica y un informe distinto
   * del mismo día no (hallazgo medio de la revisión de T4 del 2026-09-18).
   */
  identidad?: string;
}

const TIMEOUT_MS = 20_000;
const TAMANO_MAX = 5 * 1024 * 1024;

function sumarDias(fecha: string, dias: number): string {
  const d = new Date(`${fecha}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

export function armarCuerpo(reporte: Reporte, clave: DatosClave): { asunto: string; texto: string } {
  const asunto = `[${reporte.semaforo}] Sombra E1 ${reporte.fecha} — día ${reporte.dia_campana} de la campaña`;
  const lineas: string[] = [`Reporte de sombra del ${reporte.fecha}: ${reporte.semaforo}.`, ''];

  // Un salto en la numeración se ve solo, pero se nombra: un día sin reporte no se puede dar por limpio.
  const esperado = sumarDias(reporte.fecha, -1);
  if (reporte.reporte_anterior && reporte.reporte_anterior < esperado) {
    const desde = sumarDias(reporte.reporte_anterior, 1);
    lineas.push(desde === esperado
      ? `Atención: falta el reporte del ${desde}.`
      : `Atención: faltan los reportes del ${desde} al ${esperado}.`, '');
  }

  if (reporte.semaforo === 'verde') {
    lineas.push('Nada que requiera acción.');
  } else {
    lineas.push('Lo que necesita acción:');
    for (const [topic, t] of Object.entries(reporte.topicos)) {
      if (t.faltantes_sin_explicar) lineas.push(`- ${topic}: ${t.faltantes_sin_explicar} sin explicar`);
    }
    for (const a of reporte.alertas) {
      lineas.push(`- [${a.nivel}] ${a.codigo}${a.topic ? ` (${a.topic})` : ''}: ${a.mensaje}`);
    }
  }

  lineas.push('', 'El detalle completo está en el adjunto, firmado.',
    `Clave de firma: ${clave.kid}, huella SHA-256 ${clave.huella}.`,
    `La clave pública para verificarlo está en ${clave.ubicacion}; verificá con \`npm run verificar-informe\`.`);
  return { asunto, texto: lineas.join('\n') };
}

// Un salto de línea en un encabezado permite inyectar otros (un Bcc a un tercero, por ejemplo).
const SALTO = /[\r\n]/;

export async function enviar(cfg: CfgCorreo, mensaje: Mensaje): Promise<void> {
  if (SALTO.test(mensaje.asunto)) throw new Error('correo: el asunto tiene un salto de línea (inyección de encabezado)');
  for (const a of mensaje.adjuntos) {
    if (SALTO.test(a.nombre)) throw new Error('correo: el nombre del adjunto tiene un salto de línea (inyección de encabezado)');
  }
  const tope = cfg.tamanoMaxBytes ?? TAMANO_MAX;
  const tamano = mensaje.adjuntos.reduce((n, a) => n + Buffer.byteLength(a.contenido), Buffer.byteLength(mensaje.texto));
  if (tamano > tope) throw new Error(`correo: el mensaje pesa ${tamano} bytes, más que el tamaño máximo de ${tope}`);

  const timeout = cfg.timeoutMs ?? TIMEOUT_MS;
  const transporte: Transporte = cfg.transporte ?? nodemailer.createTransport({
    host: cfg.host, port: cfg.puerto, secure: cfg.seguro,
    auth: { user: cfg.usuario, pass: cfg.clave },
    connectionTimeout: timeout, greetingTimeout: timeout, socketTimeout: timeout,
  });
  // El dominio del Message-ID sale del remitente configurado: un identificador sin dominio propio lo reescriben
  // muchos servidores, y entonces deja de servir para deduplicar.
  const dominio = /@([^>\s]+)>?\s*$/.exec(cfg.desde)?.[1] ?? 'fusionbikes.local';
  const messageId = mensaje.identidad ? `<${mensaje.identidad}@${dominio}>` : undefined;
  if (messageId && SALTO.test(messageId)) throw new Error('correo: la identidad del mensaje tiene un salto de línea');
  await transporte.sendMail({
    from: cfg.desde, to: cfg.para, subject: mensaje.asunto, text: mensaje.texto,
    ...(messageId ? { messageId } : {}),
    attachments: mensaje.adjuntos.map((a) => ({ filename: a.nombre, content: a.contenido, contentType: 'application/json' })),
  });
}
