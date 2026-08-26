# Plan: Control de stock por ciclos + etiquetas + auditoría de calidad

## Contexto

José vende productos que no están físicamente en el depósito. Ya lleva 3 strikes y su
trabajo depende de resolverlo. La evidencia está en la base: **19 SKUs en stock negativo**
(ventas de cosas inexistentes ya consumadas), concentrados en accesorios y repuestos chicos
—Muc-Off, IGPSPORT, Super B, repuestos Shimano— no en bicicletas.

Hoy el módulo de inventario permite contar por categoría/marca, pero **nada garantiza que
la tienda entera se revise**: no existe registro de cuándo se contó cada SKU por última vez,
ni noción de rotación, ni un plan que reparta el trabajo en sesiones alcanzables. Las
categorías "olvidadas" quedan olvidadas porque nada las reclama.

**Objetivo:** que ningún SKU pase más de 20 días sin control, con sesiones de máximo 2 h,
y que cada conteo alimente además la calidad de las publicaciones (etiquetas, matcheo ML,
precios, fotos, descripciones, health, clips).

---

## ⚠️ Lo primero: la herramienta de conteo hoy CREA sobreventa

Este hallazgo cambia el orden de todo el plan y hay que arreglarlo antes de contar una sola
vez más.

`routes/inventario.js:803` hace `await setStockWc(wooCfg, db, item.sku, item.cantidad)`, y
`lib/wooStock.js:48` escribe **`stock_quantity` absoluto**, sin releer el stock actual ni
comparar contra el valor que había al momento de contar.

**El escenario, paso a paso:**

| Hora | Evento | WC | Físico |
|---|---|---|---|
| 12:57 | José cuenta 3 unidades del casco X | 3 | 3 |
| 13:20 | Un cliente compra 1 online | 2 | 2 |
| 13:53 | José confirma la sesión → escribe stock = 3 | **3** | **2** |

Queda una unidad fantasma, publicada y vendible. **La herramienta que existe para evitar la
sobreventa la produce.**

**No es teórico, los números lo confirman:**
- Duración real de las sesiones: 0,1 h a **14,7 h** (sesión 5). La ventana de carrera es
  toda la sesión.
- Volumen: ≥100 pedidos en los últimos 30 días (≥3,3/día), con pico entre las **10 h y las
  17 h** — exactamente la franja en la que José cuenta (sus sesiones 16 y 17 fueron 12:57 y
  13:54).
- Con 20 sesiones por ciclo, **caen unos 10 pedidos dentro de ventanas de conteo por ciclo**.
  Cada uno puede sembrar una unidad fantasma.

**El arreglo (Fase 0, primer commit):** ajuste por **delta**, no absoluto.
`inventario_sesion_alcance.stock_inicial` ya congela el stock al abrir la sesión, y
`lib/wooStock.js:59` ya tiene una función para leer stock **live** de WC. Con las dos piezas:

```
delta        = contado - stock_inicial
stock_final  = stock_live_ahora + delta
```

Si nadie tocó nada, `stock_live == stock_inicial` y el resultado es igual que hoy. Si hubo
una venta, se respeta. Si la relectura live falla, **no se escribe** (fail-closed, igual que
el resto del módulo). Además hay que registrar cuando `stock_live != stock_inicial` — es
justamente el evento que hoy se pierde en silencio.

---

## Los otros hallazgos que definen el diseño

1. **El depósito no está organizado** (José sabe de memoria dónde está cada cosa). Invalida
   el barrido masivo en cero por categoría. Es la causa estructural del problema.

2. **El cuello de botella de velocidad ya está resuelto en el código, sin usar.**
   `public/etiquetas/index.html:717` genera el barcode con **CODE128 del SKU**, no del GTIN.
   Y `routes/inventario.js:501` ya acepta escaneo de SKU. Los 3.911 SKUs "sin código de
   barras" **no necesitan GTIN**: se les imprime etiqueta hoy y el escáner las lee. Nadie
   conectó las dos herramientas. Ahí está la diferencia de 5x entre José (18–35 ítems/h) y
   Joaco (130–150 ítems/h).

3. **El barrido en cero ya está bien diseñado.** `cerrarEnCero` distingue `sin_stock`
   (masivo) de `con_stock` (uno por uno). Los 2.887 SKUs en cero casi no cuestan tiempo.

### La cuenta honesta

