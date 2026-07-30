# Reactivación automática de pausadas + auditoría de vínculos WC↔ML — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que las publicaciones de ML pausadas por falta de stock se reactiven solas cuando recuperan stock (sin revivir nada que venda por debajo del precio de contado), y que exista una pantalla para auditar qué publicaciones de ML tiene mapeadas cada producto de WooCommerce, con su precio y señales de match incorrecto.

**Architecture:** Se apoya en la maquinaria existente de `routes/sync.js` (`getReactivablesRows`, `chequearNetoReactivar`, `reactivarItems`), agregándole un disparador automático por cron y persistencia de las que quedaron frenadas por precio. Para las vistas se cachea el precio de ML en `ml_publicaciones_cache` durante el barrido que el matcher ya hace, de modo que el listado de sospechosos sea una query de SQLite sin llamadas a la API. Las señales de sospecha viven en un módulo puro nuevo, testeable sin DB ni red.

**Tech Stack:** Node ESM, Express, better-sqlite3, vitest, frontend vanilla (HTML+JS sin build) sobre `public/lib/theme.css`.

## Global Constraints

- **Idioma:** todo el código, comentarios, mensajes de UI y de error en español rioplatense.
- **Migraciones:** este proyecto NO usa archivos `.sql` numerados para cambios de esquema de este tipo. Los cambios van como sentencias idempotentes en `db/index.js` (`try { db.exec('ALTER TABLE ...') } catch (_) {}` y `CREATE TABLE IF NOT EXISTS`), que corren en cada arranque. Seguir ese patrón exactamente.
- **Fail-closed con ML:** si la API de ML no responde o responde algo incompleto, no se reactiva y no se registra frenada. Nunca asumir un estado que no se pudo verificar.
- **Rate limit de ML:** no agregar llamadas a la API por publicación en caminos masivos. Las vistas leen de SQLite.
- **Multi-publicación:** 1 SKU → N publicaciones es intencional. Jamás tratarlo como error ni como señal de sospecha.
- **Permisos:** las rutas nuevas cuelgan de `/api/sync/...`, que ya está cubierto por la regla catch-all `{ re: /^\/sync(\/|$)/ → anyOf: ['sync-ml'] }` en `lib/permisos.js`. No hace falta agregar reglas ni herramientas nuevas.
- **Tests:** `npm test` (vitest). Los tests van en `test/*.test.js`, ESM, con `vi.mock` para `../lib/mlClient.js` cuando haga falta evitar la red.
- **Commits:** frecuentes, uno por tarea como mínimo, mensaje en español.

## File Structure

| Archivo | Responsabilidad |
|---|---|
| `db/index.js` (modificar) | Columnas nuevas de `ml_publicaciones_cache` + tablas `ml_reactivacion_frenada` y `ml_vinculos_revisados` |
| `lib/modelos/publicacionMl.js` (modificar) | `aplanarItemMl` pasa a devolver `precio` y `available_quantity` |
| `routes/matcher.js` (modificar) | Pedirle esos campos a ML y persistirlos en el upsert del cache |
| `lib/vinculosSenales.js` (crear) | Módulo puro: normalización de color/talle y cálculo de las tres señales de sospecha |
| `routes/sync.js` (modificar) | `reactivarAutomatico` + endpoints de frenadas, vínculos, sospechosos, revisado-OK y reasignar |
| `server.js` (modificar) | Cron de reactivación automática + `express.static` de `/vinculos` |
| `public/vinculos/index.html` (crear) | Pantalla de detalle por producto + pestaña de sospechosos |
| `public/home/index.html` (modificar) | Dos chips nuevos en el panel de atención |
| `test/vinculos-senales.test.js` (crear) | Tests del módulo puro |
| `test/reactivar-automatico.test.js` (crear) | Tests de la reactivación automática |
| `test/vinculos-route.test.js` (crear) | Tests de los endpoints |

---

### Task 1: Esquema

**Files:**
- Modify: `db/index.js:61` (después de la línea `ALTER TABLE ml_publicaciones_cache ADD COLUMN catalogo INTEGER`)
- Test: `test/db.test.js`

**Interfaces:**
- Consumes: nada.
- Produces: columnas `ml_publicaciones_cache.precio` (REAL), `.available_quantity` (INTEGER), `.precio_actualizado_en` (TEXT). Tablas `ml_reactivacion_frenada(clave TEXT PK, sku TEXT, motivo TEXT, neto REAL, precio_contado REAL, deficit_pct REAL, detectado_en TEXT)` y `ml_vinculos_revisados(clave TEXT, senal TEXT, valor_revisado TEXT, revisado_por TEXT, revisado_en TEXT, PRIMARY KEY(clave, senal))`.

> Nota sobre `ml_vinculos_revisados`: la PK es **compuesta** `(clave, senal)`, no solo `clave`. Una misma publicación puede tener descartada la señal de precio pero no la de `seller_sku`; con PK simple, descartar una borraría la otra.

- [ ] **Step 1: Escribir el test que falla**

Agregar a `test/db.test.js`:

```js
it('crea las columnas de precio en ml_publicaciones_cache y las tablas de vínculos', () => {
  const db = openDb(TEST_DB);
  const cols = db.prepare('PRAGMA table_info(ml_publicaciones_cache)').all().map(c => c.name);
  expect(cols).toContain('precio');
  expect(cols).toContain('available_quantity');
  expect(cols).toContain('precio_actualizado_en');

  // Las tablas nuevas existen y aceptan una fila.
  db.prepare(`INSERT INTO ml_reactivacion_frenada
    (clave, sku, motivo, neto, precio_contado, deficit_pct, detectado_en)
    VALUES ('MLA1|', 'FB-1', 'El neto de ML queda por debajo del precio web', 100, 150, 0.33, '2026-07-30T10:00:00Z')`).run();
  expect(db.prepare('SELECT COUNT(*) n FROM ml_reactivacion_frenada').get().n).toBe(1);

  // PK compuesta: la misma clave con dos señales distintas convive.
  const ins = db.prepare(`INSERT INTO ml_vinculos_revisados
    (clave, senal, valor_revisado, revisado_por, revisado_en)
    VALUES (?, ?, ?, ?, ?)`);
  ins.run('MLA1|', 'precio', '99000', 'auditor', '2026-07-30T10:00:00Z');
  ins.run('MLA1|', 'seller_sku', 'FB-9', 'auditor', '2026-07-30T10:00:00Z');
  expect(db.prepare('SELECT COUNT(*) n FROM ml_vinculos_revisados').get().n).toBe(2);
  db.close();
});
```

Si `test/db.test.js` no define `TEST_DB` ni importa `openDb`, copiar el patrón del archivo (mirar cómo abre la base el resto de los tests de ese archivo y reusar exactamente ese setup/teardown).

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx vitest run test/db.test.js -t "columnas de precio"`
Expected: FAIL — `expect(cols).toContain('precio')` falla porque la columna no existe.

- [ ] **Step 3: Implementar**

En `db/index.js`, inmediatamente después de la línea `try { db.exec('ALTER TABLE ml_publicaciones_cache ADD COLUMN catalogo INTEGER'); } catch (_) {}`:

```js
  // Precio y stock de ML cacheados en el mismo barrido del matcher (el multiget ya trae el
  // item completo). Habilitan el listado de vínculos sospechosos como query local, sin una
  // llamada a la API por publicación. precio_actualizado_en permite mostrar la antigüedad
  // del dato en la UI en vez de fingir que es en vivo.
  try { db.exec('ALTER TABLE ml_publicaciones_cache ADD COLUMN precio REAL'); } catch (_) {}
  try { db.exec('ALTER TABLE ml_publicaciones_cache ADD COLUMN available_quantity INTEGER'); } catch (_) {}
  try { db.exec('ALTER TABLE ml_publicaciones_cache ADD COLUMN precio_actualizado_en TEXT'); } catch (_) {}

  // Publicaciones que recuperaron stock pero la reactivación automática NO reactivó porque
  // el neto de ML quedaría por debajo del precio de contado. Se limpia sola: cuando el precio
  // pasa el chequeo, se reactiva y se borra la fila.
  try { db.exec(`CREATE TABLE IF NOT EXISTS ml_reactivacion_frenada (
    clave TEXT PRIMARY KEY,
    sku TEXT,
    motivo TEXT,
    neto REAL,
    precio_contado REAL,
    deficit_pct REAL,
    detectado_en TEXT NOT NULL
  )`); } catch (_) {}

  // Descartes de vínculos sospechosos ("revisado OK"). Guarda el VALOR descartado, no solo la
  // clave: si el dato cambia (ej. el precio de ML se mueve otra vez), el sospechoso reaparece.
  // PK compuesta porque una publicación puede tener una señal descartada y otra vigente.
  try { db.exec(`CREATE TABLE IF NOT EXISTS ml_vinculos_revisados (
    clave TEXT NOT NULL,
    senal TEXT NOT NULL,
    valor_revisado TEXT,
    revisado_por TEXT,
    revisado_en TEXT NOT NULL,
    PRIMARY KEY (clave, senal)
  )`); } catch (_) {}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `npx vitest run test/db.test.js`
