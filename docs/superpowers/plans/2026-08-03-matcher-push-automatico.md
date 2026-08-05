# Matcher: escritura automática de SKUs en ML + grilla inmediata

Fecha: 2026-08-03

## Problema (diagnóstico verificado)

1. **690 decisiones sobre publicaciones pausadas nunca se intentan.** El filtro de
   `/push-skus-pendientes`, `/count` y `/list` exige `p.status='active'`
   (routes/matcher.js:495, :522, :536). Hoy: 393 pendientes activas + 690 pausadas.
2. **El bucle de escritura vive en la pestaña.** `escribirSkusEnMl()`
   (public/matcher/index.html:800) llama al backend en lotes de 120 desde el navegador.
   Cerrar la pestaña corta el trabajo. Además el guardia `if(d.escritos===0)break`
   aborta toda la corrida cuando un lote entero falla.
3. **ML devuelve 429 (rate limit) de forma constante** (log pm2 lleno de
   `syncMlToWc: error API ML 429`). `escribirSkuEnMl` no reintenta ante 429 y el push
   no loguea nada, así que los fallos son invisibles.

## Decisiones del usuario (2026-08-03)

- Disparo: **cron automático continuo** en el servidor. Sin pestaña abierta.
- Pausadas: **sí se escriben**, pero **las activas tienen prioridad en la cola**.
- Apertura del matcher: **grilla inmediata** con las publicaciones cacheadas; los
  candidatos se calculan de fondo y rellenan después.

## Supuestos asumidos (no consultados; señalados al usuario)

- Fallos permanentes (400/403 de ML, ej. publicación con restricciones) no se reintentan
  indefinidamente: backoff exponencial por publicación, tope 24 h.
- 429 NO cuenta como fallo de la publicación: es rate limit; se pausa la corrida y el
  resto queda para el ciclo siguiente.
- Frecuencia del cron: cada 10 minutos, alineado con los otros crons de ML.

---

## Paso 1 — Migración: tabla de fallos de push

Archivo nuevo: `migrations/002_ml_sku_push_fallos.sql`

```sql
CREATE TABLE IF NOT EXISTS ml_sku_push_fallos (
  clave              TEXT PRIMARY KEY,
  sku                TEXT NOT NULL,
  intentos           INTEGER NOT NULL DEFAULT 0,
  ultimo_error       TEXT,
  ultimo_status      INTEGER,
  proximo_intento_en TEXT,
  actualizado_en     TEXT NOT NULL
);
```

Seguir la convención de numeración/aplicación de `migrations/001_*.sql` (verificar cómo se
aplican: ver `db/` y `server.js`).

**Aceptación:** la migración corre sobre una copia de `data/fusion.sqlite` sin error y es
idempotente (`IF NOT EXISTS`).

## Paso 2 — `lib/matcherPush.js` (nuevo): motor del push

Mover `escribirSkuEnMl` desde `routes/matcher.js:186` a este módulo y exportarla
(routes/matcher.js pasa a importarla; no duplicar).

Funciones:

- `seleccionarPendientes(db, limite)` — decisiones `accion IN ('asignar','confirmar')`,
  `sku LIKE 'FB-%'`, JOIN `ml_publicaciones_cache`, `COALESCE(p.seller_sku,'') <> d.sku`,
  **sin filtro de status**. Excluye claves con fallo cuyo `proximo_intento_en` es futuro.
  Orden: `CASE WHEN p.status='active' THEN 0 ELSE 1 END`, luego `d.actualizado_en DESC`.
- `contarPendientes(db)` — mismo filtro, devuelve `{ total, activas, pausadas, enEspera }`.
- `pushSkusPendientes(db, cfg, { limite })` — recorre el lote llamando `escribirSkuEnMl`:
  - **éxito** → borra la fila de `ml_sku_push_fallos` para esa clave;
  - **429** → espera con backoff (350ms → 1s → 3s → 8s, máx. 4 reintentos de esa misma
    publicación); si sigue en 429, **corta la corrida entera** (`{ cortadoPorRateLimit: true }`)
    y NO registra fallo para las publicaciones no intentadas;
  - **otro error** → upsert en `ml_sku_push_fallos` con `intentos+1`,
    `proximo_intento_en = ahora + min(2^intentos horas, 24 h)`;
  - respeta `CALL_DELAY_MS` (350 ms) entre publicaciones;
  - `console.log` de resumen por corrida (escritos/errores/restantes) — hoy no hay
    ninguna traza en pm2, que es por qué el problema fue invisible.
