# Spec: vigía de formato de publicaciones de ML

**Fecha:** 2026-09-12
**Estado:** diseño aprobado, sin implementar
**Alcance:** detectar cuándo una publicación pasa a describir algo distinto de lo que vendemos,
pausarla y avisar.

## El incidente que lo origina

El 2026-09-11 a las 11:04 se vendió la orden `2000018407122564` (pack `2000014982984177`):

- Publicación `MLA1873455985`, SKU `FB-64881`, cubierta Continental GP5000 700x28.
- La publicación quedó enganchada a un producto de **catálogo** cuyo nombre terminaba en
  **"Kit De 2 Unidades"**. El comprador vio eso.
- Se vendió **1 "kit" a $302.585**. Comisión $41.722,73, envío a nuestro cargo $0 →
  **neto $260.862**.
- El contado de **una** cubierta es $261.900. El de dos, $523.800.

Se despachó **una sola** unidad, así que la pérdida efectiva fue de ~$1.038. Pero la orden dice
"Kit De 2 Unidades": el riesgo real no es contable, es un reclamo que ML resolvería a favor del
comprador. Si se hubieran despachado las dos, la diferencia habría sido de **$262.938**, casi
una cubierta entera.

Nadie tocó esa publicación. **La cambió la sincronización**, al asociarla al producto de catálogo
equivocado. Entre el cambio y la venta pasó menos de un día.

## Por qué no sirve revisar el catálogo buscando "kit" o "pack"

Se probó el 2026-09-12 y el resultado dice por qué este diseño mira otra cosa.

Hay **41 publicaciones** cuyo formato de venta no es "unidad". De las **10 activas**:

- 8 son legítimas: cinco juegos de ruedas de carbono, un par de manijas Shimano EF510 y dos
  cintas de manubrio. En todas, el producto de Woo **ya es el par o el juego**, y el contado
  también.
- 1 fue un falso positivo del propio filtro (`FB-21169`: el atributo existe con valor nulo y el
  chequeo convirtió ese nulo en texto).
- 1 pareció un error y no lo era: `MLA1420741571`, "Reguladores P/ Cables Cambio Shimano Ca50",
  `Pack` de 2 contra un producto llamado "Regulador De Cable Shimano SM-CA50", en singular. Los
  reguladores **vienen de a par en la caja original de Shimano**: la publicación está bien y el
  nombre del producto es el que engaña.

**La causa de fondo: en Woo no hay ningún campo que diga cuántas unidades trae un producto.**
"Regulador" en singular y "Ruedas" en plural es prosa, no dato. Cualquier regla que compare el
precio publicado contra el contado tiene que suponer cuántas unidades hay de cada lado, y esa
suposición es justamente lo que no se puede hacer sin preguntarle a una persona.

Y aun si existiera ese campo, no habría servido: el problema del GP5000 no fue que la publicación
dijera "2", fue que **pasó a decir "2"** cuando antes decía "1".

Por eso el vigía compara contra el pasado, no contra una regla. **Detecta el cambio, no el
valor.** Como efecto secundario no tiene falsos positivos de catálogo: una publicación que
siempre fue un pack legítimo nunca cambia y nunca avisa.

## Decisiones del usuario (2026-09-12)

1. **Avisa y pausa.** Escribir en ML para pausar es lo único que habría evitado esta venta,
   porque el cambio y la venta ocurrieron el mismo día.
2. **Avisa por email, por push y en pantalla**, los tres.
3. Las **31 publicaciones pausadas** no se revisan a mano: quedan cubiertas el día que alguna se
   mueva o se reactive, porque ahí se compara contra lo último guardado.

## Qué se vigila

Los tres campos que definen *qué cree ML que estás vendiendo*:

| Campo | Por qué |
|---|---|
| `catalog_product_id` | Es lo que pasó. Cambiar de producto de catálogo cambia título, fotos y ficha completa, sin que nadie toque la publicación. |
| `UNITS_PER_PACK` | Cuántas unidades cree ML que entrega una venta. |
| `SALE_FORMAT` | Unidad / Pack / Blister / etc. |

**El título NO dispara nada.** ML lo reescribe seguido por su cuenta y sería ruido constante.

**Nunca dispara la primera vez que se ve una publicación.** Sin valor anterior no hay cambio, y
ese es exactamente el terreno donde nacen los falsos positivos descritos arriba.

## El freno de mano

Si en una misma corrida del refresco el cambio afecta a **más de 5 publicaciones**, no se pausa
ninguna y se abre **un solo** incidente crítico que dice cuántas y cuáles.

El motivo: trescientas publicaciones no se rompen juntas. Un cambio masivo es casi siempre ML
cambiando algo de su lado —un atributo nuevo, un valor que pasa de nulo a "Unidad"— y pausar el
catálogo entero por un cambio de esquema sería mucho peor que el problema que este vigía viene a
resolver. El umbral es configurable.

## El conflicto con el reactivador

El reactivador de publicaciones existe para **despausar**. Si el vigía pausa una publicación y el
reactivador la reactiva, el arreglo se anula solo y en silencio.

