# Recepción documental y stock anticipado — Plan maestro para revisión

> **Estado:** REVISADO el 2026-09-21; **no ejecutar**. Los hallazgos están en
> [la revisión contra el plan maestro](2026-09-21-revision-recepcion-vs-plan-maestro.md) y
> requieren decisión de José. En particular: la Etapa 2 **no es E6** (E6 no incluye documentos,
> compras, proveedor, altas ni anticipado, y sí incluye conteos que esta Etapa 2 pierde), así que
> necesitaría un número nuevo posterior a E26; y tres decisiones que este documento declara
> abiertas en su §7 siguen sin cerrar (fórmula de disponibilidad con anticipado, autoridad entre
> documentos, y el número real de casos `sin_match`).
>
> **Para agentes implementadores:** después de aprobar este documento, dividirlo en dos planes ejecutables: (1) puente seguro del legado y (2) E6 canónico. Cada plan debe usar desarrollo guiado por pruebas, pasos con casillas, pruebas de fallo previo, implementación mínima, verificación y commits pequeños.

**Objetivo:** convertir remitos, facturas, órdenes, confirmaciones de proveedor y planillas en recepciones de stock casi automáticas, explicables y auditables, incluyendo productos inexistentes, variaciones, recepciones parciales y stock activado antes de la llegada física.

**Arquitectura:** primero se recuperará la pantalla heredada conectándola al matcher robusto existente y agregando aprendizaje por proveedor. Después E6 trasladará pedido, documentos, recepción, stock anticipado, altas borrador y efectos remotos a PostgreSQL, libro canónico y outbox idempotente.

**Tecnología:** Node.js, Express, SQLite legado, PostgreSQL plataforma, Vitest, Playwright, WooCommerce REST API, Mercado Libre API y extracción documental asistida por IA.

**Especificaciones relacionadas:** `docs/superpowers/deliveries/E6-recepcion-conteos-libro.md`, `docs/superpowers/deliveries/E22-app-recepcion-conteos.md` y `docs/superpowers/plan-maestro.md`.

## 1. Resultado esperado

Construir el flujo en dos etapas.

### Etapa 1: puente seguro sobre la recepción actual

- Recuperar rápidamente la herramienta existente.
- Reemplazar el matcher defectuoso por el motor robusto ya disponible.
- Aprender correcciones por proveedor.
- Incorporar una bandeja clara de excepciones.
- Mantener fuera de esta etapa las altas y la conciliación de stock anticipado.

### Etapa 2: E6 canónico sobre PostgreSQL

- Unificar pedido, documentos, stock anticipado y recepción física.
- Admitir PDF, fotografías, XML, CSV y XLSX.
- Conciliar orden, remito y factura sin sumar líneas duplicadas.
- Crear fichas borrador reusables para productos o variaciones inexistentes.
- Registrar stock físico, anticipado, dañado y pendiente por separado.
- Proyectar cambios idempotentes hacia WooCommerce y Mercado Libre.

El recorrido operativo será:

1. Subir cualquier documento o abrir un pedido.
2. Extraer y clasificar sus datos.
3. Vincularlo con un pedido o crear un pedido borrador.
4. Resolver los productos conocidos.
5. Proponer familias y variaciones nuevas.
6. Mostrar solamente excepciones y diferencias.
7. Ofrecer la activación anticipada en WooCommerce.
8. Al llegar la mercadería, confirmar el conjunto y corregir solamente faltantes, sobrantes o daños.
9. Conciliar lo anticipado sin sumar stock dos veces.
10. Sincronizar Mercado Libre solamente después de la recepción física.

## 2. Restricciones globales

- La operación requiere una confirmación humana final. “Casi automático” significa preparar todo y mostrar excepciones, no escribir stock sin revisión.
- La IA puede extraer y estructurar datos, pero nunca es autoridad de identidad ni de stock.
- Ninguna coincidencia ambigua puede seleccionar silenciosamente el primer candidato.
- PostgreSQL será el destino canónico de E6; SQLite se limita al puente transitorio.
- Toda mutación comercial será transaccional, atribuible, versionada y auditada.
- Los efectos remotos se realizarán mediante outbox y se considerarán exitosos solamente después de releer el recurso.
- Un resultado remoto incierto no se reintenta a ciegas.
- El stock anticipado se publica en WooCommerce, nunca en Mercado Libre.
- Mercado Libre recibe disponibilidad solo después de la recepción física.
- Los costos detectados se conservan y comparan, pero no actualizan automáticamente costo ni precio de venta.
- Toda agrupación de variaciones requiere confirmación humana.
- Los productos nuevos quedan en borrador/no publicados.
- Los datos heredados de una familia o categoría quedan marcados como heredados y pendientes de verificación.
- Deben conservarse los cambios no relacionados que ya existan en el árbol de trabajo.

