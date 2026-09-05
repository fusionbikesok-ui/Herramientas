# UM1 urgente — Identidad de productos y cierre de publicaciones ML sin SKU

**Estado:** especificación aprobada; implementación en curso.
**Prioridad:** UM1.1 es bloqueante y precede UM1.2–UM1.6.
**Superficies:** VPS, web responsive y App iPhone.
**Seguridad:** la operación productiva usa sobrescritura directa, autorización explícita y verificación remota; nunca cae automáticamente al camino heredado con stock cero.

## Resultado del programa

Reemplazar Matcher, Cobertura y Guardia por un núcleo de identidad bilateral ML↔Woo basado en `Producto Fusion`. Woo continúa como autoridad de stock. Una clave ML (`item_id + variation_id`) activa con stock solo queda cubierta cuando posee identidad y stock verificados remotamente, o una excepción explícita `solo_ml`.

Un `SELLER_SKU` válido existe, no está vacío, coincide textualmente con un único SKU Woo vigente, no contradice un GTIN válido y su relación fue persistida y verificada. `seller_custom_field` es evidencia auxiliar y nunca cobertura.

## Invariantes

- Un Producto Fusion representa una unidad vendible; familia y producto padre son conceptos separados.
- Existe como máximo una identidad Woo activa por Producto Fusion y pueden existir múltiples claves ML.
- `fusion_sku` no se edita: es `FB-{id_woo}`. Un producto provisional sin Woo no tiene SKU ni puede sincronizarse.
- Son unidades Woo activas los productos simples y variaciones en estado `publish` o `private`; un padre `variable` nunca es una unidad vendible. El stock cero conserva producto e identidades.
- Activar exige nombre canónico, familia y atributos requeridos por la familia.
- No hay borrado físico. SKU y GTIN históricos quedan reservados; transferirlos requiere Administración y auditoría.
- Cada clave ML vinculada publica el stock Woo completo.
- Una relación local no queda verificada hasta releer ML y confirmar SKU y stock objetivo con observaciones confiables de menos de 60 minutos.
- Las decisiones aproximadas requieren confirmación individual. Solo `SELLER_SKU` exacto único o GTIN canónico válido único pueden automatizarse.
- Los identificadores comerciales son tipados (`ean_8`, `ean_13`, `upc_a`, `gtin_14`): una unidad admite como máximo un EAN activo y un UPC activo, y cada valor activo es único globalmente.
- UPC-A y su EAN-13 equivalente con cero inicial representan el mismo GTIN normalizado para matching y unicidad, aunque se preservan ambos valores y tipos.
- Sólo un identificador activo de un Producto Fusion activo confirma identidad. Los históricos quedan reservados y una transferencia requiere Administración.
- Si SKU, EAN o UPC señalan productos distintos no hay auto-vínculo: la persona elige cuál coincide, el descartado queda marcado incorrecto y se crea una tarea de catálogo.

## Subentregas

### UM1.1 — Cierre inmediato de SKU ML

Construye el núcleo mínimo de productos, identidades, casos, evidencia, excepciones y operaciones. Audita todas las claves ML activas con stock y clasifica como urgentes los SKU ausentes, vacíos, inexistentes, ambiguos o contradictorios. Cada caso termina vinculado y verificado, exceptuado explícitamente como `solo_ml`, o permanece urgente.

La corrección remota persiste primero la decisión y la operación. Al ejecutar relee Woo, sobrescribe directamente `SELLER_SKU` con `FB-{id_woo}` sin modificar stock, relee ML y confirma SKU y el stock Woo fresco. Sólo entonces activa la relación y reprocesa ventas retenidas. Si ML rechaza la escritura o la verificación, pasa a intervención conservando el stock; nunca usa automáticamente la saga heredada con stock cero. Una operación con impacto potencial sobre hermanas se bloquea hasta mostrar y confirmar el alcance, hasta que evidencia real demuestre que el endpoint aísla la variación.

El ejecutor corre cada minuto, reclama operaciones para impedir solapamientos y respeta modo, autorización remota, canario y límite de lote. Su frecuencia no reemplaza los scans de cobertura.

Gate: universo inicial conciliado exactamente; cero resoluciones locales sin verificación remota; canario real, rollback y jornada observada. El modo inicial es `shadow`.

### UM1.2 — Cobertura durable

Procesa durablemente webhooks ML `items` y Woo de producto, siempre con relectura puntual desde origen. Conserva scans completos separados cada 15 minutos: Woo degrada salud a los 30 minutos y ML a los 60 sin lectura confiable. Si un scan descubre un cambio sin webhook, converge y crea una alerta/métrica de cobertura perdida. Un evento o venta retenida crea urgencia visible y primer intento de alerta en menos de dos minutos. Tres fallos o quince minutos sin progreso llevan la operación a intervención.

