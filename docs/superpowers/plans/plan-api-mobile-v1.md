# Plan: API móvil v1 (`/api/v1`)

Índice general en `plan-maestro-v2.md`. Tracker de ejecución en `tracker-app-mobile.md` (lado
app) — este documento es el lado backend/contrato. Enfoque **contract-first**: el contrato
OpenAPI se escribe y se congela antes de tocar código real, para que la app avance en paralelo
contra mocks sin esperar al backend.

**Cuándo arranca**: recién cuando A.2 y A.3 (`tracker-operacion-tiempo-real.md`) estén
cerradas, revisadas, auditadas y desplegadas — no antes. El motivo no es técnico (no hay
conflicto de archivos, ver más abajo), es de foco: es la misma sesión/pipeline la que viene
trabajando esos ítems, y mezclar objetivos a mitad de camino es la forma más fácil de perder
contexto en ambos.

**No toca**: `routes/` del backend actual, SQLite, la integración con ML/Woo, ni el plan
operativo de `tracker-operacion-tiempo-real.md`/`tracker-plan-jose.md`/
`tracker-plan-preparacion.md`. Cuando este plan sí necesite tocar backend (Bloque 4 en
adelante), lo hace agregando, no reescribiendo — ver Bloque 5 (separación de lógica).

## Bloque 1 — Repos y ramas

- App en repo separado: `fusionbikesok-ui/FusionBikes-App` (React Native + TypeScript, Expo
  con development builds salvo que aparezca una necesidad nativa que lo impida). iPhone
  primero, preparado para Android desde el día 1 (sin código específico de plataforma que
  asuma iOS únicamente).
- Backend sigue en `fusionbikesok-ui/Herramientas`. Cuando A.2/A.3 cierren, se crea
  `feature/mobile-api-v1` desde el último `conteo-confiable` estable.
- El desarrollador móvil no toca `routes/` del backend actual, SQLite, ML, webhooks, ni los
  archivos de `docs/superpowers/plans/` de sync en tiempo real/inventario/preparación.

## Bloque 2 — Contrato API compartido (contract-first)

Archivo: `openapi/mobile-v1.yaml` en el repo `Herramientas` (vive con el backend porque es su
contrato, aunque lo consuma la app). Debe cubrir, con ejemplos realistas y permisos por
endpoint:

```
POST   /api/v1/auth/login
POST   /api/v1/auth/refresh
POST   /api/v1/auth/logout
GET    /api/v1/me

POST   /api/v1/devices
DELETE /api/v1/devices/:id

GET    /api/v1/products/lookup?code=
POST   /api/v1/stock/adjustments
GET    /api/v1/operations/:id

GET    /api/v1/orders
GET    /api/v1/orders/:id

GET    /api/v1/today

GET    /api/v1/notifications
POST   /api/v1/notifications/:id/read
```

Cada endpoint documenta la respuesta correcta y los errores aplicables entre `401`, `403`,
`404`, `409`, `422`, `500` (no todos aplican a todos — ver el YAML para el detalle por
endpoint). La app genera o centraliza su cliente TypeScript a partir de este contrato
(`openapi-typescript` o equivalente) y trabaja inicialmente contra un mock server o fixtures
derivados del propio OpenAPI (`prism mock openapi/mobile-v1.yaml` es la opción más directa,
evaluar si conviene fijarla como estándar del proyecto).

**Regla del contrato**: cambiar el YAML es el evento que dispara aviso a ambos lados (app y
backend) — nunca cambiar la forma real de una respuesta sin actualizarlo primero. El YAML es
la fuente de verdad, no el código de ningún lado.

## Bloque 3 — Trabajo paralelo de la app

Cubierto en detalle en `tracker-app-mobile.md`. Resumen de lo que puede arrancar de inmediato,
contra mocks, sin esperar backend real: navegación, sistema visual, login simulado,
Keychain/Keystore, Face ID/biometría, pantalla "Hoy", escáner SKU/EAN, búsqueda manual,
detalle de producto, modificación de stock con sus 4 estados (enviando/sincronizando con
ML/sincronizado/error), lista y detalle de pedidos, registro de dispositivo, deep links desde
notificaciones simuladas, manejo de errores/offline/conflictos.