Expected: PASS, sin romper los tests que ya había en el archivo.

- [ ] **Step 5: Commit**

```bash
git add db/index.js test/db.test.js
git commit -m "Esquema: precio en cache de publicaciones + tablas de frenadas y vínculos revisados"
```

---

### Task 2: Cachear precio y stock de ML

**Files:**
- Modify: `lib/modelos/publicacionMl.js:49-110` (`aplanarItemMl`) y el typedef de las líneas 9-24
- Modify: `routes/matcher.js:96` y `routes/matcher.js:~155` (los dos `attributes=` del multiget), y `routes/matcher.js:126-137` (`prepararUpsertCache`)
- Test: `test/publicacion-ml.test.js` (crear si no existe; si existe un test del modelo con otro nombre, agregar ahí)

**Interfaces:**
- Consumes: columnas de la Task 1.
- Produces: cada fila de `aplanarItemMl(body)` incluye `precio` (number|null) y `available_quantity` (number|null). El upsert del cache los persiste junto a `precio_actualizado_en`.

> Detalle clave: en ML el precio de una publicación con variaciones puede estar **a nivel variación** (`v.price`) o solo a nivel ítem (`body.price`). La regla es: usar `v.price` si existe, si no `body.price`. Lo mismo con `available_quantity`, que en variaciones vive en `v.available_quantity`. Es la misma regla que ya aplica `chequearNetoReactivar` en `routes/sync.js` para el precio — mantenerla idéntica evita que la vista muestre un número distinto al que usa la decisión de reactivar.

- [ ] **Step 1: Escribir el test que falla**

Crear `test/publicacion-ml.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { aplanarItemMl } from '../lib/modelos/publicacionMl.js';

describe('aplanarItemMl: precio y stock', () => {
  it('toma precio y available_quantity del ítem en publicaciones simples', () => {
    const filas = aplanarItemMl({
      id: 'MLA111', title: 'Casco', status: 'active', price: 218700, available_quantity: 4,
      attributes: [{ id: 'SELLER_SKU', value_name: 'FB-6411' }],
    });
    expect(filas).toHaveLength(1);
    expect(filas[0].precio).toBe(218700);
    expect(filas[0].available_quantity).toBe(4);
  });

  it('prefiere el precio de la variación sobre el del ítem', () => {
    const filas = aplanarItemMl({
      id: 'MLA222', title: 'Bici', status: 'active', price: 1000000, available_quantity: 0,
      variations: [
        { id: 1, price: 2767707, available_quantity: 2, attribute_combinations: [{ id: 'COLOR', value_name: 'Negro/Rojo' }], attributes: [] },
        { id: 2, attribute_combinations: [{ id: 'COLOR', value_name: 'Azul' }], attributes: [] },
      ],
    });
    expect(filas[0].precio).toBe(2767707);
    expect(filas[0].available_quantity).toBe(2);
    // La variación sin precio propio hereda el del ítem.
    expect(filas[1].precio).toBe(1000000);
  });

  it('deja precio en null cuando ML no lo trae', () => {
    const filas = aplanarItemMl({ id: 'MLA333', title: 'X', status: 'active', attributes: [] });
    expect(filas[0].precio).toBeNull();
    expect(filas[0].available_quantity).toBeNull();
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx vitest run test/publicacion-ml.test.js`
Expected: FAIL — `filas[0].precio` es `undefined`, no `218700`.

- [ ] **Step 3: Implementar**

En `lib/modelos/publicacionMl.js`, agregar al typedef (después de `@property {0|1} catalogo`):

```js
 * @property {number|null} precio              precio de la variación, o del ítem si la variación no tiene propio
 * @property {number|null} available_quantity  stock disponible en ML
```

En la rama de producto simple de `aplanarItemMl`, agregar al objeto devuelto:

```js
      precio: body.price ?? null,
      available_quantity: body.available_quantity ?? null,
```

En la rama de variaciones, dentro del `vars.map(v => {...})`, agregar al objeto devuelto:

```js
      // ML puede poner el precio a nivel variación o solo a nivel ítem. Misma regla que usa
      // chequearNetoReactivar en routes/sync.js — si divergen, la vista mostraría un precio
      // distinto del que decide la reactivación.
      precio: v.price ?? body.price ?? null,
      available_quantity: v.available_quantity ?? null,
```

En `routes/matcher.js`, en **los dos** multiget (línea ~96 en `refrescarPublicacionesMl` y línea ~155 en `refrescarPublicacionesMlAcotado`), agregar `price` y `available_quantity` a la lista `attributes=`, que queda:

```
attributes=id,title,status,sub_status,seller_custom_field,attributes,variations,secure_thumbnail,thumbnail,permalink,catalog_listing,price,available_quantity
```

En `prepararUpsertCache` (`routes/matcher.js:126`), agregar las tres columnas:

```js
function prepararUpsertCache(db) {
  return db.prepare(`
    INSERT INTO ml_publicaciones_cache
      (clave, item_id, variation_id, titulo, status, sub_status, es_variante, color, talle, seller_sku, variations_texto, thumbnail, permalink, catalogo, precio, available_quantity, precio_actualizado_en, actualizado_en)
    VALUES (@clave, @item_id, @variation_id, @titulo, @status, @sub_status, @es_variante, @color, @talle, @seller_sku, @variations_texto, @thumbnail, @permalink, @catalogo, @precio, @available_quantity, @actualizado_en, @actualizado_en)
    ON CONFLICT(clave) DO UPDATE SET
      item_id=excluded.item_id, variation_id=excluded.variation_id, titulo=excluded.titulo,
      status=excluded.status, sub_status=excluded.sub_status, es_variante=excluded.es_variante, color=excluded.color,
      talle=excluded.talle, seller_sku=excluded.seller_sku, variations_texto=excluded.variations_texto,
      thumbnail=excluded.thumbnail, permalink=excluded.permalink, catalogo=excluded.catalogo,
      precio=excluded.precio, available_quantity=excluded.available_quantity,
      precio_actualizado_en=excluded.precio_actualizado_en, actualizado_en=excluded.actualizado_en
  `);
}
```

(`@actualizado_en` se usa para las dos columnas de fecha porque el precio se trae en el mismo barrido; no hace falta un timestamp separado en el `run`.)

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `npx vitest run test/publicacion-ml.test.js test/matcher.test.js`
Expected: PASS ambos. Si `test/matcher.test.js` tenía una aserción sobre el string exacto del `attributes=`, actualizarla al string nuevo.

- [ ] **Step 5: Commit**

```bash
git add lib/modelos/publicacionMl.js routes/matcher.js test/publicacion-ml.test.js
git commit -m "Cachear precio y stock de ML en el barrido del matcher"
```

---

### Task 3: Módulo puro de señales de sospecha

**Files:**
- Create: `lib/vinculosSenales.js`
- Test: `test/vinculos-senales.test.js`

**Interfaces:**
- Consumes: nada (módulo puro, sin DB ni red).
- Produces:
  - `export const UMBRAL_DESVIO_PRECIO = 0.40`
  - `export function normalizarAtributo(v: string): string`
  - `export function atributosWc(atributosJson: string): { color: string, talle: string }`
  - `export function senalesDeVinculo(fila): Senal[]` donde `Senal = { senal: 'seller_sku'|'atributos'|'precio', peso: 'alta'|'media', detalle: string, valor: string }`

`fila` es un objeto plano con: `clave`, `sku`, `seller_sku`, `color`, `talle`, `precio` (ML), `titulo` (ML), `wc_nombre`, `atributos_json` (WC), `precio_wc` (precio de lista de WC).

`valor` es el string que se guarda en `ml_vinculos_revisados.valor_revisado` — es lo que hace que un descarte se invalide cuando el dato cambia.

- [ ] **Step 1: Escribir el test que falla**