- Anti-solape: un solo push a la vez (flag de módulo, patrón de `_refresco` en
  routes/matcher.js:20; revisar si `lib/concurrencia.js` ya ofrece el helper y reusarlo).

**Aceptación:** tests vitest con `mlFetch` mockeado cubren: éxito borra fallo previo;
error 400 registra fallo con backoff creciente; 429 corta la corrida sin marcar fallos;
las activas se procesan antes que las pausadas; no hay dos corridas en paralelo.

## Paso 3 — Cron en `server.js`

Dentro del `else` de `DISABLE_CRONS` (server.js:165-212), agregar:

```js
cron.schedule('*/10 * * * *', () => {
  pushSkusPendientes(app._db, syncCfg)
    .catch(err => console.error('push SKUs matcher error:', err.message));
});
```

**Aceptación:** con `DISABLE_CRONS=true` no se programa (regla vigente para instancias
efímeras de los agentes).

## Paso 4 — `routes/matcher.js`: endpoints

- `POST /push-skus-pendientes` → deja de escribir en el request. Arranca la corrida en
  background y devuelve **202** al toque (mismo patrón que `POST /refrescar-ml`), o **409**
  si ya hay una corriendo.
- `GET /push-skus-pendientes/estado` (nuevo) → `{ running, escritos, errores, restantes,
  fallos, iniciado_en, fin_en, cortado_por_rate_limit, error }`.
- `GET /push-skus-pendientes/count` → sacar `p.status='active'`; devolver
  `{ pendientes, activas, pausadas, en_espera }`.
- `GET /push-skus-pendientes/list` → sacar `p.status='active'`; agregar `p.status` y, por
  LEFT JOIN a `ml_sku_push_fallos`, `intentos`/`ultimo_error`/`proximo_intento_en`.

**Aceptación:** tests de ruta verifican 202/409 y que `/count` ya incluye pausadas.

## Paso 5 — Frontend: push sin pestaña abierta

`public/matcher/index.html`, `escribirSkusEnMl()` (~línea 800):

- POST → si 202, sondear `GET /push-skus-pendientes/estado` cada ~3 s.
- Texto: **"Corre en el servidor — podés cerrar la pestaña"** (hoy dice justo lo
  contrario: "no cierres la pestaña").
- Eliminar el guardia `if(d.escritos===0)break` (ahora es responsabilidad del backend).
- Al abrir la página, si hay una corrida en curso, retomar el sondeo y mostrar el progreso.
- Mostrar siempre el estado del automático: pendientes totales (activas / pausadas) y
  resultado de la última corrida; los fallos siguen listándose con `mostrarFallosPushMl`,
  ahora con el motivo y el próximo reintento.

**Aceptación:** `probador-e2e` confirma que al recargar la página durante una corrida el
progreso sigue avanzando.

## Paso 6 — Frontend: grilla inmediata

Hoy el warm-start (index.html:1265-1295) sólo pinta si `/candidatos?peek=1` da `cache:true`;
si no, deja una pantalla de espera.

Nuevo comportamiento al abrir:

1. `GET /publicaciones` (barato, ya existe) → construir items **provisionales** con la misma
   forma que los resueltos (`idx`, `modo` derivado de `seller_sku`, `candidatos: []`,
   `provisional: true`) y **renderizar la grilla ya**.
2. En paralelo, `GET /candidatos` (sin `peek`): ante 202 `computing:true`, sondear.
3. Al llegar el resultado, reemplazar `TODOS` **conservando el filtro activo y el ítem
   seleccionado**.
4. Mientras un ítem sea provisional, el panel de detalle muestra "calculando candidatos…"
   y **no** permite confirmar (evita decidir sin candidatos a la vista); el SKU manual sí
   sigue disponible.

**Aceptación:** con el cache de candidatos frío, la grilla aparece con publicaciones
listadas sin pantalla de espera, y los candidatos completan solos.

## Fuera de alcance

- Cambiar el matching en sí (LCS/score).
- El modo Excel (no pega al servidor).
- Reactivar publicaciones pausadas.
