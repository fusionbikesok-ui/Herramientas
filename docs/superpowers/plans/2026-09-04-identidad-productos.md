# UM1 urgente — Identidad de productos y cierre de publicaciones ML sin SKU

**Estado:** especificación aprobada; implementación en curso.
**Prioridad:** UM1.1 es bloqueante y precede UM1.2–UM1.6.
**Superficies:** VPS, web responsive y App iPhone.
**Seguridad:** ninguna escritura real en ML se habilita sin gates verdes, canario designado y autorización operativa.

## Resultado del programa

Reemplazar Matcher, Cobertura y Guardia por un núcleo de identidad bilateral ML↔Woo basado en `Producto Fusion`. Woo continúa como autoridad de stock. Una clave ML (`item_id + variation_id`) activa con stock solo queda cubierta cuando posee identidad y stock verificados remotamente, o una excepción explícita `solo_ml`.

Un `SELLER_SKU` válido existe, no está vacío, coincide textualmente con un único SKU Woo vigente, no contradice un GTIN válido y su relación fue persistida y verificada. `seller_custom_field` es evidencia auxiliar y nunca cobertura.

## Invariantes

- Un Producto Fusion representa una unidad vendible; familia y producto padre son conceptos separados.
- Existe como máximo una identidad Woo activa por Producto Fusion y pueden existir múltiples claves ML.
- `fusion_sku` no se edita: es `FB-{id_woo}`. Un producto provisional sin Woo no tiene SKU ni puede sincronizarse.
- Activar exige nombre canónico, familia y atributos requeridos por la familia.
- No hay borrado físico. SKU y GTIN históricos quedan reservados; transferirlos requiere Administración y auditoría.
- Cada clave ML vinculada publica el stock Woo completo.
- Una relación local no queda verificada hasta releer ML y confirmar SKU y stock objetivo con observaciones confiables de menos de 60 minutos.
- Las decisiones aproximadas requieren confirmación individual. Solo `SELLER_SKU` exacto único o GTIN canónico válido único pueden automatizarse.
- Si SKU y GTIN señalan productos distintos, la clave queda bloqueada hasta una decisión explícita; el identificador descartado continúa marcado para corrección.

## Subentregas

### UM1.1 — Cierre inmediato de SKU ML

Construye el núcleo mínimo de productos, identidades, casos, evidencia, excepciones y operaciones. Audita todas las claves ML activas con stock y clasifica como urgentes los SKU ausentes, vacíos, inexistentes, ambiguos o contradictorios. Cada caso termina vinculado y verificado, exceptuado explícitamente como `solo_ml`, o permanece urgente.

La corrección remota persiste primero la decisión y luego ejecuta: stock cero y verificación; limpiar SKU y verificar; escribir `FB-{id_woo}` y verificar; restaurar stock Woo y verificar; activar relación y reprocesar ventas retenidas. Una operación con impacto potencial sobre hermanas se bloquea hasta confirmar ese impacto.

Gate: universo inicial conciliado exactamente; cero resoluciones locales sin verificación remota; canario real, rollback y jornada observada. El modo inicial es `shadow`.

### UM1.2 — Cobertura durable

Procesa durablemente webhooks ML `items`, agrega webhooks Woo de producto con relectura desde origen y conserva scan completo cada 15 minutos. La salud se degrada a los 60 minutos sin lectura confiable. Un evento o venta retenida crea urgencia visible y primer intento de alerta en menos de dos minutos. Claims avisan a los 20 minutos y vencen a los 30. Tres fallos o quince minutos llevan la operación a intervención.

### UM1.3 — Producto Fusion completo

Agrega familias y reglas versionadas, atributos canónicos, productos provisionales, archivo, reserva/transferencia de identificadores y bootstrap idempotente desde las unidades Woo actuales. Las decisiones heredadas quedan como historia; solo las exactas, únicas y nuevamente verificadas migran como relaciones.

### UM1.4 — Matching bilateral

Expone dos colas: ML→Fusion y Woo→ML. La segunda exige vincular una publicación, crear una tarea para Ventas con SLA de siete días, o excluir explícitamente el producto del canal. El candidato aproximado es único, determinista y explicable; precio y fotos no puntúan. Solo se muestra porcentaje calibrado ≥60%. La calibración exige 200 casos estratificados, ≥90% global y ninguna familia con al menos diez casos por debajo de 80%.

### UM1.5 — Experiencia web y App

La herramienta `Identidad de productos` reúne Pendientes, Productos Fusion, Operaciones e Historial, con salud/alertas persistentes. PC usa lista+detalle y móvil un caso a pantalla completa. La App entra desde Hoy y usa el mismo contrato `/api/v1`, deep links y replay offline de hasta 12 horas con `expected_version` y `evidence_fingerprint`; un conflicto detiene la cola.

### UM1.6 — Corte estricto y retiro legacy

Migra los SKU que no cumplen `FB-{id_woo}` mediante un canario y lotes de diez. Después de los gates pasa de `shadow` a `enforced`, redirige las pantallas antiguas, bloquea sus mutaciones y conserva GET por 30 días con deprecación y métricas. El rollback vuelve a sombra/read-only sin reactivar escritores anteriores ni revertir efectos remotos ya confirmados.

## Interfaces

- Web: `/herramientas/identidad-productos/` y `/api/identidad-productos`.
- App: `/api/v1/identidad-productos`.
- Deep link: `fusionbikes://identidad-productos/casos/{id}`.
- Mutaciones: `operation_id`, `expected_version` y `evidence_fingerprint` obligatorios.
- Tipos: `FusionProduct`, `ChannelIdentity`, `IdentityCase`, `MatchEvidence`, `IdentityDecision`, `IdentityException`, `PublishTask` e `IdentityOperation`.

Administradores y usuarios con `matcher:write` pueden decidir. Usuarios con lectura pueden consultar y agregar notas/evidencia. Familias y modo `shadow|enforced` son exclusivos de Administración.

## Datos y matching

La lectura ML pide `include_attributes=all`, preserva `SELLER_SKU`, GTIN, marca, modelo y `user_product_id`, y no confunde `SELLER_SKU` con `seller_custom_field`. GTIN admite 8, 12, 13 o 14 dígitos y exige dígito verificador válido. Las categorías Woo alimentan un borrador de familias en sombra; Administración valida todas las reglas antes del corte.

## Operación y alertas

Las operaciones son durables, idempotentes, reintentables y auditadas por paso. Tras tres fallos o quince minutos, Administración puede reintentar, restaurar el SKU anterior verificándolo, o dejar bloqueado. Las alertas críticas aparecen en App, pantalla y push para todos los administradores; recordar a los 15 minutos y escalar nuevamente a los 30. Si push falla, la bandeja persistente conserva el aviso.

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

La aceptación del programa exige cero publicaciones activas con stock sin decisión explícita, cero productos Woo con stock sin destino ML, scan sano y ninguna operación pendiente silenciosa.

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

Un avance sin estado, evidencia y handoff actualizados se trata como trabajo no entregado: el
siguiente agente lo re-verifica desde cero. Si una sesión se agota a mitad de una subentrega, el
handoff es lo último que se escribe antes de soltar el trabajo.

## Límites

- Woo continúa como autoridad de stock.
- Excel deja de ser fuente de identidad.
- Solo existe refresco focalizado por caso; no hay scan global manual.
- `lib/ingresoMatcher.js` queda fuera del rediseño y conserva su comportamiento.
- Los conteos de descubrimiento son una fotografía; cada gate usa una auditoría fresca.
