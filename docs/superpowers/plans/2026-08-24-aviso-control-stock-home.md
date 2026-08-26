# Plan: aviso de control de stock en la pantalla principal (Home)

## Objetivo

José pidió que la pantalla principal muestre una advertencia con **qué toca contar hoy** y
**cuánto tiempo se estima que lleva**. Es la puerta de entrada al planificador de ciclos
(Fase 4 del plan grande: `docs/superpowers/plans/2026-08-plan-jose-control-stock-ciclos.md`
— plan de control de stock de José,
sección "Fase 4 — Planificador de ciclos"), pero **entregado en modo bootstrap**: las
Fases 2 (ubicaciones) y 3 (rotación/criticidad) todavía no existen, así que este MVP usa
solo lo que ya hay en la base, sin esperar a esas fases.

## Qué NO tiene todavía (y por qué el MVP igual sirve)

- No hay `ubicaciones` → no se puede armar "barrido completo por góndola". Se agenda por
  **categoría/marca** (el mismo criterio que ya usa `inventario_sesiones` hoy), con el
  cierre en cero **deshabilitado** por defecto (regla ya establecida: sin ubicación
  registrada, nunca auto-cerrar en cero — se aplicará también acá).
- No hay `sku_criticidad`/score de rotación → el orden es simplemente **días sin contar**
  (más vencido primero), no ponderado por rotación. Es honesto: no inventa una prioridad
  que no está calculada.
- No hay columnas de ritmo (`iniciado_en`/`segundos_activos`) — esas quedaron fuera de
  alcance del fix `2026-08-24-delta-stock-inventario.md` en curso. Este MVP calcula el
  ritmo directamente de datos que YA existen: `inventario_sesiones.creado_en` /
  `confirmado_en` y el conteo de filas reales en `inventario_conteos` por sesión.
- No existe `catalogo_cache.no_contable` todavía (Fase 0 del plan grande, no despachada
  aún). Mientras tanto, se excluyen por heurística de nombre los 4 productos de servicio ya
  identificados (`Service Completo`, `Service Control`, `Tubelizado`, `GIFT CARD`, `Parte de
  pago`) vía una constante en código, no en base — se reemplaza por la columna real cuando
  la Fase 0 grande se despache.

## Cálculo de "qué toca hoy"

Universo: `catalogo_cache` con `tipo <> 'variable'` (los simples y las variaciones, igual
que hace el módulo de inventario hoy), `stock > 0` **o** en cero pero nunca confirmado en
cero (evitar que lo nunca contado en cero se declare "ya visto" sin haberlo sido — coherente
con la Ruptura 9 del plan grande: sembrar cobertura SOLO desde conteos reales).

Por SKU:
```
ultimo_conteo_real = MAX(inventario_conteos.actualizado_en)
                     JOIN inventario_sesiones ON sesion_id
                     WHERE sesiones.estado IN ('confirmada','confirmada_con_errores')
                       AND inventario_conteos.confirmado_por_omision = 0   -- Ruptura 9
dias_sin_contar     = hoy - ultimo_conteo_real (infinito si nunca)
vencido             = dias_sin_contar > 20   -- tope duro ya acordado con José
```

Orden: `dias_sin_contar DESC` (lo más vencido primero). Nunca contados van primero de todos
(tratagainst infinito).

Agrupar por `categoria_principal` (o `marca` si no hay categoría — mismo fallback que ya usa
`routes/inventario.js` en `alcance-opciones`) y tomar el/los grupo(s) más vencido(s) hasta
completar el tamaño de sesión.

## Cálculo de "cuánto va a llevar"

Ritmo (ítems/hora), por usuario logueado, de las **últimas 5 sesiones confirmadas** de ese
usuario con más de 0 ítems:
```
ritmo_sesion = items_contados_reales / horas_reales   -- (confirmado_en - creado_en)
ritmo_p25    = percentil 25 de esas 5 (Ruptura 8: usar p25, no promedio, para no prometer
               de más con una sesión rápida atípica)
```
Con menos de 3 sesiones medidas para ese usuario: usar **20 ítems/hora** como supuesto
conservador explícito, y marcarlo en la respuesta como `ritmo_estimado: true` para que el
frontend lo muestre distinto ("estimado, todavía sin datos tuyos" vs "medido").