Las pausas del vigía quedan marcadas y el reactivador las **saltea** hasta que una persona las
libere, igual que ya hace con las pausadas manualmente por el vendedor
(`routes/sync.js:2169-2177`, motivo `'Pausada manualmente por el vendedor'`).

**El vigía pausa; nunca despausa.** Reactivar es siempre una decisión humana.

**Una publicación que ya estaba pausada** —el caso de las 31— no se pausa de nuevo: el pausado es
un no-op, pero el cambio se asienta y se avisa igual, y queda marcada para que el reactivador no
la levante. Ese es el mecanismo por el que las pausadas quedan cubiertas sin revisarlas a mano.

## Modelo

Una tabla nueva:

```
ml_publicacion_cambios
  id INTEGER PK
  clave TEXT NOT NULL            -- item_id|variation_id
  item_id TEXT NOT NULL
  sku TEXT
  campo TEXT NOT NULL            -- catalog_product_id | UNITS_PER_PACK | SALE_FORMAT
  valor_anterior TEXT
  valor_nuevo TEXT
  pausada INTEGER NOT NULL DEFAULT 0   -- si el vigía llegó a pausarla en ML
  pausa_error TEXT               -- si intentó pausar y ML rechazó
  detectado_en TEXT NOT NULL
  revisado_en TEXT
  revisado_por TEXT
```

Los valores anteriores salen de `ml_publicaciones_cache`, que ya guarda `atributos_json` y
`catalogo`. Hace falta agregarle `catalog_product_id` como columna propia: hoy no se persiste
—`catalogo` es sólo un booleano— y sin él no se puede detectar el cambio que causó el incidente.

## Qué se construye

### Backend

- **Comparación en el upsert.** `prepararUpsertCache` (`routes/matcher.js:459`) es el único punto
  por donde pasan todas las publicaciones, en el refresco total y en el acotado. Antes de
  escribir, se compara la fila entrante contra la guardada y se registran las diferencias de los
  tres campos.
- **Pausado en ML**, sujeto al freno de mano. Fail-open por publicación: si ML rechaza el pausado,
  se registra en `pausa_error` y el cambio queda igual asentado y avisado. Nunca se pierde la
  detección por un fallo de escritura.
- **`abrirOActualizarIncidente`** (`lib/incidentes.js`) con `integracion: 'mercadolibre'`,
  `proceso: 'vigia_formato'`, `tipoError: 'datos'`, severidad `critico`. Email y push salen de
  ahí sin construir nada: el outbox y el worker ya existen y ya funcionan.
- **`GET /api/sync/cambios-formato`**: los cambios sin revisar, con su antes/después.
- **`POST /api/sync/cambios-formato/:id/revisar`**: marca revisado. Con `reactivar: true`,
  además despausa en ML — el único camino por el que una pausa del vigía se revierte.
- **El reactivador saltea** las publicaciones con un cambio sin revisar.

### Pantalla

Bloque **"Publicaciones que cambiaron de formato"** en el reactivador, donde ya se miran las
pausadas. Por fila: producto, qué campo cambió, el antes y el después, y si se pausó. Dos
acciones: *"Estaba bien, reactivar"* y *"Ir a corregirla"*.

### Tests

- Un cambio de `catalog_product_id` pausa la publicación, la asienta y abre incidente.
- La primera vez que se ve una publicación **no** dispara nada, aunque tenga `UNITS_PER_PACK: 2`.
- Un cambio de título **no** dispara nada.
- Con 6 cambios en una corrida no se pausa ninguna y se abre un solo incidente.
- Si ML rechaza el pausado, el cambio queda asentado con `pausa_error` y el aviso sale igual.
- El reactivador saltea una publicación con un cambio sin revisar, y la toma después de revisarla.
- Revisar con `reactivar: true` despausa; revisar a secas no toca ML.

## Fuera de alcance

- Revisar a mano las 31 pausadas: decisión explícita, quedan cubiertas por el vigía.
- Un campo de "unidades por producto" en Woo. Resolvería otra cosa (poder validar el precio de un
  pack) y es un cambio de catálogo, no de esta herramienta.
- Corregir el formato en ML automáticamente. El vigía pausa y avisa; qué es lo correcto lo decide
  una persona.
- El desvío entre el envío que ML cotiza y el que después cobra, detectado el 2026-09-12 en la
  orden `2000018414706684` ($0 cotizado contra $7.373,65 cobrado). Afecta al motor de precios,
  no a esto, y necesita su propia investigación.

## Criterio de aceptación

1. Reproducido el caso del GP5000 —una publicación que pasa a tener `catalog_product_id` de un
   producto "Kit De 2 Unidades"— queda pausada en ML, asentada y avisada por los tres canales.
2. Una corrida completa del refresco sobre el catálogo real, sin cambios, no pausa nada ni abre
   incidentes.
3. Una publicación vista por primera vez nunca dispara.
4. Superado el umbral, no se pausa nada y se abre un único incidente que dice cuántas.
5. El reactivador no reactiva una publicación pausada por el vigía sin revisar.
6. `npm test` en verde.