| | |
|---|---|
| Universo contable | 4.541 SKUs (1.476 simples + 3.065 variaciones) |
| Con stock > 0 (**el trabajo real**) | 1.635 |
| En cero (barrido pasivo, casi gratis) | 2.887 |
| Con código de barras impreso | 630 (14%) |
| Capacidad de José | 2 h/día × 20 días = **40 h/ciclo** |
| Ritmo medido de José | **18–35 ítems/h** → ~54 h para 1.635 |
| Ritmo necesario | ~41 ítems/h |

**Al ritmo de hoy la meta de 20 días queda 27% corta.** Se alcanza recién con las etiquetas
puestas. Por eso las etiquetas van antes que el planificador.

Una precisión importante: los 2.887 en cero **no requieren trabajo activo**. Un SKU en cero
que sigue en cero se valida solo al barrer su ubicación. El ciclo real es sobre los 1.635
con stock; el resto se confirma pasivamente.

### Decisiones tomadas con José

- **Universo:** toda la tienda (4.541).
- **Cadencia:** escalonada por rotación, **tope duro: nada supera 20 días**.
- **Ritmo:** lo mide el sistema y recalibra solo.
- **Ubicación:** zona + estante, cargada **mientras cuenta**.
- **Rotación:** score compuesto de las cuatro fuentes (ventas WC 12m + backfill ML +
  categorías críticas marcadas por José + historial de diferencias).
- **Etiquetas:** se mantiene formato y contenido actual (50×25 mm, CODE128 del SKU).
  Marcado manual durante el conteo con **cantidad editable**, más sugerencia automática.
- **Diferencias:** ajuste + registro histórico, con freno de revisión por encima de
  **$100.000**, o si el sistema decía que había y no hay nada, o si falta más del 50%.
  *(Ver Ruptura 2: el freno se rediseñó para no empeorar el problema.)*
- **No contables:** Service, Tubelizado, Gift Card, Parte de pago se excluyen. El sistema
  propone, José confirma.
- **Negativos:** alerta automática al cruzar a negativo.
- **Clips:** detectar y listar, con estado manual. La app no sube el archivo.
- **Auditoría de calidad:** flujo aparte, no entra en la sesión cronometrada.
- **Permisos:** solo `jose`. Joaco ayuda ocasionalmente → sesiones asignables sin solaparse.
- **Arranque:** ciclo 0 de bootstrap, priorizando lo crítico, respetando lo ya contado en
  agosto, y mostrando el progreso real contra los 20 días desde el día uno.

---

## Rupturas encontradas al estresar el plan, y cómo se resuelven

### Ruptura 1 — El ajuste absoluto crea el fantasma (crítico)
Descrita arriba. **Arreglo:** ajuste por delta + relectura live + fail-closed. Fase 0.

### Ruptura 2 — El freno por $100.000 deja el fantasma publicado (crítico, lógica invertida)
Si el conteo dice 0 y el sistema dice 3 de un producto de $500.000, frenar el ajuste
significa que **WooCommerce sigue diciendo 3 y el producto sigue vendible** durante toda la
revisión. El freno, tal como lo planteé, aumenta el riesgo de strike justo en los productos
más caros.

**Arreglo — el freno cambia de lugar:**
- **Faltantes (contado < sistema): se aplican SIEMPRE y de inmediato.** Bajar stock es la
  acción segura contra la sobreventa. Si el conteo estuvo mal, el costo es una venta
  perdida; si no se aplica, el costo es un strike.
- **El freno se convierte en alerta de investigación**, no en bloqueo del ajuste: el stock
  ya bajó, y José recibe la revisión para entender *por qué* faltaba (robo, venta sin
  descontar, error de carga) y puede revertir si fue error de conteo.
- **Sobrantes (contado > sistema): ahí sí se frena antes de escribir.** Subir stock es lo
  que crea stock fantasma. Un sobrante grande (más de $100.000 o más del 50%) espera
  confirmación de José antes de publicarse como vendible.

Esta inversión es la que respeta lo que José pidió (revisar lo grande) sin darle el cuarto
strike mientras revisa.

### Ruptura 3 — Un SKU en dos lugares: el barrido en cero borra stock real (crítico)
`producto_ubicacion(sku PRIMARY KEY)` asume una ubicación por producto. En la realidad hay
overflow: 2 cascos en la góndola y 1 en el depósito. Barrés la góndola, encontrás 2, el
barrido pone 0 a lo no visto… y si el SKU tenía unidades en el depósito, las borrás.

**Arreglo:**
- `producto_ubicacion` pasa a ser **muchos-a-muchos** (`sku + ubicacion_id`), con una marca
  de ubicación principal.