Crear `test/vinculos-senales.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { normalizarAtributo, atributosWc, senalesDeVinculo, UMBRAL_DESVIO_PRECIO } from '../lib/vinculosSenales.js';

const base = {
  clave: 'MLA1|10', sku: 'FB-6411', seller_sku: 'FB-6411',
  color: 'Negro/Rojo', talle: 'M', precio: 218700, titulo: 'Casco Giro Syntax',
  wc_nombre: 'Casco Giro Syntax Matte — Negro/Rojo / M (55-59cm)',
  atributos_json: '[{"name":"Color","option":"Negro/Rojo"},{"name":"Talle","option":"M (55-59cm)"}]',
  precio_wc: 218700,
};

describe('normalizarAtributo', () => {
  it('baja a minúsculas, saca acentos y espacios de más', () => {
    expect(normalizarAtributo('  Ámbar Metálico ')).toBe('ambar metalico');
  });
  it('devuelve cadena vacía para nulos', () => {
    expect(normalizarAtributo(null)).toBe('');
  });
});

describe('atributosWc', () => {
  it('extrae color y talle del JSON de atributos de WC', () => {
    expect(atributosWc(base.atributos_json)).toEqual({ color: 'Negro/Rojo', talle: 'M (55-59cm)' });
  });
  it('tolera JSON inválido o vacío', () => {
    expect(atributosWc('no-json')).toEqual({ color: '', talle: '' });
    expect(atributosWc(null)).toEqual({ color: '', talle: '' });
  });
});

describe('senalesDeVinculo', () => {
  it('no marca nada cuando todo coincide', () => {
    expect(senalesDeVinculo(base)).toEqual([]);
  });

  it('marca seller_sku distinto del SKU mapeado', () => {
    const s = senalesDeVinculo({ ...base, seller_sku: 'FB-9999' });
    expect(s.map(x => x.senal)).toContain('seller_sku');
    expect(s.find(x => x.senal === 'seller_sku').peso).toBe('alta');
  });

  it('ignora seller_sku cuando ML no lo tiene cargado', () => {
    expect(senalesDeVinculo({ ...base, seller_sku: '' })).toEqual([]);
  });

  it('compara seller_sku ignorando caso y espacios', () => {
    expect(senalesDeVinculo({ ...base, seller_sku: ' fb-6411 ' })).toEqual([]);
  });

  it('marca color discrepante', () => {
    const s = senalesDeVinculo({ ...base, color: 'Azul' });
    expect(s.map(x => x.senal)).toContain('atributos');
  });

  it('acepta el talle de ML como prefijo del de WC (M vs M (55-59cm))', () => {
    expect(senalesDeVinculo({ ...base, talle: 'M' })).toEqual([]);
  });

  it('marca talle discrepante de verdad', () => {
    const s = senalesDeVinculo({ ...base, talle: 'XL' });
    expect(s.map(x => x.senal)).toContain('atributos');
  });

  it('ignora atributos cuando falta el dato de un lado', () => {
    expect(senalesDeVinculo({ ...base, color: '', talle: '' })).toEqual([]);
    expect(senalesDeVinculo({ ...base, atributos_json: null })).toEqual([]);
  });

  it('marca desvío de precio por encima del umbral', () => {
    const s = senalesDeVinculo({ ...base, precio: 80000 });
    expect(s.map(x => x.senal)).toContain('precio');
    expect(s.find(x => x.senal === 'precio').peso).toBe('media');
  });

  it('no marca desvíos por debajo del umbral', () => {
    const dentro = base.precio_wc * (1 + UMBRAL_DESVIO_PRECIO - 0.01);
    expect(senalesDeVinculo({ ...base, precio: dentro })).toEqual([]);
  });

  it('no marca precio si falta el dato de ML o de WC (fail-closed, sin falso positivo)', () => {
    expect(senalesDeVinculo({ ...base, precio: null })).toEqual([]);
    expect(senalesDeVinculo({ ...base, precio_wc: 0 })).toEqual([]);
  });

  it('el valor de la señal cambia cuando cambia el dato (invalida el descarte)', () => {
    const a = senalesDeVinculo({ ...base, precio: 80000 }).find(x => x.senal === 'precio').valor;
    const b = senalesDeVinculo({ ...base, precio: 70000 }).find(x => x.senal === 'precio').valor;
    expect(a).not.toBe(b);
  });

  it('ordena las señales de peso alta antes que las de peso media', () => {
    const s = senalesDeVinculo({ ...base, seller_sku: 'FB-9999', precio: 80000 });
    expect(s[0].peso).toBe('alta');
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx vitest run test/vinculos-senales.test.js`
Expected: FAIL — "Failed to resolve import ../lib/vinculosSenales.js".

- [ ] **Step 3: Implementar**

Crear `lib/vinculosSenales.js`:

```js
/**
 * Señales de "este vínculo WC↔ML puede estar mal matcheado".
 * Funciones puras: no tocan DB ni red, para poder testear la lógica de decisión sola.
 *
 * Tres señales, elegidas por tener poca tasa de falso positivo:
 *   - seller_sku: el SKU cargado en ML no es el que el matcher asignó (la más objetiva)
 *   - atributos:  color/talle de ML no coinciden con los de la variación de WC
 *   - precio:     el precio de ML se desvía demasiado del precio de lista de WC
 *
 * Lo que deliberadamente NO es señal:
 *   - que un SKU tenga varias publicaciones (es intencional: distintas condiciones de venta)
 *   - que los títulos difieran (los de ML están llenos de palabras de marketing; se muestran
 *     lado a lado en el detalle para juicio humano, pero no disparan una alerta)
 */

/**
 * Desvío relativo de precio a partir del cual se sospecha. Es una constante de código a
 * propósito (no una columna de configuración ni una variable de entorno): si en la práctica
 * resulta ruidosa o laxa, se ajusta acá con un cambio de código y su test.
 */
export const UMBRAL_DESVIO_PRECIO = 0.40;

/** Minúsculas, sin acentos, sin espacios de más. Para comparar atributos de ML contra los de WC. */
export function normalizarAtributo(v) {
  if (v == null) return '';
  return String(v)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Color y talle de una variación de WC, desde catalogo_cache.atributos_json. */
export function atributosWc(atributosJson) {
  let arr;
  try {
    arr = JSON.parse(atributosJson || '[]');
  } catch (_) {
    return { color: '', talle: '' };
  }
  if (!Array.isArray(arr)) return { color: '', talle: '' };
  const buscar = (nombres) => {
    const a = arr.find(x => nombres.includes(normalizarAtributo(x?.name)));
    return a?.option ? String(a.option).trim() : '';
  };
  return {
    color: buscar(['color']),
    talle: buscar(['talle', 'tamaño', 'size']),
  };
}

/**
 * ¿Coinciden dos valores de atributo? WC suele ser más específico que ML ("M (55-59cm)" vs
 * "M"), así que se acepta que uno sea prefijo del otro. Si falta cualquiera de los dos, se
 * considera coincidencia: no tenemos evidencia de error y un falso positivo cuesta más que
 * un falso negativo en una lista que el usuario tiene que atender.
 */
function atributoCoincide(ml, wc) {
  const a = normalizarAtributo(ml);
  const b = normalizarAtributo(wc);
  if (!a || !b) return true;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

/**
 * Devuelve las señales disparadas por un vínculo, ordenadas por peso (alta primero).
 * `valor` es el dato concreto que disparó la señal: se persiste al descartar, para que el
 * descarte se invalide solo cuando el dato cambia.
 */
export function senalesDeVinculo(fila) {
  const senales = [];

  // 1) SKU cargado en ML vs SKU mapeado. Solo si ML tiene el dato.
  const skuMl = normalizarAtributo(fila.seller_sku);
  const skuMapeado = normalizarAtributo(fila.sku);
  if (skuMl && skuMapeado && skuMl !== skuMapeado) {
    senales.push({
      senal: 'seller_sku',
      peso: 'alta',
      detalle: `En ML el SKU cargado es "${fila.seller_sku}" pero está mapeada a "${fila.sku}"`,
      valor: String(fila.seller_sku),
    });
  }

  // 2) Color/talle de ML vs atributos de la variación de WC.
  const wc = atributosWc(fila.atributos_json);
  const colorOk = atributoCoincide(fila.color, wc.color);
  const talleOk = atributoCoincide(fila.talle, wc.talle);
  if (!colorOk || !talleOk) {
    const partes = [];
    if (!colorOk) partes.push(`color ML "${fila.color}" vs web "${wc.color}"`);
    if (!talleOk) partes.push(`talle ML "${fila.talle}" vs web "${wc.talle}"`);
    senales.push({
      senal: 'atributos',
      peso: 'alta',
      detalle: `No coinciden: ${partes.join(' · ')}`,
      valor: `${normalizarAtributo(fila.color)}|${normalizarAtributo(fila.talle)}`,
    });
  }

  // 3) Desvío de precio. Sin dato de un lado no se opina (evita falso positivo).
  const precioMl = Number(fila.precio);
  const precioWc = Number(fila.precio_wc);
  if (precioMl > 0 && precioWc > 0) {
    const desvio = Math.abs(precioMl - precioWc) / precioWc;
    if (desvio > UMBRAL_DESVIO_PRECIO) {
      senales.push({
        senal: 'precio',
        peso: 'media',
        detalle: `Precio ML $${Math.round(precioMl).toLocaleString('es-AR')} vs lista web $${Math.round(precioWc).toLocaleString('es-AR')} (${Math.round(desvio * 100)}% de desvío)`,
        valor: String(Math.round(precioMl)),
      });
    }
  }

  const orden = { alta: 0, media: 1 };
  return senales.sort((a, b) => orden[a.peso] - orden[b.peso]);
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `npx vitest run test/vinculos-senales.test.js`
Expected: PASS, los 15 casos.

- [ ] **Step 5: Commit**

```bash
git add lib/vinculosSenales.js test/vinculos-senales.test.js
git commit -m "Módulo puro de señales de vínculo sospechoso WC↔ML"
```

---

### Task 4: Reactivación automática

**Files:**
- Modify: `routes/sync.js` (agregar `reactivarAutomatico` después de `reactivarItems`, que termina cerca de la línea 992)
- Modify: `server.js:176` (agregar un `cron.schedule` dentro del bloque `else` de `DISABLE_CRONS`)
- Test: `test/reactivar-automatico.test.js`

**Interfaces:**
- Consumes: `getReactivablesRows(db, itemIds)`, `reactivarItems(db, mlCfg, itemIds)` (ambas ya existen y se exportan desde `routes/sync.js`), tabla `ml_reactivacion_frenada` (Task 1).
- Produces: `export async function reactivarAutomatico(db, cfg): Promise<{ omitido: boolean, reactivadas?: number, frenadas?: number }>`.

**Cómo distinguir "frenada por precio" de "ML no respondió":** `reactivarItems` devuelve por publicación `{ ok: false, bloqueado: true, error, clave, neto, precio_web, deficitPct }`. El discriminador exacto es **`deficitPct != null`**: solo el bloqueo por neto bajo calcula un déficit. Los bloqueos por ML caído (`'No se pudo consultar el precio en ML — reintentá'`, `'No se pudo calcular la comisión en ML — reintentá'`) traen `deficitPct: null` y **no** se registran como frenada — se reintentan solos en el próximo ciclo. Confundirlos ensuciaría la lista de frenadas con problemas que no son de precio y que el usuario no puede resolver.

- [ ] **Step 1: Escribir el test que falla**

Crear `test/reactivar-automatico.test.js`:

```js
/**
 * reactivarAutomatico: el cron que reactiva solo las publicaciones pausadas por
 * out_of_stock que recuperaron stock, con guarda de precio.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';

vi.mock('../lib/mlClient.js', () => ({
  mlFetch: vi.fn(),
  bootstrapToken: vi.fn(),
  getAccessToken: vi.fn(),
}));
vi.mock('../routes/woo.js', () => ({ wooFetch: vi.fn() }));

import { mlFetch } from '../lib/mlClient.js';
import { reactivarAutomatico } from '../routes/sync.js';

const TEST_DB = './test/tmp-reactivar-auto.sqlite';
const CFG = { ml: { clientId: 'cid', clientSecret: 'cs', userId: '99999' }, woo: { url: 'x', ck: 'c', cs: 's' } };

let db;

/** Siembra una publicación pausada por out_of_stock, mapeada, con stock web disponible. */
function sembrarReactivable({ clave = 'MLA1|', itemId = 'MLA1', sku = 'FB-1', stockWc = 3, precioWc = 300000 } = {}) {
  db.prepare(`INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, stock, precio, actualizado_en)
    VALUES (?, ?, ?, 'simple', ?, ?, '2026-07-30T00:00:00Z')`).run(Math.floor(Math.random() * 1e6), 'Producto ' + sku, sku, stockWc, precioWc);
  db.prepare(`INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en)
    VALUES (?, ?, ?, 'asignar', '2026-07-30T00:00:00Z')`).run(clave, sku, 'Producto ' + sku);
  db.prepare(`INSERT INTO ml_publicaciones_cache (clave, item_id, variation_id, titulo, status, sub_status, es_variante, actualizado_en)
    VALUES (?, ?, '', ?, 'paused', 'out_of_stock', 0, '2026-07-30T00:00:00Z')`).run(clave, itemId, 'Pub ' + sku);
}

