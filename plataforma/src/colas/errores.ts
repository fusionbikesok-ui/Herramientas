// El procesador lanza ErrorTransitorio (408/429/5xx, red) o ErrorIncierto (respuesta perdida tras un
// posible efecto). Cualquier otro error es terminal.
export class ErrorTransitorio extends Error { override name = 'ErrorTransitorio'; }
export class ErrorIncierto extends Error { override name = 'ErrorIncierto'; }
export class ErrorLeaseVencido extends Error { override name = 'ErrorLeaseVencido'; }