- **El barrido en cero solo alcanza a los SKUs cuyas ubicaciones registradas están TODAS
  dentro del alcance barrido.** Un SKU con una ubicación fuera del alcance nunca se
  auto-cierra: queda pendiente para decidir a mano.
- **Un SKU sin ubicación registrada jamás se auto-cierra en cero.** Es la regla que impide
  que el bootstrap destruya stock real.

### Ruptura 4 — El escalonado A/B/C no ahorra trabajo: lo aumenta (lógica)
Con un tope duro de 20 días para *todo*, el cap ya obliga a pasar por los 4.541. Poner A
cada 7 días y B cada 14 solo **agrega recuentos**:

| | conteos por ciclo de 20 días |
|---|---|
| Plano (todo cada 20 días) | 4.541 |
| Con A=7 (≈400 SKUs) y B=14 (≈800 SKUs) | ≈5.620 (**+24%**) |

Lo que hace viable la meta no es el escalonado: es el barrido en cero barato y las
etiquetas. **Arreglo:** el tope de 20 días es el régimen base y único obligatorio. El
escalonado A/B se aplica **solo con capacidad sobrante**, y arranca con un conjunto A chico
(negativos + los accesorios de alta rotación donde están las fallas reales). Es un extra,
no el mecanismo.

### Ruptura 5 — Urgencia por SKU vs. sesión por ubicación son incompatibles
El SKU más urgente puede vivir en una góndola llena de ítems no urgentes. O barrés la
góndola entera (perdés tiempo) o contás solo los urgentes (rompés el barrido completo, que
es lo único que habilita el cierre en cero).

**Arreglo — dos tipos de sesión, explícitos:**
- **Barrido completo** (alcance = ubicación, se recorre entero): habilita el cierre en cero
  masivo. Es el que sostiene el ciclo. Se agenda por urgencia **de la ubicación**.
- **Conteo dirigido** (lista puntual de SKUs urgentes: negativos, clase A, sospechosos):
  **NO habilita cierre en cero** bajo ninguna condición. Sirve para apagar incendios sin
  romper la garantía del barrido.

La cadencia y el tope de 20 días se miden sobre los barridos completos.

### Ruptura 6 — En el ciclo 0 nada tiene ubicación: el planificador queda inerte
Si el plan del día se arma agrupando por ubicación y al principio ningún SKU tiene
ubicación, el planificador no puede armar ninguna sesión. Deadlock en el arranque.

**Arreglo — transición explícita por ubicación, no global:**
- El bootstrap agenda por **categoría/marca** (como hoy), con **cierre en cero masivo
  deshabilitado**.
- A medida que se registran ubicaciones, cada ubicación que alcanza estado "mapeada"
  (José la marca como recorrida y completa) pasa al régimen de barrido con cierre en cero
  habilitado.
- El tablero muestra las dos poblaciones: qué parte de la tienda ya está bajo régimen y
  qué parte sigue en bootstrap. La meta de 20 días se declara cumplida solo sobre la parte
  bajo régimen.

### Ruptura 7 — `FB-65576` ya rompe el ajuste de stock hoy
El SKU está repetido en **20 variaciones** de "Bicicleta de Ruta - Twitter" (id_woo 65621 a
65640). `lib/wooStock.js:39` lanza `SKU "..." ambiguo` cuando hay homónimos, así que **esas
20 variaciones no se pueden ajustar por inventario hoy** — falla cerrado, pero falla. Y un
barcode de ese SKU sería ambiguo al escanear.

**Arreglo:** corregir los SKUs en WooCommerce (fuera de la app) y convertir el log de
`routes/woo.js` ("2 SKU repetidos en más de un producto") en un **bloqueo visible** en el
tablero, no un aviso que nadie lee. Es prerrequisito de la Fase 1.

### Ruptura 8 — El ritmo promedio genera metas incumplibles
Una sesión rápida en una categoría fácil infla el promedio, el planificador arma una sesión
grande, José no llega, el tablero se pone en rojo y el sistema pierde credibilidad.

**Arreglo:** usar el **percentil 25** de las últimas sesiones, no el promedio. Y medir el
ritmo **por condición**, no global: escaneado vs. manual difieren 5x, así que una sesión en
una zona sin etiquetar debe dimensionarse con el ritmo lento. Con menos de 3 sesiones
medidas, arrancar con un supuesto conservador (20 ítems/h) y avisar que es provisorio.

