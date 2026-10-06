# Revisión: plan de recepción documental contra el plan maestro E0–E26

**Fecha:** 2026-09-21
**Tipo:** revisión de diseño (hallazgos priorizados). No es un plan ejecutable.
**Objeto revisado:** `plans/2026-09-21-recepcion-documental-stock-anticipado.md`
**Salida que cumple:** la sección 7 de ese plan pide "una lista de hallazgos priorizados".

## Contexto

José pidió revisar el plan de recepción porque tiene **urgencia inmediata por lentitud en tres
frentes**: recibir mercadería contra remito/factura, dar de alta productos y variaciones nuevas,
y la respuesta general de la app.

Encuadre fijado por José durante la revisión: *"esto no tiene que ser total, ya que el plan
maestro lo iba a tratar, pero hay urgencia inmediata para algunas cosas"*. Por eso la revisión
cotejó el plan contra el maestro y las 27 fichas, en vez de evaluarlo aislado.

**Corrección registrada:** una primera pasada recomendó hacer stock anticipado en SQLite para
evitar PostgreSQL. Eso era incorrecto y quedó retirado: contradice una decisión vigente (Postgres
es el destino canónico), E1 está desplegado y E2 tramo 1 también. Una vía SQLite paralela crearía
una segunda autoridad que E7 después tendría que apagar.

## Estado real del código verificado (2026-09-21)

Contrastado contra el repo, no contra la documentación:

- `public/recepcion/index.html:608-644` — el matching automático corre **entero en el navegador**.
  `matchItem` tiene dos señales: SKU exacto contra `codigo_proveedor`, y `fuzzyMatchItem`, que
  cuenta substrings de palabras >2 caracteres sobre el catálogo completo y acepta con
  `mejorScore >= 2`. Sin IDF, sin atributos, sin desempate entre hermanos, sin confianza.
  **Ningún test lo cubre.**
- `lib/ingresoMatcher.js` — 168 líneas, TF-IDF (`tsr`), atributos estructurados, contradicción de
  color/talle, detección de empate entre hermanos, devuelve confianza y razones. 252 líneas de
  test en `test/ingreso-matcher.test.js`. Su docblock dice que reemplaza el `score >= 2` del
  prototipo de recepción. **Está huérfano: ninguna ruta Express lo importa.** Fue escrito contra
  el incidente real de los talles 41/43/45 que sumaba todo el stock a una sola variación.
- `routes/recepciones.js` — el backend recibe `id_woo` ya resuelto por el navegador; nunca
  matchea. Serializa por `id_woo` con un mapa de locks in-process que no sobrevive a multiproceso.
- **No existe tabla de alias por proveedor.** `recepcion_items.codigo_proveedor` se guarda y jamás
  se relee. `mapeo_fusion` es de otro dominio y no tiene columna proveedor.
- `routes/nuevosProductos.js` analiza con IA y devuelve una ficha, pero **no crea nada en Woo**.
  `estado_item='pendiente_creacion'` y `ficha_json` existen en el esquema y el front de recepción
  no los usa nunca (`grep pendiente_creacion public/recepcion/index.html` → cero hits). El alta
  real es 100 % manual.
- Extracción: Gemini `gemini-3.1-flash-lite`. PDF e imagen por `inline_data`, CSV/XML/TXT por
  texto. **XLSX no está soportado** y no hay parser de Excel en el repo.
- `cargarCatalogo()` (`public/recepcion/index.html:396`) baja el catálogo completo al navegador y
  `fuzzyMatchItem` lo barre entero por cada línea del documento.

## Hallazgos priorizados

### P0 — El alta de productos nuevos no existe en ninguna ficha del programa

Verificado por grep sobre las 27 fichas de `deliveries/`: "alta", "producto nuevo", "productos
nuevos", "alias" y "anticipad" **no aparecen en ninguna**. Los candidatos naturales lo excluyen:

- **E2** importa lo existente: "Catálogo relacional completo **importado** y reconciliado". Modela
  `product_models`/`sellable_variants` pero no tiene camino de creación.
- **E12** normaliza existentes: "No cambia storefront ni publica en Woo", "Nunca inventar
  atributos sin evidencia".
- **E13** publica, pero lotes de normalización de E12 — no productos nuevos.
- **E6** no lo menciona.

El único lugar del repo donde el alta está especificada es §4.5 del plan de recepción, que a su
vez la declara provisional y delega el resto a un "módulo completo de catálogo" / "herramienta
completa" que **no tiene número E asignado**.

Es un hueco del programa, no un detalle de secuencia. Y es la mitad del dolor declarado.

### P0 — E6 oficial y la "Etapa 2" del plan son cosas distintas

La ficha E6 tiene 6 tablas (`receipts`, `receipt_lines`, `count_sessions`, `count_lines`,
`count_approvals`, `location_assignments`) y su alcance es "recepción parcial, putaway, conteo
ciego, aprobación de diferencias". Las palabras **documento, remito, factura y proveedor no
figuran en la ficha**.