## Bloque 4 — Trabajo del backend (después de A.2/A.3)

Estado: implementación backend completada en `conteo-confiable`; pruebas dirigidas verdes.
La app registra cada dispositivo con su refresh token vigente y eliminarlo revoca la familia
de refresh tokens asociada. Pendiente únicamente el gate operativo de despliegue/configuración
del secreto en el entorno que vaya a ejecutar la API móvil.

### Decisión de autenticación (2026-08-28)

Para la app móvil se implementará JWT con access token de vida corta y refresh token
revocable por dispositivo. El panel web conserva `express-session` por cookie. No se agrega
JWT al backend de Hito 7 de forma aislada: se implementará junto con login, refresh, logout,
revocación y sus pruebas del Bloque 4, reutilizando `users`/`user_permisos` y la tabla de
dispositivos ya creada por Hito 7.

- Prefijo `/api/v1`, autenticación por access token + refresh token (JWT o equivalente),
  **separada** del `express-session` de cookies que ya usa el panel web — no migrar el panel a
  tokens, son dos mecanismos de auth coexistiendo sobre las mismas tablas de usuario.
- Refresh tokens revocables por dispositivo (tabla nueva, ej. `mobile_refresh_tokens` con
  `device_id`, `revocado_en`).
- Registro de dispositivos (`POST /api/v1/devices` / `DELETE /api/v1/devices/:id`) — necesario
  para revocación y para push (Bloque 8).
- `GET /api/v1/me` — perfil + permisos del usuario autenticado.
- Roles y permisos: **reusar `users`/`user_permisos`** (`db/index.js`, `lib/permisos.js`), ya
  existen y ya modelan roles — no crear un sistema de permisos paralelo.
- Validación de entradas, respuestas y errores uniformes (mismo shape de error en todos los
  endpoints — definirlo una vez en el OpenAPI y reusarlo).
- Auditoría de accesos y operaciones (quién hizo qué, desde qué dispositivo — reusar el patrón
  de auditoría que ya existe para otras acciones del panel si aplica, no inventar uno nuevo).
- Documentación OpenAPI actualizada a medida que se implementa (no diverge del contrato
  congelado en Bloque 2 sin aviso).
- Tests de contrato, autenticación, permisos, revocación e idempotencia.

**El panel web sigue con sus sesiones de cookies.** No hay ningún plan de migrar el panel a
tokens — son necesidades distintas (sesión de escritorio de larga duración vs. token corto +
refresh para móvil).

## Bloque 5 — Separación de lógica de negocio (progresiva, no un big-bang)

Arquitectura objetivo:

```
Panel web  → rutas web  → servicios de negocio
App móvil  → /api/v1    → los mismos servicios de negocio
Servicios  → SQLite, WooCommerce, Mercado Libre
```

Hoy la lógica vive inline en las rutas Express (`routes/woo.js`, `routes/recepciones.js`,
`routes/preparacion.js`, etc. — confirmado en el código real, no hay capa de servicio
separada todavía). Extraer progresivamente, **solo cuando `/api/v1` necesite la misma lógica**
(no adelantar el refactor sin un segundo consumidor real):

- Consulta de productos (`routes/codigos.js`, `routes/consultaPrecios.js` hoy).
- Modificación de stock (`syncSkuPuntual` ya está en `routes/sync.js`, reusable tal cual; el
  ajuste con control de concurrencia del Bloque 6 es lógica NUEVA, no extraída).
- Pedidos (`pedidos_cache`, alimentado por `routes/preparacion.js`).
- Preparación.
- Preguntas y mensajes (`routes/notificacionesMl.js`).
- Reclamos (cuando A.4 los implemente).
- Usuarios, permisos y auditoría (`lib/permisos.js`, `routes/usuarios.js`).

## Bloque 6 — Modificación segura de stock

**No** un `PATCH` simple que escriba una cantidad sin control de concurrencia — es exactamente
el gap que ya existe hoy en `/api/woo/stock/aplicar` y
`/api/recepciones/:id/confirmar` (confirmado en el código: ninguno de los dos verifica el
stock esperado antes de escribir). `POST /api/v1/stock/adjustments` corrige esto desde el
diseño:

