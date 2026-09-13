// Esperas de reintento y de ritmo entre llamadas, acortables sólo en la suite de tests.
//
// `vitest.config.js` define FUSION_ESPERAS_RAPIDAS=1: los backoff de reintento (500/1500/4000 ms)
// y las pausas entre llamadas a ML hacían que ~36 tests esperaran tiempo real (210 s de la suite,
// medido 2026-09-13) sin probar nada más que con 1 ms. Producción nunca define la variable.
//
// Se lee en cada llamada (no al cargar el módulo) para que un test que verifica el valor real
// —por ejemplo, el piso de 500 ms ante un Retry-After:0— pueda apagarla sólo para sí.
export function espera(ms) {
  return process.env.FUSION_ESPERAS_RAPIDAS === '1' ? Math.min(ms, 1) : ms;
}