### Ruptura 9 — Sembrar desde el alcance inflaría la cobertura al doble
`inventario_sesion_alcance` tiene **2.297 filas**, pero `inventario_conteos` solo **292**.
Sembrar "ya contado" desde el alcance declararía ~50% de la tienda controlada cuando la
cobertura real es ~6%. Sería exactamente la clase de falso confort que produce un strike.

**Arreglo:** sembrar `sku_ultimo_conteo` **solo desde `inventario_conteos`** de sesiones
confirmadas, y marcar aparte los `confirmado_por_omision=1` (hoy son 2) como evidencia más
débil que un escaneo real.

### Ruptura 10 — `no_contable` como agujero negro permanente
Un producto real marcado no contable por error nunca vuelve a contarse: reproduce el
problema de las "categorías olvidadas", pero invisible.

**Arreglo:** los no contables se listan siempre en el tablero con su fecha de marcado y
quién lo marcó, y se re-proponen para revisión cada 6 meses. Nunca es una decisión
silenciosa ni definitiva.

### Ruptura 11 — Un día perdido compone y no hay forma de recuperarlo
Con 40 h de capacidad y ~54 h de trabajo, cualquier día perdido (enfermedad, un pedido
urgente) se acumula sin techo y el tablero se vuelve un cartel de fracaso permanente.

**Arreglo:** el tablero muestra **deuda en días-SKU** y una proyección de recuperación
concreta ("necesitás 3 sesiones extra, o 2 sesiones de Joaco"). La deuda se declara y se
planifica, no se esconde ni se resetea.

---

## Fase 0 — Seguridad inmediata (antes de contar una vez más)

1. **Ajuste por delta** en `/confirmar` (Ruptura 1). Es el commit más importante del plan.
   Reutilizar `stock_inicial` de `inventario_sesion_alcance` y la lectura live de
   `lib/wooStock.js:59`. Fail-closed si la relectura falla.
2. **Freno rediseñado** (Ruptura 2): faltantes se aplican siempre, sobrantes grandes frenan.
3. **Corregir `FB-65576`** en WooCommerce y bloquear SKUs duplicados visiblemente
   (Ruptura 7).
4. `catalogo_cache.no_contable` + sugerencias + revisión visible (Ruptura 10).
5. Tabla `inventario_diferencias` — histórico por SKU: es lo que responde "¿qué me falta
   siempre?" y alimenta el score de criticidad.
6. `stock_negativo_alertas` + banner en el Home, enganchado al `refrescarCatalogo` de
   `routes/woo.js` que ya detecta y loguea los 19 negativos.
7. **Medición de ritmo:** `iniciado_en`, `segundos_activos`, `items_contados` en
   `inventario_sesiones`, con p25 por usuario y por condición (Ruptura 8).

Migración `migrations/015_inventario_higiene.sql` + ALTERs idempotentes en `db/index.js`
(patrón `try { db.exec('ALTER TABLE …') } catch (_) {}` de las líneas 14-30).

## Fase 1 — Etiquetas persistentes (desbloquea la velocidad)

Hoy `public/etiquetas/index.html` guarda en `localStorage`: se pierde al cerrar el navegador.

**Migración `016_etiquetas_cola.sql`:** `etiquetas_cola(id, sku, cantidad, origen, sesion_id,
solicitado_por, nota, estado, creado_en, impreso_en)`.

**Router nuevo `routes/etiquetas.js`** (la herramienta no tiene backend hoy): CRUD de cola +
`marcar-impresas`. Registrar en `server.js` y agregar la regla en `lib/permisos.js` — la
herramienta `etiquetas` ya existe en `HERRAMIENTAS` (`niveles:false`).

**En el conteo:** botón "Necesita etiqueta" con cantidad **precargada con la contada y
editable** (José lo pidió: algunos ya tienen etiqueta). Los SKUs sin GTIN y sin etiqueta
previa se sugieren solos, sin forzar.

**En la página de etiquetas:** pestaña "Cola de conteo" que alimenta el **mismo renderer
50×25 mm sin tocarlo**. No cambiar formato, contenido, tamaño ni impresora.

Antes de imprimir en masa: probar un CODE128 de 21 caracteres (hay 2 SKUs así) en la
térmica — puede quedar demasiado denso para leerse.

## Fase 2 — Ubicaciones (hace seguro el barrido en cero)