beforeEach(() => {
  fs.rmSync(TEST_DB, { force: true });
  db = openDb(TEST_DB);
  mlFetch.mockReset();
});
afterEach(() => { db.close(); fs.rmSync(TEST_DB, { force: true }); });

describe('reactivarAutomatico', () => {
  it('reactiva la publicación cuando el neto pasa el chequeo', async () => {
    sembrarReactivable({ precioWc: 300000 });
    mlFetch.mockImplementation(async (_db, _cfg, metodo, path) => {
      if (metodo === 'get' && path.startsWith('/items/MLA1?')) {
        return { status: 200, data: { id: 'MLA1', status: 'paused', sub_status: ['out_of_stock'], price: 400000, category_id: 'MLA1234', listing_type_id: 'gold_special', shipping: { free_shipping: false } } };
      }
      if (metodo === 'get' && path.includes('sale_fee')) return { status: 200, data: { sale_fee_amount: 40000 } };
      return { status: 200, data: {} };
    });

    const r = await reactivarAutomatico(db, CFG);
    expect(r.reactivadas).toBe(1);
    expect(db.prepare("SELECT status FROM ml_publicaciones_cache WHERE clave='MLA1|'").get().status).toBe('active');
    expect(db.prepare('SELECT COUNT(*) n FROM ml_reactivacion_frenada').get().n).toBe(0);
  });

  it('NO reactiva y registra la frenada cuando el neto queda por debajo del precio de contado', async () => {
    sembrarReactivable({ precioWc: 900000 });
    mlFetch.mockImplementation(async (_db, _cfg, metodo, path) => {
      if (metodo === 'get' && path.startsWith('/items/MLA1?')) {
        return { status: 200, data: { id: 'MLA1', status: 'paused', sub_status: ['out_of_stock'], price: 200000, category_id: 'MLA1234', listing_type_id: 'gold_special', shipping: { free_shipping: false } } };
      }
      if (metodo === 'get' && path.includes('sale_fee')) return { status: 200, data: { sale_fee_amount: 30000 } };
      return { status: 200, data: {} };
    });

    const r = await reactivarAutomatico(db, CFG);
    expect(r.reactivadas).toBe(0);
    expect(r.frenadas).toBe(1);
    const f = db.prepare('SELECT * FROM ml_reactivacion_frenada').get();
    expect(f.clave).toBe('MLA1|');
    expect(f.deficit_pct).toBeGreaterThan(0);
    // No se activó en ML.
    expect(db.prepare("SELECT status FROM ml_publicaciones_cache WHERE clave='MLA1|'").get().status).toBe('paused');
  });

  it('fail-closed: si ML no responde, no reactiva NI registra frenada', async () => {
    sembrarReactivable();
    mlFetch.mockResolvedValue({ status: 500, data: null });

    const r = await reactivarAutomatico(db, CFG);
    expect(r.reactivadas).toBe(0);
    expect(r.frenadas).toBe(0);
    expect(db.prepare('SELECT COUNT(*) n FROM ml_reactivacion_frenada').get().n).toBe(0);
  });

  it('borra la frenada cuando en un ciclo posterior el precio pasa el chequeo', async () => {
    sembrarReactivable({ precioWc: 300000 });
    db.prepare(`INSERT INTO ml_reactivacion_frenada (clave, sku, motivo, neto, precio_contado, deficit_pct, detectado_en)
      VALUES ('MLA1|', 'FB-1', 'viejo', 1, 2, 0.5, '2026-07-29T00:00:00Z')`).run();
    mlFetch.mockImplementation(async (_db, _cfg, metodo, path) => {
      if (metodo === 'get' && path.startsWith('/items/MLA1?')) {
        return { status: 200, data: { id: 'MLA1', status: 'paused', sub_status: ['out_of_stock'], price: 400000, category_id: 'MLA1234', listing_type_id: 'gold_special', shipping: { free_shipping: false } } };
      }
      if (metodo === 'get' && path.includes('sale_fee')) return { status: 200, data: { sale_fee_amount: 40000 } };
      return { status: 200, data: {} };
    });

    await reactivarAutomatico(db, CFG);
    expect(db.prepare('SELECT COUNT(*) n FROM ml_reactivacion_frenada').get().n).toBe(0);
  });

  it('no hace nada si no hay reactivables', async () => {
    const r = await reactivarAutomatico(db, CFG);
    expect(r.reactivadas).toBe(0);
    expect(mlFetch).not.toHaveBeenCalled();
  });
});
```

> Si al correr el test los importes exactos no producen el veredicto esperado (`veredictoNeto` compara el neto contra el precio de **contado**, que es `precio_lista × 2/3`, con tolerancia de 5% para abajo), ajustar los números del mock hasta que un caso dé `ok` y el otro `bajo` — verificando el cálculo real con `veredictoNeto` en un scratch, no adivinando. Lo que el test fija es el **comportamiento** (reactiva / frena / fail-closed), no los importes.

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx vitest run test/reactivar-automatico.test.js`
Expected: FAIL — `reactivarAutomatico is not a function` (no está exportada).

