# Evaluación externa del diseño de E2 T1 (Codex, gpt-5.6-sol, esfuerzo bajo) — 2026-09-18

Sólo lectura. Diseño evaluado: `specs/2026-09-18-e2-tramo1-modelos-variantes-design.md` en el commit `b44c23e`.

## Críticos

1. **§4 no puede proyectar “varias veces” desde el inbox actual.** `integrations.inbox_messages` es una cola de consumo único: cada mensaje tiene un solo `status`, `lease_token` y `lease_until` ([0001_esquema_base.sql:217](/opt/fusionbikes/herramientas/plataforma/migrations/0001_esquema_base.sql:217)); el worker reclama y completa esa única fila. No hay checkpoint por proyector ni fan-out. Un proyector E2 independiente perderá mensajes ya marcados `succeeded`, o competiría con el consumidor de E1. La arquitectura de §4 necesita un dispatcher que invoque todas las proyecciones atómicamente, o un log inmutable con offsets/checkpoints por consumidor.

2. **El inbox no es un snapshot completo disponible a voluntad.** Sí guarda el cuerpo completo que devolvió cada GET: Woo usa `payload: p` ([woo.ts:74](/opt/fusionbikes/herramientas/plataforma/src/reconciliacion/adaptadores/woo.ts:74)) y ML `payload: it` ([ml.ts:314](/opt/fusionbikes/herramientas/plataforma/src/reconciliacion/adaptadores/ml.ts:314)); el motor cifra exactamente ese payload ([motor.ts:63](/opt/fusionbikes/herramientas/plataforma/src/reconciliacion/motor.ts:63)). Pero sólo encola cuando la versión/hash cambia ([motor.ts:87](/opt/fusionbikes/herramientas/plataforma/src/reconciliacion/motor.ts:87)). Las vueltas Woo completas leen únicamente `_fields=id` y no generan contenido ([woo.ts:124](/opt/fusionbikes/herramientas/plataforma/src/reconciliacion/adaptadores/woo.ts:124)). Por lo tanto:

   - Un recurso leído antes de arrancar E2 y no modificado después no vuelve a producir payload.
   - La vuelta diaria de ML vuelve a hacer el multiget, pero tampoco reencola un ítem sin cambios.
   - El payload cifrado tiene retención contractual de 90 días ([diseño E1 §3](/opt/fusionbikes/herramientas/docs/superpowers/specs/2026-09-15-e1-tramo2-barridos-design.md:34)); no sirve como almacenamiento permanente del snapshot inicial.
   - La cifra “271, sólo los que cambiaron” de §2 contradice el supuesto de cobertura completa de §4.

   Hace falta un bootstrap explícito de E2 que fuerce una emisión completa versionada, o una fuente/snapshot durable separada. Lanzar otra corrida ordinaria no resuelve la falta.

3. **§5 no define la identidad estable necesaria para fusionar una variante pendiente con una existente.** Hoy el flujo propuesto crea una variante nueva por publicación sin decisión (§5, línea 84). Si luego se asigna un SKU que ya pertenece a otra variante, el `UNIQUE(sku)` rechaza la actualización. Si se evita el error cambiando la representación, queda una variante huérfana/duplicada; y el trigger de “SKU inmutable” impide corregir una asignación equivocada.

   Debe existir una operación transaccional explícita de resolución que:

   - bloquee variante provisional, variante destino y clave externa;
   - mueva la representación y los casos a la variante que ya posee el SKU;
   - archive la provisional sin reutilizar su identidad;
   - cierre el caso y agregue auditoría;
   - sea idempotente y tenga versión esperada/conflicto concurrente.

   “Asignar SKU a la variante pendiente” sólo es válido cuando ese SKU todavía no existe. Ese borde y su prueba faltan por completo en §5 y §7.

4. **El modelo no representa una familia ML `user_product`.** `modelo_ml = user_product` sólo etiqueta una representación; no guarda `user_product_id` ni una entidad/clave de familia. En el modelo nuevo, varios ítems distintos pueden ser variantes hermanas de la misma familia. Con §5 quedarían como modelos independientes o sin modelo. E1 conserva el cuerpo completo, pero su proyección técnica ni siquiera incluye `user_product_id`: sólo estado, fecha y IDs/cantidad de variaciones ([ml.ts:320](/opt/fusionbikes/herramientas/plataforma/src/reconciliacion/adaptadores/ml.ts:320)). Se necesita una clave externa de familia y una regla para que esos ítems compartan `product_model`.

