# Integraciones MercadoLibre y WooCommerce

## Fuente normativa

Las reglas de negocio que no se rompen están en la sección homónima de `CLAUDE.md`. Leela
completa cuando una tarea toque ventas, pedidos, publicaciones, catálogo, precios o sync
ML/Woo; no hace falta para tareas ajenas a esas integraciones.

## Mapa de contexto

- Precio de contado y pedidos creados desde ventas ML: `CLAUDE.md` y `lib/mlPrecios.js`.
- Contratos HTTP relacionados: `docs/api-contrato.md`.
- Diseño o intención histórica: buscar primero en `docs/superpowers/plans/` por el nombre
  concreto de la función, sin cargar todos los planes.

## Contratos vigentes de Entrega 1

- La reasignación manual de un vínculo ML→Woo exige el SKU observado por el cliente y
  responde conflicto si otra operación lo cambió antes de escribir.
- Un timeout durante el primer PUT de tracking a Woo es un resultado incierto: se persiste y
  la UI no afirma que el tracking o el mail fueron confirmados hasta reconciliar con Woo.
- `pack_id` es la identidad canónica del paquete ML para preparación; las filas anteriores se
  completan desde pedidos sincronizados, incluso si la preparación ya fue cerrada.

## Cuándo actualizar

ML distingue `elegible`, `no_elegible` e `inconcluso`: faltan `shipping.id` o
`logistic_type` son inconclusos/fail-open; solo logística externa explícita permite
invalidar/podar. El cron poda ausencias únicamente con listado confiable.

Solo con decisiones verificadas que cambien contratos, invariantes, fuentes de datos o rutas
canónicas de esta integración. No dupliques reglas normativas: enlazalas a su única fuente.

- Las confirmaciones puntuales no elegibles de Woo o ML conservan la fila de `pedidos_cache`
  como `no_elegible` para no romper preparaciones/auditoría, pero la excluyen de la cola y
  del inicio; ML requiere `paid`, `ready_to_ship` y logística local.
