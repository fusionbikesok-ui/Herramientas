# Canario de Identidad: criterio de salida (propuesta)

Estado: **propuesta para aprobar** (2026-10-06). Hoy `identidad_config` = `enforced`, escrituras habilitadas, `lote_max = 1`,
`canario_ml_key = MLA1100263569|173550478780` (una sola clave). `procesarOperacionesIdentidad` solo toma operaciones de las claves del
canario (hasta 2) y de a `lote_max` (máximo 2 por código).

## Qué mostró el canario hasta hoy
- 124 operaciones completadas entre el 04 y el 06/09 (51 publicaciones distintas): 101 con el atajo «ML ya tenía el SKU», 22 con
  escritura directa sin poner stock en 0.
- 459 pasos confirmados y **0 pasos fallidos**.
- Duración media de una operación que bajó el stock a 0: 9,7 min; la peor, 29,8 min.
- Desde el 06/09 no se completó ninguna. Hay 20 sin completar (19 `pendiente` y 1 `bloqueada_impacto`), que el canario de una sola
  clave nunca va a tomar: hasta ahora **nadie se enteraba** (ver «Alarma»).

## Criterio de salida propuesto
El canario se retira (se vacía `canario_ml_key`, se sube `lote_max`) cuando se cumplen **todas**:
1. **Volumen:** al menos 10 operaciones completadas desde el último cambio de código de la saga, en publicaciones distintas.
2. **Limpieza:** 0 operaciones en `intervencion` o `fallida` por causa de la saga (las canceladas a mano no cuentan) en ese tramo.
3. **Stock:** 0 eventos `stock_no_devuelto_por_contradiccion` y ninguna publicación del tramo quedó en 0 por la saga.
4. **Ventana en cero:** las que pasaron por stock 0 estuvieron menos de 15 minutos (hoy: media 9,7 min).
5. **Alarma limpia:** la alarma «encoladas sin ejecutar > 2 h» estuvo en 0 durante 48 h seguidas.

Escalera: canario 1 clave / lote 1 → **2 claves / lote 1** (48 h) → **sin canario / lote 1** (48 h) → lote 2 (el tope del código; subirlo
es un cambio de código con revisión). Cada escalón es reversible: volver a poner `canario_ml_key`.

Quién decide: José, con los números de arriba. Cada paso queda en `identidad_historial`.

## Alarma «encoladas sin ejecutar > 2 h»
- `lib/identidadAlarmas.js`: cuenta operaciones `pendiente`, 0 intentos, sin pasos, de más de 2 h. `shadow` no cuenta (es intencional).
  **Límite:** la alarma `n` cuenta solo `intentos=0` y sin pasos. Una operación que ya intentó (con pasos o con intentos) y quedó
  trabada no entra ahí. Para ese caso hay un segundo contador, `procesando_vencidas`: operaciones en `procesando` con el `claim_hasta`
  vencido (el worker murió o el paso se colgó a mitad). Las `intervencion` y `fallida` se ven en la bandeja de Identidad, no en esta alarma.
- Informa también cuántas están **fuera del canario**: esas el worker no las toma nunca; hay que cancelarlas o ampliar el canario.
- Visible en `/api/sync/dashboard` (`identidad_encoladas`), en «Para resolver» de Sincronización ML y en los chips de Atención del home.

## Restore con contradicción de título
Si la saga baja el stock a 0 y el título pasa a contradecir al producto antes del paso `restore`, ahora **el stock vuelve al valor
objetivo** y la operación queda en `intervencion` con el caso reabierto como `urgente`. Si ML rechaza la devolución del stock, eso queda
escrito en `ultimo_error` y en el historial (`stock_no_devuelto_por_contradiccion`), no se esconde.

Causa raíz del bug anterior: el `catch` de la contradicción hacía `UPDATE identidad_casos SET estado='abierto', bloquea_sync=1`, y
ni el estado `abierto` ni la columna `bloquea_sync` existen en esa tabla. El `UPDATE` fallaba, la transacción se revertía y la operación
quedaba `procesando` hasta vencer el claim, se reintentaba y volvía a fallar, con la publicación en stock 0 todo el tiempo.
