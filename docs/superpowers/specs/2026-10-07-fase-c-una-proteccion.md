# Fase C: una sola protección (Identidad) y vínculo automático seguro

Fecha: 2026-10-07. Programa: `docs/superpowers/specs/2026-10-03-consolidacion-herramientas.md`, Fase C.
Decisiones de José tomadas en la sesión del 2026-10-07 (citadas en cada regla).

## Objetivo

Que el sync de stock ML tenga **una sola fuente de protección**: los casos de Identidad. Guardia deja de decidir.
Y que ninguna publicación activa quede vendiendo sin control: o se vincula sola de forma segura, o queda en
stock 0 con un caso para que alguien decida.

## Estado medido en producción (solo lectura, 2026-10-07)

- `guardia_ml_casos` abiertos con `bloquea_sync=1`: **67**, todos `sin_cobertura`.
  - Las 67 tienen `sku_matcher_decisiones.accion='omitir'`, cargada a mano el 2026-08-19.
  - Son **links de pago**: SKUs de proveedor fuera de Woo y ~99.999 unidades cada una.
  - Como el sync ya ignora lo que no tiene vínculo, ese bloqueo hoy **no frena nada**.
- `identidad_casos` sin cerrar: **20**.
  - 15 son `gtin_contradictorio`, y en **los 15 el `seller_sku` de ML es igual al SKU vinculado**. El error está en
    el GTIN de catálogo de ML: `7798426655043` aparece en 7 publicaciones de SKUs distintos y `765250690073` en 2.
  - El resto: 1 `contradiccion_titulo` (SKU igual), 2 `decision_no_aplicada` (SKU distinto, ya pausadas) y
    2 `sku_exacto` en intervención.
- `guardia_ml_pedidos_retenidos`: 3 filas, todas liberadas.
- `autoVincularPorSellerSku` (`lib/mlMapeo.js:95`) ya existe. Corre en cada refresco de ML (`routes/matcher.js:386`)
  y vincula con SKU exacto y único.

## Reglas

### R1. Links de pago: fuera de todo (José: "son links de pago, descartar")

Una publicación con decisión `omitir` no se sincroniza, no abre casos y no cuenta como "sin cobertura". Los 67 casos de
Guardia actuales se cierran con motivo `omitida_link_pago`, en el despliegue y con backup.

### R2. El SKU manda (José: "hay que ver si tiene el sku igual porque hay publicaciones de catálogo con los códigos mal puestos")

Para una publicación **vinculada** con caso de Identidad abierto:

| Situación | Sync | Caso |
|---|---|---|
| `seller_sku` de ML = SKU vinculado, y el caso es `gtin_contradictorio` o `contradiccion_titulo` | sigue normal | baja a severidad `normal` ("revisar cuando haya tiempo") |
| `seller_sku` falta o es distinto del vinculado, y hay contradicción | **stock 0 en ML** | `urgente` |
| estado `intervencion` (una persona lo marcó) | **stock 0 en ML** | sin cambio |
| `decision_no_aplicada`, `pendiente` u otro leve | sigue normal | sin cambio |

"Stock 0" quiere decir que el sync manda `available_quantity=0`. **No** pausa ni toca precio: cuando el caso se
resuelve, la publicación vuelve sola con el stock de Woo, por el reactivador.

### R3. Vínculo automático seguro (José: "SKU exacto y único")

Una publicación **sin decisión** se vincula sola si cumple todo esto:
- su `seller_sku`, o el de la variación, coincide exacto con **un solo** producto de `catalogo_cache`;
- ninguna otra publicación sin decisión de la misma corrida trae ese SKU;
- no hay contradicción por SKU distinto.

El GTIN **no veta**, por R2. Es la regla actual de `autoVincularPorSellerSku`, que ya no mira el GTIN. Se mantiene su
veto por contradicción de título o atributos (`contradiccionDeClave`: color, talle, rodado), porque para vincular sin
una persona conviene ser conservador. Una publicación vetada así abre un caso `sin_vinculo` (R4).

### R4. Publicación nueva no vinculable: stock 0 + caso (decisión de José del 2026-10-06)

