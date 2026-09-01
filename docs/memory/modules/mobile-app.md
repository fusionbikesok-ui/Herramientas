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
- La App debe validar iPhone y Android desde los primeros verticales.
- Preparación requiere conexión para mutar; inventario puede usar cola offline cifrada y acotada.

## Contrato y arquitectura

- `/opt/fusionbikes/herramientas/openapi/mobile-v1.yaml` es la fuente de verdad del contrato.
- El objetivo es publicar un artefacto generado por CI por commit de backend, fijarlo desde la App
  y verificar divergencias automáticamente. Las copias manuales son transitorias.
- Expo SDK 57, TypeScript, Expo Router, TanStack Query, Zustand limitado a estado local,
  SecureStore y cliente HTTP compartido son la arquitectura prevista.
- Refresh tokens y secretos permanecen en almacenamiento seguro; permisos e idempotencia se
  resuelven en backend.

## Orden de verticales

1. Autenticación, dispositivos, permisos y contrato real.
2. Bandeja, notificaciones, reclamos ML, deep links y tareas urgentes.
3. Consulta rápida de stock.
4. Movimientos, transferencias, picking y faltantes.
5. Recepción.
6. Conteos offline.
7. Devoluciones, daños, métricas y reposición.

Cada vertical móvil debe incluir estados vacío, cargando, sin permiso, error, reintento y conflicto,
además de E2E en iPhone y Android cuando sea posible.