Una baja, papelera o cambio de SKU Woo se confirma releyendo Woo. Si persiste, todas las claves ML vinculadas quedan en stock cero y bloqueadas, y las ventas afectadas se retienen. Cuando reaparece la misma unidad con SKU canónico y stock válido, se verifican ambos canales, se restaura stock y se liberan ventas auditadamente. Una unidad recreada con otro `id_woo` requiere transferencia administrativa manual.

Una publicación ML pausada o sin stock con identidad inválida conserva un caso no urgente. Si se cierra o elimina, la identidad se archiva y el trabajo abierto se cierra con motivo remoto, sin borrar historia. Si reaparece activa con stock e identidad inválida, se protege en cero y pasa a urgencia máxima.

### UM1.3 — Producto Fusion completo

Agrega familias y reglas versionadas, atributos canónicos, productos provisionales, archivo, reserva/transferencia de identificadores y bootstrap idempotente desde unidades Woo vendibles. El `global_unique_id` Woo existente se importa tipado, activo y principal. Producto Fusion conserva todos los EAN/UPC/GTIN y proyecta a Woo sólo el principal. ML conserva todos los valores `GTIN`, `EAN` y `UPC` con su tipo, sin colapsarlos.

Las decisiones heredadas quedan como historia; sólo las exactas, únicas y nuevamente verificadas migran como relaciones. Las identidades ya verificadas sin familia o atributos completos siguen sincronizando, pero generan deuda de catálogo con SLA de siete días; los vínculos nuevos incompletos se bloquean. Cambiar familia o atributos discriminantes revalida todos sus vínculos y conserva automáticamente sólo los exactos no contradictorios.

### UM1.4 — Matching bilateral

Expone dos colas: ML→Fusion y Woo→ML. La segunda incluye unidades Woo activas con stock y exige vincular una publicación, crear una tarea para Ventas con SLA de siete días, o excluir explícitamente el producto del canal. Una tarea vencida escala sin cerrarse y termina sólo al descubrir una publicación verificada o aprobar la exclusión. El candidato aproximado es único, determinista y explicable; precio y fotos no puntúan. Sólo se muestra porcentaje calibrado ≥60%. La calibración exige 200 casos estratificados, ≥90% global y ninguna familia con al menos diez casos por debajo de 80%.

### UM1.5 — Experiencia web y App

La herramienta `Identidad de productos` reúne Pendientes, Productos Fusion, Operaciones e Historial, con salud/alertas persistentes. “Pendientes” cuenta sólo acciones humanas; las operaciones que esperan worker tienen contador propio. `bloqueada_impacto` aparece en Pendientes y Operaciones. Una contradicción de identificador posterior a una identidad verificada crea tarea de catálogo y no reabre ni repite la escritura de SKU.

PC usa lista+detalle y móvil un caso a pantalla completa. La App entra desde Hoy y usa el mismo contrato `/api/v1` y deep links. Offline por hasta 12 horas permite vínculos y notas, pero no excepciones, transferencias, confirmación de impacto ni configuración. Cada operación valida `expected_version` y `evidence_fingerprint`: un conflicto bloquea sólo esa operación y las independientes continúan; una decisión válida entra al flujo remoto normal.

### UM1.6 — Corte estricto y retiro legacy

Migra los SKU que no cumplen `FB-{id_woo}` mediante un canario y lotes de diez. Después de los gates pasa de `shadow` a `enforced`, redirige las pantallas antiguas, bloquea sus mutaciones y conserva GET por 30 días con deprecación y métricas. El rollback vuelve a sombra/read-only sin reactivar escritores anteriores ni revertir efectos remotos ya confirmados.

## Interfaces

- Web: `/herramientas/identidad-productos/` y `/api/identidad-productos`.
- App: `/api/v1/identidad-productos`.
- Deep link: `fusionbikes://identidad-productos/casos/{id}`.
- Mutaciones: `operation_id`, `expected_version` y `evidence_fingerprint` obligatorios.
- Tipos: `FusionProduct`, `ChannelIdentity`, `IdentityCase`, `MatchEvidence`, `IdentityDecision`, `IdentityException`, `PublishTask` e `IdentityOperation`.

Administradores y usuarios con `matcher:write` pueden decidir. Los claims son opcionales y cualquier decisor puede relevar uno con motivo; `expected_version` resuelve la concurrencia. Usuarios con lectura pueden consultar y agregar notas/evidencia. Sólo Administración aprueba `solo_ml`, exclusiones Woo→ML, transferencias, familias y modo `shadow|enforced`.

## Datos y matching

La lectura ML pide `include_attributes=all`, preserva `SELLER_SKU`, todos los `GTIN`/`EAN`/`UPC`, marca, modelo y `user_product_id`, y no confunde `SELLER_SKU` con `seller_custom_field`. Los códigos admiten 8, 12, 13 o 14 dígitos según tipo y exigen dígito verificador válido. Las categorías Woo alimentan un borrador de familias en sombra; Administración valida todas las reglas antes del corte.

## Operación y alertas