## 3. Etapa 1: puente seguro en el legado

### 3.1 Matching

- Sustituir `matchItem` y el conteo de palabras de `public/recepcion/index.html` por `lib/ingresoMatcher.js`.
- Exponer el matcher mediante backend; el navegador no decide identidades.
- Resolver candidatos en este orden:
  1. Alias confirmado para ese proveedor y código.
  2. SKU exacto y único.
  3. Código de proveedor confirmado previamente.
  4. Marca, modelo y atributos estructurados compatibles.
  5. Coincidencia textual solamente como candidato, nunca como confirmación.
- Color, talle, rodado, medida u otro atributo de variación contradictorio descarta el candidato.
- GTIN funciona como evidencia adicional, no como identidad suficiente.
- Un resultado ambiguo nunca selecciona el primer candidato.
- Cada candidato devuelve producto, variación, confianza (`alta`, `revisar`, `baja`), razones positivas, contradicciones y fuente del vínculo.
- Solo los matches exactos o previamente confirmados se precargan como resueltos. El resto queda visible antes de confirmar.

### 3.2 Aprendizaje por proveedor

Extender el mapeo legado para incluir:

- Proveedor normalizado.
- Código del proveedor cuando exista.
- Descripción normalizada.
- Texto de variación normalizado.
- `id_woo` confirmado.
- Usuario, fecha y recepción de origen.
- Estado vigente o revocado.

Reglas:

- Una corrección confirmada crea una nueva versión del vínculo.
- Los vínculos no se comparten entre proveedores.
- Un cambio revoca el anterior y crea otro; no reescribe historia.
- Si el mismo código del proveedor aparece vinculado a dos variantes vigentes, se bloquea la automatización y se abre una excepción.
- La UI permite consultar y revocar aprendizajes.

### 3.3 Interfaz transitoria

Reorganizar la pantalla en:

- Resueltos automáticamente.
- Necesitan revisión.
- Sin producto existente.
- No recibidos o excluidos.

Cada fila muestra descripción original, código, cantidad, candidato, confianza y explicación.

Acciones disponibles:

- Buscar y seleccionar otra variación.
- Confirmar o revocar un match.
- Marcar no recibido.
- Dejar pendiente por producto inexistente.
- Confirmar conjuntamente todos los matches de confianza alta.
- Impedir que una línea ambigua se confirme como resuelta.

Un producto inexistente queda explícitamente pendiente; no se crea todavía en WooCommerce ni se pierde la línea.

### 3.4 Archivos soportados

- PDF e imágenes continúan usando extracción documental.
- XML se procesa estructuralmente antes de recurrir a IA.
- CSV y XLSX se transforman en una tabla normalizada.
- La IA puede identificar columnas y extraer texto, pero no decide la identidad final.
- Conservar archivo, hash, tipo MIME, resultado bruto y extracción normalizada.
- Reprocesar el mismo hash no duplica documentos ni líneas.

### 3.5 API transitoria

- `POST /api/recepciones/analizar-documento`
  - Entrada multipart.
  - Devuelve documento clasificado, encabezado, líneas normalizadas y advertencias.
- `POST /api/recepciones/matchear`
  - Entrada: proveedor y líneas normalizadas.
  - Devuelve candidatos explicados por línea.
- `POST /api/recepciones/:id/items/:itemId/resolver`
  - Confirma, cambia o revoca un vínculo.
- `GET /api/mapeo/proveedor/:proveedor`
  - Lista aprendizajes vigentes y conflictos.

Esta etapa no cambia la semántica de stock anticipado ni implementa altas completas en SQLite.

## 4. Etapa 2: E6 canónico

### 4.1 Modelo de compras y documentos

Agregar en PostgreSQL:

- `purchasing.purchase_orders`: proveedor, número original y normalizado, moneda, estado, fechas estimadas y versión.
- `purchasing.purchase_order_lines`: producto/variación si se conoce, identidad del proveedor, cantidades pedida y cancelada, y precio informado.
- `receiving.documents`: archivo, hash, tipo documental, estado de procesamiento y pedido asociado.
- `receiving.document_extractions`: resultado bruto, versión del extractor, confianza y errores.
- `receiving.document_lines`: texto original, código, cantidad, precio, atributos y rol documental.
- `receiving.supplier_aliases`: vínculos versionados y revocables por proveedor.
- `receiving.receipts` y `receiving.receipt_lines`: cantidades aceptadas, dañadas, rechazadas, sobrantes y pendientes.
- `receiving.product_drafts` y `receiving.product_draft_variants`: fichas nuevas aún no publicadas.
- `inventory.advance_activations` y sus líneas: cantidad activada anticipadamente, recibida, cancelada y todavía en tránsito.

