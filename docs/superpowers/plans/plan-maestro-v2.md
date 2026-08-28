# Plan maestro v2 — FusionBikes (Herramientas + App móvil)

Índice y tablero de estado. No repite detalle histórico — cada bloque linkea al documento que
sí lo tiene. Reemplaza a `2026-08-26-plan-maestro-consolidado.md` como punto de entrada
(ese archivo queda como referencia histórica de cómo se llegó hasta acá, no se borra).

## Contexto

- **Backend**: `fusionbikesok-ui/Herramientas` (Node/Express ESM, better-sqlite3, vitest).
  Rama de producción real: `conteo-confiable` (no `master` — líneas divergentes, ver
  `plan-consolidacion-ramas.md`).
- **App móvil**: `fusionbikesok-ui/FusionBikes-App` (React Native + TypeScript, Expo).
  Repo separado, arranca en paralelo al backend usando un contrato OpenAPI congelado — no
  espera a que existan endpoints reales.
- **Regla operativa no negociable**: todo cambio de código del backend pasa por el pipeline
  `hard-worker → revisor → tester/probador-e2e → auditor-despliegue` antes de mergear a
  `conteo-confiable`. La app móvil tiene su propio ciclo (ver `tracker-app-mobile.md`), pero
  cualquier cambio que sí toque `Herramientas` (el contrato OpenAPI, los endpoints reales de
  `/api/v1`) sigue el mismo pipeline.
- **Dos personas en paralelo**: una en la app móvil, otra en los endpoints del backend. El
  punto de sincronización entre ambas es el contrato OpenAPI
  (`openapi/mobile-v1.yaml`, ver `plan-api-mobile-v1.md`) — no se coordinan por Slack sobre la
  forma de cada respuesta, se coordinan editando ese archivo.

## Documentos del plan

| Documento | Qué cubre |
|---|---|
| `tracker-operacion-tiempo-real.md` | A.1–A.4: sync ML↔Woo en tiempo real (venta→Preparación, stock→ML, reclamos). |
| `plan-api-mobile-v1.md` | Contrato OpenAPI, seguridad, extracción de servicios, ajuste de stock idempotente, pedidos, eventos durables — lado backend de la app móvil. |
| `tracker-app-mobile.md` | Entregas verticales de la app (pantallas, builds, TestFlight, riesgos de Expo/nativo). |
| `plan-consolidacion-ramas.md` | Unificar `master` y `conteo-confiable` en una sola línea. |
| `tracker-plan-jose.md` | Conteo programado / control de stock por ciclos (ya existía, sin cambios de este reorden). |
| `tracker-plan-preparacion.md` | Preparación de envíos: provincia, direcciones, notas, vínculos, despacho (ya existía, sin cambios de este reorden). |

## Cola de prioridad (orden general)

1. ~~**A.2 y A.3 cerradas** (backend Herramientas)~~ — ✅ **ambas desplegadas** (corrección
   2026-08-28: A.3 estaba marcada "sin empezar" por un doc desactualizado; ya estaba
   implementada desde el 2026-08-27 y se confirmó activa en producción). Ver
   `tracker-operacion-tiempo-real.md`.
2. **En paralelo a lo anterior**: crear el repo de la app y el contrato OpenAPI inicial
   (`openapi/mobile-v1.yaml`). La app arranca contra mocks/fixtures derivados de ese contrato
   sin esperar al punto 1.
3. Tras cerrar A.2/A.3: crear `feature/mobile-api-v1` desde el último `conteo-confiable`
   estable.
4. Implementar autenticación y dispositivos (Entrega 1 de `tracker-app-mobile.md` +
   Bloque 4 de `plan-api-mobile-v1.md`). Primera integración real app↔API.
5. Implementar stock idempotente con control de concurrencia (Entrega 2 + Bloque 6).
6. Implementar pedidos de solo lectura sobre `pedidos_cache` (Entrega 3 + Bloque 7).
7. Pantalla "Hoy" (Entrega 4).
8. Eventos durables (`integration_events` + worker) y notificaciones push (Entrega 5 +
   Bloque 8).
9. **A.4** (reclamos ML) y el resto de `tracker-plan-jose.md`/`tracker-plan-preparacion.md`
   continúan en paralelo, sin depender de la app móvil — son trabajo del mismo backend pero de
   otro dominio (conteo, preparación) y ya tienen sus propios trackers y prioridad interna.
