# Plataforma auditable de catálogo, identidad, stock y pedidos

**Estado:** aprobado por el usuario (José) 2026-09-13
**Fecha:** 2026-09-13.
**Precedencia propuesta:** cuando sea aprobado, reemplazará como guía futura a
`2026-09-04-identidad-productos.md` y `2026-09-05-arquitectura-um1.md`. Esos documentos
permanecerán como evidencia histórica de las decisiones y errores anteriores.

## 1. Resumen

Construir un núcleo nuevo sobre PostgreSQL que reemplace Matcher, Identidad y Guardia por un
único modelo relacional, auditable y resistente a fallos. WooCommerce será la autoridad inicial
del catálogo y stock; Fusion será el registro canónico de operaciones, decisiones, pedidos y
auditoría, preparado para convertirse posteriormente en autoridad del inventario.

El programa se ejecutará por verticales: infraestructura, catálogo/identidad, stock y
pedidos/preparación. Cada corte tendrá un máximo de 15 minutos y nunca coexistirán dos escritores
remotos.

### 1.1 Diagnóstico verificado

- `productos_fusion` replica esencialmente cada ID Woo: 5.178 productos activos, una sola familia
  y cero atributos canónicos.
- Se incluyeron padres variables como unidades vendibles, contradiciendo el propio diseño.
- Matcher, Identidad y Guardia siguen activos simultáneamente, con decisiones, operaciones y
  estados incompatibles.
- Hay operaciones pendientes que el canario actual nunca ejecutará y casos verificados con
  operaciones bloqueadas.
- Identidad y verificación de stock están mezcladas en un mismo estado.
- Hay 38 grupos GTIN conflictivos, algunos compartidos por decenas de productos.
- 51 registros incumplen `FB-{ID_WOO}`; 39 son vendibles y afectan 14 filas ML.
- La conciliación puede informar éxito aunque existan operaciones atascadas.
- No hay libro de inventario: existen cero movimientos y prácticamente ninguna ubicación
  mapeada.
- El VPS tiene 8,9 GB libres de 96 GB y el DR externo previsto por el script nunca funcionó.
- Node 20 está fuera de soporte.

### 1.2 Errores que no deben repetirse

- Se implementó la capa urgente de UM1 antes de completar el modelo de Producto Fusion, dejando
  un placeholder como fundamento.
- Se declaró retirado el legado mientras continuaban dos ejecutores y varias puertas de escritura.
- El canario se usó como filtro permanente y dejó operaciones fuera de ejecución sin estado
  explícito.
- Se trató una conciliación matemática como salud integral del sistema.
- Se mezclaron evidencia comercial append-only y telemetría repetitiva, lo que terminó forzando
  una purga del supuesto historial inmutable.
- Se permitió que GTIN confirmara automáticamente identidades pese a la mala calidad real de los
  datos.
- Se diseñó para una sola cuenta y con configuración global.
- Se confundió identidad correcta con coincidencia momentánea de stock.

## 2. Arquitectura objetivo

### 2.1 Plataforma e infraestructura

- Desplegar con Docker Compose stacks separados para producción y QA, detrás de Nginx, con
  imágenes fijadas por digest, healthchecks y límites de CPU/RAM.