Todos los agregados tienen `company_id`, `version`, timestamps, actor y eventos de auditoría. Las correcciones agregan eventos compensatorios; no eliminan historia comercial.

### 4.2 Estados obligatorios

Pedido:

- `borrador`
- `aprobado`
- `parcialmente_recibido`
- `completado`
- `cancelado`

Documento:

- `subido`
- `procesando`
- `extraido`
- `requiere_revision`
- `fallido`

Línea conciliada:

- `resuelta`
- `ambigua`
- `producto_inexistente`
- `conflicto_documental`
- `excluida`

Recepción:

- `borrador`
- `lista_para_confirmar`
- `confirmando`
- `confirmada_con_pendientes`
- `confirmada`
- `requiere_recuperacion`
- `anulada_por_compensacion`

Producto borrador:

- `incompleto`
- `listo_para_crear`
- `creado_no_publicado`
- `publicado`
- `descartado`

Condición de stock:

- `en_transito_activado`
- `fisico_vendible`
- `cuarentena_no_vendible`
- `rechazado`
- `pendiente_proveedor`

### 4.3 Conciliación de documentos

- Orden o confirmación del proveedor: cantidad pedida.
- Remito: cantidad declarada como entregada.
- Factura: cantidad facturada y costo informado.
- Planilla: función seleccionada o detectada, con confirmación si resulta ambigua.
- Nunca sumar automáticamente líneas equivalentes de documentos distintos.
- Fusionar solamente cuando proveedor, código y atributos sean compatibles.
- Conservar cada afirmación documental por separado.
- Mostrar por línea: pedido, remitido, facturado, recibido y diferencia.
- Si no existe un pedido inequívoco, sugerir candidatos, permitir seleccionar uno o crear un pedido borrador. Nunca mezclar automáticamente compras dudosas.
- Los cambios de costo se muestran y registran; no modifican costo ni precio de venta.

### 4.4 Validación física

- Las cantidades documentales se precargan como propuesta.
- El operador confirma el lote completo y edita solamente excepciones.
- Desde celular se puede escanear para localizar una línea, pero no es obligatorio escanear cada unidad.
- Los faltantes permanecen pendientes del pedido.
- Los sobrantes requieren aceptación explícita.
- Los dañados ingresan en `cuarentena_no_vendible`, con motivo y evidencia opcional.
- Una recepción parcial no cierra el pedido mientras haya saldo o incidencias.
- Confirmar cero, un sobrante o un daño exige una acción explícita.

### 4.5 Altas de productos y variaciones

Crear una ficha intermedia reusable por el futuro módulo completo de catálogo.

Campos obligatorios antes de crear el borrador:

- Proveedor.
- Código o identidad estable del proveedor.
- Marca.
- Categoría.
- Nombre/modelo.
- Tipo: producto simple, familia nueva o variación.
- Producto padre si es variación.
- Ejes de variación y valores de cada línea.
- Precio propuesto.
- SKU interno, o estado explícito `sku_pendiente` hasta que Woo asigne identidad.

Campos heredables desde familia o categoría:

- Atributos comunes.
- Peso.
- Dimensiones.
- Descripción base.

Todo dato heredado guarda origen y se muestra como “heredado por verificar”.

Agrupación:

- Analizar juntas todas las líneas del documento.
- Proponer cuáles representan el mismo modelo y cuáles son sus atributos diferenciadores.
- Explicar por qué se agruparon.
- Exigir confirmación humana para toda asociación a un padre existente o nuevo.
- No crear familias automáticamente aunque la confianza sea alta.

Al confirmar:

- Crear la representación de WooCommerce como borrador/no publicada.
- Registrar la existencia como no publicable hasta tener una representación válida.
- No enviar el producto a Mercado Libre.
- Dejar imágenes, SEO, texto comercial final y publicación para la herramienta completa.

### 4.6 Stock anticipado

Al procesar cualquier documento asociado a un pedido:

- Ofrecer `Activar stock anticipado en WooCommerce`.
- Proponer el total pedido confirmado por línea.
- Requerir confirmación humana del resumen.
- Registrar primero el evento canónico y luego encolar la proyección.
- No activar productos borrador no publicados.
- No enviar stock anticipado a Mercado Libre.
- Deduplicar por pedido, línea y versión; otro documento no vuelve a sumar lo ya activado.

