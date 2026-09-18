import { describe, it, expect } from 'vitest';
import { armarCuerpo, enviar } from '../../src/informes/correo.ts';

const REPORTE = {
  tipo: 'reporte' as const, fecha: '2026-09-16',
  ventana: { desde: '2026-09-16T03:00:00.000Z', hasta: '2026-09-17T03:00:00.000Z' },
  topicos: { 'woo.orders': { senales_legado: 10, senales_nucleo: 10, faltantes: 0, faltantes_sin_explicar: 0, cobertura: 1, convergencia: 1, descartadas: 0 } },
  faltantes_sin_explicar: 0, alertas: [], semaforo: 'verde' as const, dia_campana: 3, reporte_anterior: '2026-09-15',
};
const CLAVE = { kid: 'k1', huella: 'AAAA', ubicacion: 'docs/superpowers/specs/e1/firma-informes.pub' };

describe('armarCuerpo', () => {
  it('el asunto lleva semáforo, fecha y día de campaña', () => {
    expect(armarCuerpo(REPORTE, CLAVE).asunto).toBe('[verde] Sombra E1 2026-09-16 — día 3 de la campaña');
  });

  it('en verde no enumera los tópicos: sólo dice que no hay nada que hacer', () => {
    const { texto } = armarCuerpo(REPORTE, CLAVE);
    expect(texto).toMatch(/Nada que requiera acción/);
    expect(texto).not.toMatch(/woo\.orders/);
  });

  it('en rojo detalla lo que necesita acción', () => {
    const { texto, asunto } = armarCuerpo({
      ...REPORTE, semaforo: 'rojo', faltantes_sin_explicar: 2,
      topicos: { ...REPORTE.topicos, 'ml.orders': { senales_legado: 5, senales_nucleo: 3, faltantes: 2, faltantes_sin_explicar: 2, cobertura: 0.6, convergencia: null, descartadas: 0 } },
      alertas: [{ nivel: 'alta' as const, codigo: 'senal_vieja', mensaje: 'Señal activa de más de 15 min' }],
    }, CLAVE);
    expect(asunto).toMatch(/^\[rojo\]/);
    expect(texto).toMatch(/ml\.orders.*2 sin explicar/s);
    expect(texto).toMatch(/senal_vieja/);
  });

  it('el cuerpo identifica la clave sin pegarla', () => {
    const { texto } = armarCuerpo(REPORTE, CLAVE);
    expect(texto).toMatch(/k1/); expect(texto).toMatch(/AAAA/);
    expect(texto).not.toMatch(/BEGIN PUBLIC KEY/);
  });

  it('avisa cuando falta el reporte del día anterior', () => {
    expect(armarCuerpo({ ...REPORTE, fecha: '2026-09-16', reporte_anterior: '2026-09-13' }, CLAVE).texto)
      .toMatch(/faltan los reportes del 2026-09-14 al 2026-09-15/);
  });
});

describe('enviar', () => {
  const CFG = { host: 'smtp', puerto: 587, seguro: false, usuario: 'u', clave: 'clave-smtp-secreta', desde: 'a@b', para: 'c@d' };

  it('manda el adjunto por nodemailer y no filtra la clave', async () => {
    const visto: Array<Record<string, unknown>> = [];
    await enviar({ ...CFG, transporte: { async sendMail(m: Record<string, unknown>) { visto.push(m); return {}; } } },
      { asunto: 'x', texto: 'y', adjuntos: [{ nombre: 'reporte.json', contenido: '{"a":1}' }] });
    expect(visto[0]).toMatchObject({ from: 'a@b', to: 'c@d', subject: 'x' });
    expect(visto[0]!.attachments).toEqual([{ filename: 'reporte.json', content: '{"a":1}', contentType: 'application/json' }]);
    // La clave SMTP es credencial del transporte, no parte del mensaje: no puede aparecer en lo que se envía.
    expect(JSON.stringify(visto)).not.toContain('clave-smtp-secreta');
  });

  it('rechaza un adjunto más grande que el tope', async () => {
    await expect(enviar({ ...CFG, tamanoMaxBytes: 10, transporte: { async sendMail() { return {}; } } },
      { asunto: 'x', texto: 'y', adjuntos: [{ nombre: 'r.json', contenido: 'z'.repeat(50) }] }))
      .rejects.toThrow(/tama/);
  });

  it('rechaza saltos de línea en el asunto y en el nombre del adjunto', async () => {
    const transporte = { async sendMail() { return {}; } };
    await expect(enviar({ ...CFG, transporte }, { asunto: 'x\r\nBcc: otro@d', texto: 'y', adjuntos: [] }))
      .rejects.toThrow(/encabezado/);
    await expect(enviar({ ...CFG, transporte },
      { asunto: 'x', texto: 'y', adjuntos: [{ nombre: 'r\n.json', contenido: '{}' }] })).rejects.toThrow(/encabezado/);
  });

  it('un rechazo del servidor se propaga', async () => {
    await expect(enviar({ ...CFG, transporte: { async sendMail() { throw new Error('451 try later'); } } },
      { asunto: 'x', texto: 'y', adjuntos: [] })).rejects.toThrow(/451/);
  });
});