- [ ] **Step 3: Implementar**

En `routes/sync.js`, después del cierre de `reactivarItems` (antes del comentario `// ─── limpieza masiva de variaciones muertas ───`):

```js
/**
 * Reactivación AUTOMÁTICA (cron): reactiva sola toda publicación pausada por out_of_stock
 * que recuperó stock y cuyo neto de ML pasa el chequeo contra el precio de contado.
 *
 * Las que NO pasan el chequeo de precio quedan pausadas y se registran en
 * ml_reactivacion_frenada para que el usuario las vea y corrija el precio en ML. La tabla se
 * limpia sola: si en un ciclo posterior el precio pasa, se reactiva y se borra la fila.
 *
 * FAIL-CLOSED: un bloqueo por ML caído (no se pudo consultar el precio o la comisión) NO se
 * registra como frenada — no es un problema de precio y el usuario no puede hacer nada con
 * él. Se reintenta solo en el próximo ciclo. El discriminador es deficitPct != null: solo el
 * bloqueo por neto bajo calcula un déficit.
 *
 * Comparte el candado _reactivarEnCurso con la reactivación manual: nunca corren a la vez
 * (se pisarían contra ML y competirían por el rate limit).
 */
export async function reactivarAutomatico(db, cfg) {
  if (!mlCfgOk(cfg)) return { omitido: true };
  if (_reactivarEnCurso) return { omitido: true };
  _reactivarEnCurso = true;
  try {
    const rows = getReactivablesRows(db);
    const itemIds = [...new Set(rows.map(r => r.item_id))];
    if (itemIds.length === 0) return { omitido: false, reactivadas: 0, frenadas: 0 };

    const { resultados } = await reactivarItems(db, cfg.ml, itemIds);

    const guardarFrenada = db.prepare(`
      INSERT INTO ml_reactivacion_frenada (clave, sku, motivo, neto, precio_contado, deficit_pct, detectado_en)
      VALUES (@clave, @sku, @motivo, @neto, @precio_contado, @deficit_pct, @detectado_en)
      ON CONFLICT(clave) DO UPDATE SET
        motivo=excluded.motivo, neto=excluded.neto, precio_contado=excluded.precio_contado,
        deficit_pct=excluded.deficit_pct, detectado_en=excluded.detectado_en
    `);
    const borrarFrenada = db.prepare('DELETE FROM ml_reactivacion_frenada WHERE clave = ?');
    const skuDeClave = db.prepare('SELECT sku FROM sku_matcher_decisiones WHERE clave = ?');

    let reactivadas = 0;
    let frenadas = 0;
    const ts = now();

    for (const r of resultados) {
      if (r.ok) {
        reactivadas++;
        // Reactivada: si venía frenada por precio, ya no lo está.
        for (const v of rows.filter(x => x.item_id === r.item_id)) borrarFrenada.run(v.clave);
        continue;
      }
      // Solo el bloqueo por neto bajo trae deficitPct. Los demás (ML caído, sin precio web)
      // no son frenadas de precio: se reintentan solos, sin ensuciar la lista.
      if (r.bloqueado && r.deficitPct != null && r.clave) {
        frenadas++;
        guardarFrenada.run({
          clave: r.clave,
          sku: skuDeClave.get(r.clave)?.sku ?? null,
          motivo: r.error ?? 'El neto de ML queda por debajo del precio web',
          neto: r.neto ?? null,
          precio_contado: r.precio_web ?? null,
          deficit_pct: r.deficitPct,
          detectado_en: ts,
        });
      }
    }

    return { omitido: false, reactivadas, frenadas };
  } finally {
    _reactivarEnCurso = false;
  }
}
```

En `server.js`, dentro del bloque `else` de `DISABLE_CRONS`, después del cron de `procesarCancelacionesMl`:

```js
      // Reactivación automática de pausadas por falta de stock que ya recuperaron stock.
      // Las que no pasan el chequeo de precio quedan registradas como frenadas (badge en el home).
      cron.schedule('*/10 * * * *', () => {
        reactivarAutomatico(app._db, syncCfg)
          .catch(err => console.error('reactivación automática error:', err.message));
      });
```

Y agregar `reactivarAutomatico` al import de `./routes/sync.js` en `server.js:19`.

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `npx vitest run test/reactivar-automatico.test.js`
Expected: PASS los 5 casos.

Después: `npx vitest run` — la suite entera tiene que seguir verde (hay tests de caracterización sobre `routes/sync.js` que no se deben romper).

- [ ] **Step 5: Commit**

```bash
git add routes/sync.js server.js test/reactivar-automatico.test.js
git commit -m "Reactivación automática de pausadas con guarda de precio y registro de frenadas"
```

---

### Task 5: Endpoints de frenadas

**Files:**
- Modify: `routes/sync.js` (dentro de `syncRouter`, cerca del endpoint `/reactivar` de la línea ~1439)
- Modify: `routes/sync.js:1271-1390` (el handler de `/dashboard`, para sumar los contadores)
- Test: `test/vinculos-route.test.js`

**Interfaces:**
- Consumes: tabla `ml_reactivacion_frenada`, `reactivarItems`.
- Produces:
  - `GET /api/sync/frenadas` → `{ ok, data: [{ clave, sku, item_id, titulo, thumbnail, permalink, motivo, neto, precio_contado, deficit_pct, detectado_en }] }`
  - `POST /api/sync/frenadas/forzar` con body `{ itemIds: string[] }` → reactiva igual (override explícito), reutilizando `reactivarItems`, y borra las frenadas de las que salieron OK.
  - `GET /api/sync/dashboard` suma `frenadas` (number) y `vinculos_sospechosos` (number) al JSON que ya devuelve.

> El override **no** saltea `chequearNetoReactivar`: `reactivarItems` lo aplica siempre. Forzar sirve para el caso real —el usuario corrigió el precio en ML y no quiere esperar 10 minutos al próximo ciclo—, no para vender a pérdida. Si el precio sigue mal, la publicación vuelve a quedar frenada y la UI muestra el motivo. Esto es deliberado: un botón que saltee la guarda convierte el fail-closed en decorativo.

- [ ] **Step 1: Escribir el test que falla**

Crear `test/vinculos-route.test.js` con el setup de Express que usan los otros tests de rutas (mirar `test/cobertura-route.test.js` y copiar su patrón de montaje de router y de autenticación mockeada), y este primer caso:

```js
it('GET /api/sync/frenadas devuelve las frenadas con datos de la publicación', async () => {
  db.prepare(`INSERT INTO ml_publicaciones_cache (clave, item_id, variation_id, titulo, status, sub_status, es_variante, thumbnail, permalink, actualizado_en)
    VALUES ('MLA1|', 'MLA1', '', 'Bici Sava Deck', 'paused', 'out_of_stock', 0, 'http://img', 'http://ml', '2026-07-30T00:00:00Z')`).run();
  db.prepare(`INSERT INTO ml_reactivacion_frenada (clave, sku, motivo, neto, precio_contado, deficit_pct, detectado_en)
    VALUES ('MLA1|', 'FB-1', 'El neto de ML queda por debajo del precio web', 120000, 200000, 0.4, '2026-07-30T10:00:00Z')`).run();

  const res = await request(app).get('/api/sync/frenadas');
  expect(res.status).toBe(200);
  expect(res.body.data).toHaveLength(1);
  expect(res.body.data[0]).toMatchObject({ clave: 'MLA1|', sku: 'FB-1', titulo: 'Bici Sava Deck', deficit_pct: 0.4 });
});

it('GET /api/sync/dashboard incluye el contador de frenadas', async () => {
  db.prepare(`INSERT INTO ml_reactivacion_frenada (clave, sku, motivo, neto, precio_contado, deficit_pct, detectado_en)
    VALUES ('MLA9|', 'FB-9', 'x', 1, 2, 0.5, '2026-07-30T10:00:00Z')`).run();
  const res = await request(app).get('/api/sync/dashboard');
  expect(res.body.frenadas).toBe(1);
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx vitest run test/vinculos-route.test.js`
Expected: FAIL — 404 en `/api/sync/frenadas`.

