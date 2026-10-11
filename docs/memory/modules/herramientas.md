# Herramientas de `public/`

Una fila por herramienta servida desde `public/`, con su ruta (`/herramientas/<carpeta>/`), endpoints principales, documentación y estado. El destino acordado (4 herramientas más depósito y operación) está en [`docs/superpowers/specs/2026-10-03-consolidacion-herramientas.md`](../../superpowers/specs/2026-10-03-consolidacion-herramientas.md); el contrato HTTP en [`docs/api-contrato.md`](../../api-contrato.md).

Estados: **vigente** (queda), **se fusiona/absorbe en X** (sigue viva hasta su fase) y **retirada, ver E14** (se archiva o apaga en la entrega E14; hoy sigue servida). Actualizá esta tabla cuando una herramienta cambie de estado.

## Destino: las 4 herramientas que quedan

| Herramienta | Qué hace | Ruta | Endpoints principales | Doc | Estado |
|---|---|---|---|---|---|
| Catálogo y vínculos | Una pantalla y un único escritor (motor de Identidad) para vincular publicaciones ML con productos Woo. Hoy repartida en Matcher, Identidad y Bandeja | `/catalogo-vinculos/` (Fase D; `/matcher/`, `/identidad-productos/`, `/guardia-ml/`, `/bandeja-identidad/` redirigen) | `/api/catalogo-vinculos/*` (más `/api/matcher/*`, `/api/identidad-productos`, `/api/bandeja-identidad` heredadas) | spec de consolidación (Fase D); `public/matcher/*.md` se reescriben o archivan en la Fase B | vigente; pantalla única pendiente (Fase D) |
| Sincronización ML | Estado de la conexión y de los flujos, lista «Para resolver» por gravedad (errores, pausadas con stock, ventas sin producto, frenadas por precio, cambios de producto), menú «Correr ahora» y ventas ML | `/sync-ml/` (+ `/sync-ml/pausadas/`) | `/api/sync/dashboard`, `/frenadas`, `/cambios-formato`, `/pausadas-con-stock[/reactivar]`, `/reactivar` | `modules/integrations-ml-woo.md`, `modules/ui-ux.md`, `docs/api-contrato.md` | vigente (rediseñada 2026-10-05) |
| Precios ML | Auditoría de precios de ML contra el contado y corrección | `/precios/` | `/api/precios/objetivo`, `/actualizar-precio`, `/actualizar-precio-item`, `/recalcular` | `docs/api-contrato.md`, `lib/mlPrecios.js` | vigente |
| Códigos universales | Carga de GTIN/EAN y asignación a productos | `/codigos/` | `/api/codigos/firma`, `/faltantes`, `/buscar`, `/asignar` | `docs/api-contrato.md` | vigente |

## Absorbidas por una de las 4 (siguen vivas hasta su fase)

| Herramienta | Qué hace | Ruta | Endpoints principales | Doc | Estado |
|---|---|---|---|---|---|
| Matcher | Candidatos y vinculación de SKU | `/matcher/` | `/api/matcher/candidatos`, `/api/guardia-ml/vincular-clave` | `public/matcher/VINCULAR_SKU_CONTRACT.md`, `KEYBOARD_SHORTCUTS.md` | se fusiona en Catálogo y vínculos |
| Identidad de productos | Motor y casos de identidad de producto | `/identidad-productos/` | `/api/identidad-productos` | spec de consolidación | se fusiona en Catálogo y vínculos |
| Bandeja de identidad | Cola de decisiones de identidad (E3) | `/bandeja-identidad/` | `/api/bandeja-identidad` | `modules/ui-ux.md` | se fusiona en Catálogo y vínculos |
| Guardia ML | Casos y «vincular», ventas retenidas, escaneo y worker | `/guardia-ml/` | `/api/guardia-ml` | spec de consolidación | casos y vincular → Catálogo y vínculos; escaneo y worker, retirada, ver E14 |
| Detalle de sincronización | Errores, ventas sin mapeo, re-mapeo, reintentos | `/sync-detalle/` | `/api/sync/reactivar`, `/reactivables`, `/reintentar-item`, `/desvincular` | `docs/api-contrato.md` | se absorbe en Sincronización ML |
| Config ML | Reservas locales y modo por SKU (`solo_local`) | `/config-ml/` | `/api/sync/config-ml`, `/catalogo-config`, `/buscar-sku` | `docs/api-contrato.md` | se absorbe en Sincronización ML |

