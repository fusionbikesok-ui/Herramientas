# Registro de decisiones del Plan Maestro

Actualizado: 2026-09-04. Este registro resume decisiones aprobadas; el detalle operativo está en el maestro. Cambiar una decisión exige fecha, responsable, impacto y entregas afectadas.

| ID | Decisión vigente | Impacto principal |
| --- | --- | --- |
| PM-001 | Documentación local en `/opt/fusionbikes/herramientas` es canónica; MCP es espejo eventual. | Continuidad E0–E24 |
| PM-002 | Programa renumerado E0–E24; una entrega solo termina en estado `aceptada`. | Gobierno |
| PM-003 | Zona operativa `America/Argentina/Buenos_Aires`, formato 24 h y fecha explícita. | Jornada, SLA, auditoría |
| PM-004 | ML tiene prioridad absoluta. Web tiene máximo normal de preparación 15:00 con calendario de excepciones. El transporte único retira ML, Andreani y Flex; ML/Andreani deben estar listos con 30 min de margen y Flex debe salir como máximo a las 17:00 para permitir el regreso antes del cierre de las 19:00. | E1, E4 |
| PM-005 | La ola inicial conserva sus necesidades normales; pedidos normales posteriores forman mini-olas y ML urgente puede incorporarse a la ola activa. La reasignación automática de la última unidad queda en E12. | E1, E12 |
| PM-029 | **Superada por PM-031 el 2026-09-04.** UM1 urgente separa Guardia ML, Corrección y Consulta. La cobertura válida es publicación+variación con SKU Woo exacto; decisiones históricas sin SKU no cubren. La primera publicación es solo lectura y no escribe ML. | UM1, E1, E11, E12 |
| PM-030 | **Superada parcialmente por PM-032 el 2026-09-04:** cae la confirmación de stock compartido; el resto sigue vigente. Un SKU puede publicar su stock completo en varias claves ML con confirmación de stock compartido. No se promete cero sobreventa: el exceso agregado abre incidente crítico y retiene pedidos según plazo ML, antigüedad y prioridad ML sobre web. | UM1, E11, E12 |
| PM-006 | La misma persona puede preparar, fotografiar y aprobar; despacho es otra responsabilidad. | Permisos y auditoría |
| PM-007 | Una foto cuenta solo tras guardado, validación y procesamiento del servidor. Evidencia se retiene 180 días salvo hold. | E2 |
| PM-008 | Aprobación, auditoría y encolado de etiqueta interna son atómicos; un job idempotente por paquete. | E2, E3 |
| PM-009 | Etiqueta interna 50×25 y etiquetas de transporte son artefactos y momentos distintos. | E3, E4 |
| PM-010 | Woo es autoridad del disponible comercial; Fusion modela físico, comprometido, no disponible, condicionado y entrante sin doble descuento. | E8–E12 |
| PM-011 | Stock físico se deriva de movimientos inmutables; correcciones son inversos o deltas auditados y nunca generan saldo negativo. | E9, E10 |
| PM-012 | Rollout de stock por familia/SKU con familia, ubicación, conteo base y reconciliación; no hay retorno a escrituras legacy. | E9–E12 |
| PM-013 | Recepción es de dos pasos: entrada y putaway; Woo aumenta solo al ubicar disponible. | E14, E15 |
| PM-014 | Conteo inicial ciego con snapshot y reconciliación; tolerancia versionada y alto riesgo con control reforzado. | E16, E17 |
| PM-015 | App es herramienta de piso, iPhone primero; Android queda fuera hasta demanda concreta. | E5, E13–E21 |
| PM-016 | Offline es captura provisional cifrada, ordenada y con lease; jamás usa `last-write-wins`. | E13, E15, E17, E21 |
| PM-017 | Inbox durable distingue reconocer de resolver y enruta por área/turno. | E6, E7 |
| PM-018 | Cancelaciones, devoluciones, daños, proveedor, garantías y taller cambian stock por tareas y movimientos auditados. | E18–E21 |
| PM-019 | Métricas requieren un mes de línea base y no publican rankings personales. | E22 |
| PM-020 | Backend/web pueden publicarse por pipeline verde con rollback automático; Windows y App Store requieren autorización explícita. | E3, E5, E23 |
| PM-021 | Cada entrega dura idealmente 3–5 días, usa flag, piloto acotado y una jornada observada. | Todas |
| PM-022 | App y backend fijan `/api/v1` por commit, con compatibilidad corta y actualización obligatoria cuando corresponda. | E5, E13 |
| PM-023 | E1 usa tablero PC, celular web centrado en una tarea y tablet futura como tablero compartido sin PII; App iPhone futura tendrá el flujo completo de piso. | E1, E5, E13 |
| PM-024 | Un operario mantiene una sola tarea abierta. La ayuda se solicita por zona manual, identifica al ayudante al recibir productos y no permite que el ayudante modifique cantidades, pedidos o estados. | E1 |
| PM-025 | La búsqueda consolidada no escanea unidad por unidad. La confirmación unitaria ocurre en mesa; la herramienta sugiere prioridad y el responsable confirma la asignación. | E1 |
| PM-026 | La ola tiene estados `disponible → en búsqueda → en mesa → cerrada`; el pedido tiene estados independientes y una ola cierra solo con unidades asignadas, devueltas, resguardadas o derivadas explícitamente. | E1 |
| PM-027 | Errores relevantes, reintentos agrupados y correcciones se auditan con actor, hora, antes/después y motivo; los eventos no se borran. | E1, E2 |
| PM-028 | Sustitución transitoria puede autorizarla el operario con constancia del cliente y motivo; Fusion actualiza el pedido comercial, ML bloquea si no puede reflejarlo y un flag de Admin habilita la transición futura a Ventas. | E1 |
| PM-031 | UM1 deja de ser «Guardia ML» y pasa a ser el programa de Identidad de productos UM1.1–UM1.6: Matcher, Cobertura y Guardia se **reemplazan** por un núcleo bilateral ML↔Woo con `Producto Fusion` como identidad canónica y `fusion_sku = FB-{id_woo}` no editable. Supera PM-029. La unidad es `item_id + variation_id` y solo cubre con verificación remota de menos de 60 minutos o excepción explícita `solo_ml`. | UM1, E1, E11, E12 |
| PM-032 | Compartir un SKU entre publicaciones es la operación **normal**, no una excepción: 511 SKUs ya comparten 1176 publicaciones. Cada clave vinculada publica el stock Woo completo y no se pide confirmación de stock compartido. Supera esa parte de PM-030; sigue vigente que no se promete cero sobreventa y que el exceso agregado abre incidente crítico. | UM1, E11, E12 |
| PM-033 | `seller_custom_field` es evidencia auxiliar y **nunca** cobertura: solo `SELLER_SKU` tiene semántica de identidad. `skuDesdeAtributosMl` dejó de usarlo como fallback. Verificado contra las 21 pruebas de `test/guardia-ml.test.js`: el cambio no rompe Guardia. | UM1 |
| PM-034 | En esta base `user_version` **no** numera migraciones: es la compuerta de la migración Hito 7 (`user_version < 30`, al final de `openDb`). Ninguna migración nueva puede escribirlo. Subirlo saltea Hito 7, deja la base sin `device_tokens` y tira toda la auth móvil. La idempotencia de cada migración la da su marcador en `_schema_migrations`. `test/identidad-productos.test.js` afirma `user_version === 30` y la presencia de `device_tokens` para que no se rompa en silencio otra vez. | Esquema, E5, E13, UM1 |
| PM-035 | El trabajo sin commitear de un agente que se queda sin contexto se rescata en un commit propio, atribuido a él y declarado explícitamente como no verificado, antes de tocarlo. Separa lo recibido de lo corregido y permite medir la regresión contra una base limpia en un worktree aparte. | Gobierno, todas |
| PM-036 | La pantalla de UM1.1 se construye **acotada a UM1.1** (salud, conciliación, cola ML→Fusion, detalle del caso, operaciones, historial) y no espera a la herramienta unificada de UM1.5. Motivo: el gate 6 de UM1.1 exige E2E 390/768/1440 y sin superficie no hay nada que probar. `Productos Fusion` queda como lista de solo lectura hasta UM1.3, y la cola Woo→ML hasta UM1.4. | UM1.1, UM1.3–UM1.5 |
| PM-037 | Lista+detalle solo por encima de 850 px. En 390 **y 768** el caso ocupa la pantalla completa con botón de volver: a 768 la comparación ML↔Woo en dos columnas queda ilegible. Fija la ambigüedad del plan, que decía «PC lista+detalle, móvil pantalla completa» sin definir la tablet, y mantiene el mismo umbral que el resto de las pantallas de Herramientas. | UM1.1, UM1.5 |
| PM-038 | El modo (`shadow`/`enforced`) se muestra siempre en pantalla y el detalle avisa explícitamente que no se escribe en ML. No es un detalle interno: decide qué puede hacer la persona, y ocultarlo llevaría a creer que una decisión ya tuvo efecto remoto. | UM1.1, UM1.6 |
| PM-039 | La conciliación del gate 2 se muestra como **resultado de la igualdad** (`total = verificadas + excepciones + urgentes`), no solo como cuatro números sueltos, para que un desvío no pase inadvertido a simple vista. | UM1.1 |
| PM-040 | El vínculo manual se hace con **búsqueda humana explícita** por nombre, SKU Woo o GTIN, con vista previa obligatoria (clave ML, SELLER_SKU actual → objetivo, producto y stock a publicar) antes de confirmar. El candidato aproximado por familia, con puntaje y explicación, es UM1.4 y no se adelanta. Solo se ofrecen productos `activo`: un provisional no tiene `fusion_sku` y no puede sincronizarse. | UM1.1, UM1.4 |
| PM-041 | Los archivos con CRLF y BOM del repo (`public/home/index.html`, entre otros) se editan preservando esos terminadores. Una escritura que los normaliza convierte un cambio de 16 líneas en un diff de 2547 y vuelve la revisión imposible, escondiendo cualquier cambio real en el ruido. | Gobierno, frontend |
| PM-042 | El E2E de una pantalla incluye axe-core sobre la pantalla real en cada ancho y falla ante violaciones `critical` o `serious`. Correr accesibilidad aparte de la pantalla levantada es trabajo duplicado y se saltea cuando el gate aprieta. | UM1.1, frontend |
| PM-043 | La igualdad del gate 2 (`total = verificadas + excepciones + urgentes`) **no alcanza** como evidencia: se cumple igual de bien con la clasificación 100% equivocada. Medido sobre el universo real el 2026-09-04: daba `conciliado: true` con las 1201 claves activas con stock marcadas `sku_ausente`, cuando 907 tienen SKU exacto. El gate exige además cero observaciones incompletas. | UM1.1, UM1.2 |
| PM-044 | Una clave ML cuya última observación es anterior a la migración 082 (`atributos_json IS NULL`) **no se clasifica**: no genera caso, se cuenta como `observacion_incompleta`, impide declarar el universo conciliado y degrada la salud. Motivo: `seller_sku_presente` tiene `DEFAULT 0` y las filas viejas lo conservan, así que clasificarlas fabricaría un backlog falso del tamaño del universo entero. Solo un refresco ML completo con `include_attributes=all` las vuelve clasificables. | UM1.1, UM1.2 |
| PM-045 | Prohibido rellenar `seller_sku_presente = 1` a partir de un `seller_sku` no vacío del cache viejo. Hasta PM-033 el código usaba `seller_custom_field` como fallback de `seller_sku`, así que ese relleno marcaría como atributo presente un valor del campo legacy — exactamente lo que el plan prohíbe tratar como cobertura. La única vía válida es releer de ML. | UM1.1 |
| PM-046 | La conciliación del gate 2 se calcula en **una sola función** (`conciliacionIdentidad`), usada por la auditoría y por `/resumen`, y siempre sobre el mismo universo: claves activas con stock y con observación completa. Un caso de una clave que después se pausó o quedó en cero deja de contar; si contara, la igualdad quedaría inalcanzable para siempre. Además exige `total > 0`: con el universo vacío la igualdad se cumple sola y la pantalla anunciaría «conciliado» sin haber mirado nada. | UM1.1, UM1.2 |

## Pendientes que no deben suponerse

| Pendiente | Responsable | Bloquea | Evidencia de cierre |
| --- | --- | --- | --- |
| Modelo, driver, lenguaje y puerto de impresora | Depósito | Publicación E3 | Relevamiento físico y prueba de página real |
| Modelo e iOS exactos del iPhone | Equipo móvil | Matriz final E5 | Dispositivo registrado y build probada |
| Campo SLA real por modalidad ML | Integración y operación | Aceptación E1/E4 | Para MercadoEnvíos no es fijo y puede variar por paquete; usar la hora máxima de entrega en centro de acopio del shipment. Flex: salida máxima 17:00. Payload capturado y regla confirmada |
| Infraestructura y sanitización de staging | Operaciones | Pruebas integrales y publicación automática | Instancia aislada sin credenciales de escritura reales |
| RTO y RPO | Operaciones | Aceptación E23 | Medición real de backup y restauración |