- [ ] **Step 3: Implementar**

En `syncRouter`, junto al endpoint `/reactivar`:

```js
  // Publicaciones que la reactivación automática frenó por precio (neto por debajo del contado).
  router.get('/frenadas', (req, res) => {
    const data = db.prepare(`
      SELECT f.clave, f.sku, f.motivo, f.neto, f.precio_contado, f.deficit_pct, f.detectado_en,
             p.item_id, p.titulo, p.thumbnail, p.permalink, p.variations_texto
      FROM ml_reactivacion_frenada f
      LEFT JOIN ml_publicaciones_cache p ON p.clave = f.clave
      ORDER BY f.deficit_pct DESC, f.detectado_en DESC
    `).all();
    res.json({ ok: true, data });
  });

  // Override: reintentar la reactivación de publicaciones frenadas (típicamente después de
  // corregir el precio en ML, sin esperar al próximo ciclo del cron). NO saltea el chequeo de
  // neto — reactivarItems lo aplica siempre. Si el precio sigue mal, vuelve a quedar frenada.
  router.post('/frenadas/forzar', async (req, res) => {
    if (!mlCfgOk(cfg)) return res.status(400).json({ ok: false, error: 'MercadoLibre no configurado' });
    const itemIds = Array.isArray(req.body?.itemIds) ? req.body.itemIds.map(String).filter(Boolean) : [];
    if (itemIds.length === 0) return res.status(400).json({ ok: false, error: 'itemIds requerido' });

    const { resultados } = await reactivarItems(db, cfg.ml, itemIds);
    const borrar = db.prepare('DELETE FROM ml_reactivacion_frenada WHERE clave IN (SELECT clave FROM ml_publicaciones_cache WHERE item_id = ?)');
    for (const r of resultados) {
      if (r.ok) borrar.run(r.item_id);
    }
    res.json({ ok: true, resultados });
  });
```

En el handler de `/dashboard`, antes del `res.json` final:

```js
    const frenadas = db.prepare('SELECT COUNT(*) n FROM ml_reactivacion_frenada').get().n;
```

y en el objeto que devuelve, junto a `stock`, `atencion`, etc.:

```js
      frenadas,
```

El contador de vínculos sospechosos se agrega en la Task 6, junto con la función que lo calcula — esta tarea no lo toca.

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `npx vitest run test/vinculos-route.test.js`
Expected: PASS los 2 casos.

- [ ] **Step 5: Commit**

```bash
git add routes/sync.js test/vinculos-route.test.js
git commit -m "Endpoints de publicaciones frenadas por precio + contador en el dashboard"
```

---

### Task 6: Endpoints de vínculos y sospechosos

**Files:**
- Modify: `routes/sync.js` (nuevos endpoints en `syncRouter` + la función `contarVinculosSospechosos`)
- Test: `test/vinculos-route.test.js` (agregar casos)

**Interfaces:**
- Consumes: `senalesDeVinculo`, `atributosWc` de `lib/vinculosSenales.js`; `precioContado` de `lib/mlPrecios.js`; tablas `ml_vinculos_revisados`, `ml_publicaciones_cache`, `catalogo_cache`, `sku_matcher_decisiones`.
- Produces:
  - `function filasDeVinculos(db, { sku = null })` → filas crudas listas para `senalesDeVinculo`
  - `function contarVinculosSospechosos(db): number`
  - `GET /api/sync/vinculos/:sku` → `{ ok, producto: {...}, publicaciones: [...] }`
  - `GET /api/sync/vinculos-sospechosos` → `{ ok, data: [...] }`
  - `POST /api/sync/vinculos/revisado` body `{ clave, senal, valor }` → marca revisado OK
  - `POST /api/sync/vinculos/reasignar` body `{ clave, sku }` → reasigna el vínculo

> **Reasignar** escribe en `sku_matcher_decisiones` con exactamente el mismo statement que usa el matcher (`routes/matcher.js:404`): `INSERT OR REPLACE INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en) VALUES (?, ?, ?, ?, ?)` con `accion='asignar'`. No inventar un camino de escritura paralelo: si el matcher cambia su semántica, un segundo escritor divergiría en silencio.
>
> Al reasignar o desvincular hay que **borrar los descartes de esa clave** (`DELETE FROM ml_vinculos_revisados WHERE clave = ?`): los descartes valían para el vínculo viejo, no para el nuevo.

- [ ] **Step 1: Escribir los tests que fallan**

Agregar a `test/vinculos-route.test.js`:

```js
/** Siembra un producto WC + una publicación ML mapeada. */
function sembrarVinculo({ clave = 'MLA1|10', itemId = 'MLA1', sku = 'FB-6411', sellerSku = 'FB-6411',
  color = 'Negro/Rojo', talle = 'M', precioMl = 218700, precioWc = 218700 } = {}) {
  db.prepare(`INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, stock, precio, atributos_json, actualizado_en)
    VALUES (?, ?, ?, 'variation', 5, ?, ?, '2026-07-30T00:00:00Z')`)
    .run(Math.floor(Math.random() * 1e6), 'Casco Giro Syntax Matte — Negro/Rojo / M (55-59cm)', sku, precioWc,
         '[{"name":"Color","option":"Negro/Rojo"},{"name":"Talle","option":"M (55-59cm)"}]');
  db.prepare(`INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en)
    VALUES (?, ?, 'Casco Giro', 'asignar', '2026-07-30T00:00:00Z')`).run(clave, sku);
  db.prepare(`INSERT INTO ml_publicaciones_cache (clave, item_id, variation_id, titulo, status, es_variante, color, talle, seller_sku, precio, available_quantity, actualizado_en, precio_actualizado_en)
    VALUES (?, ?, '10', 'Casco Giro Syntax', 'active', 1, ?, ?, ?, ?, 3, '2026-07-30T00:00:00Z', '2026-07-30T00:00:00Z')`)
    .run(clave, itemId, color, talle, sellerSku, precioMl);
}

it('GET /api/sync/vinculos/:sku devuelve el producto y sus publicaciones', async () => {
  sembrarVinculo();
  const res = await request(app).get('/api/sync/vinculos/FB-6411');
  expect(res.status).toBe(200);
  expect(res.body.producto.sku).toBe('FB-6411');
  expect(res.body.publicaciones).toHaveLength(1);
  expect(res.body.publicaciones[0].senales).toEqual([]);
});

it('varias publicaciones para un mismo SKU no generan sospecha (multi-publicación es intencional)', async () => {
  sembrarVinculo({ clave: 'MLA1|10', itemId: 'MLA1' });
  db.prepare(`INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en)
    VALUES ('MLA2|', 'FB-6411', 'Casco Giro', 'asignar', '2026-07-30T00:00:00Z')`).run();
  db.prepare(`INSERT INTO ml_publicaciones_cache (clave, item_id, variation_id, titulo, status, es_variante, seller_sku, precio, actualizado_en)
    VALUES ('MLA2|', 'MLA2', '', 'Casco Giro Syntax', 'active', 0, 'FB-6411', 218700, '2026-07-30T00:00:00Z')`).run();

  const res = await request(app).get('/api/sync/vinculos/FB-6411');
  expect(res.body.publicaciones).toHaveLength(2);
  expect(res.body.publicaciones.every(p => p.senales.length === 0)).toBe(true);
  const sosp = await request(app).get('/api/sync/vinculos-sospechosos');
  expect(sosp.body.data).toHaveLength(0);
});

it('GET /api/sync/vinculos-sospechosos lista los que tienen señales', async () => {
  sembrarVinculo({ sellerSku: 'FB-9999' });
  const res = await request(app).get('/api/sync/vinculos-sospechosos');
  expect(res.body.data).toHaveLength(1);
  expect(res.body.data[0].senales.map(s => s.senal)).toContain('seller_sku');
});

it('marcar revisado OK saca al sospechoso de la lista', async () => {
  sembrarVinculo({ sellerSku: 'FB-9999' });
  await request(app).post('/api/sync/vinculos/revisado')
    .send({ clave: 'MLA1|10', senal: 'seller_sku', valor: 'FB-9999' });
  const res = await request(app).get('/api/sync/vinculos-sospechosos');
  expect(res.body.data).toHaveLength(0);
});

it('el sospechoso REAPARECE si el valor descartado cambia', async () => {
  sembrarVinculo({ sellerSku: 'FB-9999' });
  await request(app).post('/api/sync/vinculos/revisado')
    .send({ clave: 'MLA1|10', senal: 'seller_sku', valor: 'FB-9999' });
  // El SKU en ML cambia a otro valor equivocado distinto: el descarte ya no aplica.
  db.prepare("UPDATE ml_publicaciones_cache SET seller_sku='FB-7777' WHERE clave='MLA1|10'").run();
  const res = await request(app).get('/api/sync/vinculos-sospechosos');
  expect(res.body.data).toHaveLength(1);
});

it('reasignar cambia el SKU del vínculo y borra los descartes viejos', async () => {
  sembrarVinculo({ sellerSku: 'FB-9999' });
  db.prepare(`INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, stock, precio, actualizado_en)
    VALUES (777777, 'Otro producto', 'FB-9999', 'simple', 2, 218700, '2026-07-30T00:00:00Z')`).run();
  await request(app).post('/api/sync/vinculos/revisado')
    .send({ clave: 'MLA1|10', senal: 'seller_sku', valor: 'FB-9999' });

  const res = await request(app).post('/api/sync/vinculos/reasignar').send({ clave: 'MLA1|10', sku: 'FB-9999' });
  expect(res.status).toBe(200);
  expect(db.prepare("SELECT sku FROM sku_matcher_decisiones WHERE clave='MLA1|10'").get().sku).toBe('FB-9999');
  expect(db.prepare("SELECT COUNT(*) n FROM ml_vinculos_revisados WHERE clave='MLA1|10'").get().n).toBe(0);
});
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `npx vitest run test/vinculos-route.test.js`
Expected: FAIL — 404 en los endpoints nuevos.

- [ ] **Step 3: Implementar**

En `routes/sync.js`, agregar el import arriba:

```js
import { senalesDeVinculo } from '../lib/vinculosSenales.js';
```

y `precioContado` al import existente de `../lib/mlPrecios.js`.

Antes de `syncRouter`, las dos funciones de datos:

```js
/**
 * Filas crudas de vínculos WC↔ML (publicación mapeada + su producto de WC), listas para
 * pasarle a senalesDeVinculo. Si se pasa `sku`, se acota a ese producto.
 *
 * El dedup por SKU es el mismo criterio que COMPUTED_STOCK_CTE: si un SKU está cargado en
 * más de un producto de WC, se toma uno solo (el de menor stock) para no multiplicar filas.
 */