Nota: la duración `confirmado_en - creado_en` sobrestima el tiempo activo si José dejó la
sesión abierta y volvió después (la sesión 5 real duró 14,7 h). Mientras no exista
`segundos_activos` (Fase 0 grande), filtrar outliers: descartar del cálculo de ritmo las
sesiones de más de 3 horas de duración de pared (probablemente no fueron continuas). Si eso
deja menos de 3 sesiones válidas, cae al supuesto conservador de 20/h.

Tamaño de sesión objetivo: **2 horas** (fijo, acordado con José). `items_objetivo =
round(ritmo_p25 * 2)`. Tiempo estimado a mostrar = `items_propuestos / ritmo_p25` (puede ser
menor a 2h si el grupo más vencido tiene menos ítems que el objetivo).

## Endpoint nuevo

`GET /api/inventario/plan-hoy` — mismo router `routes/inventario.js`, mismo permiso
(`inventario`, ya en `lib/permisos.js`). Reutilizar `pendientesDeSesion`/helpers de
alcance existentes donde aplique en vez de reimplementar filtros ya resueltos.

Respuesta:
```json
{
  "ok": true,
  "grupo": { "tipo": "categoria", "valor": "Cascos" },
  "items_propuestos": 42,
  "dias_vencido_max": 34,
  "tiempo_estimado_horas": 1.4,
  "ritmo_items_hora": 30,
  "ritmo_estimado": false,
  "cobertura_general": { "controlado_20d": 812, "vencido": 1201, "nunca_contado": 622 },
  "sin_ritmo_medido": false
}
```
Si no hay NADA pendiente (todo controlado dentro de 20 días): `items_propuestos: 0` y un
mensaje de "al día", no un error.

## Banner en Home

`public/home/index.html` — agregar una tarjeta de advertencia (mismo estilo visual que los
banners existentes del Home, ej. el de estado del token ML) que consuma `plan-hoy` al
cargar. Contenido: nombre del grupo, cantidad de ítems, tiempo estimado, y un link directo
a `public/inventario/` con el alcance pre-cargado (categoría/marca del grupo propuesto) —
confirmar con `hard-worker-frontend` cómo pasar ese pre-filtro (querystring probablemente,
mirar si `inventario/index.html` ya soporta abrir con alcance predefinido por URL).

Si `items_propuestos == 0`: banner en tono neutral/positivo ("Stock al día"), no ocultarlo
del todo — la ausencia de aviso no debe leerse como "no hay que revisar nunca".

## Fuera de alcance (a propósito)

Ubicaciones, score de rotación, freno por sobrante/faltante, etiquetas, auditoría de
publicación. Esas son las Fases 1/2/3/5 del plan grande de José, se despachan aparte.

## Tests

- `plan-hoy` con 0 sesiones históricas del usuario → usa ritmo conservador 20/h,
  `ritmo_estimado: true`.
- Con sesiones históricas válidas → usa p25, `ritmo_estimado: false`.
- Sesión de duración de pared > 3h se excluye del cálculo de ritmo.
- SKU con `confirmado_por_omision=1` NO cuenta como "contado" para `dias_sin_contar`
  (Ruptura 9).
- Productos de servicio (lista heurística) excluidos del universo.
- Con todo controlado dentro de 20 días → `items_propuestos: 0`, sin error.
- Front: banner se renderiza con los datos de la API; con `items_propuestos: 0` muestra
  tono neutral, no error ni banner vacío.

## Orden de despacho

Este plan queda **en cola**: no se despacha hasta que el fix de
`2026-08-24-delta-stock-inventario.md` (en curso en el worktree `delta-anti-fantasma`)
llegue a `CONGELADO_PARA_REVISION`. Motivo: `agents/model-routing.md` fija máximo un
hard-worker activo a la vez, y ambos tocan `routes/inventario.js`.