- Usar Node.js 24 LTS, TypeScript estricto, React + TypeScript y PostgreSQL 18.6. Node 20 está EOL
  y PostgreSQL 18.6 es la versión estable soportada actual. Referencias:
  [Node.js releases](https://nodejs.org/en/about/previous-releases) y
  [PostgreSQL versioning](https://www.postgresql.org/support/versioning/).
- Separar API, workers, scheduler y frontend en procesos independientes. El dominio no dependerá
  del framework HTTP ni de los clientes Woo/ML.
- Implementar un monolito modular con límites estrictos entre catálogo, identidad, inventario,
  pedidos, fulfillment, integraciones, seguridad y auditoría. Los límites deben permitir extraer
  un módulo a servicio futuro sin cambiar sus contratos de dominio.
- Usar PostgreSQL como cola durable para inbox, outbox, comandos, intentos y dead-letter queue,
  con reclamos transaccionales y `FOR UPDATE SKIP LOCKED`.
- Usar migraciones SQL versionadas, consultas tipadas y cambios expand/contract para despliegues
  blue/green.
- Guardar tiempos en UTC y mostrar/calcular jornadas en `America/Argentina/Buenos_Aires`.

### 2.2 Gate 0 obligatorio

No instalar ni activar el nuevo núcleo hasta cumplir todo este gate:

- Configurar Backblaze B2 con cifrado, versionado y Object Lock de un año, alerta presupuestaria
  y credenciales de alcance mínimo.
- Configurar base backups PostgreSQL, archivo continuo de WAL y recuperación PITR con RPO de
  5 minutos y RTO de 1 hora. Verificar checksums y hacer restauraciones completas mensuales en QA.
  Referencias: [PITR](https://www.postgresql.org/docs/18/continuous-archiving.html) y
  [pg_verifybackup](https://www.postgresql.org/docs/18/app-pgverifybackup.html).
- Reemplazar los tarballs diarios completos de uploads por respaldo incremental cifrado. No
  retirar ninguna copia local hasta verificar inventario, hashes y una restauración desde B2.
- Catalogar snapshots SQLite ad hoc y duplicados grandes antes de retirar únicamente copias
  redundantes verificadas.
- Exigir al menos 30 GB libres y uso de disco no superior al 70% antes de instalar producción.
  Alertar al 70%, declarar crítico al 80% y bloquear trabajos no esenciales al 85%.
- Crear QA en stack y base separados, con datos anonimizados, sin secretos de canales reales y
  con prioridad de recursos inferior a producción.
- Incorporar monitoreo externo para disponibilidad, disco, WAL sin archivar, antigüedad de
  backups, colas, DLQ y SLA de notificaciones.
- Conservar el primario en este VPS y aceptar restauración desde DR ante pérdida completa. Un
  upgrade futuro del VPS mejora capacidad, pero no reemplaza B2.

## 3. Modelo de dominio

### 3.1 Reglas generales de datos

- Todas las entidades pertenecen a una empresa y, cuando corresponda, a una cuenta de canal.
- La primera instalación tendrá una empresa, varias cuentas de canal y un único Woo primario.
- Usar PK internas estables y restricciones únicas para las claves externas por cuenta/canal.
- Usar FKs, `CHECK`, índices únicos parciales y control optimista de versión para hacer cumplir
  invariantes en PostgreSQL, no sólo en código.
- No borrar físicamente entidades comerciales: archivar y conservar la causa, actor y momento.
- Reservar JSONB para evidencia externa y extensiones de borde; relaciones, estados y atributos
  canónicos deben ser relacionales.
- Separar eventos inmutables de sus proyecciones actuales. No exigir reconstruir toda la
  aplicación exclusivamente desde eventos.

### 3.2 Catálogo y producto

- `product_models` representa el modelo comercial; `sellable_variants`, la unidad inventariable.
- Un producto simple se representa como modelo con una variante. Un padre Woo `variable` nunca
  es vendible.
- La identidad de ciclo de vida nace del ID Woo. Si Woo elimina y recrea el recurso, se crea una
  identidad nueva.
- El SKU es obligatorio, inmutable y no reutilizable: `FB-{ID_WOO}` para un simple o una variación
  vendible.
- Modelar relacionalmente categorías jerárquicas, marcas, colecciones, atributos, unidades,
  vocabularios, valores, imágenes, textos localizables y procedencia.
- Operar inicialmente en `es-AR`, dejando el contenido preparado para futuros idiomas.
- Separar categoría primaria, marca y colecciones comerciales como Hotsale.
- Definir plantillas versionadas por categoría/familia con atributos requeridos/recomendados,
  tipo, unidad, vocabulario y uso como faceta.
- Fusion administrará el catálogo completo y publicará cambios en el Woo primario mediante
  comandos auditados y verificados.
- Reservar overlays y capacidades por canal para contenido y precios ML, pero no habilitar esos
  escritores en este programa.
- Modelar ofertas ML tipo pack/kit con composición versionada. Cada línea de pedido conserva el
  snapshot de composición aplicado.

### 3.3 Identidad y matcher único

- Identificar una representación externa mediante empresa, cuenta, canal, tipo de recurso, ID
  externo y variación.
- Permitir un vínculo Woo activo por variante y múltiples publicaciones ML por variante.
- Auto-vincular exclusivamente una clave ML nueva cuyo `seller_sku` coincida exactamente con un
  SKU actual único.
- Usar GTIN, atributos, títulos e imágenes sólo como evidencia y sugerencias.
- Cuando un GTIN sea conflictivo, abrir un caso de catálogo con tres resoluciones auditadas:
  asignar propietario, localizar el producto correcto o retirarlo internamente y de los canales.
- Un vínculo humano confirmado persiste ante cambios posteriores de `seller_sku`; la divergencia
  genera alerta, pero no reasigna ni detiene automáticamente el stock.
- Una publicación ML vendible sin identidad confiable se pausa mediante comando durable, se
  verifica remotamente y abre un caso urgente.
- Importar del legado sólo vínculos sustentados por SKU exacto único o decisión humana unívoca.
  Duplicados, objetivos cambiantes y contradicciones vuelven a revisión.
- Garantizar una única decisión vigente por caso/clave y transiciones de estado válidas mediante
  restricciones de base.
- Sustituir todos los escritores de Matcher, Guardia e Identidad por un solo ejecutor.

### 3.4 Inventario

- Implementar un libro append-only de movimientos, ubicaciones, conteos, ajustes, reservas,
  asignaciones, retenciones y salidas.
- Operar inicialmente con una bolsa vendible y múltiples ubicaciones físicas; preparar el esquema
  para depósitos futuros.
- Importar Woo como saldo de apertura provisional. Los conteos físicos incrementan la confianza y
  certifican progresivamente cada variante.
- Calcular `disponible = existencia - reservas - retenciones`; ninguna cantidad se sobrescribe sin
  movimiento causal.
- Reservar sólo con pago aprobado.
- Durante la transición, evitar restar dos veces pedidos que Woo ya descontó. Al pasar la autoridad
  a Fusion, Woo se convierte en una proyección del libro.
- Ejecutar prioritariamente las disminuciones remotas; bloquear aumentos hasta confirmar identidad,
  saldo, reservas y observación remota fresca.
- Publicar el stock completo calculado en cada oferta ML, ajustado por la composición del pack.
- Agrupar publicaciones que comparten `user_product` por recurso de stock remoto para no duplicar
  escrituras.
- Reconocer que exponer el total en publicaciones independientes conserva una ventana de
  sobreventa. Detectar el conflicto y notificarlo en menos de dos minutos.

### 3.5 Pedidos, preparación y despacho

- Ingerir webhooks como señales durables antes de responder; releer el recurso remoto y soportar
  duplicados, desorden y reintentos.
- Fusion conserva la orden canónica. Toda venta ML crea una orden espejo Woo correlacionada e
  idempotente, sin generar una segunda reserva.
- Una venta ML paga tiene prioridad sobre pedidos Woo/locales hasta el evento físico
  `dispatch_confirmed`.
- Si ML desplaza un pedido local antes del despacho, liberar su asignación, retenerlo, bloquear
  preparación/salida y abrir una incidencia. Nunca cancelar ni reembolsar automáticamente.
- Separar estados de pedido, pago, asignación, picking, empaque verificado, despacho físico,
  entrega, cancelación y devolución.
- Completar la herramienta de preparación dentro de esta vertical. `packed_verified` y
  `dispatch_confirmed` serán eventos diferentes.
- Al despachar, convertir la reserva en salida de stock sin cambiar nuevamente el disponible.
- Al cancelar, liberar la reserva sólo después de verificar el estado remoto.
- Las devoluciones ingresan en cuarentena y no vuelven a disponible hasta clasificación humana.

## 4. Auditoría y seguridad

### 4.1 Retención y evidencia

- Mantener eventos comerciales, decisiones, comandos, verificaciones y cambios indefinidamente.
- Conservar telemetría cruda 90 días y agregados históricos sin PII.
- Conservar el payload externo original cifrado durante 90 días en B2; guardar indefinidamente su
  normalización, hash, cuenta, endpoint y metadatos de procedencia.
- Encadenar eventos de auditoría por hash y generar un manifiesto diario firmado, guardado
  indefinidamente y bloqueado contra modificación durante un año.
- Auditar todas las mutaciones y las lecturas de PII, búsquedas sensibles y exportaciones. No
  registrar cada lectura ordinaria de catálogo o panel.

### 4.2 Identidad de usuario y autorización

- Cifrar PII y secretos por aplicación con claves fuera de la base; usar índices ciegos para las
  búsquedas exactas necesarias.
- Conservar la PII indefinidamente por decisión de negocio.
- Definir roles base operador, catálogo y administrador, complementados por capacidades finas.
- Exigir passkey a catálogo y administración, con códigos de recuperación de un solo uso.
- Exigir autenticación reciente antes de aprobar acciones de riesgo.
- Administración puede autoaprobar con reautenticación. Catálogo necesita aprobación
  administrativa cuando existe riesgo comercial real.
- Permitir automatización de acciones protectoras como bajar stock o pausar. Aumentar exposición,
  cambiar identidad/composición activa, transferir datos o ejecutar lotes requiere evaluación de
  impacto.

## 5. Interfaces públicas

### 5.1 API v2

- Exponer `/api/v2/catalog`, `/identities`, `/inventory`, `/orders`, `/fulfillment`,
  `/integration-commands`, `/incidents` y `/audit`.
- Toda mutación recibe `Idempotency-Key`, `expected_version`, actor, motivo y `correlation_id`.
- Ninguna ruta HTTP llama directamente a Woo o ML: crea una intención transaccional y devuelve su
  estado.
- Estandarizar errores con código estable, mensaje, detalles seguros y correlación.
- Exponer estado de comandos e intentos, evidencias remotas y motivos de bloqueo.
- Usar SSE para actualizar bandejas e incidencias, con polling como fallback.

### 5.2 Compatibilidad

- Bloquear escritores legacy al cortar cada vertical.
- Mantener adaptadores GET read-only durante 30 días, con advertencias de deprecación y métricas.
- Después de 30 días, retirar las pantallas antiguas y responder `410 Gone` desde sus rutas.
- No copiar el motor Matcher del navegador: toda sugerencia debe provenir del único motor de
  dominio del servidor.
- **App iPhone (decisión 2026-09-13, PM-162):** `/api/v1` NO se retira con el plazo de 30 días.
  Se conserva como **fachada delgada sobre el dominio v2** mientras la App lo use, y la App migra
  pantalla por pantalla a v2 mediante **actualizaciones OTA** (`expo-updates`, runtime `fingerprint`).
  Quedan pocas builds de App Store: la próxima build debe incluir todas las capacidades nativas
  que el programa vaya a necesitar y después se congelan las dependencias nativas. El chequeo de
  contrato de la App (`/api/v1/meta`) debe seguir respondiendo compatible en cada corte.

## 6. Migración y cortes

1. **Gate 0 — Infraestructura:** resolver DR, capacidad, Node 24, PostgreSQL, QA, monitoreo y
   restauración.
2. **Fundación shadow:** desplegar esquema, auditoría, inbox/outbox, autenticación y workers sin
   escrituras remotas.
3. **Catálogo e identidad:** importar modelos/variantes, relaciones, evidencia fuerte y
   excepciones. Corregir los 39 SKU vendibles legacy mediante campaña coordinada: pausar ofertas
   afectadas, cambiar Woo/ML, verificar y reanudar.
4. **Stock:** importar apertura provisional y pedidos pagados abiertos, activar reservas y comparar
   proyecciones contra Woo antes de transferir autoridad. **Recepción y conteos entran en este
   mismo corte** como escritores del libro (PM-161): hoy escriben stock en Woo y dejarlos afuera
   crearía dos escritores.
5. **Pedidos y preparación:** activar orden canónica, espejo ML→Woo, asignaciones, prioridad,
   picking, empaque y despacho.
6. **Estandarización:** proponer atributos por categoría en lotes revisables, mostrar vista previa,
   publicar en Woo y verificar.
7. **Retiro legacy:** eliminar workers, motores duplicados, tablas operativas y pantallas antiguas
   después del plazo read-only.

La búsqueda facetada, navegación, URLs, SEO visible y accesibilidad del storefront Woo quedan para
un plan posterior, alimentado por el catálogo normalizado de este programa.

### 6.1 Procedimiento de cada corte

- Congelar sólo los escritores de la vertical.
- Exportar el delta final SQLite, calcular hashes y conservar el archivo SQLite completo inmutable
  con crosswalk a PostgreSQL.
- Exigir conciliación exacta de entidades, relaciones, reservas y comandos.
- Cambiar Nginx/API y habilitar un único worker remoto.
- Observar un canario por cuenta y luego ampliar lotes. El trabajo fuera del canario debe quedar
  explícitamente `parked`, nunca `pending` invisible.
- Si falla el corte, devolver la API nueva a shadow/read-only. No reactivar escritores viejos ni
  deshacer efectos remotos confirmados; usar comandos compensatorios.
- Mantener cada ventana por debajo de 15 minutos.

## 7. Pruebas y criterios de aceptación

- Restricciones de unicidad, FKs, archivo, SKU estricto, decisiones vigentes y máquinas de estado.
- Pruebas de concurrencia para reservas, aprobaciones, reclamos de workers, webhooks duplicados y
  dos operadores.
- Reintentos ante timeout, 403/408/429/5xx, respuesta incierta y caída entre efecto remoto y
  confirmación local.
- Verificación obligatoria posterior a toda escritura Woo/ML.
- Casos de múltiples publicaciones, `user_product`, packs, kits y ventas simultáneas.
- Prioridad ML antes del despacho, protección del pedido local después de `dispatch_confirmed` y
  retención sin cancelación automática.
- Migración de los 51 SKU irregulares, duplicados actuales, ocho productos Woo ausentes, GTIN
  masivos y decisiones contradictorias.
- Separación demostrable entre salud de identidad, salud de stock y salud de operaciones.
- Cero operaciones pendientes fuera del alcance del scheduler; DLQ y bloqueos siempre visibles.
- Notificación push, panel y email iniciada antes de dos minutos, con acuse y escalamiento.
- Pruebas contractuales contra fixtures Woo/ML y reconciliaciones completas periódicas.
- Pruebas responsive y WCAG 2.2 AA para la nueva web.
- Restauración mensual desde B2 que demuestre RPO menor o igual a 5 minutos y RTO menor o igual a
  1 hora.
- Ningún corte se aprueba con discrepancias críticas, escritor remoto duplicado, backup no
  restaurable, disco bajo el umbral o cola sin observabilidad.

## 8. Decisiones fijadas y límites

- Una empresa, varias cuentas de canal y un único Woo primario.
- Woo gobierna inicialmente catálogo y stock; las ediciones se realizan desde Fusion mediante
  comandos auditados.
- PostgreSQL será el destino definitivo; SQLite quedará como archivo histórico verificable.
- Producción y QA comparten VPS, pero no base, secretos ni recursos sin límites.
- No habrá réplica caliente inicial.
- El stock completo se expondrá por publicación ML aun aceptando la ventana de sobreventa
  declarada.
- Contenido ML y precios quedan previstos, pero se diseñarán y activarán posteriormente.
- La estandarización de catálogo sí pertenece a este programa; el storefront público no.
- Este documento no autoriza limpiar disco, instalar servicios, cambiar canales, migrar datos ni
  desplegar. Cada ejecución requiere que el borrador sea revisado y aprobado.


## 9. Integración con el plan maestro (decisiones del 2026-09-13)

- **Roles de los documentos:** `plan-maestro-v2.md` sigue siendo la especificación funcional
  canónica —procesos, escenarios, gates y aceptación operativa—. Este documento es la arquitectura
  y el programa de ejecución que la implementa. Reemplaza la §18.1 (UM1) y el orden de la §19 del
  maestro; la secuencia vigente está en la §19.0 del maestro.
- **Gates acumulados:** cada corte cumple los de este documento y los de la §20 del maestro
  (suite completa, E2E 390/768/1440, jornada observada y aceptación del usuario).
- **Regla de congelamiento del legado (PM-160):** mientras dure el programa, el legado sólo recibe
  arreglos de bugs que pierden plata o bloquean la operación; no se construyen funciones nuevas en
  áreas que una vertical reemplaza. La corrección de conteos con auditoría espera al libro de
  stock.
- **Huecos que el borrador no cubría y quedan resueltos:**
  - Recepción y conteos dentro del corte de stock (PM-161).
  - App iPhone sobre fachada `/api/v1` + migración por OTA (PM-162, §5.2).
  - Excepciones físicas, garantías y taller no están en ninguna vertical: se **reconstruyen sobre el
    núcleo nuevo después del corte de stock**. Hoy tienen 0 filas, así que no hay datos que migrar
    (PM-163).
  - Precios ML, consulta de precios y sync ML quedan en el legado hasta un plan propio.
  - Lo construido en el legado esta semana —vigía de formato, auto-vínculo por `seller_sku`,
    liberación de ventas retenidas— es comportamiento requerido de la vertical de catálogo e
    identidad y de la de pedidos, no código a portar.
- **Kits/combos:** el maestro los tenía fuera de alcance; entran a este programa (PM-164).
