import pino from 'pino';

export function crearLogger(servicio: string, destino?: pino.DestinationStream): pino.Logger {
  const opciones: pino.LoggerOptions = {
    base: { servicio },
    messageKey: 'msg',
    redact: {
      paths: ['password', 'clave', 'token', 'email', '*.password', '*.token', '*.email', 'req.headers.cookie', 'req.headers.authorization', 'headers.cookie', 'headers.authorization'],
      censor: '[oculto]',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  return destino ? pino(opciones, destino) : pino(opciones);
}