Al recibir:

- Una unidad ya activada pasa de `en_transito_activado` a `fisico_vendible` sin incrementar nuevamente Woo.
- Las ventas ocurridas durante el tránsito ya están reflejadas en Woo y se conservan.
- Una unidad recibida que nunca fue anticipada sí genera un incremento en Woo.
- Si llega menos, el operador decide en esa recepción entre mantener el saldo anticipado confirmado o retirarlo de Woo.
- Si el proveedor reduce o cancela unidades, retirar automáticamente de Woo el saldo anticipado aún no recibido y verificar mediante relectura.
- Si las ventas comprometidas impiden cubrir la reducción, no inventar stock negativo: dejar el canal en el mínimo válido y abrir una incidencia urgente con la cantidad no cubierta.
- Las unidades dañadas o rechazadas reducen el anticipado vendible cuando corresponda.
- Mercado Libre se sincroniza solo al confirmar recepción física, usando disponibilidad física vendible y reservas aplicables.

### 4.7 Efectos remotos y recuperación

- Toda mutación v2 exige `Idempotency-Key`.
- Toda edición exige `expected_version`; una versión vencida responde `409` sin efecto parcial.
- Confirmar una recepción crea movimientos y comandos de outbox en una transacción.
- WooCommerce y ML se actualizan mediante workers, nunca dentro de la transacción HTTP.
- Después de escribir remotamente se relee el producto y se verifica la cantidad.
- Los comandos usan `pending`, `claimed`, `succeeded`, `retryable`, `uncertain` y `dead_lettered`.
- Un timeout posterior al envío queda `uncertain`; no se repite a ciegas.
- Los errores 408, 429 y 5xx usan backoff con jitter.
- Los 4xx permanentes abren una excepción operativa.
- Un scheduler recupera leases vencidos para que ninguna recepción quede eternamente en `confirmando`.

### 4.8 API v2

Endpoints mínimos:

- `POST /api/v2/receiving/documents`
- `GET /api/v2/receiving/documents/:id`
- `POST /api/v2/receiving/documents/:id/reprocess`
- `GET /api/v2/purchase-orders/candidates`
- `POST /api/v2/purchase-orders`
- `POST /api/v2/purchase-orders/:id/documents/:documentId/link`
- `POST /api/v2/receiving/reconciliations`
- `GET /api/v2/receiving/reconciliations/:id`
- `POST /api/v2/receiving/lines/:id/resolve-match`
- `POST /api/v2/receiving/product-drafts`
- `POST /api/v2/receiving/product-drafts/:id/confirm-grouping`
- `POST /api/v2/advance-activations`
- `POST /api/v2/advance-activations/:id/cancel`
- `POST /api/v2/receipts`
- `PATCH /api/v2/receipts/:id/lines/:lineId`
- `POST /api/v2/receipts/:id/confirm`
- `GET /api/v2/receipts/:id/projection-status`

Errores uniformes:

```json
{
  "code": "RECEIPT_AMBIGUOUS_LINES",
  "message": "Hay líneas que necesitan revisión",
  "correlation_id": "uuid",
  "details": {}
}
```

Capacidades:

- `receiving.read`
- `receiving.edit`
- `receiving.confirm`
- `receiving.resolve_match`
- `catalog.create_draft`
- `inventory.activate_advance`
- `inventory.resolve_discrepancy`

### 4.9 Experiencia responsive

En PC:

- Tabla comparativa por documento.
- Selección masiva.
- Panel lateral con explicación del match.
- Resumen previo a cualquier cambio de stock.

En celular:

- Tarjetas por excepción.
- Cámara/escáner para localizar líneas.
- Controles grandes para recibido, faltante, dañado y cambio de producto.
- Resumen final compacto.

Ambas superficies cubren carga, extracción en progreso, vacío, error recuperable, conflicto de versión, procesamiento remoto, operación parcialmente completada y modo de solo lectura.

## 5. Orden de implementación

1. Congelar fixtures reales anonimizados de los casos con `sin_match`.
2. Escribir pruebas que reproduzcan los matches incorrectos actuales.
3. Integrar `ingresoMatcher` en backend y retirar el matcher textual del navegador.
4. Implementar alias por proveedor y UI de excepciones.
5. Incorporar XML, CSV y XLSX con deduplicación por hash.
6. Ejecutar el puente en sombra y comparar sus decisiones contra el flujo actual.
7. Actualizar formalmente E6 y crear las migraciones PostgreSQL.
8. Implementar pedido, documentos y conciliación sin efectos remotos.
9. Implementar fichas borrador y confirmación de familias/variaciones.
10. Implementar libro de recepción y cuarentena.
11. Implementar activaciones anticipadas y outbox Woo.
12. Implementar conciliación física y sincronización posterior con ML.
13. Migrar pedidos y recepciones abiertas; mantener los cerrados mediante crosswalk de consulta.
14. Ejecutar un canario con una ubicación y un proveedor.
15. Retirar escrituras del legado cuando E6 complete una jornada observada sin discrepancias críticas.