10. **Consolidación `master`/`conteo-confiable`** — proyecto independiente, se ejecuta cuando
    no haya sesiones trabajando en vivo sobre esas ramas (repetir la verificación del Paso 0
    de `plan-consolidacion-ramas.md` cuando se retome, no asumir que sigue vigente).

No hay que completar todo en ese orden estricto — es la prioridad relativa. Puede adelantarse
un ítem si el usuario lo pide.

## Reglas de convivencia entre las dos personas (app / backend)

- **El desarrollador móvil no toca**: `routes/`, `lib/`, SQLite, ML/Woo, webhooks, ni ninguno
  de los archivos de `tracker-operacion-tiempo-real.md`/`tracker-plan-jose.md`/
  `tracker-plan-preparacion.md`/`plan-consolidacion-ramas.md`. Su único punto de contacto con
  el repo `Herramientas` es `openapi/mobile-v1.yaml` (proponer cambios, no aplicarlos sin
  acuerdo) y, más adelante, código dentro de `feature/mobile-api-v1` una vez que esa rama
  exista.
- **El desarrollador de backend no bloquea a la app** esperando para definir el contrato — el
  OpenAPI se escribe con ejemplos realistas ANTES de implementar, y se ajusta si al
  implementar aparece algo que el contrato no prevé (avisando al lado móvil, no cambiando en
  silencio).
- **Ningún lado dedujo el estado del otro** — este documento y sus trackers son la fuente de
  verdad del estado, no lo que cada uno recuerda de la última conversación.

## Deuda operativa dispersa (no bloqueante, hacer cuando haya hueco)

- Rotar `WOO_CS` (quedó expuesto en `/tmp` el 2026-08-10).
- Completar `WOO_WEBHOOK_SECRET` en el `.env` del VPS (tarea operativa del usuario: sin esto
  el webhook de Woo acepta cualquier payload sin validar firma HMAC — obtenerlo desde
  WooCommerce → Ajustes → Avanzado → Webhooks → editar → copiar secreto).
- ~~**`test/auditoria.test.js` tiene un fallo FUNCIONAL preexistente**~~ — ✅ **corregido**
  (2026-08-27, commit `be2baf9`): la causa raíz era `reservarCupo('lectura', {})` pasando un
  string donde `lib/mlRateLimiter.js` esperaba un array (`recursos.every is not a function`),
  lo que hacía que `barridoAuditoria` nunca auditara nada en producción pese a correr en
  horario. Fixeado a `reservarCupo(['lectura'], {})`, test corregido, PM2 reiniciado. Este
  archivo ya no es una falla conocida — si vuelve a fallar, es una regresión real, no lo
  descartes como preexistente sin investigar.
- **Fallas de suite completa reales, distintas de las de arriba** (auditoría de despliegue del
  Hito 6, 2026-08-28): `test/recepciones.test.js` (`NO serializa productos distintos...`) y
  `test/sync.test.js` (`atencion/:cat: total es el COUNT real...`) fallan también aislados y
  también sobre `conteo-confiable` limpio — son las fallas preexistentes reales hoy, no
  `test/auditoria.test.js`. Actualizar también `docs/agent-coordination.md`, que todavía
  nombra a `auditoria.test.js` como la única falla que "aparece SIEMPRE".
- Timeout intermitente de `test/matcherPush.test.js` bajo suite completa — aumentar timeout o
  aislar mejor si sigue molestando.
- Asignar el permiso `notificaciones-ml` a quien corresponda desde la pantalla de Usuarios
  (nadie lo tiene todavía, el aviso del Home no se le muestra a nadie hasta asignarlo).
- Confirmar la URL real del link "Ver en MercadoLibre" en el aviso del Home
  (`https://myaccount.mercadolibre.com.ar/questions/list` — no se pudo verificar en vivo
  contra el panel real, bajo impacto si está mal).

## Historial

Este plan reorganiza `2026-08-26-plan-maestro-consolidado.md` para separar el trabajo de la
API móvil (proyecto nuevo, contract-first, repo separado) del trabajo operativo del backend
que ya venía en curso. El archivo viejo no se borra — queda como registro de cómo se llegó a
este punto, incluido el detalle completo de A.1 y A.2 antes de que se movieran a
`tracker-operacion-tiempo-real.md`.