**Migración `017_ubicaciones.sql`:**
```
ubicaciones(id, zona, estante, estado, activa, creado_en)   -- UNIQUE(zona, estante)
producto_ubicacion(sku, ubicacion_id, principal, confirmado_en, confirmado_por)
                                                             -- PK(sku, ubicacion_id)
```
Muchos-a-muchos por la Ruptura 3.

- **Captura durante el conteo:** la sesión tiene ubicación activa; todo SKU escaneado se
  asocia solo. Cero trabajo extra.
- **Alcance por ubicación:** extender `alcance-opciones` / `alcance-preview` / `POST /sesiones`.
  Reutilizar `productoEnAlcanceOr` (línea 79), que ya resuelve la lógica OR.
- **Reglas de seguridad del cierre en cero** (Rupturas 3 y 6), documentadas en el código
  como reglas de negocio:
  1. Solo con alcance por ubicación.
  2. Solo sobre SKUs cuyas ubicaciones estén todas dentro del alcance.
  3. Nunca sobre SKUs sin ubicación registrada.
  4. Solo en ubicaciones marcadas como "mapeadas".

## Fase 3 — Rotación y criticidad

**Migración `018_ventas_historial.sql`:** `ventas_historial(canal, orden_id, sku, cantidad,
precio_unitario, fecha)` con `UNIQUE(canal, orden_id, sku)`, `sku_criticidad`,
`categorias_criticas`.

**Backfill (`scripts/backfill-ventas.mjs`):**
- WooCommerce `/wp-json/wc/v3/orders` — verificado: 5.413 pedidos en 12 meses. Reutilizar la
  auth de `routes/woo.js`.
- MercadoLibre `/orders/search` — necesario porque el espejo ML dentro de WC **solo arranca
  en julio 2026**. Reutilizar `mlFetch` de `lib/mlClient.js` (token + rate limit resueltos).
- Cron diario incremental.

**Score compuesto** (`lib/criticidad.js`), las cuatro fuentes que pidió José: ventas 12m 40%,
historial de diferencias 30%, categoría marcada crítica 20%, valor de stock 10%.

**Cadencia (corregida por la Ruptura 4):** el régimen base es **todo cada 20 días**, único
obligatorio. Con capacidad sobrante se agrega una clase A chica a 7 días (negativos +
accesorios de alta rotación). El escalonado es un extra, no el mecanismo de viabilidad.

## Fase 4 — Planificador de ciclos

**Migración `019_ciclos_conteo.sql`:** `sku_ultimo_conteo(sku, contado_en, sesion_id,
por_omision, diferencia_ultima)`, `ciclos(numero, inicio, fin_objetivo, estado)`.

Sembrado **solo desde `inventario_conteos`** de sesiones confirmadas (Ruptura 9).

**`GET /api/inventario/plan-hoy`:**
1. `dias_sin_contar` por SKU; nunca contados = infinito.
2. Urgencia de **ubicación** (no de SKU suelto) para los barridos completos (Ruptura 5).
3. Dimensiona a ≤ 2 h con el **p25** del ritmo del usuario y de la condición (Ruptura 8).
4. Devuelve también qué queda afuera y por qué.
5. Mientras haya zonas sin mapear, propone sesiones de bootstrap por categoría/marca con
   cierre en cero deshabilitado (Ruptura 6).

Endpoint hermano **`GET /api/inventario/dirigido`** para conteos puntuales (negativos, clase
A, sospechosos) que nunca habilitan cierre en cero.

**Tablero:** % bajo régimen vs. bootstrap, deuda en días-SKU, proyección de recuperación
concreta, cobertura de ubicación y de etiquetas. Sin maquillaje: su valor es avisar antes
del strike.

**Concurrencia con Joaco:** `sesionesSolapan` (línea 355) ya evita alcances superpuestos.
Extenderlo a ubicaciones y mostrar quién tiene qué zona tomada.

## Fase 5 — Auditoría de calidad de publicación

Flujo aparte, alimentado por lo contado.

**Migración `020_auditoria_publicacion.sql`:** `auditoria_publicacion(sku, clave_ml, health,
fotos_ml, fotos_wc, tiene_descripcion_ml/wc, video_ml, video_wc, estado_clip, precio_wc,
precio_ml, desvio_precio, problemas_json, revisado_en, auditado_en)`.

**Verificado en vivo contra la API de ML:** `health` (0.6 en la publicación de prueba),
`video_id` (null = sin clip), `pictures` (4). Todo sale del multiget
`/items?ids=…&attributes=…`. **Reutilizar `mlFetch` y el multiget de a 20 de
`routes/matcher.js`** — no escribir cliente nuevo. Respetar `lib/mlRateLimiter.js`: ya hay
429 en el log de `pedidos_cache`, no agregar presión.

