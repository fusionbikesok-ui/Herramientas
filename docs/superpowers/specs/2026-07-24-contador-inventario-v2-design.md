# Contador de Inventario v2 — diseño

**Fecha:** 2026-07-24
**Estado:** aprobado, pendiente de plan de implementación

## Contexto y problema

Hoy `public/inventario/index.html` es 100% client-side (localStorage, sin backend). Trae
fricciones reales: no persiste entre dispositivos, no compara contra el stock real de Woo,
no ajusta stock (solo exporta CSV para procesar a mano afuera), y no soporta que dos
operarios cuenten a la vez sin pisarse. El usuario pidió rehacerla con: comparación real
vs. contado por sesión, filtros/orden para contar, ajuste de stock en Woo al confirmar,
aprendizaje de EANs nuevos, persistencia entre dispositivos por sesión (no global), registro
de quién contó, solución al problema de multiusuario, y mejora de interfaz.

## Decisiones (confirmadas con el usuario)

1. **Una sesión es de un solo operario**, no colaborativa en tiempo real. Persiste entre
   sus propios dispositivos (vía login), pero no se mezcla con la sesión de otro.
2. **Alcance obligatorio** (categoría y/o marca) al crear la sesión — habilita el
   anti-solape entre sesiones concurrentes.
3. **Anti-solape con visibilidad del dueño:** si el alcance elegido choca con otra sesión
   abierta (de cualquier usuario), se bloquea la creación mostrando de quién es la sesión
   que bloquea y qué se solapa.
4. **Ajuste de stock al confirmar:** stock en Woo = cantidad contada, por cada producto
   contado. Los productos del alcance NO contados quedan sin tocar (no se ponen en 0).
5. **EAN nuevo:** se asocia a un SKU existente en el momento (o "Después", pero bloqueante
   recién al confirmar — no queda suelto sin que el sistema lo reclame).
6. **Filtros/orden mientras se cuenta:** categoría/marca (ya definen el alcance),
   pendientes vs. contados, y orden por magnitud de diferencia contra stock de Woo.
7. **Registro de quién contó:** a nivel de sesión (`usuario`, `creado_en`,
   `confirmado_en`) — no hace falta atribución por ítem porque cada sesión es de un solo
   operario (decisión 1).
8. **Confirmación es irreversible** (ajusta stock real): mismo nivel de fricción que ya
   usa el proyecto para acciones de precio/stock — doble paso (hold-to-confirm o tipear
   CONFIRMAR), fail-closed por ítem si falla el PATCH a Woo.

## Arquitectura

### Backend nuevo: `routes/inventario.js` (no existe hoy)

**Tablas** (patrón `ensureTables`, como `routes/preparacion.js`):

```sql
CREATE TABLE IF NOT EXISTS inventario_sesiones (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario        TEXT NOT NULL,
  categoria      TEXT,
  marca          TEXT,
  estado         TEXT NOT NULL DEFAULT 'abierta',  -- abierta | confirmada | descartada
  creado_en      TEXT NOT NULL,
  confirmado_en  TEXT
);
CREATE INDEX IF NOT EXISTS idx_inv_sesiones_estado ON inventario_sesiones(estado);

CREATE TABLE IF NOT EXISTS inventario_conteos (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  sesion_id      INTEGER NOT NULL,
  ean            TEXT NOT NULL,
  sku            TEXT,             -- NULL = "sin asociar" (EAN nuevo, bloqueante al confirmar)
  cantidad       INTEGER NOT NULL DEFAULT 0,
  actualizado_en TEXT NOT NULL,
  UNIQUE(sesion_id, ean)
);
```

**Reuso de patrones existentes (no reinventar):**
- `setStockWc(cfg, db, sku, cantidad)` de `lib/wooStock.js` — ajuste de stock al confirmar.
- `GET /api/codigos/buscar` (`routes/codigos.js:105-118`) — búsqueda de SKU/nombre para
  asociar un EAN nuevo (reusar tal cual desde el frontend, sin duplicar).
- Asociar EAN↔SKU: mismo INSERT que ya hace `POST /api/consulta-precios/ean`
  (`routes/consultaPrecios.js:63-74`) — validar que el SKU exista en `catalogo_cache` antes
  de sembrar `ean_sku`, igual criterio.
- Clasificación EAN/SKU con checksum GS1 real: se porta del frontend actual
  (`public/inventario/index.html`, funciones `kindOf`/`gtinCheckOk`), sin cambios de lógica.
- Escaneo (cámara + pistola HID): `public/lib/scanner.js`, sin cambios.

**Endpoints nuevos:**
- `GET /alcance-opciones` — categorías/marcas distintas disponibles, vía `SELECT DISTINCT`
  sobre `catalogo_cache` (no hay endpoint de taxonomías separado en el proyecto — se arma
  parseando `categorias_json`/`marca` de las filas ya cacheadas).
