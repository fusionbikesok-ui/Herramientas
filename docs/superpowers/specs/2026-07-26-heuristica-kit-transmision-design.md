# Heurística de kit_transmision — Preparación de Pedidos

**Fecha:** 2026-07-26
**Estado:** aprobado, pendiente de plan de implementación
**Alcance:** sexto y último ciclo de la lista de mejoras a Preparación de Pedidos.
Ataca la fricción restante: la heurística de `resolverPerfil` (que decide si un producto
es `bici`/`kit_transmision`/`sellado` según categoría y nombre) es frágil para casos
puntuales, y hoy solo se puede corregir a nivel de **categoría completa**, no por
producto individual.

**Nota:** ciclo planeado y ejecutado con el usuario no disponible en el momento
(orquestador tomando las decisiones de diseño en su representación, mismo criterio
conservador que los ciclos anteriores).

## Contexto y problema

`resolverPerfil` (`lib/preparacion.js`) usa regex sobre categoría y nombre para
adivinar el perfil de un producto cuando no hay una regla explícita. Ya existe una
mitigación parcial: la tabla `preparacion_perfiles` permite fijar un perfil fijo por
**categoría** (match por substring, editable en la pestaña "Perfiles de foto"). Pero:

- Un producto individual mal clasificado (ej. un ítem con categoría genérica
  "ACCESORIOS" que en realidad es un kit de transmisión, o un producto cuyo nombre no
  contiene ninguna de las palabras clave de la heurística) **no se puede corregir** sin
  reclasificar TODA la categoría — lo cual afectaría a otros productos de esa misma
  categoría que sí están bien resueltos hoy.
- No hay forma de fijar el perfil de **un SKU puntual** sin pasar por Woo (cambiar la
  categoría del producto ahí, que es un cambio de catálogo, no de esta herramienta).

## Decisiones (tomadas por el orquestador en ausencia del usuario)

1. **Se agrega un nivel de override por SKU, con prioridad más alta que el de
   categoría.** Orden final de resolución: **SKU exacto → categoría (substring, ya
   existente) → heurística por nombre (ya existente, sin cambios)**. No se toca
   `resolverPerfil` en sí — sigue siendo el fallback de último recurso.
2. **Tabla nueva `preparacion_perfiles_sku`** (no se reutiliza `preparacion_perfiles`
   agregando una columna "tipo"): la clave natural es distinta (SKU exacto vs. substring
   de categoría) y mezclar ambas reglas en una tabla con match ambiguo complicaría la
   query de resolución sin necesidad. Sigue el mismo patrón de columnas que
   `preparacion_perfiles` (`perfil`, `requisitos_json` opcional, `actualizado_en`).
3. **Mismo patrón de API y UI que las reglas por categoría**, para no introducir un
   paradigma nuevo que el operario tenga que aprender: `GET/PUT/DELETE /perfiles-sku/:sku`
   y una segunda sección en la pestaña "Perfiles de foto" existente, con el mismo look
   (fila con select + Guardar/Borrar + fila para agregar uno nuevo).
4. **Match de SKU exacto (case-insensitive, trim), no substring.** A diferencia de
   categoría (donde un substring tiene sentido porque las categorías de Woo son
   jerárquicas y compuestas), el SKU es un identificador único de producto — un match
   parcial ahí sería una fuente de bugs, no una conveniencia.
5. **No se prepara ningún dato de ejemplo/seed.** A diferencia de `preparacion_perfiles`
   (que arranca con 2 categorías sembradas), esta tabla arranca vacía — el operario la
   completa a medida que encuentra casos puntuales mal resueltos.

## Diseño técnico

### Esquema

```sql
CREATE TABLE IF NOT EXISTS preparacion_perfiles_sku (
  sku             TEXT PRIMARY KEY,
  perfil          TEXT NOT NULL,
  requisitos_json TEXT,
  actualizado_en  TEXT NOT NULL
);
```

### Backend (`routes/preparacion.js`)

`perfilParaItem` y `requisitosParaItem` ganan un chequeo de SKU exacto **antes** del
chequeo de categoría existente:

```js
function perfilParaItem(db, { sku, categoria, nombre }) {
  const skuNorm = String(sku || '').trim().toUpperCase();
  if (skuNorm) {
    const regla = db.prepare('SELECT perfil FROM preparacion_perfiles_sku WHERE sku=?').get(skuNorm);
    if (regla) return regla.perfil;
  }
  // ...resto igual (categoría, después heurística)...
}
```

Mismo patrón para `requisitosParaItem` (chequeo de SKU antes del de categoría).

**Nuevos endpoints**, calcados de `/perfiles/:categoria` (mismo estilo REST con
`@Put`/`@Delete` que ya usa este router para `/perfiles/:categoria` — se mantiene la
convención existente del archivo, no se introduce RPC-style para no mezclar paradigmas
dentro del mismo router):

- `GET /perfiles-sku` → `{ ok, data: [...] }`
- `PUT /perfiles-sku/:sku` → upsert (mismo body shape que `/perfiles/:categoria`)
- `DELETE /perfiles-sku/:sku`

### Frontend (`public/preparacion/index.html`, tab "Perfiles de foto")

Segunda sección debajo de la existente, mismo patrón visual (`cargarPerfilesSku`,
`guardarPerfilSku`, `borrarPerfilSku`, `agregarPerfilSku`), con un encabezado que
explica el orden de prioridad: *"Reglas por SKU exacto — tienen prioridad sobre las
reglas por categoría de arriba."*

## Fuera de alcance de este ciclo

- Tocar `resolverPerfil` (la heurística de nombre en sí) — sigue siendo el fallback,
  sin cambios de comportamiento para los productos que ya resuelve bien.
- Importación masiva de reglas por SKU (CSV, etc.) — se agregan de a una desde la UI,
  como ya sucede con las de categoría.
- Autocompletado de SKU en el input (buscar contra `catalogo_cache`) — el operario ya
  tiene el SKU a mano (lo ve en el ítem mal clasificado durante la preparación).

## Siguiente paso

Invocar el plan de implementación: tabla nueva + prioridad de resolución (TDD) +
endpoints + UI.
