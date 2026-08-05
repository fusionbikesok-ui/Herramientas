# Reactivación automática de pausadas + auditoría de vínculos WC↔ML

Fecha: 2026-07-30
Estado: aprobado por el usuario, pendiente de plan de implementación

## Problema

Dos dolores concretos sobre el sync de stock con MercadoLibre:

1. **Publicaciones pausadas que no vuelven solas.** Cuando un SKU se queda sin stock, ML
   pausa la publicación por `out_of_stock`. Cuando el stock vuelve, la publicación sigue
   pausada hasta que alguien entra a `/sync-ml/#reactivar` y aprieta el botón. Toda la
   maquinaria existe (`getReactivablesRows`, `chequearNetoReactivar`, `reactivarItems`) —
   falta que sea automática.

2. **No hay forma de auditar el vínculo WC→ML.** Dado un producto de WooCommerce, no se
   puede ver qué publicaciones de ML tiene mapeadas, ni verificar que el precio esté bien,
   ni detectar que el matcher haya vinculado la publicación equivocada.

## Decisiones tomadas

| Decisión | Elección |
|---|---|
| Reactivación | Automática, con guarda de precio (no revive nada que venda por debajo del contado) |
| Vista de auditoría | Detalle por producto + listado de sospechosos |
| Origen del precio ML | Cacheado para las vistas; llamada viva solo antes de reactivar de verdad |
| Señales de sospecha | `seller_sku` ≠ SKU, color/talle discrepante, desvío de precio. Huecos de mapeo → enlace a Cobertura |
| Acciones en el detalle | Desvincular + reasignar + marcar revisado OK |
| Aviso de frenadas por precio | Solo badge en el home, sin mail |

## Arquitectura

### 1. Reactivación automática

Función `reactivarAutomatico(db, cfg)` en `routes/sync.js`, disparada por un cron nuevo cada
10 min en `server.js` (dentro del bloque `DISABLE_CRONS`). Usa el candado
`_reactivarEnCurso` ya existente, para que la corrida automática y el botón manual nunca se
pisen ni compitan por el rate limit de ML.

Por publicación:

1. `getReactivablesRows` → pausadas por `out_of_stock`, con stock web disponible y mapeadas.
2. `chequearNetoReactivar` con precio vivo de ML (la llamada que ya se hace hoy en el flujo
   manual; no se agregan llamadas nuevas).
3. Veredicto `ok` o `alto` → `reactivarItems` reactiva y empuja el stock actual.
4. Veredicto `bajo` o `sin_precio` → no se toca. Se registra en `ml_reactivacion_frenada`.

Una frenada se limpia sola: si en un ciclo posterior el precio pasa el chequeo, se reactiva
y se borra la fila. No queda estado para limpiar a mano.

El botón manual de `/sync-ml/#reactivar` sigue existiendo como override: desde la lista de
frenadas se puede forzar la reactivación de una publicación que el sistema frenó, con
confirmación explícita que muestra neto ML y precio de contado.

### 2. Precio en el cache

`ml_publicaciones_cache` gana `precio`, `available_quantity` y `precio_actualizado_en`. Se
pueblan en el mismo barrido del matcher que ya trae las publicaciones — el precio viene en
la respuesta que ya se pide, cero llamadas nuevas. `precio_actualizado_en` permite que la UI
diga "precio de hace 2 h" en vez de fingir que es en vivo.

Este cache es el habilitador de las dos vistas: sin él, el listado de sospechosos requeriría
una llamada a ML por publicación y competiría con el sync por el rate limit.

### 3. Vista de detalle por producto

Pantalla `/vinculos/`. Backend: `GET /api/sync/vinculos/:sku`.

Se busca por SKU o nombre. Arriba el producto WC (foto, nombre, stock, precio de lista y de
contado). Debajo, una tarjeta por cada publicación ML mapeada:

- thumbnail, título ML, variación (color/talle), status, enlace a la publicación
- **stock**: ML vs web, indicando el modo aplicado (`solo_local` / `reserva`) para explicar
  por qué difieren
- **precio**: precio ML, neto estimado, precio de contado, veredicto (`ok` / `bajo` / `alto`)
- **coincidencia**: las tres señales en semáforo, más los títulos WC y ML lado a lado para
  juicio humano
