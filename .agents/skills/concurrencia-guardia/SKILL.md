---
name: concurrencia-guardia
description: Invariantes de concurrencia del worker de Guardia ML (lib/guardiaMl.js) — qué revisar y qué probar antes de tocar el flujo caso→operación→worker, para no repetir el bug de septiembre de 2026 que rompió el 100% de las escrituras en producción con la suite en verde.
---

# Concurrencia en Guardia ML

## El bug que motiva esta skill

En `lib/guardiaMl.js`, el worker que ejecuta operaciones encoladas valida dos invariantes antes
de escribir en ML:

```js
if (op.caso_version !== null && op.caso_version !== casoActual.expected_version) throw new Error('la versión del caso cambió antes de ejecutar');
if (op.operador && casoActual.responsable !== op.operador) throw new Error('el responsable del caso cambió antes de ejecutar');
```

Los endpoints `POST /casos/:id/vincular` y `POST /casos/:id/pausar` encolaban la operación con
`operador: actor(req)` **sin escribir nunca `responsable` en el caso**. Resultado: la segunda
línea comparaba `casoActual.responsable` (NULL) contra `op.operador` (el usuario logueado) y
tiraba siempre. Todo caso sin `responsable` previo fallaba en conflicto, sin reintento
automático — 16 de 18 operaciones en producción, con la suite de vitest en verde, porque ningún
test despachaba una operación con `operador` seteado contra un caso sin `responsable`.

## Qué revisar en cualquier cambio a `lib/guardiaMl.js` o `routes/guardiaMl.js`

1. **Todo endpoint que encola una operación con `operador` debe garantizar, en la misma
   transacción lógica, que `responsable` del caso ya esté escrito** (o escribirlo él mismo antes
   de encolar) — nunca asumir que un paso previo lo hizo.
2. **`encolarOperacionGuardia` bumpea `expected_version`** al pasar el caso a
   `pendiente_ml` (`UPDATE ... SET expected_version=? WHERE id=? AND expected_version=?`). Si un
   endpoint necesita escribir `responsable` como efecto lateral de "tomar" el caso, esa escritura
   **no debe bumpear `expected_version`** — si lo hace, la próxima verificación de versión del
   worker falla por una causa distinta pero indistinguible en el mensaje de error.
3. **El regex de enrutamiento de conflicto** (`/caso ya no está pendiente|versión del caso
   cambió|responsable del caso cambió/`) agrupa tres causas distintas bajo el mismo camino de
   reintento. Si agregás una cuarta invariante, decidí explícitamente si entra en ese regex o
   necesita su propio manejo — si no, el diagnóstico de producción se vuelve indistinguible como
   pasó acá.
4. **Todo caso puede llegar al worker con `responsable` NULL.** No asumas que `tomar`/`vincular`
   siempre corrió antes — la vía de auto-escaneo (`escanearGuardiaMl`) también encola sin pasar
   por esos endpoints.

## Qué probar (obligatorio antes de aprobar un cambio en esta superficie)

- Un test que despache una operación con `operador` seteado contra un caso con `responsable`
  **NULL** — es exactamente el caso que faltaba y dejó pasar el bug.
- Un test que confirme que escribir `responsable` como efecto lateral **no** cambia
  `expected_version` (o, si tu diseño sí lo cambia intencionalmente, que el caller lo sepa y lo
  maneje).
- Un test de vinculación repetida por el mismo operador (no debe fallar por "responsable
  cambió" contra sí mismo).
- Nunca dar por buena una suite en verde como evidencia de que la concurrencia funciona si
  ningún test ejercita el camino endpoint→worker con `operador` seteado. La suite estaba
  100% verde durante todo el incidente.

## Verificación en producción, no solo en tests

Este módulo escribe en `data/fusion.sqlite`, que en este repo es siempre la base real (no hay
staging separado). Antes de dar un fix por bueno:
1. `SELECT estado, ultimo_error, COUNT(*) FROM guardia_ml_operaciones WHERE creado_en > <ts del deploy> GROUP BY estado, ultimo_error` — confirmar que no hay una nueva clase de error apareciendo.
2. Nunca correr `node server.js` ni la suite completa de vitest contra `data/fusion.sqlite` real
   mientras el proceso de PM2 (`herramientas`) esté vivo — usar worktree + copia de DB.
