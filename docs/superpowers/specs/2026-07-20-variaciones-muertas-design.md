# Variaciones muertas: limpieza, prevención y UX de descarte

**Fecha:** 2026-07-20
**Estado:** aprobado (diseño)

## Problema

Cuando una publicación de MercadoLibre se convierte de *variaciones* a *simple* (o se
recrea con nuevas variaciones), los `variation_id` viejos **dejan de existir en ML** y
ML nunca los reutiliza. Eso deja "variaciones muertas" que ensucian el sistema:

- **Decisiones colgadas:** `sku_matcher_decisiones` conserva la decisión `asignar`/`confirmar`
  de la variación vieja. Es una bomba latente: cuando cambia el stock del SKU, `_syncWcToMl`
  intenta empujar stock a la variación inexistente, ML responde
  `"Item X doesn't have a variation with id Y"`, el sync borra la decisión y loguea
  `remapeo_requerido`.
- **Loop de `sin_mapeo`:** si hubo una venta vieja de esa variación (registrada `sin_mapeo`),
  el usuario la reasigna, el siguiente ciclo de sync la borra por "doesn't have a variation",
  y la fila `sin_mapeo` reaparece. Reasignar nunca la resuelve.
- **Ruido en `remapeo_requerido`:** las claves muertas ya borradas se acumulan en esa vista.

**Estado medido en prod (2026-07-20):** 272 decisiones activas de variación muerta en 112
publicaciones (todas hoy simples en el cache), y 334 entradas `remapeo_requerido` pendientes.

Mecanismo de escape actual: `errores_descartados` (una clave ahí queda excluida de todas las
vistas de atención). Hoy el usuario debe descartar a mano; nada lo hace automático ni masivo.

## Objetivos

1. **Prevención permanente:** que una variación muerta desaparezca de *todas* las vistas
   automáticamente, sin intervención.
2. **Limpieza del backlog** existente (272 + 334), verificada contra ML.
3. **UX:** en `sin_mapeo`, cuando la variación vendida ya no existe, ofrecer *Descartar* en
   vez del buscador de SKU inútil.

## No-objetivos (YAGNI)

- No se tocan decisiones `omitir` de variaciones muertas (son inertes; no aparecen en ninguna vista).
- No se reconstruye retroactivamente ninguna venta vieja (las órdenes son idempotentes y ya
  quedaron procesadas/parciales).
- No se cambia la semántica de `remapeo_requerido` para variaciones que *sí* existen.

## Diseño

### Concepto único

Una variación que **ML confirma que no existe** es "muerta" y debe descartarse en todos lados.
Como ML no reutiliza `variation_id`, una variación ausente está muerta para siempre.

Helper compartido (en `lib/mlMapeo.js` o `routes/sync.js`):

```
descartarVariacionMuerta(db, clave, motivo):
  - DELETE FROM sku_matcher_decisiones WHERE clave = ?   (si existe)
  - INSERT ... errores_descartados (clave, motivo, now) ON CONFLICT actualiza
```

Descartar la clave la excluye a la vez de `sin_mapeo`, `remapeo_requerido` y `errores`
(todas filtran por `errores_descartados`).

### 1. Prevención reactiva en `_syncWcToMl`

En la rama existente `/doesn'?t have a variation/i` (routes/sync.js), además de borrar la
decisión y loguear `remapeo_requerido` (se conserva para el trail de auditoría), llamar a
`descartarVariacionMuerta`. Resultado: cualquier variación muerta futura se auto-descarta y
no vuelve a aparecer en ninguna vista.

### 2. Limpieza masiva del backlog

Función `limpiarVariacionesMuertas(db, mlCfg)` + endpoint `POST /api/sync/limpiar-variaciones-muertas`
(protegido igual que el resto del router de sync).

Candidatos:
- Decisiones activas (`asignar`/`confirmar`) con `variation_id` no vacío.
- Claves `remapeo_requerido` pendientes (sin decisión activa y no descartadas).

Verificación **contra ML (fail-closed)**:
- Agrupar candidatos por `item_id`. Multiget `/items?ids=...&attributes=id,status,variations`
  (chunks de 20, ~6 llamadas para 112 items).
- Para cada candidato, la variación está **muerta** si ML devolvió el item (code 200) y su
  `variation_id` **no** está entre las `variations[].id` actuales. (Un item simple no tiene
  `variations` → cualquier variación mapeada está muerta.)
- Si ML **no** devolvió el item (error de red, item inaccesible, chunk fallido) → **saltear**
  ese candidato (no se descarta ante la duda). Fail-closed: preferimos dejar ruido antes que
  borrar un mapeo posiblemente vivo.
- Para cada muerta confirmada → `descartarVariacionMuerta(db, clave, 'Variación inexistente en ML (limpieza masiva)')`.

Devuelve `{ revisados, muertas, saltados, items }` para el reporte.

**Botón UI:** en el dashboard de sync, botón "Limpiar variaciones muertas" que llama al
endpoint y muestra el resultado (cuántas descartó / cuántas salteó por ML). Con confirmación
previa.

### 3. UX en `sin_mapeo`

Modelado en `diagnosticarErrores` (que ya consulta ML para la vista `errores`). Nueva función
`diagnosticarSinMapeo(db, mlCfg, rows)` (o extender la existente) que, para cada fila de
`sin_mapeo`, consulta el item en ML y marca:
- `variacion_muerta = true` si la fila tiene `variation_id` y ML confirma que ya no existe.
- caso contrario, la fila sigue siendo mapeable (comportamiento actual).

En `GET /api/sync/atencion/sin_mapeo`, correr ese diagnóstico (degradación elegante si ML falla:
las filas quedan como hoy).

Frontend (`public/sync-detalle/index.html`, modo `mapeo`): si `row.variacion_muerta`, en vez del
buscador de SKU mostrar un mensaje claro ("La variación vendida ya no existe en ML —
la venta no se puede re-mapear") y el botón **Descartar** (ya existe la acción `descartar`).
Si ML no diagnosticó (fallo), se mantiene el buscador + Descartar como hoy.

## Manejo de errores

- ML inaccesible en la limpieza masiva → esos candidatos se saltean; el endpoint reporta
  `saltados`. Se puede reintentar.
- ML inaccesible en el diagnóstico de `sin_mapeo` → la vista degrada al comportamiento actual.
- Todas las escrituras (`descartarVariacionMuerta`) son idempotentes (ON CONFLICT).

## Testing

- **Unit `descartarVariacionMuerta`:** borra decisión + inserta descartado; idempotente.
- **`_syncWcToMl` (syncFlow.test):** ante `"doesn't have a variation"`, la clave queda en
  `errores_descartados` (además del `remapeo_requerido` logueado) y no vuelve a aparecer.
- **`limpiarVariacionesMuertas`:** con mock de mlFetch — descarta las muertas confirmadas,
  **no** descarta cuando ML no devuelve el item (fail-closed), no toca variaciones vivas.
- **Endpoint `POST /limpiar-variaciones-muertas`:** responde con los conteos.
- **`atencion/sin_mapeo`:** una fila con variación muerta viene con `variacion_muerta=true`;
  degradación elegante si ML falla.
- Front: verificación manual responsive (regla de despliegue del proyecto).

## Rollout

1. Implementar con TDD, todos los tests verdes.
2. Auditoría de código.
3. Correr la limpieza masiva una vez contra prod (vía el endpoint / botón) y verificar
   conteos (`sin_mapeo`, `remapeo_requerido` a 0 salvo lo que ML no confirme).