function filasDeVinculos(db, { sku = null } = {}) {
  const params = [];
  let filtro = '';
  if (sku) { filtro = 'AND d.sku = ?'; params.push(sku); }
  return db.prepare(`
    WITH catalogo_dedup AS (
      SELECT sku, nombre, stock, precio, atributos_json, img,
        ROW_NUMBER() OVER (PARTITION BY sku ORDER BY stock ASC, id_woo ASC) AS rn
      FROM catalogo_cache
      WHERE sku IS NOT NULL AND sku <> ''
    )
    SELECT d.clave, d.sku,
           p.item_id, p.variation_id, p.titulo, p.status, p.sub_status, p.color, p.talle,
           p.seller_sku, p.variations_texto, p.thumbnail, p.permalink, p.precio,
           p.available_quantity, p.precio_actualizado_en,
           c.nombre AS wc_nombre, c.stock AS stock_wc, c.precio AS precio_wc,
           c.atributos_json, c.img AS wc_img,
           e.cantidad_ml
    FROM sku_matcher_decisiones d
    JOIN catalogo_dedup c ON c.sku = d.sku AND c.rn = 1
    JOIN ml_publicaciones_cache p ON p.clave = d.clave
    LEFT JOIN ml_stock_estado e ON e.clave = d.clave
    WHERE d.accion IN ('asignar','confirmar') AND d.sku IS NOT NULL AND d.sku <> '' ${filtro}
    ORDER BY c.nombre, p.titulo, d.clave
  `).all(...params);
}

/**
 * Señales vigentes de una fila: las que dispara senalesDeVinculo menos las que el usuario
 * marcó como revisadas CON EL MISMO VALOR. Si el valor cambió, el descarte no aplica y la
 * señal vuelve a aparecer — descartar significa "esta discrepancia concreta está bien".
 */
function senalesVigentes(fila, descartesPorClave) {
  const descartes = descartesPorClave.get(fila.clave) || new Map();
  return senalesDeVinculo(fila).filter(s => descartes.get(s.senal) !== s.valor);
}

/** Mapa clave → Map(senal → valor_revisado), para no consultar por fila. */
function cargarDescartes(db) {
  const m = new Map();
  for (const r of db.prepare('SELECT clave, senal, valor_revisado FROM ml_vinculos_revisados').all()) {
    if (!m.has(r.clave)) m.set(r.clave, new Map());
    m.get(r.clave).set(r.senal, r.valor_revisado);
  }
  return m;
}

/** Cantidad de vínculos con al menos una señal vigente (para el chip del home). */
function contarVinculosSospechosos(db) {
  const descartes = cargarDescartes(db);
  let n = 0;
  for (const fila of filasDeVinculos(db)) {
    if (senalesVigentes(fila, descartes).length > 0) n++;
  }
  return n;
}
```

Y dentro de `syncRouter`:

```js
  // Detalle de un producto de WC y TODAS las publicaciones de ML mapeadas a su SKU.
  router.get('/vinculos/:sku', (req, res) => {
    const sku = String(req.params.sku || '').trim();
    if (!sku) return res.status(400).json({ ok: false, error: 'sku requerido' });

    const filas = filasDeVinculos(db, { sku });
    const descartes = cargarDescartes(db);
    const prod = db.prepare(`
      SELECT sku, nombre, stock, precio, img FROM catalogo_cache
      WHERE sku = ? AND sku <> '' ORDER BY stock ASC, id_woo ASC LIMIT 1
    `).get(sku);
    if (!prod) return res.status(404).json({ ok: false, error: 'SKU no encontrado en el catálogo' });

    const publicaciones = filas.map(f => ({
      clave: f.clave, item_id: f.item_id, variation_id: f.variation_id,
      titulo: f.titulo, status: f.status, sub_status: f.sub_status,
      color: f.color, talle: f.talle, variations_texto: f.variations_texto,
      seller_sku: f.seller_sku, thumbnail: f.thumbnail, permalink: f.permalink,
      precio_ml: f.precio, precio_actualizado_en: f.precio_actualizado_en,
      stock_ml: f.available_quantity, stock_sincronizado: f.cantidad_ml,
      senales: senalesVigentes(f, descartes),
    }));

    res.json({
      ok: true,
      producto: {
        sku: prod.sku, nombre: prod.nombre, stock: prod.stock, img: prod.img,
        precio_lista: prod.precio,
        precio_contado: prod.precio > 0 ? precioContado(prod.precio) : null,
      },
      publicaciones,
    });
  });

  // Listado de vínculos con señales vigentes, ordenado por severidad (alta primero).
  router.get('/vinculos-sospechosos', (req, res) => {
    const descartes = cargarDescartes(db);
    const data = [];
    for (const f of filasDeVinculos(db)) {
      const senales = senalesVigentes(f, descartes);
      if (senales.length === 0) continue;
      data.push({
        clave: f.clave, sku: f.sku, item_id: f.item_id,
        titulo: f.titulo, wc_nombre: f.wc_nombre, thumbnail: f.thumbnail, permalink: f.permalink,
        precio_ml: f.precio, precio_wc: f.precio_wc, senales,
      });
    }
    data.sort((a, b) => {
      const peor = (x) => (x.senales.some(s => s.peso === 'alta') ? 0 : 1);
      return peor(a) - peor(b) || b.senales.length - a.senales.length;
    });
    res.json({ ok: true, data });
  });

  // Marcar una señal como revisada y correcta. Guarda el VALOR: si el dato cambia, reaparece.
  router.post('/vinculos/revisado', (req, res) => {
    const { clave, senal, valor } = req.body || {};
    if (!clave || !senal) return res.status(400).json({ ok: false, error: 'clave y senal requeridas' });
    db.prepare(`
      INSERT INTO ml_vinculos_revisados (clave, senal, valor_revisado, revisado_por, revisado_en)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(clave, senal) DO UPDATE SET
        valor_revisado=excluded.valor_revisado, revisado_por=excluded.revisado_por, revisado_en=excluded.revisado_en
    `).run(clave, senal, valor == null ? null : String(valor), req.user?.usuario ?? null, now());
    res.json({ ok: true });
  });

  // Reasignar el vínculo a otro SKU. Mismo statement que usa el matcher para sus decisiones.
  router.post('/vinculos/reasignar', (req, res) => {
    const { clave, sku } = req.body || {};
    if (!clave || !sku) return res.status(400).json({ ok: false, error: 'clave y sku requeridos' });
    const prod = db.prepare("SELECT nombre FROM catalogo_cache WHERE sku = ? AND sku <> '' LIMIT 1").get(sku);
    if (!prod) return res.status(400).json({ ok: false, error: 'El SKU no existe en el catálogo' });

    db.prepare('INSERT OR REPLACE INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en) VALUES (?, ?, ?, ?, ?)')
      .run(clave, sku, prod.nombre, 'asignar', now());
    // Los descartes valían para el vínculo anterior, no para el nuevo.
    db.prepare('DELETE FROM ml_vinculos_revisados WHERE clave = ?').run(clave);
    logSync(db, { direccion: 'wc_ml', clave, sku, estado: 'remapeo_requerido', error: 'reasignada manualmente desde Vínculos' });
    res.json({ ok: true });
  });
