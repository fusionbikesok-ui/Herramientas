# Plan: Fase C — una sola protección (Identidad)

Spec: `docs/superpowers/specs/2026-10-07-fase-c-una-proteccion.md` (aprobada por José el 2026-10-07).

**Quién hace cada cosa:**
- Implementa la sesión worker, en su worktree, con la rama `feat/fase-c-proteccion` desde `origin/master`.
- Revisa el coordinador.
- Los gates son revisor, probador-e2e (paso 6) y auditor-despliegue.
- El despliegue lleva backup y el OK de José en la sesión del worker.

**Qué se prueba:** en cada paso, primero el test que falla y después el código. Se corren solo los archivos
afectados. La suite completa no hace falta salvo que José la pida.

**Qué dispara el flujo:** todo es automático del sistema, sin un paso manual:
- el refresco de ML (cron cada 15 min, `routes/matcher.js` alrededor de la línea 386) corre el autovínculo y abre los
  casos;
- el sync WC→ML (`_syncWcToMl`, `routes/sync.js:1294`) aplica el stock.

## Paso 1. Variable de modo y regla R2 como función pura

- **Archivos:** nuevo `lib/proteccionIdentidad.js` y su test `test/proteccion-identidad.test.js`.
- **`modoProteccion()`.** Lee `IDENTIDAD_PROTECCION`. Los valores son `apagado`, `sombra` y `activo`, y el default es
  `sombra`. Un valor inválido cuenta como `sombra` (fail-closed: no cambia lo que se manda a ML).
- **`frenaIdentidad(db, clave)`.** Devuelve `{ frena, motivo }` según la tabla R2 de la spec. Lee:
  - `identidad_casos` con `direccion='ml_fusion'`, `ml_key=clave` y estado en `urgente`, `intervencion` o `pendiente`;
  - `ml_publicaciones_cache.seller_sku`;
  - `sku_matcher_decisiones.sku`.
- **SQL equivalente.** Hay que exportar también un fragmento SQL que produzca lo mismo, para usarlo en la CTE (paso 2).
  Un test compara la función contra la consulta sobre el mismo fixture.
- **Aceptación:** tests de los 4 casos de la tabla R2, más `omitir` (no frena porque no se sincroniza) y una clave sin
  caso.

## Paso 2. CTE del sync (R2)

- **Archivos:** `routes/sync.js` (`COMPUTED_STOCK_CTE`, alrededor de las líneas 248 a 270) y `test/sync.test.js`.
- **`activo`:**
  - sin el `LEFT JOIN guardia_ml_casos`;
  - con la columna `frena_identidad`;
  - si `frena_identidad = 1`, entonces `stock_disponible_ml = 0`.
- **`sombra` y `apagado`:** la CTE es exactamente la de hoy. Un test lo compara byte a byte o por resultado.
- **Aceptación:**
  - SKU igual con GTIN contradictorio sincroniza el stock de Woo;
  - SKU distinto con contradicción da 0;
  - `intervencion` da 0;
  - en modo sombra el resultado no cambia respecto de hoy.

## Paso 3. Casos `sin_vinculo` (R4) y sync de claves sin decisión

- **Archivos:**
  - `lib/identidadProductos.js`: alta y cierre de caso `sin_vinculo`;
  - `routes/matcher.js`, después de `autoVincularPorSellerSku`;
  - `routes/sync.js` (`_syncWcToMl`);
  - `migrations/120_fase_c_identidad.sql`;
  - los tests.
- **Después del autovínculo,** cada publicación activa sin decisión y fuera de `errores_descartados` abre o mantiene
  un caso `sin_vinculo`:
  - severidad `urgente`;
  - motivo: `sin_sku`, `sku_inexistente`, `sku_ambiguo` o `contradiccion_atributos`.
- **Cierre:** el caso se cierra solo cuando aparece una decisión (`asignar`, `confirmar` u `omitir`).
- **En `activo`,** `_syncWcToMl` manda `available_quantity=0` a las claves con caso `sin_vinculo` abierto y cantidad
  ML mayor que 0. Usa el mismo camino de escritura y el mismo log que el resto. No pausa.
- **Migración 120:**
  - índice `identidad_casos(ml_key, estado)`;
  - `sin_vinculo`, si la clasificación tiene CHECK (hoy es TEXT libre: verificarlo);
  - cerrar los casos de `guardia_ml_casos` abiertos cuya clave tiene decisión `omitir`, con
    `estado='resuelto'`, `bloquea_sync=0` y motivo `omitida_link_pago` en el evento (R1).
- **Aceptación:**
  - una publicación nueva sin SKU abre caso y, en `activo`, recibe 0;
  - con SKU ambiguo no se vincula y abre caso;
  - con SKU exacto y único se vincula aunque el GTIN difiera;
  - al vincular se cierra el caso;
  - `omitir` no abre caso;
  - la migración es idempotente.

## Paso 4. Retención de pedidos (R5)

- **Archivos:** `lib/guardiaMl.js` (`esClaveCubierta`), `lib/guardiaBloqueo.js` (`claveBloqueadaGuardia`),
  `routes/sync.js:725` y `test/guardia-retenidas-auto.test.js`.
- **En `activo`:**
  - cubierta quiere decir decisión `asignar` o `confirmar` y que `frenaIdentidad` no frena;
  - `omitir` nunca retiene;
  - `claveBloqueadaGuardia` pasa a delegar en `frenaIdentidad`.
- **En `sombra`:** el comportamiento de hoy.
- **Aceptación:** un pedido de una clave `omitir` no se retiene; uno de una clave sin decisión sí.

## Paso 5. Reporte de sombra

- **Archivos:** `routes/sync.js`, endpoint `GET /api/sync/fase-c/sombra` (solo admin), y los tests.
- **Qué devuelve:** para cada clave, el stock que se manda hoy y el que se mandaría en `activo`, la regla que aplica,
  las publicaciones que el autovínculo vincularía y las que quedarían en 0 por R4.
- **Para quién:** el coordinador lo resume para José.
- **Aceptación con datos de producción:**
  - las 15 `gtin_contradictorio` salen "sin cambio";
  - las 67 de links de pago no aparecen.

## Paso 6. Apagar Guardia (solo en `activo`)

- **Archivos:** `routes/matcher.js:101` (escaneo), `server.js:925` (worker) y `public/guardia-ml/`, donde va un aviso
  "Guardia se retiró: la protección vive en Identidad" con un link.
- **Escaneo y worker:** no corren si el modo es `activo`.
- **Tablas:** sin cambios. Quedan 30 días en solo lectura.
- **Aceptación:** test de que el escaneo no corre en `activo`, y probador-e2e de la página de Guardia, de escritorio y
  celular.

## Paso 7. Memoria y PR

- **Memoria:** actualizar `docs/memory/modules/integrations-ml-woo.md` con la protección única, R1 a R5 y el modo.
  También una línea en `active.md`.
- **PR:** a `master`, con el resultado de los tests dirigidos.

## Despliegue (después del merge, con OK de José)

1. Backup de la base y migración 120 con `IDENTIDAD_PROTECCION=sombra`.
2. Correr el refresco y el sync normales. El coordinador lee `/api/sync/fase-c/sombra` y se lo resume a José.
3. Con el OK de José: `IDENTIDAD_PROTECCION=activo` y `pm2 restart`.
4. **Para volver atrás:** `IDENTIDAD_PROTECCION=sombra` y `pm2 restart`. La migración es aditiva.

**Producción todavía no corre `master`:** está en `3fefbe4a`, con Mensajería de Astra sin commitear. Cómo se trae el
código lo decide José al momento de desplegar.