La Etapa 2 del plan agrega tres dominios que E6 no nombra: compras
(`purchasing.purchase_orders`), documentos con extracción IA (`receiving.documents`,
`document_extractions`, `document_lines`), alias de proveedor, `product_drafts` y
`advance_activations`. Son ~11 tablas en 3 esquemas.

A la inversa: **la Etapa 2 pierde los conteos**, que sí son de E6.

Llamar "E6" a la Etapa 2 subdimensiona el trabajo por un factor de ~3 y deja los conteos sin
dueño. Por la regla de IDs congelados del maestro, esto no es E6 redefinida: es alcance nuevo que
requiere número posterior a E26 y decisión documental.

### P1 — La dependencia E3/E4 → recepción es nominal, no real

El DAG obliga E2→E3→E4→E5→E6. Al mirar el contenido:

- **E4 es nominal para recepción.** Es la campaña de 39 SKU fuera de convención y el apagado de
  escritores legacy de identidad. Nada de eso condiciona compras, documentos, alias de proveedor
  ni stock anticipado.
- **E3 es parcialmente real.** Recepción necesita un motor de identidad explicable, y ya existe en
  el legado (`lib/ingresoMatcher.js`). Lo que E3 **no** da, y recepción sí necesita, es la capa
  proveedor: los pasos 1 y 3 del orden de resolución del plan ("alias confirmado para ese
  proveedor", "código de proveedor confirmado previamente") no están en E3 en ninguna forma.
- **E5 sí es dependencia dura de la Etapa 2**: sin libro append-only no hay dónde escribir
  movimientos de recepción.

La dependencia dura para el E6 canónico es **E5, no E3/E4**. El alivio urgente sobre el legado no
depende de ninguna de las tres.

### P1 — El programa no direcciona la lentitud del legado en ningún punto

Grep de `lent(o|itud)`, `performance`, `rendimiento` sobre las 27 fichas: **cero resultados**. Lo
único cercano es un bullet boilerplate de latencia p95/p99, que es observabilidad de los servicios
nuevos.

Las fichas que tocan el legado lo tratan como algo a **archivar y apagar** (E14, E15), nunca a
acelerar, y ambas están al final del DAG (E14 depende de E11 y E13). Si la lentitud duele hoy, el
programa no prevé alivio antes de E14.

### P2 — E5, E6, E7 y E12 no cumplen el contrato para salir de borrador

`delivery-contract.md` exige que una ficha se pueda ejecutar "sin elegir diseño, esquema, API,
conducta ante fallos, prueba, rollout ni rollback", y declara bloqueante "una API supuesta, una
decisión abierta o un rollback genérico".

E5, E6, E7 y E12 tienen como única definición de interfaces frases del tipo "API v2 de
recepción/conteo con leases" — exactamente la API supuesta que el contrato prohíbe. Salvo E2 (246
líneas con bitácora real), las fichas son **todas de exactamente 78 líneas generadas del mismo
template**, con ~8 bullets específicos cada una.

`npm run docs:validate-deliveries` pasa porque chequea presencia de secciones, no profundidad. El
gate existe pero no muerde.

### P2 — Decisiones que el plan de recepción declara abiertas y nunca cierra

Su §7 lista preguntas y el documento no las responde. Tres son bloqueantes:

- **Fórmula exacta de disponibilidad** con físico, anticipado, ventas y reservas conviviendo. Sin
  ella "no sumar dos veces" es una intención, no una regla. Debe conciliar con el invariante ya
  fijado del maestro: `disponible = existencia - reservas - retenciones`, que **no tiene término
  de anticipado**.
- **Autoridad entre pedido, remito, factura y conteo físico** cuando discrepan.
- **Los "22 casos sin_match"**: el número aparece una sola vez en todo el repo, en la línea 449 del
  propio plan, como criterio de salida de sí mismo; los fixtures que lo respaldarían son su tarea
  1. Las tablas de recepción están en 0 filas en el checkout. Hay que re-derivarlo de producción.

### P2 — Contradicción interna del plan sobre qué se precarga como resuelto

§3.1 dice "solo los matches exactos o previamente confirmados se precargan como resueltos". §3.3
ofrece "confirmar conjuntamente todos los matches de confianza alta". Pero `autoAplicable()`
(`lib/ingresoMatcher.js:166`) da alta sin confirmación previa ni SKU exacto. El plan dice las dos
cosas.

### P3 — XLSX se promete sin base técnica

§3.4 y §4.1 lo dan por soportado. No hay parser de Excel en el repo; el front lo mandaría como
binario a Gemini, que no lo lee. Es dependencia nueva no declarada (`xlsx`/`exceljs`). O se
declara, o se saca de la lista.

## Recomendación

Separar en tres piezas, no en dos etapas.

### 1. Urgencia inmediata sobre el legado — ejecutable sin tocar el DAG

Cabe bajo la regla vigente del maestro: *"el legado sólo recibe correcciones que eviten pérdida
económica o bloqueo operativo mientras su vertical tenga reemplazo planificado"*. Sumar stock a la
variación equivocada **es pérdida económica**, así que califica.