5. **Las representaciones ML clásicas no están modeladas con suficiente precisión.** Un ítem clásico con variaciones necesita distinguir:

   - una representación del ítem/contenedor, que no es vendible por sí misma;
   - una representación vendible por cada `variation.id`;
   - atributos/SKU por variación;
   - el vínculo común al mismo modelo.

   `external_representations` aparece descrita como “ítem o variación” pero no se especifica si puede apuntar a modelo además de variante, ni cómo se impide convertir el ítem padre en vendible. E1 guarda el item completo, pero su proyección sólo extrae `variation.id` y cantidad ([ml.ts:318](/opt/fusionbikes/herramientas/plataforma/src/reconciliacion/adaptadores/ml.ts:318)). Falta un escenario contractual de ítem clásico con dos variaciones.

6. **La restricción externa propuesta admite duplicados en recursos sin variación.** En PostgreSQL, un `UNIQUE(canal, cuenta, recurso, variación)` normal permite múltiples filas cuando `variación IS NULL`. Eso afecta exactamente a productos Woo simples e ítems ML simples. Debe usar `NULLS NOT DISTINCT`, una clave normalizada no nula, o índices parciales separados.

## Altos

7. **Los modelos ML-only quedan sin regla de pertenencia.** `product_models` se define sólo como “padre variable de Woo, o un simple” (§5, línea 74), pero §5 crea variantes desde publicaciones ML sin decisión. No se dice qué `model_id` reciben un ítem ML simple, un clásico con variaciones ni una familia `user_product` sin contraparte Woo. Si `sellable_variants.model_id` es obligatorio, no pueden importarse; si es nullable, `/models` deja de representar el universo.

8. **Woo sin SKU, SKU duplicado o SKU no canónico no tiene tratamiento.** §5 afirma que toda variación/simple Woo crea una variante con `FB-{ID_WOO}`. Eso confunde el SKU canónico generado con el SKU realmente observado en Woo y oculta anomalías. El legado admite SKU vacío y duplicado —el índice no es único ([db/schema.sql:1](/opt/fusionbikes/herramientas/db/schema.sql:1))— y el propio código cuenta ambos casos ([woo.js:759](/opt/fusionbikes/herramientas/routes/woo.js:759)). Deben clasificarse como evidencia/caso, conservar el valor remoto y definir si `FB-{ID_WOO}` se deriva siempre o sólo tras normalización aprobada.

9. **La “barrida completa inicial” de ML no encaja como está descripta con E1.** E1 ya tiene una única corriente `ml.items/full_scan` diaria ([0004_corrientes.sql:34](/opt/fusionbikes/herramientas/plataforma/migrations/0004_corrientes.sql:34)). Crear otra barrida exige definir si comparte cursor, scheduler, lease y exclusión por cuenta. La estimación de §4 también es incompleta: para 7.000 ítems son aproximadamente 350 multigets **más** unas 70 páginas de scan, no 350 llamadas totales. Además:

   - los cinco multigets de cada página se lanzan en paralelo ([ml.ts:340](/opt/fusionbikes/herramientas/plataforma/src/reconciliacion/adaptadores/ml.ts:340));
   - el cliente limita conexiones concurrentes, no 60 solicitudes/minuto ([cliente-http.ts:42](/opt/fusionbikes/herramientas/plataforma/src/reconciliacion/cliente-http.ts:42));
   - el transporte gateway no muestra limitador de tasa ([transporte-gateway.ts:146](/opt/fusionbikes/herramientas/plataforma/src/reconciliacion/transporte-gateway.ts:146));
   - una corrida fallida se reintenta desde su cursor confirmado anterior, sin checkpoint durable por página visible en el contrato del worker.

   “~6 minutos al tope de 60/min” no es una garantía implementada. Falta presupuesto conjunto con órdenes, señales y `missed_feeds`, limitador por cuenta y prueba de 429 a mitad de catálogo sin recomenzar cientos de llamadas.

