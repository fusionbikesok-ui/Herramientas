# Reconciliación de stock contra ML real

Fecha: 2026-08-06
Rama: `worktree-reconciliacion-stock-ml`

## El problema, con el caso real que lo destapó

`syncWcToMl` decide si empujar comparando el stock deseado contra `ml_stock_estado.cantidad_ml`,
que es **lo que nosotros recordamos haber empujado**, no lo que ML tiene.

Caso real detectado el 2026-08-06: publicación `MLA1117110786|` (SKU `FB-4501`, horquilla
Rockshox Recon Silver).

- `ml_stock_estado.cantidad_ml = 0` desde el **2026-07-17**.
- Woo: stock 0. ML: **1 unidad, activa y vendible**.
- Como deseado (0) == recordado (0), el sync nunca la volvió a tocar.
- **Tres semanas de sobreventa latente**, sin error, sin log, sin señal en ninguna pantalla.
  La detectó el usuario, no el sistema.

Se corrigió a mano (se puso `cantidad_ml = 1`, el valor real de ML, y el sync empujó el 0 solo
en la corrida siguiente; verificado: ML quedó en `paused` con stock 0). Pero la causa sigue
abierta: **cualquier cambio de cantidad hecho fuera de nuestro sync** —una venta cancelada que
devuelve la unidad, una edición manual en ML, un ajuste de ML— queda invisible para siempre.

## Decisiones del usuario (2026-08-06)

- **Alcance:** solo publicaciones **activas**. Son las únicas que pueden vender, o sea las
  únicas donde la sobreventa es real. ~975 publicaciones mapeadas activas.
- **Dirección:** corregir **en ambos sentidos**. Si ML tiene de más, se baja (sobreventa). Si
  ML tiene de menos, se sube: recupera ventas de publicaciones que quedaron en cero por error.
- **Visibilidad:** cada divergencia se **registra en `sync_log`** con la clave, lo que tenía ML
  y lo que correspondía. Sin esto no hay forma de saber si el problema es sistémico.

## Restricción de presupuesto — medida hoy, no estimada

- ~975 items activos mapeados → barrido completo con multiget de a 20 = **49 llamadas**.
- **Medido el 2026-08-06: ML devuelve 429 tras 2-3 multiget consecutivos sin pausa.** Con
  ~1,5-2s entre lotes el barrido pasa limpio. El límite efectivo está MUY por debajo de los
  1500 rpm que documenta `lib/mlLimites.js`. El diseño tiene que **espaciar, nunca ráfagar**.

## Diseño: reconciliación incremental con cursor

Cron nuevo, **separado** del sync de stock, que recorre el universo de a poco:

1. Cursor persistido en `sync_estado` (ej. `cursor_reconciliacion_stock`).
2. Cada corrida toma el **siguiente lote** desde el cursor (sugerido: 100 items = 5 multiget),
   consulta `/items?ids=...&attributes=id,status,available_quantity,variations` y compara la
   cantidad real de ML contra `ml_stock_estado.cantidad_ml`.
3. Si difieren, **corrige `ml_stock_estado` con el valor REAL de ML** y registra en `sync_log`.
4. **No escribe en ML.** El `syncWcToMl` que ya existe, en su próxima corrida, ve la diferencia
   contra el stock real de Woo y empuja la corrección por su camino ya probado. Esta es la clave
   del diseño: la reconciliación solo abre los ojos.
5. Al llegar al final del universo, el cursor vuelve al principio.

Con 100 items por corrida cada 10 min: barrido completo en ~1h40m, **5 llamadas por corrida
(~720/día)**, sin ráfagas.

## Criterio de aceptación

- Una publicación cuyo `ml_stock_estado` diverge del valor real de ML queda corregida tras pasar
  el cursor, y la divergencia aparece en `sync_log`.
- Reproducir el caso de la horquilla: estado 0, ML 1, Woo 0 → la reconciliación deja el estado en
  1 → `syncWcToMl` empuja 0.
- Una corrida sobre publicaciones sin divergencia no escribe nada ni ensucia el log.
- El cursor avanza y da la vuelta sin saltearse publicaciones.

---

## Paso 1 — Cron y cursor

**Archivos:** `routes/sync.js` (función nueva), `server.js` (cron)

`reconciliarStockMl(db, cfg)`:
- Universo: publicaciones **activas** con decisión de matcher (`asignar`/`confirmar`) y fila en
  `ml_stock_estado`. Orden estable por `clave` para que el cursor tenga sentido.
- Lee el cursor de `sync_estado`, toma los siguientes `LOTE` items, y al terminar lo avanza. Al
  llegar al final, vuelve a empezar.
- Candado anti-solape en el mismo proceso, como `_mlToWcEnCurso` (`routes/sync.js:141`).
- Cron escalonado en un minuto libre: los ocupados son `:01/:16/:31/:46` (catálogo), `:02`,
  `:03`, `:04`, `:06`, `:08/:23/:38/:53`, y el push en `:00/:10/:20/...`. **Sugerido: `'7-59/10'`.**

## Paso 2 — Comparación y corrección

**Archivo:** `routes/sync.js`

- Multiget en chunks de 20 reutilizando el patrón de `evaluarPreciosReactivables`, **con pausa
  explícita entre chunks** (~1,5s) y `try/catch` por chunk (un throw de axios no puede abortar
  la corrida — mismo criterio que `routes/sync.js:1221-1237`).
- Cantidad por clave: `variations[].available_quantity` si la fila tiene `variation_id`, si no
  `item.available_quantity`. **Misma granularidad que `ml_stock_estado.clave`.**
- **Fail-closed en la escritura del estado:** solo se corrige cuando ML respondió 200 y la
  cantidad es un número finito. Item ausente del multiget, respuesta parcial o cantidad nula →
  se deja la fila como está y se sigue. Esto es crítico: escribir un valor equivocado en
  `ml_stock_estado` hace que el sync empuje stock equivocado A ML.
- Si el item ya no está `active` en ML, se saltea (no es sobreventa: no vende).

## Paso 3 — Registro de divergencias

**Archivo:** `routes/sync.js`

Por cada divergencia, una fila en `sync_log` vía `logSync` con `direccion: 'wc_ml'`, la clave, y
un mensaje que diga **lo que tenía ML y lo que teníamos registrado**. Tiene que poder leerse
seis meses después sin contexto.

Sin divergencias, no se escribe nada (el log no se ensucia con ruido).

## Fuera de alcance

- No se toca `syncWcToMl`: la corrección la sigue haciendo él, por su camino ya probado.
- No se escribe en ML desde la reconciliación.
- No se tocan las publicaciones **sin mapeo** (16 detectadas hoy): el sistema no sabe a qué
  producto de Woo corresponden, así que no hay con qué compararlas. Es trabajo de negocio.
- No se toca `public/`.

## Riesgos

- **Corregir mal el estado dispara escrituras equivocadas a ML.** Mitigación: el fail-closed del
  paso 2, sin excepciones.
- **Ráfagas → 429.** El espaciado entre chunks no es cosmético; está medido.
- **Ruido en el log** si hay muchas divergencias legítimas y transitorias (ej. una venta de ML
  recién hecha que todavía no procesamos). Aceptado a propósito: el usuario pidió verlas.