## Retiradas

| Herramienta | Qué hace | Ruta | Endpoints principales | Doc | Estado |
|---|---|---|---|---|---|
| Cobertura de catálogo | Cobertura, Solo ML y multi-publicación | `/cobertura/` | `/api/cobertura/*` | `docs/api-contrato.md` | retirada, ver E14 |
| Vínculos ML | Vínculos y sospechosos | `/vinculos/` | `/api/sync/vinculos`, `/vinculos-sospechosos`, `/desvincular` | `docs/api-contrato.md` | retirada, ver E14 |
| Auditoría de publicaciones | Revisión de publicaciones | `/auditoria/` | `/api/auditoria/item` | — | retirada, ver E14 |

## Depósito y operación (siguen vivas)

| Herramienta | Qué hace | Ruta | Endpoints principales | Doc | Estado |
|---|---|---|---|---|---|
| Preparación de pedidos | Cola, olas y jornada de preparación | `/preparacion/` | `/api/preparacion`, `/api/jornada/*` | `modules/warehouse-operations.md` | vigente |
| Gestión de pedidos | Pedidos de venta y armado de lotes | `/gestion-pedidos/` | `/api/gestion-pedidos`, `/api/preparacion/lote-desde-gestion` | `modules/warehouse-operations.md` | vigente |
| Pedidos de compra | Pedidos a proveedor y clasificación | `/pedidos/` | `/api/pedidos`, `/sin-clasificar`, `/clasificar` | `modules/warehouse-operations.md` | vigente |
| Recepción de mercadería | Recepciones con extracción de remitos | `/recepcion/` | `/api/recepciones`, `/catalogo`, `/aliases`, `/api/gemini/extraer` | `modules/warehouse-operations.md` | vigente |
| Ingreso de stock | Alta de stock y productos nuevos | `/stock/` | `/api/woo/stock`, `/api/woo/catalogo`, `/api/nuevos-productos/categorias` | `modules/warehouse-operations.md` | vigente |
| Contador de inventario | Conteos por sesión y ubicación, diferencias | `/inventario/` | `/api/inventario/sesiones`, `/ubicaciones`, `/diferencias` | `modules/warehouse-operations.md`, `public/lib/design-system.md` | vigente |
| Etiquetas | Etiquetas 50×25 mm | `/etiquetas/` | `/api/etiquetas/cola` | `modules/warehouse-operations.md` | vigente |
| Excepciones físicas | Incidentes y proveedor de stock | `/excepciones/` | `/api/stock-exceptions/*` | entrega E16 | vigente |
| Garantías | Posventa | `/garantias/` | `/api/warranties` | entrega E17 | vigente |
| Taller | Órdenes de taller | `/taller/` | `/api/workshop` | entrega E18 | vigente |
| Consulta de precios | Importación y búsqueda de precios de proveedor | `/consulta-precios/` | `/api/consulta-precios/*` | `docs/api-contrato.md` | vigente; clasificación definitiva pendiente en E14 |

## Transversales

| Herramienta | Qué hace | Ruta | Endpoints principales | Doc | Estado |
|---|---|---|---|---|---|
| Inicio | Portal con resumen de pendientes | `/home/` | `/api/sync/dashboard`, `/api/notificaciones-ml/count` | `modules/ui-ux.md` | vigente |
| Usuarios y permisos | Cuentas y permisos por herramienta | `/usuarios/` | `/api/usuarios`, `/usuarios/herramientas` | `modules/architecture.md` | vigente |
| Acceso y contraseña | Login y restablecimiento | `/login/`, `/reset-password/` | `/api/auth/*` | `modules/architecture.md` | vigente |
| Política de privacidad | Página legal pública | `/privacidad/` | — | — | vigente |