10. **La instantánea del matcher no tiene un corte consistente con Woo/ML.** `sku_matcher_decisiones` es estado mutable, no historial: su PK es `clave` ([db/schema.sql:28](/opt/fusionbikes/herramientas/db/schema.sql:28)); las decisiones se sobrescriben mediante upsert ([cobertura.js:876](/opt/fusionbikes/herramientas/routes/cobertura.js:876)) y también se eliminan ([cobertura.js:922](/opt/fusionbikes/herramientas/routes/cobertura.js:922)). Mientras se copia:

   - puede cambiar una decisión después de leer parte de la tabla;
   - una decisión puede referir a una versión ML/Woo distinta de la que proyecta E2;
   - una segunda instantánea append-only puede importar como vigentes dos decisiones incompatibles;
   - `actualizado_en` no demuestra qué estado remoto vio el operador.

   El hash de la instantánea sólo prueba el contenido copiado, no consistencia temporal. Hace falta snapshot SQLite transaccional/backup consistente, `cutoff_at`, hash y conteo, más captura delta o sincronización continua hasta retirar el escritor legado. La pregunta de §9.2 no puede quedar abierta antes del plan.

11. **“Append-only” no alcanza para representar que una decisión legacy dejó de estar vigente.** §5 copia acciones como evidencia, pero no define `effective_from/effective_to`, supersesión, revocación ni el evento compensatorio para deletes/remapeos. Sin eso, E2 no puede decidir cuál es la decisión efectiva ni cumplir “viceversa” en §7.

12. **Faltan vigencia y archivo en representaciones externas.** La ficha exige entidades con vigencia y archivo (§Diseño, datos e interfaces), pero el modelo resumido de §5 no fija `observed_at`, versión remota, estado remoto, `archived_at`, razón de baja ni relación con el inbox/run de procedencia. Una publicación cerrada, borrada o movida de familia no tiene transición definida.

## Medios

13. **“Importación repetible = mismo hash” (§7) no es verificable sin definir el hash.** Falta especificar universo, orden canónico, columnas incluidas, exclusión de timestamps/IDs generados y el punto remoto congelado. Dos corridas contra fuentes vivas pueden dar hashes distintos legítimamente; dos importaciones defectuosas pueden dar el mismo hash si omiten la misma clase de filas.

14. **“100 % del universo” (§7) no define denominadores independientes.** Debe reconciliar, por cuenta y tipo, al menos: padres Woo, simples Woo, variaciones Woo, ítems ML simples, variaciones ML clásicas e ítems `user_product`; además activos, pausados, cerrados/borrados y rechazos. “Cada publicación y cada producto” no detecta que se perdieron variaciones anidadas o familias.

15. **“Cruce íntegro” está formulado incorrectamente.** “Toda decisión confirmada tiene representación, y viceversa” implicaría que toda representación debe tener decisión, contradiciendo pendientes y omitidas. Debe separar conjuntos: decisiones vigentes aplicables ↔ representaciones vinculadas; pendientes ↔ caso abierto; omitidas ↔ decisión de omisión vigente; huérfanas ↔ rechazo/caso explícito.

16. **§7 no alcanza para declarar terminada la ficha E2.** Es sólo un gate parcial de T1, pero el título dice “ficha de E2”. La ficha exige además taxonomía, atributos, unidades, imágenes, identificadores y packs/kits ([E2:15](/opt/fusionbikes/herramientas/docs/superpowers/deliveries/E2-catalogo-modelo-importacion.md:15)); snapshots de packs, staging/rechazos, métricas, evidencia reproducible, revisión independiente, suite global y observación durante siete días ([E2:55](/opt/fusionbikes/herramientas/docs/superpowers/deliveries/E2-catalogo-modelo-importacion.md:55)). T1 debería declararse “terminado como tramo”, sin afirmar que satisface la ficha completa.

17. **Los escenarios de §7 omiten justamente los casos de mayor riesgo.** Faltan pruebas contractuales para:

   - Woo simple sin SKU y SKU duplicado;
   - ML clásico con varias variaciones;
   - dos ítems de una misma familia `user_product`;
   - publicación pendiente que luego recibe un SKU ya existente;
   - dos resoluciones concurrentes;
   - remapeo/revocación durante la convivencia con legado;
   - recurso sin cambios anterior al arranque de E2;
   - payload expirado o ya consumido;
   - 429/fallo a mitad de `ml.items`;
   - duplicado con `variación NULL`;
   - cierre/baja y reaparición de representaciones;
   - conciliación por cuenta y cobertura de variaciones, no sólo de recursos padre.