- `GET /sesion-activa` — la sesión abierta del usuario logueado, si existe.
- `POST /sesiones` `{categoria?, marca?}` — crea sesión. **Fail-closed de solape**: rechaza
  con 409 + `{ocupada_por: usuario, categoria, marca}` si hay otra sesión `abierta` cuyo
  alcance se cruza (mismo categoria Y/O misma marca, según cuáles se hayan elegido).
- `GET /sesiones/:id` — detalle: filas contadas + comparación contra `catalogo_cache.stock`
  + productos del alcance pendientes de contar (para el filtro "Pendientes").
- `POST /sesiones/:id/escanear` `{codigo}` — clasifica EAN/SKU (checksum GS1), resuelve SKU
  vía `ean_sku`/`catalogo_cache.gtin` si es EAN, upsert en `inventario_conteos`
  (`sku=NULL` si no se pudo resolver). Solo el dueño de la sesión puede escanear en ella.
- `POST /sesiones/:id/asociar` `{ean, sku}` — asocia un EAN "sin asociar" a un SKU
  (reusa la validación de `consulta-precios/ean`), actualiza la fila.
- `DELETE /sesiones/:id/items/:itemId` — elimina una fila (deshacer).
- `POST /sesiones/:id/descartar` — cierra sin ajustar stock (`estado='descartada'`).
- `POST /sesiones/:id/confirmar` — **bloquea con 409 si hay filas sin asociar**. Si no,
  para cada fila con `sku` resuelto llama `setStockWc`; fail-closed por ítem (un PATCH que
  falla no aborta el resto, se reporta aparte); marca `estado='confirmada'`,
  `confirmado_en`. Devuelve `{ajustados, sin_cambios, fallidos}`.
- `GET /sesiones` — historial de sesiones cerradas (confirmada/descartada) del usuario.

### Frontend: `public/inventario/index.html` reescrito, 6 pantallas (SPA, un solo archivo)

1. **Inicio** — tarjeta "Retomar" si hay sesión abierta propia (con antigüedad), si no,
   solo "Nueva sesión"; historial colapsable de sesiones cerradas, read-only. Tareas de
   mantenimiento (import/export JSON del mapa) se sacan del flujo del operario.
2. **Elegir alcance** — type-ahead de categoría/marca (al menos uno obligatorio), resumen
   en lenguaje natural, aviso de choque con dueño visible si aplica.
3. **Conteo** — barra de estado fija (alcance + LED de foco + chip "Guardado"), input de
   escaneo + cámara (preserva `scanner.js`), 3 contadores (Contados/Pendientes/Con
   diferencia), chips de filtro + orden por diferencia, lista de filas con +1/−1/✕,
   botón fijo "Revisar y cerrar".
4. **Panel EAN nuevo** — bottom-sheet no bloqueante, buscador de SKU, botón "Después".
5. **Revisión** — ordenada por magnitud de diferencia, bloque bloqueante de "sin asociar",
   nota informativa de no-contados, botones "Volver a contar"/"Confirmar ajuste".
6. **Confirmación** — modal "pesado" (velo denso, rojo sólido), resumen numérico, frase
   explícita de irreversibilidad, hold-to-confirm 2s o tipear CONFIRMAR.
7. **Resultado** — progreso de escritura, resumen Ajustados/Sin cambios/Fallidos con
   reintento, sesión queda cerrada read-only.

**Tokens/componentes nuevos en `public/lib/theme.css`** (ya especificados por
`disenador-ui`, ver detalle abajo): `--tap-min`, `--chip-*`/`--chip-on-*`, `--diff-*`,
`--state-*`, `--progress-*`, `--danger-*` (único hex nuevo: `--danger-on #2A0505`, texto
sobre rojo sólido), `--sheet-*`. Todos verificados WCAG 2.2 AA (≥4.5:1) por `disenador-ui`.
Documentar en `public/lib/design-system.md` (crear si no existe, ya lo usó el ciclo del
home).

## Fuera de alcance de este ciclo

- Colaboración en tiempo real dentro de una misma sesión (decisión 1: sesiones aisladas
  por operario).
- Gestión admin de sesiones ajenas (cerrar la sesión de otro) — el anti-solape ya evita el
  problema de raíz; si hace falta forzar el cierre de una sesión de otro operario, es un
  ciclo futuro.
- Vista de mantenimiento del mapa EAN↔SKU (import/export JSON) para admins — se saca del
  flujo del operario pero no se rediseña en este ciclo.
- Categorías/marcas propias del Contador (hoy se derivan 100% de `catalogo_cache`, no hay
  taxonomía propia que crear).

## Siguiente paso

Invocar `superpowers:writing-plans` para el plan de implementación: tabla+endpoints nuevos
en `routes/inventario.js` (TDD), tokens en `theme.css`, y las 6 pantallas de
`public/inventario/index.html`.
