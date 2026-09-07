# App móvil FusionBikes

## Fuente y base

- Repositorio: `fusionbikesok-ui/FusionBikes-App`.
- Rama de trabajo elegida: `feature/stock-flow-ui`.
- La App consume únicamente `/api/v1`; no accede directamente a WooCommerce, MercadoLibre ni
  servicios internos del VPS.
- El backend canónico es `/opt/fusionbikes/herramientas`.

## Estado verificado

- `main` es un scaffold Expo. `feature/app-foundation` contiene base de autenticación/API y
  `feature/stock-flow-ui` agrega prototipos, mocks y auth/biometría/push parcial.
- El prototipo de stock con edición absoluta no es el diseño aprobado; debe reemplazarse por
  movimientos, ubicaciones, tareas, conteos y recepción.
- La App se diseña y valida primero para iPhone. Android queda fuera hasta que exista demanda concreta.
- Toda operación de piso puede capturarse offline sobre tareas reclamadas y descargadas, pero queda provisional hasta aceptación del servidor; decisiones comerciales y confirmaciones finales esperan conexión.

## Contrato y arquitectura

- `/opt/fusionbikes/herramientas/openapi/mobile-v1.yaml` es la fuente de verdad del contrato.
- `InboxItem` expone aditivamente `kind` (`mensaje`, `pregunta`, `reclamo`, `pedido`, `otro`) y
  `priority` sin cambiar la versión `1.0.0`; filas antiguas se presentan como `otro`/`normal`.
- El objetivo E5 es publicar un artefacto generado por CI por commit de backend, fijarlo desde la App
  y verificar divergencias automáticamente. Las copias manuales son transitorias.
- Expo SDK 57, TypeScript, Expo Router, TanStack Query, Zustand limitado a estado local,
  SecureStore y cliente HTTP compartido son la arquitectura prevista.
- Refresh tokens y secretos permanecen en almacenamiento seguro; permisos e idempotencia se
  resuelven en backend.

## Orden E0–E24 relevante para App

1. E5: autenticación, dispositivos, permisos y contrato real en iPhone.
2. E6–E7: bandeja, reclamos ML, alertas, deep links y turnos.
3. E12–E13: tareas de stock y base offline común.
4. E15 y E17: recepción y conteos iPhone/offline.
5. E18–E19: excepciones y garantías.
6. E21: taller iPhone/offline.
7. E22: métricas, reposición, entrante y preventa.

Cada vertical móvil incluye vacío, carga, sin permiso, error, reintento, conflicto y sincronización. Cierra con E2E en un iPhone real. El lease offline máximo es 12 horas y la cola cifrada se conserva hasta siete días, sin `last-write-wins`.
## Estado E21

E21 está en desarrollo en `/opt/fusionbikes/FusionBikes-App`, rama `feature/stock-flow-ui`.
Los commits `36a1d28`, `514605e`, `86bfb8d`, `8083318`, `06c3544` y `3237077` agregan el cliente
tipado, pantalla móvil, cola offline ordenada, SecureStore, edición local y encolado de acciones
de taller con lease de 12 horas y replay detenido ante conflictos. `2e8416c` agrega el contrato
de evidencia fotográfica offline, `5016189` prepara cámara/permisos, `fac7975` la asocia al
trabajo, `ecb401e` la encola en SecureStore y `17d4e28` prepara el replay multipart autenticado.
El backend expone `/api/v1/workshop` desde `ca2d2c0`, `eddd245` fija las rutas en OpenAPI y
`2d4ea96` envía el binario multipart de la URI local y `76a6c4b` inicia el replay al abrir sesión.
La ruta de evidencia exige `operation_id`; las mutaciones tipadas incluyen identificador de dispositivo. El smoke aislado de E21 verificó autenticación, multipart e idempotencia: 25 tests dirigidos aprobados el 2026-09-03. Falta validarlo en dispositivo real.
No hay build publicada; falta conectar captura real y validar `/api/v1` en un iPhone.