**Cron de auditoría:** barrido rotativo con cursor en `sync_estado`, mismo patrón que la
reconciliación de stock de `routes/sync.js` (que funciona bien: ~20 correcciones/día).

**Detección:** matcheo → reutilizar `/vinculos-sospechosos` y `/cruce` de
`routes/cobertura.js`, ya resuelto. Precio → `lib/mlPrecios.js` ya calcula neto y comisión.
Fotos, descripción, health, `video_id` → del multiget. **Estado de clip manual** (sin clip /
grabado / subido a ML / subido a WC).

**Cola de revisión** (`public/auditoria/`): priorizada por impacto (health bajo + alta
rotación primero), con link a ML y a WC.

---

## Orden y por qué

| Fase | Entrega | Depende de |
|---|---|---|
| **0 — Seguridad** | **Delta anti-fantasma**, freno corregido, SKU duplicado, negativos, ritmo | — |
| 1 — Etiquetas | Cola persistente; rompe el cuello de botella de velocidad | 0 |
| 2 — Ubicaciones | Barrido en cero seguro | 1 |
| 3 — Rotación | Score y cadencia | 0 |
| 4 — Planificador | Sesión del día + tablero | 2, 3 |
| 5 — Auditoría | Calidad de publicación y clips | 4 |

La Fase 0 sola ya frena la sangría y se despliega en días. **Las fases 0 a 2 son el ciclo 0
de bootstrap**: lento a propósito, produce el mapa de ubicaciones y las etiquetas. Recién al
terminarlas el ciclo de 20 días es una meta real.

## Verificación

- **Ruptura 1 (la clave):** abrir sesión, contar un SKU con stock 3, **vender 1 desde WC a
  mano**, confirmar. El stock final debe quedar en **2**, no en 3. Hoy queda en 3 — hay que
  ver el test fallar antes del arreglo.
- **Ruptura 2:** faltante de $500.000 → se ajusta igual y genera alerta. Sobrante grande →
  frena antes de escribir.
- **Ruptura 3:** SKU con dos ubicaciones, barrer una sola → no debe auto-cerrarse en cero.
- **Ruptura 6:** con cero ubicaciones registradas, `plan-hoy` debe devolver una sesión de
  bootstrap por categoría, no un plan vacío.
- **Ruptura 9:** tras el sembrado, la cobertura reportada debe ser ~6% (292 SKUs), no ~50%.
- **Fase 1:** marcar 3 ítems, recargar el navegador → siguen en la cola. Imprimir → mismo
  formato 50×25 mm que hoy.
- **Fase 3:** contrastar el top 20 de rotación contra la intuición de José. Si no coinciden,
  el score está mal ponderado.
- **Fase 5:** contrastar `health` y `video_id` de 10 publicaciones contra el panel de ML.
- **Tests:** `npx vitest run` (el proyecto usa vitest, no `node --test`; hoy
  `test/sync.test.js` da 118/118). Sumar casos para delta, freno, urgencia y dimensionado.
- **Regresión obligatoria:** las sesiones con alcance por categoría/marca deben seguir
  funcionando. Nada puede romper el claim atómico de `/confirmar`, el gate de
  `pendientesConStock` (que ya evitó el incidente del 2026-08-21) ni el fail-closed de
  códigos desconocidos.

## Agujeros que siguen abiertos

1. **Dónde vive el clip/video en WooCommerce.** No lo pude determinar desde la base ni la
   API. Bloquea la mitad WC de la auditoría de clips; no bloquea las fases 0 a 4.
2. **¿Las 2 h son de corrido o partidas?** Dos bloques de 1 h tienen más costo de arranque.
   Se puede medir tiempo activo, pero conviene saberlo para dimensionar.
3. **Variaciones de talle/color:** 3.065 de 4.541 SKUs. Una percha con 8 talles es más lenta
   por unidad. Puede necesitar un modo de conteo agrupado por modelo.
4. **Productos que aparecen y no están en el sistema.** Hoy quedan `codigo_desconocido` y
   traban la confirmación. En un ciclo completo puede pasar seguido → tal vez haga falta un
   alta rápida.
5. **El umbral de $100.000 no está calibrado** contra la realidad. Hay que medir cuántas
   veces frena por sesión y ajustarlo.