Si una publicación activa sin decisión no cumple R3 (no tiene SKU, el SKU no existe en Woo o hay varios candidatos):
- se manda stock 0 a ML;
- se abre un caso de Identidad `sin_vinculo`, severidad `urgente`, con el motivo.

Cuando alguien la vincula o la marca `omitir`, el caso se cierra y el sync la toma (o la ignora) en la corrida
siguiente.

### R5. Ventas retenidas

`retenerPedidoMl` (`routes/sync.js:725`) sigue reteniendo un pedido de ML cuyas claves no tienen cobertura. La
cobertura pasa a definirse así: decisión `asignar`/`confirmar` y ningún caso de Identidad que frene por R2. Una
clave `omitir` no retiene (links de pago).

## Cambios técnicos

1. **`routes/sync.js` `COMPUTED_STOCK_CTE`.**
   - Se quita el `LEFT JOIN guardia_ml_casos`.
   - Se agrega `frena_identidad`, calculado por R2. Cuando vale 1, `stock_disponible_ml = 0` en lugar de excluir la
     clave.
2. **Claves sin decisión (R4).** Hoy el sync no las ve. Se agrega una rama en `_syncWcToMl` que les manda 0, solo a
   las que tienen caso `sin_vinculo` abierto.
3. **`lib/mlMapeo.js` `autoVincularPorSellerSku`.** Mantiene sus reglas. Las publicaciones activas sin decisión que no
   vincula abren el caso `sin_vinculo` (R4).
4. **`lib/identidadProductos.js`.** Se agrega la clasificación `sin_vinculo` y se baja la severidad según R2.
5. **Guardia.**
   - Se apagan el escaneo (`routes/matcher.js:101`) y el worker (`server.js:925`).
   - Sus tablas quedan en solo lectura durante 30 días.
   - La página muestra un aviso que lleva a Identidad.
   - `esClaveCubierta` y `claveBloqueadaGuardia` pasan a leer Identidad.
6. **Migración 120.**
   - Agrega `identidad_casos.clasificacion` `sin_vinculo`, si hace falta en el CHECK.
   - Agrega un índice por `ml_key` y estado.
   - Cierra los casos `sin_cobertura` de Guardia cuyas claves están en `omitir`, por R1.

## Despliegue en sombra (decisión de José: "primero en sombra")

1. **Modo sombra** (`IDENTIDAD_PROTECCION=sombra`). Se calcula todo, pero el sync sigue con la CTE vieja.
2. **Reporte para José.** Para cada clave cuyo stock enviado cambiaría:
   - el stock de antes y el de después;
   - la regla que aplica;
   - las que se vincularían solas;
   - las que quedarían en stock 0 por R4.
3. **Activar.** José revisa el reporte y da el OK para pasar a `activo`. Se puede volver atrás cambiando la variable.

## Criterios de aceptación

- **Tests (CTE):**
  - SKU igual con GTIN contradictorio sincroniza;
  - SKU distinto con contradicción manda 0;
  - `intervencion` manda 0;
  - `omitir` se ignora.
- **Tests (autovínculo y casos nuevos):**
  - con SKU exacto y único, el autovínculo vincula aunque el GTIN de ML no coincida;
  - SKU ambiguo en la corrida no vincula y abre `sin_vinculo`;
  - la publicación nueva sin SKU abre caso y manda 0.
- **Tests (retención):** un pedido de una clave `omitir` no se retiene; uno sin vínculo sí.
- **En sombra, con producción:**
  - las 15 `gtin_contradictorio` aparecen como "sin cambio";
  - las 67 de links de pago no aparecen;
  - el reporte llega antes de activar.
- **Gates:** revisor, probador-e2e (por el aviso de Guardia), auditor-despliegue y backup antes de la migración.

## Fuera de alcance

- La pantalla única "Catálogo y vínculos" (Fase D).
- Los webhooks (Fase E).
- El log de eventos de decisiones (pasa a la Fase D).
- El GTIN de familia como señal débil en la detección: R2 ya lo neutraliza para el sync.