Las operaciones son durables, idempotentes, reintentables y auditadas por paso. Tras tres fallos o quince minutos sin progreso, Administración puede reintentar o dejar bloqueado; no se restaura automáticamente un SKU anterior ni se usa stock cero como fallback. Las alertas críticas aparecen en App, pantalla y push para Administración y usuarios activos con `matcher:write`; recordar a los 15 minutos y escalar nuevamente a los 30. Si push falla, la bandeja persistente conserva el aviso.

`solo_ml` excluye la publicación de sincronización de stock Fusion: su cantidad se administra manualmente en ML. Requiere aprobación administrativa, motivo y vigencia fechada o indefinida. Todo cambio de identidad la invalida. Una exclusión Woo→ML sigue las mismas reglas de autoridad y auditoría.

## Pruebas y aceptación

- Esquema idempotente, unicidad, archivo, reserva y transferencia.
- SKU exacto, GTIN válido, duplicados y contradicciones.
- Conciliación exhaustiva del universo ML inicial.
- Saga remota con fallo, timeout o respuesta tardía en cada paso.
- Ventas retenidas y reproceso posterior a verificación.
- Webhooks duplicados/fuera de orden, reinicio y scan de respaldo.
- Claims, control de versión y replay offline conflictivo.
- Excepciones fechadas/indefinidas e invalidación por cambio de identidad.
- Web/App a 390/768/1440, claro/oscuro, teclado, lector de pantalla y deep links.
- Rollback sin pérdida de casos, operaciones, eventos o evidencia.

Una línea ML con identidad insegura retiene el pedido completo. Al abrir un incidente se revisan pedidos abiertos/no conciliados desde la última evidencia confiable. Tras recuperar identidad y stock se reprocesan cronológica e idempotentemente, respetando prioridad ML y deteniéndose cuando el stock no alcanza.

La aceptación del programa exige cero publicaciones activas con stock sin decisión explícita, cero productos Woo activos con stock sin vínculo, tarea o exclusión, scans sanos y ninguna operación pendiente silenciosa. “Observada” exige una jornada comercial completa. El rollback se prueba restaurando una copia sanitaria y cambiando producción a `shadow/read-only`, sin reactivar legacy ni revertir cambios remotos confirmados. El auditor recomienda; sólo el usuario puede declarar una subentrega `aceptada`.

## Estado, handoff y evidencia en cada avance

Esta regla es obligatoria y no depende de que la subentrega termine. **Cada vez que un agente
avanza —aunque el avance sea parcial y aunque la sesión se corte— actualiza, en el mismo commit
que el código:**

1. **Estado**: la ficha de la subentrega en curso (`docs/superpowers/deliveries/UM1.N-*.md`) y,
   si el estado cambió, la fila correspondiente en `docs/superpowers/deliveries/README.md`.
   El estado se escribe con el vocabulario del maestro (`planificada → desarrollo → candidata →
   publicada → observada → aceptada`); no se infiere por existir código, commit o rama.
2. **Evidencia de dónde avanzó**: en la sección `Evidencia` de la ficha, con ubicación exacta —
   worktree, rama, commit, archivos tocados— y el **comando reproducible junto a su resultado
   copiado literalmente** (por ejemplo `npx vitest run test/identidad-productos.test.js — 15/15`).
   Un gate que no se ejecutó se escribe `no ejecutado` con la razón; nunca se deja en blanco ni
   se da por aprobado.
3. **Handoff**: la sección `Checkpoint para el próximo agente` de la ficha, reescrita para que
   otro agente pueda retomar sin leer esta conversación. Debe decir: base y worktree, qué quedó
   funcionando y verificado, **qué quedó a medias y en qué archivo/línea**, y cuál es la próxima
   acción reproducible.
4. **Decisiones**: toda decisión que otro agente podría revertir por no conocer su motivo se
   registra en `/opt/fusionbikes/herramientas/docs/superpowers/decisions/plan-maestro-decisions.md`
   con ID `PM-NNN`, decisión vigente e impacto. Entran tanto las decisiones de producto como las
   técnicas no obvias: por qué una alternativa razonable quedó descartada, qué invariante protege
   una línea que parece inofensiva, y qué decisión anterior queda superada. Si una decisión nueva
   contradice una vigente, no se reescribe la vieja en silencio: se marca como superada, con fecha
   y quién la superó. Una decisión que solo vive en un comentario de código o en el mensaje de un
   commit **no** cuenta como registrada: el comentario explica el código, el registro explica el
   programa.

Un avance sin estado, evidencia y handoff actualizados se trata como trabajo no entregado: el
siguiente agente lo re-verifica desde cero. Si una sesión se agota a mitad de una subentrega, el
handoff es lo último que se escribe antes de soltar el trabajo.

## Límites

- Woo continúa como autoridad de stock.
- Excel deja de ser fuente de identidad.
- Solo existe refresco focalizado por caso; no hay scan global manual.
- `lib/ingresoMatcher.js` queda fuera del rediseño y conserva su comportamiento.
- Los conteos de descubrimiento son una fotografía; cada gate usa una auditoría fresca.