```json
{
  "client_request_id": "uuid",
  "sku": "FB-1234",
  "expected_stock": 5,
  "requested_stock": 7,
  "reason": "ajuste_manual"
}
```

El backend debe:
1. Comprobar que `client_request_id` no haya sido procesado (idempotencia real, no solo
   deduplicación por tiempo).
2. Releer el stock actual.
3. Devolver `409` si ya no coincide con `expected_stock` (optimistic locking — mismo patrón
   que ya existe en `routes/cobertura.js` con `expected_sku`/`ya_resuelto`, ver
   `plan-consolidacion-ramas.md`).
4. Actualizar WooCommerce.
5. Ejecutar `syncSkuPuntual` hacia ML (ya existe, reusar tal cual — ver seguimientos BAJO en
   `tracker-operacion-tiempo-real.md` antes de exponerlo a un consumidor nuevo).
6. Crear y devolver un `operation_id`.
7. Informar por separado el estado en WooCommerce y en ML — **nunca afirmar que ML está
   sincronizado antes de confirmarlo** (mismo criterio de honestidad que ya aplica
   `sync_ml` en A.2: `sincronizado`/`sin_cambios`/`error`/`omitido`, no un genérico "ok").
8. Permitir consultar el resultado en `GET /api/v1/operations/:id` (la operación puede tardar
   más que el request HTTP si `syncSkuPuntual` reintenta — mismo problema de latencia que ya
   se resolvió en A.2 moviendo el push fuera del camino síncrono cuando hacía falta).

## Bloque 7 — Pedidos

La app **no crea una segunda cola de pedidos**. Consume `pedidos_cache`, ya alimentado por los
webhooks de A.1 y respaldado por los crons existentes — es la ventaja directa de que A.1 ya
esté cerrado antes de que esto arranque.

`GET /api/v1/orders` con filtros:
- `status=new` / `status=preparing`
- `channel=ml` / `channel=web`
- `assigned_to=me`
- `updated_after=<fecha>`

La identidad del pedido y la idempotencia permanecen en el backend (`pedidos_cache` ya tiene
su propio upsert `ON CONFLICT` — la API móvil es de solo lectura sobre esto, no reimplementa
nada).

## Bloque 8 — Eventos, tareas y notificaciones

Después de los primeros endpoints (Bloques 4/6/7), crear una entrada durable para eventos —
confirmado que **no existe hoy** (`integration_events` no aparece en el código, es trabajo
enteramente nuevo):

- `integration_events`: payload original, tópico, recurso, fecha de recepción, estado,
  cantidad de intentos, último error, deduplicación, reintentos con backoff.
- Worker separado del receptor HTTP: el webhook responde rápido (como ya hace hoy) y deja el
  procesamiento al worker — es un cambio de arquitectura respecto al webhook actual, que
  procesa inline dentro del handler HTTP (`server.js`, `POST /api/woo/webhook/order` y
  `POST /api/ml/notificacion`). Los crons actuales siguen de respaldo, sin tocarlos.

Sobre esos eventos, el modelo de pendientes: prioridad, responsable, estado, vencimiento,
origen, enlace al recurso, historial de acciones. **No todo webhook genera una tarea** — solo
cuando una regla explícita requiere intervención humana.

Primeras notificaciones móviles (con deep link a la pantalla exacta):
- Pregunta nueva.
- Mensaje postventa.
- Reclamo (depende de A.4).
- Pedido nuevo para preparar.
- Error al sincronizar stock (depende de Bloque 6).

## Seguridad — checklist antes de exponer `/api/v1` a producción

- [ ] Tokens con expiración corta + refresh, revocación real por dispositivo (probada con
      test, no solo documentada).
- [ ] Ningún endpoint de escritura sin idempotencia si puede reintentarse desde la app
      (reintentos de red son la norma en móvil, no la excepción).
- [ ] Rate limiting básico en `/api/v1/auth/login` (fuerza bruta contra biometría/PIN local no
      es problema del backend, pero el login sí).
- [ ] Todos los endpoints declaran sus permisos en el OpenAPI y el middleware los aplica —sin
      excepciones "porque total es de lectura".
- [ ] `docs/api-contrato.md` (el del panel web) y `openapi/mobile-v1.yaml` no se contradicen
      donde describan el mismo recurso de negocio (ej. stock, pedidos).