- acciones: Desvincular, Reasignar (buscador de SKU vía `lib/matcherResolver.js`), Marcar
  revisado OK

### 4. Listado de sospechosos

Pestaña dentro de `/vinculos/`. Query pura sobre SQLite, sin tocar la API de ML, ordenada
por severidad.

| Señal | Regla | Peso |
|---|---|---|
| `seller_sku` ≠ SKU mapeado | comparación exacta ignorando caso y espacios; solo si ML tiene `seller_sku` cargado | alta |
| color/talle discrepante | normalizado (minúsculas, sin acentos) contra `atributos_json` de `catalogo_cache`; solo si ambos lados tienen el dato | alta |
| desvío de precio | \|precio ML − precio lista WC\| / precio lista > umbral | media |

El umbral de desvío arranca en **40%**, definido como constante exportada en el módulo que
calcula las señales (no como columna de configuración ni variable de entorno): se ajusta con
un cambio de código si la práctica muestra que 40% es demasiado ruidoso o demasiado laxo.

**Multi-publicación por SKU no es señal**: 1 SKU → N publicaciones es intencional en esta
operación (distintas condiciones de venta).

Los huecos de mapeo (SKU sin publicación, publicación sin SKU) no se calculan acá: un enlace
fijo lleva a Cobertura, que ya es la herramienta que los cubre.

Un descarte ("revisado OK") guarda el **valor** descartado, no solo la clave. Si el precio de
ML cambia y vuelve a desviarse, el sospechoso reaparece. Descartar significa "esta
discrepancia concreta está bien", no "no me muestres más esta publicación". Sin esto, la
lista acumula ruido permanente y termina ignorada.

### 5. Esquema

Los cambios van como sentencias idempotentes en `db/index.js` (`ALTER TABLE` dentro de
`try/catch` y `CREATE TABLE IF NOT EXISTS`), que es la convención real del proyecto para este
tipo de cambio — los archivos `.sql` numerados de `migrations/` se usan para otra cosa.

- `ml_publicaciones_cache`: `+ precio`, `+ available_quantity`, `+ precio_actualizado_en`
- `ml_reactivacion_frenada`: `clave` PK, `sku`, `motivo`, `neto`, `precio_contado`,
  `deficit_pct`, `detectado_en`
- `ml_vinculos_revisados`: PK **compuesta** `(clave, senal)`, `valor_revisado`, `revisado_por`,
  `revisado_en`. La PK es compuesta porque una publicación puede tener una señal descartada y
  otra vigente; con PK simple, descartar una borraría la otra.

### 6. Home

Dos chips nuevos en el panel de atención existente:

- "N pausadas frenadas por precio" → `/sync-ml/#frenadas`
- "N vínculos sospechosos" → `/vinculos/#sospechosos`

Ambos desaparecen en cero, como el resto de los chips.

## Manejo de errores

Fail-closed en todo lo que toca ML:

- Si la API de ML no responde al chequear el precio, **no se reactiva**. Se pospone al
  siguiente ciclo y **no** se registra como frenada — no es un problema de precio y no debe
  ensuciar esa lista.
- Si el cache de precio está vacío para una publicación, la señal de precio no dispara, en
  vez de generar un falso positivo.
- La reactivación automática nunca toca publicaciones con `paused_by_seller` (ya excluidas
  en `getReactivablesRows`).

## Testing

Tests vitest que cubren:

- normalización de color/talle: acentos, `"M"` vs `"M (55-59cm)"`
- decisión de reactivar según veredicto (`ok`/`alto` reactiva, `bajo`/`sin_precio` frena)
- fail-closed ante ML caído: no reactiva y no registra frenada
- reaparición de un sospechoso descartado cuando cambia el valor
- multi-publicación por SKU no genera sospecha

Si toca frontend, incluye axe-core. Al ser pantalla nueva, corresponde `probador-e2e` sobre
`/vinculos/` antes del gate del auditor.

## Alcance del pipeline

Cambio **grande**: pantalla nueva + cambio de esquema + toca el sync ML↔Woo. Pipeline
completo, con `disenador-ux` y `disenador-ui` antes de que se escriba código.
