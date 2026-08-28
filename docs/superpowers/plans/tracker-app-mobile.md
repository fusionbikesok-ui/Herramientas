# Tracker: App móvil FusionBikes

Repo: `fusionbikesok-ui/FusionBikes-App` (React Native + TypeScript, Expo con development
builds salvo necesidad nativa que lo impida). iPhone primero, Android preparado desde el día 1.
Plan de contrato/backend en `plan-api-mobile-v1.md`. Índice general en `plan-maestro-v2.md`.

Este archivo trackea el estado de ejecución por entrega — mismo patrón que
`tracker-plan-jose.md`/`tracker-plan-preparacion.md`.

## Principio: entregas verticales, no capas

Cada entrega cierra con una prueba de integración real entre la app y la API (real, no mock)
antes de pasar a la siguiente. No se espera al final del proyecto para integrar todo de una
vez — el riesgo de integración se reparte entrega por entrega.

## Estado

Decisión vigente: la app móvil usará access tokens JWT cortos y refresh tokens revocables por
dispositivo. El panel web seguirá usando cookies de sesión; ambos mecanismos coexistirán.

| Entrega | App | Backend | Estado |
|---|---|---|---|
| **0 — Setup** | Repo creado, Expo + TS, navegación base, sistema visual, cliente TS generado desde `openapi/mobile-v1.yaml`, mock server/fixtures funcionando | `openapi/mobile-v1.yaml` congelado (v1 inicial) | ⬜ Sin empezar |
| **1 — Acceso** | Login (contra mock primero), biometría (Face ID / Android biometric), manejo de sesión (access+refresh en Keychain/Keystore), estados offline | Login, refresh, logout, `/me`, registro y revocación de dispositivos | ⬜ Sin empezar (backend depende de A.2/A.3 cerrados) |
| **2 — Stock** | Escáner SKU/EAN, búsqueda manual, detalle de producto, edición de stock, estados (enviando/sincronizando ML/sincronizado/error), manejo de conflicto 409 | `products/lookup`, `stock/adjustments` idempotente con `expected_stock`, `operations/:id` | ⬜ Sin empezar |
| **3 — Pedidos** | Lista, filtros (`status`/`channel`/`assigned_to`/`updated_after`), detalle, indicador de pedido nuevo | Adaptador de solo lectura sobre `pedidos_cache`, filtros, permisos, paginación | ⬜ Sin empezar |
| **4 — Hoy** | Tarjetas por prioridad, contadores, accesos directos | Agregador de pedidos + stock + mensajes + preguntas + reclamos + tareas | ⬜ Sin empezar |
| **5 — Notificaciones** | Registro push, preferencias, deep links a la pantalla exacta | Dispositivos, integración APNs/FCM, reglas de envío, registro de entrega y errores | 🟡 Backend Hito 7 implementado; app e integración APNs/FCM pendientes |

## Fuera de alcance de este tracker (ya cubierto en otro lado)

- Todo lo del backend genérico de sync ML↔Woo, inventario y preparación → sus propios
  trackers (`tracker-operacion-tiempo-real.md`, `tracker-plan-jose.md`,
  `tracker-plan-preparacion.md`). La app no toca esos flujos directamente, solo los consume
  vía `/api/v1`.
- Consolidación `master`/`conteo-confiable` → `plan-consolidacion-ramas.md`. No bloquea el
  arranque de esta app, pero conviene que ambos no corran en paralelo sin coordinarse (ver
  nota en ese documento).

## Riesgos específicos de la app (a validar temprano, no al final)

- **Expo vs. nativo**: si Face ID/biometría, notificaciones push, o el escáner de
  cámara/EAN necesitan algo que Expo managed/dev-client no cubre, decidirlo en la Entrega 0/1,
  no descubrirlo en la Entrega 5. `expo-local-authentication`, `expo-notifications` y
  `expo-camera`/`expo-barcode-scanner` (o `vision-camera` si hace falta más control) cubren la
  mayoría de los casos con development builds — confirmar antes de comprometerse a Expo
  managed puro.
- **Android desde el día 1**: no es "portar después" — decisiones de biometría (BiometricPrompt
  vs. Face ID) y push (FCM vs. APNs) tienen que estar en el diseño de la Entrega 1 y 5 aunque
  el primer build real sea solo iOS/TestFlight.
- **Mocks fieles al contrato**: si el mock server no refleja fielmente los 4 estados de
  `sync_ml`/`operations` (incluido `omitido`, que ya demostró en A.2 ser un estado real y no
  cosmético), la app va a construir una UI que no cubre el caso real cuando el backend esté
  listo. Generar los fixtures del mock directamente desde ejemplos del OpenAPI, no a mano por
  separado.

## TestFlight / builds

(Completar cuando exista el primer build real — placeholder para no perder el tracking desde
el arranque.)

| Build | Fecha | Entrega cubierta | Notas |
|---|---|---|---|
| — | — | — | — |