```

Además, en el endpoint `/desvincular` existente (línea ~1554), agregar el borrado de descartes después del `DELETE FROM sku_matcher_decisiones`:

```js
    db.prepare('DELETE FROM ml_vinculos_revisados WHERE clave = ?').run(clave);
```

Y en `/dashboard`, junto al `frenadas` que agregó la Task 5, sumar `vinculos_sospechosos: contarVinculosSospechosos(db),`.

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `npx vitest run test/vinculos-route.test.js`
Expected: PASS los 8 casos (2 de la Task 5 + 6 de esta).

Después: `npx vitest run` — suite completa verde.

- [ ] **Step 5: Commit**

```bash
git add routes/sync.js test/vinculos-route.test.js
git commit -m "Endpoints de vínculos WC↔ML: detalle por producto, sospechosos, revisado OK y reasignar"
```

---

### Task 7: Pantalla `/vinculos/`

**Files:**
- Create: `public/vinculos/index.html`
- Modify: `server.js` (agregar `app.use('/vinculos', express.static(path.join(__dirname, 'public/vinculos')));` junto a los otros `express.static`, siguiendo el patrón de `/cobertura` en `server.js:101`)

**Interfaces:**
- Consumes: `GET /api/sync/vinculos/:sku`, `GET /api/sync/vinculos-sospechosos`, `POST /api/sync/vinculos/revisado`, `POST /api/sync/vinculos/reasignar`, `POST /api/sync/desvincular`, `GET /api/sync/buscar-sku?tipo=all&q=`.
- Produces: la pantalla. No expone nada a otras tareas.

**Requisitos de esta pantalla (no negociables, los verifica el auditor):**
- Usa los tokens de `public/lib/theme.css` — cero colores hardcodeados. Importar también `public/lib/format.js` y `public/lib/api.js` como hacen las otras pantallas (mirar `public/cobertura/index.html` como referencia de estructura, header y manejo de sesión).
- Responsive real: en 375px de ancho nada queda cortado ni oculto. Las tarjetas de publicación pasan a una columna.
- Estados explícitos: cargando, vacío ("no hay vínculos sospechosos"), error con botón de reintentar.
- Accesible: los botones son `<button>` reales, la búsqueda tiene `<label>`, foco visible, contraste AA.

**Estructura:**

1. **Header** con el título "Vínculos ML" y el patrón de sesión de las otras pantallas.
2. **Dos pestañas**: "Buscar producto" y "Sospechosos" (`#sospechosos` como hash para deep-link desde el home).
3. **Pestaña Buscar producto:** input de búsqueda (SKU o nombre) con autocompletado contra `/api/sync/buscar-sku?tipo=all&q=`, igual que hace `public/sync-detalle/index.html:374`. Al elegir un resultado, `GET /api/sync/vinculos/:sku` y se renderiza:
   - Tarjeta del producto WC: imagen, nombre, SKU, stock, precio de lista y **precio de contado** (el que importa para el veredicto).
   - Una tarjeta por publicación con: thumbnail, título ML (y debajo, en menor jerarquía, el nombre de WC para comparación visual lado a lado), variación, estado, stock ML vs web, precio ML con su antigüedad ("precio de hace 2 h", calculada desde `precio_actualizado_en`), y los chips de señal en semáforo (rojo para peso alta, ámbar para media, verde "sin señales" cuando `senales` está vacío).
   - Acciones por publicación: **Ver en ML** (link a `permalink`, `target="_blank" rel="noopener"`), **Desvincular** (con `confirm()`), **Reasignar** (abre el buscador de SKU y postea a `/vinculos/reasignar`), **Revisado OK** por cada señal (postea `{clave, senal, valor}` con el `valor` que vino en la señal).
4. **Pestaña Sospechosos:** carga `/api/sync/vinculos-sospechosos` y lista las filas ordenadas como vienen (el backend ya ordena por severidad). Cada fila muestra título ML vs nombre WC, los chips de señal con su `detalle`, y las mismas acciones. Al pie, un enlace fijo: **"¿Buscás productos sin publicación en ML o publicaciones sin SKU? Eso lo cubre Cobertura →"** apuntando a `/cobertura/`.

**Comportamiento tras una acción:** después de desvincular, reasignar o marcar revisado, recargar solo la vista activa (no toda la página) y mostrar un mensaje de confirmación efímero. Si la llamada falla, mostrar el error real del backend, nunca un "algo salió mal" genérico.

- [ ] **Step 1: Crear la pantalla**

Escribir `public/vinculos/index.html` siguiendo la estructura de arriba y el patrón de `public/cobertura/index.html`. Registrar el `express.static` en `server.js`.

- [ ] **Step 2: Verificar a mano en el navegador**

Levantar con `DISABLE_CRONS=true node server.js` (obligatorio: sin eso, una instancia efímera corre los crons contra la base real y puede duplicar pedidos — ver el incidente del 2026-07-25) y abrir `http://localhost:3001/vinculos/`. Comprobar: búsqueda con autocompletado, render del detalle, pestaña de sospechosos, las tres acciones, y el layout a 375px.

- [ ] **Step 3: Commit**

```bash
git add public/vinculos/index.html server.js
git commit -m "Pantalla de Vínculos ML: detalle por producto y listado de sospechosos"
```

---

### Task 8: Chips en el home

**Files:**
- Modify: `public/home/index.html:826-833` (el array `chips` dentro de `cargarPanelSync`)

**Interfaces:**
- Consumes: `d.frenadas` y `d.vinculos_sospechosos` de `GET /api/sync/dashboard` (Tasks 5 y 6).
- Produces: nada.

- [ ] **Step 1: Agregar los chips**

En el array `chips` de `cargarPanelSync`, después del chip de `d.reactivables`:

```js
        peChip(d.frenadas, 'pausadas frenadas por precio', 'warn', '/herramientas/sync-ml/#frenadas', 'sync-ml'),
        peChip(d.vinculos_sospechosos, 'vínculos sospechosos', 'warn', '/herramientas/vinculos/#sospechosos', 'sync-ml'),
```

`peChip` ya devuelve `null` cuando el número es 0 y el `.filter(Boolean)` posterior los saca, así que los chips desaparecen solos cuando no hay nada — no hace falta lógica extra.

- [ ] **Step 2: Verificar en el navegador**

Con el server levantado (`DISABLE_CRONS=true`), sembrar una frenada y un sospechoso a mano en la base de prueba, recargar el home y confirmar que aparecen los dos chips y que sus links llevan a donde corresponde. Después borrarlos y confirmar que desaparecen.

- [ ] **Step 3: Commit**

```bash
git add public/home/index.html
git commit -m "Home: chips de pausadas frenadas por precio y vínculos sospechosos"
```

---

### Task 9: Verificación final

- [ ] **Step 1: Suite completa**

Run: `npm test`
Expected: todo verde. Ningún test preexistente modificado salvo los dos ajustes explícitamente previstos (el `attributes=` de `test/matcher.test.js` en la Task 2 y las adiciones a `test/db.test.js` en la Task 1).

- [ ] **Step 2: Verificar que no quedaron bases de prueba tiradas**

Run: `git status --short`
Expected: sin archivos `test/tmp-*.sqlite` sin trackear. Si aparecen, es que un test no limpió en su `afterEach` — arreglarlo, no borrarlos a mano.

- [ ] **Step 3: Confirmar el arranque real**

Run: `DISABLE_CRONS=true node server.js` y verificar que arranca sin errores (las sentencias de esquema de la Task 1 corren en cada arranque; un error de SQL ahí rompe el server entero). Cortar con Ctrl-C.

---

## Notas para el pipeline

- Este plan cubre backend (Tasks 1-6) y frontend (Tasks 7-8). La Task 7 requiere pasar antes por `disenador-ux` (flujo de la pantalla nueva) y `disenador-ui` (sistema visual), como indica el CLAUDE.md para cambios normales/grandes.
- Después del código: `revisor` → corrección → `tester` → `probador-e2e` sobre `/vinculos/` y `/sync-ml/#frenadas` → `auditor-despliegue`.
- El deploy a producción lo hace el usuario a mano.