Antes de ejecutar, convertir los puntos 1–6 y 7–15 en dos planes independientes con archivos, interfaces, pruebas fallidas, implementación mínima, comandos verificables y commits por tarea.

## 6. Pruebas y aceptación

### Unitarias

- Mismo nombre con color o talle contradictorio no se autoasocia.
- Dos variaciones hermanas ambiguas quedan para revisión.
- Alias de un proveedor no afecta a otro.
- Alias revocado deja de utilizarse.
- SKU duplicado bloquea automatización.
- XML, PDF, imagen, CSV y XLSX producen el mismo modelo normalizado.
- Orden, remito y factura no duplican cantidades.
- Variaciones propuestas conservan sus atributos diferenciadores.
- Un reintento con la misma idempotencia no duplica stock ni documentos.

### Integración

- Activar 10 unidades en Woo y recibir 10 no produce un segundo `+10`.
- Activar 10, vender 3 y recibir 10 mantiene correctamente el saldo remoto.
- Activar 10 y recibir 7 permite mantener o retirar las 3 pendientes.
- Cancelar 4 anticipadas retira solamente el saldo no recibido.
- Stock anticipado nunca genera un comando hacia ML.
- La recepción física sí genera la sincronización ML correspondiente.
- Producto borrador recibe existencia interna pero no queda publicado.
- Daño queda en cuarentena y no aumenta disponibilidad.
- Timeout de Woo queda `uncertain` y no se repite a ciegas.
- Una caída durante `confirmando` se recupera sin doble escritura.

### E2E

- Flujo desde pedido abierto.
- Flujo iniciado únicamente con documento.
- Varios documentos del mismo pedido.
- Recepción casi automática sin excepciones.
- Documento con matches ambiguos.
- Producto nuevo con varias variaciones.
- Recepción parcial con faltantes y daños.
- Stock anticipado con ventas previas.
- Viewports de 390, 768 y 1440 px.
- Navegación por teclado, etiquetas accesibles y errores accionables.

Crear `npm run test:e6` como contrato obligatorio. Debe ejecutar migraciones sobre base limpia, pruebas unitarias, integración, recuperación de outbox y E2E responsive; debe fallar si falta uno de esos grupos.

### Criterios de salida del puente

- No usa el matcher textual anterior.
- Ninguna ambigüedad se confirma silenciosamente.
- Las correcciones se reutilizan por proveedor.
- Los 22 casos históricos `sin_match` quedan clasificados como resueltos, ambiguos o producto inexistente.

### Criterios de salida de E6

- Una jornada real completa se procesa por el flujo nuevo.
- No existe doble suma de stock anticipado.
- ML no recibe stock no entregado.
- Todas las mutaciones quedan auditadas.
- No hay comandos `pending`, `claimed` o `uncertain` invisibles.
- La conciliación canónica y Woo no presentan diferencias críticas.
- Existe rollback probado a UI de solo lectura/legado sin repetir efectos remotos.

## 7. Guía para la revisión externa

La revisión debe intentar encontrar decisiones faltantes o contradicciones, especialmente en:

- Fórmula exacta de disponibilidad cuando conviven stock físico, anticipado, ventas y reservas.
- Identidad y deduplicación de líneas entre documentos heterogéneos.
- Transición de un producto borrador a una representación Woo definitiva.
- Tratamiento de cancelaciones que ya tienen ventas comprometidas.
- Autoridad entre pedido, remito, factura y conteo físico.
- División correcta entre movimientos del libro y proyecciones por canal.
- Compatibilidad con el catálogo canónico y la regla de SKU inmutable.
- Migración y crosswalk de recepciones/pedidos abiertos del legado.
- Recuperación de estados `uncertain`, leases vencidos y DLQ.
- Permisos necesarios para activación anticipada, confirmación, cuarentena y altas.
- Límites de tamaño, cantidad de páginas/filas y retención de documentos.
- Datos sensibles presentes en facturas y política de cifrado/retención.

La salida esperada de la revisión es una lista de hallazgos priorizados y una versión corregida de este documento, sin marcadores abiertos ni decisiones delegadas al implementador.