- Cablear `lib/ingresoMatcher.js` en el backend; retirar `matchItem`/`fuzzyMatchItem` del
  navegador. El motor y sus tests ya existen: es cableado, no desarrollo. Efecto colateral
  medible: desaparece la descarga del catálogo completo al browser.
- Alias por proveedor en SQLite, versionado y revocable, para que cada corrección deje de
  repetirse.
- Cerrar el alta: `POST /products` a Woo en borrador desde la `ficha_json` que
  `routes/nuevosProductos.js` ya genera, consumiendo el `estado_item='pendiente_creacion'` que el
  esquema ya tiene.

Es la Etapa 1 del plan más el alta que el plan dejó para después. No crea autoridad nueva ni
contradice E5/E6/E7: son correcciones sobre el vertical que E7 va a apagar igual.

### 2. Ficha nueva para el hueco del programa

Alta de productos/variaciones, alias de proveedor y stock anticipado no tienen dueño en E0–E26.
Por la regla de IDs congelados corresponde **número nuevo posterior a E26 con decisión documental
de José**, no estirar E6.

Partición sugerida: compras + documentos + alias + drafts en una ficha; stock anticipado en otra,
dependiente de E5 y con la fórmula de disponibilidad resuelta antes de salir de borrador.

### 3. E6 se queda como está

Recepción física, putaway y conteos sobre el libro. Dependencia dura E5. No se le cuelgan compras,
documentos ni anticipado.

## Decisiones de José (2026-09-21)

1. **La urgencia sobre el legado se ejecuta. SÍ.** Acepta que E7 después descarte ese trabajo a
   cambio de alivio inmediato. Autoriza el punto 1 de la recomendación: cablear `ingresoMatcher`
   en backend, alias por proveedor en SQLite, y cerrar el alta con el `POST /products` faltante.
2. **El número nuevo posterior a E26 queda en suspenso.** *"Lo vemos, capaz es cuestión que se
   toca en alguna entrega intermedia."* No se crea ficha por ahora. Esto **no** habilita meter
   documentos, compras ni anticipado dentro de E6: el hallazgo P0 sobre el alcance de E6 sigue
   vigente y habrá que resolverlo cuando se decida dónde cae.
3. **La fórmula de disponibilidad con anticipado se cierra después, en el plan maestro.** No
   bloquea el punto 1, que no toca anticipado. Sí es prerrequisito de cualquier trabajo de stock
   anticipado; hasta entonces rige `disponible = existencia - reservas - retenciones`.
4. **PENDIENTE, sin decidir: re-derivar de producción el número real de casos `sin_match`.**
   Es el criterio de salida del trabajo autorizado en (1) y hoy no tiene respaldo. Sin ese número
   el punto 1 se puede implementar pero no se puede dar por verificado.

## Alcance ejecutable autorizado (derivado de la decisión 1)

Lo que sigue queda habilitado para convertirse en un plan ejecutable con TDD. **No está
implementado.** Orden sugerido, cada pieza usable sola:

1. **Cablear `ingresoMatcher` en el backend.** Endpoint que reciba proveedor + líneas
   normalizadas y devuelva candidatos con confianza y razones; retirar `matchItem` y
   `fuzzyMatchItem` de `public/recepcion/index.html:608-644`; pantalla agrupada por confianza.
   Reusa `lib/ingresoMatcher.js` y `test/ingreso-matcher.test.js`, ya escritos. Efecto colateral
   medible: desaparece la descarga del catálogo completo al navegador (`cargarCatalogo()`,
   línea 396).
   *Antes de cerrarlo:* congelar fixtures reales anonimizados y re-derivar el número de
   `sin_match` (decisión 4), o el criterio de salida queda sin poder verificarse.
2. **Alias por proveedor en SQLite.** Tabla nueva, versionada y revocable, con el orden de
   resolución del plan original §3.1 (alias confirmado → SKU exacto → código de proveedor
   confirmado). Hoy `recepcion_items.codigo_proveedor` se guarda y nunca se relee.
3. **Cerrar el alta.** `POST /products` a Woo en borrador/no publicado desde la `ficha_json` que
   `routes/nuevosProductos.js` ya genera, consumiendo el `estado_item='pendiente_creacion'` que el
   esquema ya tiene y el front nunca usa.

Restricciones que siguen rigiendo sobre este trabajo: no toca anticipado (decisión 3), no crea
autoridad de stock nueva, y los productos nuevos quedan en borrador/no publicados sin enviarse a
Mercado Libre.

## Comandos de verificación de esta revisión

```
grep -rniE "alta|producto nuevo|alias|anticipad" docs/superpowers/deliveries/
grep -rniE "lent|performance|rendimiento" docs/superpowers/deliveries/
grep -rn "ingresoMatcher" --include=*.js .
grep -rn "pendiente_creacion" public/recepcion/index.html
grep -rn "sin_match" docs/ test/
npx vitest run test/ingreso-matcher.test.js
```
