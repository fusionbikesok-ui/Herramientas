# Vigía de formato de publicaciones — plan de implementación

> **Para agentes ejecutores:** SUB-SKILL REQUERIDA: usá `superpowers:subagent-driven-development`
> (recomendado) o `superpowers:executing-plans` para implementar tarea por tarea. Los pasos usan
> checkbox (`- [ ]`) para seguimiento.

**Goal:** Detectar cuándo una publicación de ML pasa a describir algo distinto de lo que vendemos
(cambia su producto de catálogo, sus unidades por pack o su formato de venta), pausarla y avisar.

**Architecture:** La comparación se engancha en el refresco del cache de publicaciones, que es el
único lugar por donde pasan todas. Se toma un snapshot del cache **antes** de reemplazarlo, se
comparan tres campos, se asientan las diferencias en una tabla nueva, se pausa en ML bajo un
umbral de seguridad y se abre un incidente por el canal que ya manda email y push.

**Tech Stack:** Node/Express (ESM), better-sqlite3, vitest + supertest, migraciones `.sql`
numeradas registradas en `db/index.js`.

**Spec:** `docs/superpowers/specs/2026-09-12-vigia-formato-publicaciones-design.md`

## Global Constraints

- Responder en español; comentarios y mensajes de UI en español.
- Migraciones: archivo numerado en `migrations/`, registrado en `db/index.js` con su clave en
  `_schema_migrations`. El siguiente número libre es **103**.
- El umbral del freno de mano es **5** publicaciones por corrida, configurable por constante
  exportada `UMBRAL_PAUSA_MASIVA`.
- Nunca disparar cuando no hay valor anterior (publicación vista por primera vez).
- El vigía pausa; **nunca** despausa salvo por acción explícita del usuario vía endpoint.
- `npm test` completo lo corre el orquestador, una sola vez, al final y sin nada más corriendo.
  Durante las tareas se corren archivos sueltos.

---

## Estructura de archivos

| Archivo | Responsabilidad |
|---|---|
| `migrations/103_ml_publicacion_cambios.sql` (crear) | Tabla `ml_publicacion_cambios` + columna `catalog_product_id` en `ml_publicaciones_cache`. |
| `db/index.js` (modificar, ~línea 843) | Registrar la migración 103. |
| `lib/modelos/publicacionMl.js` (modificar, `aplanarItemMl`, líneas 84 y 110) | Mapear `catalog_product_id` del item a la fila. |
| `routes/matcher.js` (modificar, líneas 317, 459-479, 511) | Pedir `catalog_product_id` a ML y persistirlo en el upsert. |
| `lib/vigiaFormato.js` (crear) | Lógica pura: comparar snapshot vs. filas nuevas y decidir qué cambió. Sin DOM, sin fetch, sin ML. |
| `routes/matcher.js` (modificar, líneas 340-353) | Tomar el snapshot antes del `DELETE` y registrar los cambios. |
| `lib/vigiaPausado.js` (crear) | Aplicar el freno de mano, pausar en ML y abrir el incidente. |
| `routes/sync.js` (modificar, `getReactivablesRows` línea 1921) | Saltear publicaciones con un cambio sin revisar. |
| `routes/sync.js` (modificar) | `GET /cambios-formato` y `POST /cambios-formato/:id/revisar`. |
| `public/sync-ml/index.html` (modificar) | Bloque "Publicaciones que cambiaron de formato". |
| `test/vigiaFormato.test.js` (crear) | Lógica pura de detección. |
| `test/vigiaPausado.test.js` (crear) | Freno de mano, pausado, incidente. |
| `test/vigia-endpoints.test.js` (crear) | Endpoints + skip del reactivador. |

**Por qué `lib/vigiaFormato.js` separado:** la decisión de "qué cambió" es la parte que, mal
hecha, pausa el catálogo entero. Aislada de ML y de la base se prueba sin mocks, igual que
`lib/conteoLista.js` y `lib/conteoCantidad.js`.

---

### Task 1: Esquema y persistencia de `catalog_product_id`

Hoy el cache guarda `catalogo` (booleano) pero **no** el `catalog_product_id`. Sin ese campo no se
puede detectar el cambio que causó el incidente del GP5000, así que esta tarea es el cimiento.

**Files:**
- Create: `migrations/103_ml_publicacion_cambios.sql`
- Modify: `db/index.js:843` (después del bloque de `preparacion_devoluciones_102`)
- Modify: `lib/modelos/publicacionMl.js:84` y la rama de variaciones (~línea 110)
- Modify: `routes/matcher.js:317`, `routes/matcher.js:459-479`, `routes/matcher.js:511`
- Test: `test/modelos-publicacionMl.test.js` (ya existe, se le agregan casos)

**Interfaces:**
- Consumes: nada.
- Produces: columna `ml_publicaciones_cache.catalog_product_id TEXT`; tabla
  `ml_publicacion_cambios`; `aplanarItemMl(body)` devuelve filas con
  `catalog_product_id: string|null`.

- [ ] **Step 1: Escribir el test que falla**

En `test/modelos-publicacionMl.test.js`, agregar:

```javascript
it('mapea catalog_product_id del item a la fila (simple)', () => {
  const filas = aplanarItemMl({
    id: 'MLA1', title: 'x', status: 'active', attributes: [], variations: [],
    catalog_listing: true, catalog_product_id: 'MLA44441017',
  });
  expect(filas[0].catalog_product_id).toBe('MLA44441017');
});

it('catalog_product_id ausente → null, no undefined', () => {
  const filas = aplanarItemMl({
    id: 'MLA2', title: 'x', status: 'active', attributes: [], variations: [],
    catalog_listing: false,
  });
  expect(filas[0].catalog_product_id).toBeNull();
});

it('denormaliza catalog_product_id en cada variación', () => {
  const filas = aplanarItemMl({
    id: 'MLA3', title: 'x', status: 'active', attributes: [], catalog_listing: true,
    catalog_product_id: 'MLA999',
    variations: [{ id: 1, attribute_combinations: [], attributes: [] },
                 { id: 2, attribute_combinations: [], attributes: [] }],
  });
  expect(filas.map(f => f.catalog_product_id)).toEqual(['MLA999', 'MLA999']);
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx vitest run test/modelos-publicacionMl.test.js -t "catalog_product_id"`
Expected: FAIL — `expected undefined to be 'MLA44441017'`

- [ ] **Step 3: Escribir la migración**

`migrations/103_ml_publicacion_cambios.sql`:

```sql
-- Vigía de formato de publicaciones (2026-09-12).
--
-- El 2026-09-11 la publicación MLA1873586405 (cubierta Continental GP5000, FB-64881) se enganchó
-- sola a un producto de catálogo llamado "... Kit De 2 Unidades" y se vendió al precio de una
-- unidad el mismo día. Nadie la tocó: la cambió la sincronización. Esta tabla guarda cada cambio
-- de formato detectado para poder pausar, avisar y revisar después.
--
-- `catalog_product_id` no se persistía: el cache sólo tenía `catalogo` (booleano), que no cambia
-- cuando una publicación de catálogo salta de un producto a otro. Sin esta columna el incidente
-- que originó todo sería indetectable.
ALTER TABLE ml_publicaciones_cache ADD COLUMN catalog_product_id TEXT;

CREATE TABLE IF NOT EXISTS ml_publicacion_cambios (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  clave          TEXT    NOT NULL,
  item_id        TEXT    NOT NULL,
  sku            TEXT,
  campo          TEXT    NOT NULL,
  valor_anterior TEXT,
  valor_nuevo    TEXT,
  pausada        INTEGER NOT NULL DEFAULT 0,
  pausa_error    TEXT,
  detectado_en   TEXT    NOT NULL,
  revisado_en    TEXT,
  revisado_por   TEXT
);

CREATE INDEX IF NOT EXISTS idx_ml_pub_cambios_sin_revisar
  ON ml_publicacion_cambios(revisado_en, clave);
CREATE INDEX IF NOT EXISTS idx_ml_pub_cambios_clave
  ON ml_publicacion_cambios(clave, id);
```

- [ ] **Step 4: Registrar la migración en `db/index.js`**

Después del bloque `devolucionesMigration` (línea 843), agregar:

```javascript
  const vigiaFormatoMigration = db.prepare("SELECT 1 FROM _schema_migrations WHERE key='ml_publicacion_cambios_103'").get();
  if (!vigiaFormatoMigration) {
    db.transaction(() => {
      // La columna puede existir ya en bases que vienen de producción con un ALTER manual:
      // en ese caso sólo se crea la tabla y se registra la migración.
      const columnas = db.prepare('PRAGMA table_info(ml_publicaciones_cache)').all();
      if (columnas.some((c) => c.name === 'catalog_product_id')) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS ml_publicacion_cambios (
            id INTEGER PRIMARY KEY AUTOINCREMENT, clave TEXT NOT NULL, item_id TEXT NOT NULL,
            sku TEXT, campo TEXT NOT NULL, valor_anterior TEXT, valor_nuevo TEXT,
            pausada INTEGER NOT NULL DEFAULT 0, pausa_error TEXT, detectado_en TEXT NOT NULL,
            revisado_en TEXT, revisado_por TEXT);
          CREATE INDEX IF NOT EXISTS idx_ml_pub_cambios_sin_revisar ON ml_publicacion_cambios(revisado_en, clave);
          CREATE INDEX IF NOT EXISTS idx_ml_pub_cambios_clave ON ml_publicacion_cambios(clave, id);
        `);
      } else {
        db.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', '103_ml_publicacion_cambios.sql'), 'utf8'));
      }
      db.prepare("INSERT INTO _schema_migrations (key) VALUES ('ml_publicacion_cambios_103')").run();
    })();
  }
```

- [ ] **Step 5: Mapear el campo en `aplanarItemMl`**

En `lib/modelos/publicacionMl.js`, junto a `const catalogo = body.catalog_listing ? 1 : 0;`
(línea 84) agregar:

```javascript
  // El id del producto de CATÁLOGO al que está atada la publicación. `catalogo` (booleano) no
  // alcanza: una publicación puede seguir siendo de catálogo y saltar de un producto a otro,
  // que es exactamente lo que pasó con el GP5000 el 2026-09-11.
  const catalogProductId = body.catalog_product_id ?? null;
```

y agregar `catalog_product_id: catalogProductId,` al objeto devuelto en **las dos** ramas (la de
item simple, junto a `user_product_id`, y la del `vars.map(...)`).

- [ ] **Step 6: Pedirle el campo a ML y persistirlo**

En `routes/matcher.js`, en las líneas 317 y 511, agregar `,catalog_product_id` al final de la
lista `attributes=`:

```javascript
      `/items?ids=${chunk.join(',')}&include_attributes=all&attributes=id,title,status,sub_status,seller_custom_field,attributes,variations,secure_thumbnail,thumbnail,permalink,catalog_listing,catalog_product_id,price,available_quantity,user_product_id,channels`,
```

En `prepararUpsertCache` (línea 459), agregar la columna en los tres lugares: la lista de
columnas, la de `VALUES` y el `DO UPDATE SET`:

```javascript
       seller_sku, seller_sku_presente, seller_custom_field, atributos_json, gtin, user_product_id, canales_json,
       variations_texto, thumbnail, permalink, catalogo, catalog_product_id, precio, available_quantity, precio_actualizado_en, actualizado_en)
```
```javascript
      @variations_texto, @thumbnail, @permalink, @catalogo, @catalog_product_id, @precio, @available_quantity, @actualizado_en, @actualizado_en)
```
```javascript
      thumbnail=excluded.thumbnail, permalink=excluded.permalink, catalogo=excluded.catalogo,
      catalog_product_id=excluded.catalog_product_id,
```

- [ ] **Step 7: Correr los tests y verificar que pasan**

Run: `npx vitest run test/modelos-publicacionMl.test.js test/db.test.js`
Expected: PASS. `db.test.js` tiene una lista de tablas esperadas — si falla por
`ml_publicacion_cambios` faltante, agregarla a esa lista (es un cambio deliberado de esquema).

- [ ] **Step 8: Commit**

```bash
git add migrations/103_ml_publicacion_cambios.sql db/index.js lib/modelos/publicacionMl.js routes/matcher.js test/modelos-publicacionMl.test.js test/db.test.js
git commit -m "feat(vigia): persistir catalog_product_id y crear ml_publicacion_cambios

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: La detección — `lib/vigiaFormato.js`

Lógica pura. Recibe el snapshot anterior y las filas nuevas, devuelve la lista de cambios. No
toca ML, no toca la base, no decide si pausar.

**Files:**
- Create: `lib/vigiaFormato.js`
- Test: `test/vigiaFormato.test.js`

**Interfaces:**
- Consumes: filas con la forma que produce `aplanarItemMl` (Task 1).
- Produces:
  - `CAMPOS_VIGILADOS` → `['catalog_product_id', 'UNITS_PER_PACK', 'SALE_FORMAT']`
  - `valorDeCampo(fila, campo)` → `string|null`
  - `detectarCambios(previas, nuevas)` → `Array<{clave, item_id, sku, campo, valor_anterior, valor_nuevo}>`
    donde `previas` es un `Map<clave, fila>` y `nuevas` un array de filas.

- [ ] **Step 1: Escribir el test que falla**

`test/vigiaFormato.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { detectarCambios, valorDeCampo, CAMPOS_VIGILADOS } from '../lib/vigiaFormato.js';

// Arma una fila con la forma que produce aplanarItemMl.
function fila({ clave = 'MLA1|', item_id = 'MLA1', seller_sku = 'FB-1',
                catalog_product_id = null, units = null, formato = null } = {}) {
  const attrs = [];
  if (units !== null) attrs.push({ id: 'UNITS_PER_PACK', value_name: units });
  if (formato !== null) attrs.push({ id: 'SALE_FORMAT', value_name: formato });
  return { clave, item_id, seller_sku, catalog_product_id, atributos_json: JSON.stringify(attrs) };
}

describe('vigiaFormato — qué se considera un cambio', () => {
  it('un cambio de catalog_product_id se detecta', () => {
    const previas = new Map([['MLA1|', fila({ catalog_product_id: 'MLA111' })]]);
    const r = detectarCambios(previas, [fila({ catalog_product_id: 'MLA222' })]);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      clave: 'MLA1|', campo: 'catalog_product_id',
      valor_anterior: 'MLA111', valor_nuevo: 'MLA222',
    });
  });

  // El caso exacto del GP5000: no era de catálogo y pasó a serlo.
  it('pasar de null a un producto de catálogo es un cambio', () => {
    const previas = new Map([['MLA1|', fila({ catalog_product_id: null })]]);
    const r = detectarCambios(previas, [fila({ catalog_product_id: 'MLA44441017' })]);
    expect(r).toHaveLength(1);
    expect(r[0].valor_anterior).toBeNull();
    expect(r[0].valor_nuevo).toBe('MLA44441017');
  });

  it('un cambio de UNITS_PER_PACK se detecta', () => {
    const previas = new Map([['MLA1|', fila({ units: '1' })]]);
    const r = detectarCambios(previas, [fila({ units: '2' })]);
    expect(r).toHaveLength(1);
    expect(r[0].campo).toBe('UNITS_PER_PACK');
  });

  it('un cambio de SALE_FORMAT se detecta', () => {
    const previas = new Map([['MLA1|', fila({ formato: 'Unidad' })]]);
    const r = detectarCambios(previas, [fila({ formato: 'Pack' })]);
    expect(r[0].campo).toBe('SALE_FORMAT');
  });

  // La regla que evita los falsos positivos que rompieron el análisis manual del 2026-09-12.
  it('una publicación vista por primera vez NO dispara, aunque traiga UNITS_PER_PACK 2', () => {
    const r = detectarCambios(new Map(), [fila({ units: '2', formato: 'Pack' })]);
    expect(r).toEqual([]);
  });

  it('sin cambios no devuelve nada', () => {
    const previas = new Map([['MLA1|', fila({ units: '2', formato: 'Pack' })]]);
    const r = detectarCambios(previas, [fila({ units: '2', formato: 'Pack' })]);
    expect(r).toEqual([]);
  });

  it('el título NO se vigila', () => {
    expect(CAMPOS_VIGILADOS).not.toContain('titulo');
  });

  it('un atributo con value_name nulo se lee como null, no como el texto "null"', () => {
    // Es el error que produjo el falso positivo de FB-21169 el 2026-09-12.
    const f = { catalog_product_id: null,
      atributos_json: JSON.stringify([{ id: 'SALE_FORMAT', value_name: null }]) };
    expect(valorDeCampo(f, 'SALE_FORMAT')).toBeNull();
  });

  it('atributos_json inválido no rompe: se lee como sin atributos', () => {
    const previas = new Map([['MLA1|', { clave: 'MLA1|', item_id: 'MLA1', catalog_product_id: null, atributos_json: '{no json' }]]);
    expect(() => detectarCambios(previas, [fila()])).not.toThrow();
  });

  it('dos campos que cambian a la vez dan dos filas', () => {
    const previas = new Map([['MLA1|', fila({ units: '1', formato: 'Unidad' })]]);
    const r = detectarCambios(previas, [fila({ units: '2', formato: 'Pack' })]);
    expect(r).toHaveLength(2);
    expect(r.map(x => x.campo).sort()).toEqual(['SALE_FORMAT', 'UNITS_PER_PACK']);
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx vitest run test/vigiaFormato.test.js`
Expected: FAIL — no existe `lib/vigiaFormato.js`.

- [ ] **Step 3: Implementar `lib/vigiaFormato.js`**

```javascript
/*
 * lib/vigiaFormato.js — qué cambió en una publicación de ML.
 *
 * Lógica PURA: sin base, sin ML, sin DOM. Vive acá por el mismo motivo que conteoCantidad.js:
 * es la parte que, mal hecha, pausa el catálogo entero, y así se prueba sin un solo mock.
 *
 * La regla central es que se compara contra el PASADO, no contra un criterio. Un análisis del
 * 2026-09-12 sobre las 41 publicaciones con formato distinto de "unidad" mostró por qué: 8 de
 * las 10 activas eran packs legítimos (juegos de ruedas, pares de manijas) y las 2 restantes
 * fueron falsos positivos. En Woo no hay ningún campo que diga cuántas unidades trae un
 * producto, así que ninguna regla puede saber si un "Pack de 2" está bien o mal. Lo que sí se
 * puede afirmar sin ambigüedad es que algo CAMBIÓ.
 */

/** Los tres campos que definen qué cree ML que estás vendiendo. El título NO: ML lo reescribe
 *  por su cuenta y sería ruido constante. */
export const CAMPOS_VIGILADOS = ['catalog_product_id', 'UNITS_PER_PACK', 'SALE_FORMAT'];

function atributosDe(fila) {
  const crudo = fila?.atributos_json;
  if (!crudo) return [];
  try {
    const a = JSON.parse(crudo);
    return Array.isArray(a) ? a : [];
  } catch {
    // Fail-open: un JSON roto no puede frenar el refresco entero ni inventar un cambio.
    return [];
  }
}

/**
 * Valor comparable de un campo vigilado. Devuelve `null` cuando no hay valor — nunca la cadena
 * "null", que es justo el error que produjo un falso positivo el 2026-09-12.
 */
export function valorDeCampo(fila, campo) {
  if (campo === 'catalog_product_id') {
    const v = fila?.catalog_product_id;
    return v == null || v === '' ? null : String(v);
  }
  const attr = atributosDe(fila).find((a) => a && a.id === campo);
  if (!attr) return null;
  const v = attr.value_name;
  return v == null || v === '' ? null : String(v);
}

/**
 * @param {Map<string, object>} previas  filas del cache ANTES del refresco, por clave
 * @param {object[]} nuevas              filas que vienen de ML
 * @returns {Array<{clave,item_id,sku,campo,valor_anterior,valor_nuevo}>}
 */
export function detectarCambios(previas, nuevas) {
  const cambios = [];
  for (const nueva of nuevas || []) {
    const anterior = previas?.get(nueva.clave);
    // Sin línea base no hay cambio. Una publicación nueva que ya nace como "Pack de 2" puede
    // ser perfectamente legítima y no hay forma de saberlo desde acá.
    if (!anterior) continue;
    for (const campo of CAMPOS_VIGILADOS) {
      const antes = valorDeCampo(anterior, campo);
      const despues = valorDeCampo(nueva, campo);
      if (antes === despues) continue;
      cambios.push({
        clave: nueva.clave,
        item_id: nueva.item_id,
        sku: nueva.seller_sku || null,
        campo,
        valor_anterior: antes,
        valor_nuevo: despues,
      });
    }
  }
  return cambios;
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `npx vitest run test/vigiaFormato.test.js`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/vigiaFormato.js test/vigiaFormato.test.js
git commit -m "feat(vigia): detección pura de cambios de formato

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: El freno de mano, el pausado y el aviso — `lib/vigiaPausado.js`

**Files:**
- Create: `lib/vigiaPausado.js`
- Test: `test/vigiaPausado.test.js`

**Interfaces:**
- Consumes: `detectarCambios` (Task 2); `abrirOActualizarIncidente` de `lib/incidentes.js`;
  `mlFetch(db, cfg, metodo, path, body)` de `lib/mlClient.js`.
- Produces:
  - `UMBRAL_PAUSA_MASIVA = 5`
  - `async procesarCambios(db, mlCfg, cambios, opts)` →
    `{ detectados, pausadas, omitidos_por_umbral, errores }`

- [ ] **Step 1: Escribir el test que falla**

`test/vigiaPausado.test.js`:

```javascript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';

vi.mock('../lib/mlClient.js', () => ({ mlFetch: vi.fn(), bootstrapToken: vi.fn(), getAccessToken: vi.fn() }));
import { mlFetch } from '../lib/mlClient.js';
import { openDb } from '../db/index.js';
import { procesarCambios, UMBRAL_PAUSA_MASIVA } from '../lib/vigiaPausado.js';

const TEST_DB = './test/vigia-pausado.sqlite';
const CFG = { clientId: 'x', clientSecret: 'y', redirectUri: 'z' };

function cambio(n, extra = {}) {
  return { clave: `MLA${n}|`, item_id: `MLA${n}`, sku: `FB-${n}`, campo: 'catalog_product_id',
    valor_anterior: null, valor_nuevo: 'MLA44441017', ...extra };
}

describe('vigiaPausado', () => {
  let db;
  beforeEach(() => { db = openDb(TEST_DB); vi.clearAllMocks(); mlFetch.mockResolvedValue({ status: 200, data: {} }); });
  afterEach(() => { db.close(); if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('un cambio se asienta, se pausa en ML y abre incidente', async () => {
    const r = await procesarCambios(db, CFG, [cambio(1)]);
    expect(r.detectados).toBe(1);
    expect(r.pausadas).toBe(1);
    expect(mlFetch).toHaveBeenCalledWith(db, CFG, 'put', '/items/MLA1', { status: 'paused' });
    const fila = db.prepare('SELECT * FROM ml_publicacion_cambios').get();
    expect(fila.pausada).toBe(1);
    expect(fila.revisado_en).toBeNull();
    const inc = db.prepare("SELECT * FROM incidentes_operativos WHERE proceso='vigia_formato'").get();
    expect(inc.severidad).toBe('critico');
  });

  it('sin cambios no hace nada ni abre incidente', async () => {
    const r = await procesarCambios(db, CFG, []);
    expect(r).toMatchObject({ detectados: 0, pausadas: 0 });
    expect(mlFetch).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) n FROM incidentes_operativos WHERE proceso='vigia_formato'").get().n).toBe(0);
  });

  it('superado el umbral no pausa NINGUNA y abre un solo incidente', async () => {
    const muchos = Array.from({ length: UMBRAL_PAUSA_MASIVA + 1 }, (_, i) => cambio(i + 1));
    const r = await procesarCambios(db, CFG, muchos);
    expect(r.pausadas).toBe(0);
    expect(r.omitidos_por_umbral).toBe(UMBRAL_PAUSA_MASIVA + 1);
    expect(mlFetch).not.toHaveBeenCalled();
    // Los cambios igual quedan asentados: la detección no se pierde.
    expect(db.prepare('SELECT COUNT(*) n FROM ml_publicacion_cambios').get().n).toBe(UMBRAL_PAUSA_MASIVA + 1);
    expect(db.prepare('SELECT COUNT(*) n FROM ml_publicacion_cambios WHERE pausada=1').get().n).toBe(0);
    expect(db.prepare("SELECT COUNT(*) n FROM incidentes_operativos WHERE proceso='vigia_formato'").get().n).toBe(1);
  });

  it('justo en el umbral SÍ pausa', async () => {
    const justos = Array.from({ length: UMBRAL_PAUSA_MASIVA }, (_, i) => cambio(i + 1));
    const r = await procesarCambios(db, CFG, justos);
    expect(r.pausadas).toBe(UMBRAL_PAUSA_MASIVA);
  });

  it('si ML rechaza el pausado, el cambio queda asentado con el error y el aviso sale igual', async () => {
    mlFetch.mockResolvedValue({ status: 403, data: { message: 'forbidden' } });
    const r = await procesarCambios(db, CFG, [cambio(1)]);
    expect(r.pausadas).toBe(0);
    expect(r.errores).toBe(1);
    const fila = db.prepare('SELECT * FROM ml_publicacion_cambios').get();
    expect(fila.pausada).toBe(0);
    expect(fila.pausa_error).toContain('403');
    expect(db.prepare("SELECT COUNT(*) n FROM incidentes_operativos WHERE proceso='vigia_formato'").get().n).toBe(1);
  });

  // El caso de las 31 pausadas: el cambio se asienta y avisa, pero no se intenta pausar de nuevo.
  it('una publicación YA pausada no se vuelve a pausar, pero el cambio se asienta y avisa', async () => {
    db.prepare(`INSERT INTO ml_publicaciones_cache
      (clave, item_id, variation_id, titulo, status, sub_status, es_variante, actualizado_en)
      VALUES ('MLA1|','MLA1','','x','paused','out_of_stock',0,datetime('now'))`).run();
    const r = await procesarCambios(db, CFG, [cambio(1)]);
    expect(mlFetch).not.toHaveBeenCalled();
    expect(r.pausadas).toBe(1);        // cuenta como cubierta: el efecto deseado ya está
    expect(r.errores).toBe(0);
    expect(db.prepare('SELECT pausada FROM ml_publicacion_cambios').get().pausada).toBe(1);
    expect(db.prepare("SELECT COUNT(*) n FROM incidentes_operativos WHERE proceso='vigia_formato'").get().n).toBe(1);
  });

  it('dos cambios del mismo item pausan una sola vez', async () => {
    const r = await procesarCambios(db, CFG, [cambio(1), cambio(1, { campo: 'UNITS_PER_PACK', valor_anterior: '1', valor_nuevo: '2' })]);
    expect(r.detectados).toBe(2);
    expect(mlFetch).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT COUNT(*) n FROM ml_publicacion_cambios WHERE pausada=1').get().n).toBe(2);
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx vitest run test/vigiaPausado.test.js`
Expected: FAIL — no existe `lib/vigiaPausado.js`.

- [ ] **Step 3: Implementar `lib/vigiaPausado.js`**

```javascript
/*
 * lib/vigiaPausado.js — qué hacer con un cambio de formato detectado.
 *
 * Asienta, pausa en ML y avisa. La detección vive en lib/vigiaFormato.js; acá está la parte que
 * ESCRIBE, con su freno de mano.
 */
import { mlFetch } from './mlClient.js';
import { abrirOActualizarIncidente } from './incidentes.js';

/**
 * Máximo de publicaciones que el vigía puede pausar en una sola corrida.
 *
 * Trescientas publicaciones no se rompen juntas: un cambio masivo es casi siempre ML cambiando
 * algo de su lado (un atributo nuevo, un valor que pasa de nulo a "Unidad"). Pausar el catálogo
 * entero por un cambio de esquema sería mucho peor que el problema que el vigía viene a resolver.
 */
export const UMBRAL_PAUSA_MASIVA = 5;

const now = () => new Date().toISOString();

function describir(c) {
  const antes = c.valor_anterior === null ? '(vacío)' : c.valor_anterior;
  const despues = c.valor_nuevo === null ? '(vacío)' : c.valor_nuevo;
  return `${c.sku || c.item_id}: ${c.campo} pasó de ${antes} a ${despues}`;
}

export async function procesarCambios(db, mlCfg, cambios, opts = {}) {
  const umbral = Number.isInteger(opts.umbral) ? opts.umbral : UMBRAL_PAUSA_MASIVA;
  const lista = cambios || [];
  if (!lista.length) return { detectados: 0, pausadas: 0, omitidos_por_umbral: 0, errores: 0 };

  const ts = now();
  const insertar = db.prepare(`INSERT INTO ml_publicacion_cambios
    (clave, item_id, sku, campo, valor_anterior, valor_nuevo, pausada, pausa_error, detectado_en)
    VALUES (?,?,?,?,?,?,0,NULL,?)`);
  const ids = [];
  db.transaction(() => {
    for (const c of lista) {
      const info = insertar.run(c.clave, c.item_id, c.sku || null, c.campo, c.valor_anterior, c.valor_nuevo, ts);
      ids.push(info.lastInsertRowid);
    }
  })();

  // Un item puede tener dos campos cambiados: se pausa una sola vez.
  const items = [...new Set(lista.map((c) => c.item_id))];
  const excede = items.length > umbral;

  let pausadas = 0;
  let errores = 0;
  if (!excede) {
    const marcarOk = db.prepare('UPDATE ml_publicacion_cambios SET pausada=1 WHERE id=?');
    const marcarError = db.prepare('UPDATE ml_publicacion_cambios SET pausa_error=? WHERE id=?');
    const estadoEnCache = db.prepare("SELECT status FROM ml_publicaciones_cache WHERE item_id=? LIMIT 1");
    for (const itemId of items) {
      const idsDelItem = ids.filter((_, i) => lista[i].item_id === itemId);
      let error = null;
      // Si ya está pausada —el caso de las 31 pausadas que este vigía viene a cubrir— no se
      // toca ML: el efecto deseado ya está, el cambio se asienta igual y el reactivador la
      // saltea por la fila sin revisar. Pedirle a ML que pause lo ya pausado sólo agrega una
      // llamada que puede fallar por una razón que no le importa a nadie.
      const yaPausada = estadoEnCache.get(itemId)?.status === 'paused';
      if (!yaPausada) {
        try {
          const r = await mlFetch(db, mlCfg, 'put', `/items/${itemId}`, { status: 'paused' });
          if (r.status < 200 || r.status >= 300) error = `ML respondió ${r.status}`;
        } catch (e) {
          error = e?.message || 'error desconocido';
        }
      }
      // Fail-open por publicación: si no se pudo pausar, el cambio queda asentado igual y el
      // aviso sale igual. Perder la detección por un fallo de escritura sería lo peor posible.
      if (error) { errores += 1; for (const id of idsDelItem) marcarError.run(error, id); }
      else { pausadas += idsDelItem.length; for (const id of idsDelItem) marcarOk.run(id); }
    }
  }

  const detalle = lista.slice(0, 10).map(describir).join('; ');
  abrirOActualizarIncidente(db, {
    integracion: 'mercadolibre',
    proceso: 'vigia_formato',
    tipoError: 'datos',
    severidad: 'critico',
    mensajeTecnico: detalle,
    mensajeHumano: excede
      ? `${items.length} publicaciones cambiaron de formato en una sola corrida. No se pausó ninguna por seguridad: revisá si fue un cambio de MercadoLibre antes de tocar nada.`
      : `${items.length} publicación(es) cambiaron de formato y se pausaron. ${detalle}`,
    contexto: { items: items.slice(0, 20), excede_umbral: excede, umbral },
  });

  return { detectados: lista.length, pausadas, omitidos_por_umbral: excede ? lista.length : 0, errores };
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `npx vitest run test/vigiaPausado.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/vigiaPausado.js test/vigiaPausado.test.js
git commit -m "feat(vigia): freno de mano, pausado en ML y aviso por incidente

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Enganchar el vigía al refresco

El refresco total hace `DELETE FROM ml_publicaciones_cache` y reinserta dentro de la misma
transacción (`routes/matcher.js:349`). El snapshot hay que tomarlo **antes** de esa transacción o
el valor anterior ya no existe. Este es el detalle que hace o rompe la tarea.

**Files:**
- Modify: `routes/matcher.js:340-353` (refresco total) y el bloque equivalente del refresco
  acotado (`refrescarPublicacionesMlAcotado`, ~línea 531)
- Test: `test/vigia-refresco.test.js` (crear)

**Interfaces:**
- Consumes: `detectarCambios` (Task 2), `procesarCambios` (Task 3).
- Produces: `refrescarPublicacionesMl` y `refrescarPublicacionesMlAcotado` devuelven además
  `vigia: { detectados, pausadas, omitidos_por_umbral, errores }`.

- [ ] **Step 1: Escribir el test que falla**

`test/vigia-refresco.test.js`:

```javascript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';

vi.mock('../lib/mlClient.js', () => ({ mlFetch: vi.fn(), bootstrapToken: vi.fn(), getAccessToken: vi.fn() }));
import { mlFetch } from '../lib/mlClient.js';
import { openDb } from '../db/index.js';
import { refrescarPublicacionesMlAcotado } from '../routes/matcher.js';

const TEST_DB = './test/vigia-refresco.sqlite';
// `userId` es obligatorio: mlCfgOk de routes/matcher.js:209 lo exige y, sin él, el refresco
// aborta con "Configuración de MercadoLibre incompleta" antes de llegar a la detección.
// Mismo valor que usa test/cobertura-actualizar-ml.test.js.
const CFG = { clientId: 'cid', clientSecret: 'cs', userId: '99999' };

// Responde el multiget de /items con un item simple y el catalog_product_id pedido.
function mockItems(catalogProductId) {
  mlFetch.mockImplementation(async (_db, _cfg, metodo, url) => {
    if (metodo === 'get' && url.includes('/items?ids=')) {
      return { status: 200, data: [{ code: 200, body: {
        id: 'MLA1', title: 'Cubierta', status: 'active', sub_status: [],
        seller_custom_field: 'FB-64881', attributes: [], variations: [],
        thumbnail: 't', permalink: 'p', catalog_listing: !!catalogProductId,
        catalog_product_id: catalogProductId, price: 302585, available_quantity: 3,
      } }] };
    }
    return { status: 200, data: {} };
  });
}

describe('vigía enganchado al refresco', () => {
  let db;
  beforeEach(() => { db = openDb(TEST_DB); vi.clearAllMocks(); });
  afterEach(() => { db.close(); if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('la primera corrida no detecta nada (no hay línea base)', async () => {
    mockItems(null);
    const r = await refrescarPublicacionesMlAcotado(db, CFG, ['MLA1']);
    expect(r.vigia.detectados).toBe(0);
  });

  // El caso GP5000: segunda corrida, ahora atada a un producto de catálogo distinto.
  it('la segunda corrida con otro catalog_product_id detecta, pausa y asienta', async () => {
    mockItems(null);
    await refrescarPublicacionesMlAcotado(db, CFG, ['MLA1']);
    mockItems('MLA44441017');
    const r = await refrescarPublicacionesMlAcotado(db, CFG, ['MLA1']);
    expect(r.vigia.detectados).toBe(1);
    expect(r.vigia.pausadas).toBe(1);
    const fila = db.prepare('SELECT * FROM ml_publicacion_cambios').get();
    expect(fila.campo).toBe('catalog_product_id');
    expect(fila.valor_nuevo).toBe('MLA44441017');
  });

  it('una corrida sin cambios no asienta nada', async () => {
    mockItems('MLA44441017');
    await refrescarPublicacionesMlAcotado(db, CFG, ['MLA1']);
    const r = await refrescarPublicacionesMlAcotado(db, CFG, ['MLA1']);
    expect(r.vigia.detectados).toBe(0);
    expect(db.prepare('SELECT COUNT(*) n FROM ml_publicacion_cambios').get().n).toBe(0);
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx vitest run test/vigia-refresco.test.js`
Expected: FAIL — `r.vigia` es `undefined`.

- [ ] **Step 3: Enganchar en el refresco total**

En `routes/matcher.js`, reemplazar el bloque de las líneas 345-353 por:

```javascript
  if (filas.length > 0) {
    // SNAPSHOT ANTES DE TOCAR NADA. El refresco total borra el cache entero y reinserta dentro
    // de una transacción: si la comparación se hiciera adentro, el valor anterior ya no existe.
    const previas = new Map(
      db.prepare('SELECT clave, item_id, seller_sku, catalog_product_id, atributos_json FROM ml_publicaciones_cache').all()
        .map((f) => [f.clave, f])
    );
    const cambios = detectarCambios(previas, filas);

    const upsert = prepararUpsertCache(db);
    const ts = now();
    const tx = db.transaction((rows) => {
      db.prepare('DELETE FROM ml_publicaciones_cache').run();
      for (const f of rows) upsert.run({ ...f, actualizado_en: ts });
    });
    tx(filas);

    // Después de persistir: pausar toca ML y no puede correr dentro de la transacción.
    vigia = await procesarCambios(db, cfg, cambios);
  }
```

Declarar `let vigia = { detectados: 0, pausadas: 0, omitidos_por_umbral: 0, errores: 0 };` antes
del `if`, agregar `vigia` al objeto devuelto, e importar arriba del archivo:

```javascript
import { detectarCambios } from '../lib/vigiaFormato.js';
import { procesarCambios } from '../lib/vigiaPausado.js';
```

- [ ] **Step 4: Enganchar igual en el refresco acotado**

En `refrescarPublicacionesMlAcotado` (~línea 531), el snapshot se acota a las claves que se van a
tocar, porque este camino **no** borra el resto del cache:

```javascript
    const previas = new Map(
      db.prepare(`SELECT clave, item_id, seller_sku, catalog_product_id, atributos_json
                  FROM ml_publicaciones_cache WHERE item_id IN (${itemIds.map(() => '?').join(',')})`)
        .all(...itemIds).map((f) => [f.clave, f])
    );
    const cambios = detectarCambios(previas, filas);
```

y después del upsert, `const vigia = await procesarCambios(db, cfg, cambios);`, agregándolo al
objeto devuelto.

- [ ] **Step 5: Correr los tests y verificar que pasan**

Run: `npx vitest run test/vigia-refresco.test.js test/vigiaFormato.test.js test/vigiaPausado.test.js`
Expected: PASS.

- [ ] **Step 6: Correr los tests de matcher para verificar que no se rompió nada**

Run: `npx vitest run test/matcher-engine.test.js test/matcher-ml-robusto-hito4.test.js test/cobertura-actualizar-ml.test.js`
Expected: PASS. Si alguno falla por el campo nuevo en el upsert, agregar `catalog_product_id: null`
a las filas de prueba que arma ese test.

- [ ] **Step 7: Commit**

```bash
git add routes/matcher.js test/vigia-refresco.test.js
git commit -m "feat(vigia): enganchar la detección al refresco de publicaciones

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Que el reactivador no deshaga el trabajo del vigía

Sin esto la entrega no sirve: el reactivador despausa, y despausaría justo lo que el vigía pausó.

**Files:**
- Modify: `routes/sync.js:1921-1939` (`getReactivablesRows`)
- Test: `test/vigia-endpoints.test.js` (crear)

**Interfaces:**
- Consumes: tabla `ml_publicacion_cambios` (Task 1).
- Produces: `getReactivablesRows` excluye claves con un cambio sin revisar.

- [ ] **Step 1: Escribir el test que falla**

En `test/vigia-endpoints.test.js`:

```javascript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { openDb } from '../db/index.js';
import { getReactivablesRows } from '../routes/sync.js';

const TEST_DB = './test/vigia-endpoints.sqlite';

function sembrarPausada(db, clave = 'MLA1|', sku = 'FB-1') {
  db.prepare(`INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, stock, actualizado_en)
    VALUES (1, 'Cubierta', ?, 'simple', 5, datetime('now'))`).run(sku);
  // SIN ESTA FILA EL TEST NO MIDE NADA. getReactivablesRows se apoya en COMPUTED_STOCK_CTE
  // (routes/sync.js:224), que arranca `FROM sku_matcher_decisiones` con accion IN
  // ('asignar','confirmar'): sin una decisión, la consulta devuelve [] pase lo que pase y los
  // tres casos "pasarían" por la razón equivocada.
  db.prepare(`INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en)
    VALUES (?, ?, 'WC Cubierta', 'confirmar', datetime('now'))`).run(clave, sku);
  db.prepare(`INSERT INTO ml_publicaciones_cache
    (clave, item_id, variation_id, titulo, status, sub_status, es_variante, seller_sku, available_quantity, actualizado_en)
    VALUES (?, 'MLA1', '', 'Cubierta', 'paused', 'out_of_stock', 0, ?, 0, datetime('now'))`).run(clave, sku);
}

describe('el reactivador respeta las pausas del vigía', () => {
  let db;
  beforeEach(() => { db = openDb(TEST_DB); });
  afterEach(() => { db.close(); if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('sin cambios del vigía, la publicación es reactivable', () => {
    sembrarPausada(db);
    expect(getReactivablesRows(db).map(r => r.clave)).toContain('MLA1|');
  });

  it('con un cambio SIN revisar, el reactivador la saltea', () => {
    sembrarPausada(db);
    db.prepare(`INSERT INTO ml_publicacion_cambios (clave, item_id, campo, valor_anterior, valor_nuevo, pausada, detectado_en)
      VALUES ('MLA1|','MLA1','catalog_product_id',NULL,'MLA44441017',1,datetime('now'))`).run();
    expect(getReactivablesRows(db).map(r => r.clave)).not.toContain('MLA1|');
  });

  it('revisado el cambio, vuelve a ser reactivable', () => {
    sembrarPausada(db);
    db.prepare(`INSERT INTO ml_publicacion_cambios (clave, item_id, campo, valor_anterior, valor_nuevo, pausada, detectado_en, revisado_en, revisado_por)
      VALUES ('MLA1|','MLA1','catalog_product_id',NULL,'MLA44441017',1,datetime('now'),datetime('now'),'jose')`).run();
    expect(getReactivablesRows(db).map(r => r.clave)).toContain('MLA1|');
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx vitest run test/vigia-endpoints.test.js`
Expected: FAIL en el segundo test — la clave sigue apareciendo.

- [ ] **Step 3: Agregar el filtro**

En `getReactivablesRows` (`routes/sync.js:1928`), después de
`AND cm.stock_disponible_ml > 0`, agregar:

```javascript
      AND NOT EXISTS (
        SELECT 1 FROM ml_publicacion_cambios vc
        WHERE vc.clave = p.clave AND vc.revisado_en IS NULL
      )
```

con el comentario arriba de la función:

```javascript
// El vigía de formato pausa publicaciones que pasaron a describir otra cosa (ver
// docs/superpowers/specs/2026-09-12-vigia-formato-publicaciones-design.md). Si el reactivador
// las levantara, el arreglo se anularía solo y en silencio: se saltean hasta que una persona
// revise el cambio, igual que se hace con las pausadas manualmente por el vendedor.
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `npx vitest run test/vigia-endpoints.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add routes/sync.js test/vigia-endpoints.test.js
git commit -m "fix(vigia): el reactivador saltea publicaciones con cambio sin revisar

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Endpoints de revisión

**Files:**
- Modify: `routes/sync.js` (agregar las dos rutas junto a las demás del router)
- Test: `test/vigia-endpoints.test.js` (extender)

**Interfaces:**
- Consumes: tabla `ml_publicacion_cambios`; `mlFetch`.
- Produces:
  - `GET /api/sync/cambios-formato` → `{ ok, data: [{id, clave, item_id, sku, titulo, campo, valor_anterior, valor_nuevo, pausada, pausa_error, detectado_en}] }`
  - `POST /api/sync/cambios-formato/:id/revisar` body `{ reactivar?: boolean }` →
    `{ ok, reactivada: boolean }`

- [ ] **Step 1: Escribir el test que falla**

Agregar a `test/vigia-endpoints.test.js` un bloque con `express` + `supertest` siguiendo el patrón
de `test/precios.test.js:176-181` (`app.use('/api/sync', syncRouter(db, { ml: CFG }))`):

```javascript
  it('GET /cambios-formato devuelve los sin revisar con su antes y después', async () => {
    sembrarPausada(db);
    db.prepare(`INSERT INTO ml_publicacion_cambios (clave, item_id, sku, campo, valor_anterior, valor_nuevo, pausada, detectado_en)
      VALUES ('MLA1|','MLA1','FB-1','catalog_product_id',NULL,'MLA44441017',1,datetime('now'))`).run();
    const r = await request(app).get('/api/sync/cambios-formato');
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(1);
    expect(r.body.data[0]).toMatchObject({ campo: 'catalog_product_id', valor_nuevo: 'MLA44441017', pausada: 1 });
    expect(r.body.data[0].titulo).toBe('Cubierta');
  });

  it('revisar sin reactivar marca revisado y NO toca ML', async () => {
    sembrarPausada(db);
    const info = db.prepare(`INSERT INTO ml_publicacion_cambios (clave, item_id, campo, valor_anterior, valor_nuevo, pausada, detectado_en)
      VALUES ('MLA1|','MLA1','SALE_FORMAT','Unidad','Pack',1,datetime('now'))`).run();
    const r = await request(app).post(`/api/sync/cambios-formato/${info.lastInsertRowid}/revisar`).send({});
    expect(r.status).toBe(200);
    expect(r.body.reactivada).toBe(false);
    expect(mlFetch).not.toHaveBeenCalled();
    expect(db.prepare('SELECT revisado_en FROM ml_publicacion_cambios WHERE id=?').get(info.lastInsertRowid).revisado_en).toBeTruthy();
  });

  it('revisar con reactivar:true despausa en ML', async () => {
    sembrarPausada(db);
    mlFetch.mockResolvedValue({ status: 200, data: {} });
    const info = db.prepare(`INSERT INTO ml_publicacion_cambios (clave, item_id, campo, valor_anterior, valor_nuevo, pausada, detectado_en)
      VALUES ('MLA1|','MLA1','SALE_FORMAT','Unidad','Pack',1,datetime('now'))`).run();
    const r = await request(app).post(`/api/sync/cambios-formato/${info.lastInsertRowid}/revisar`).send({ reactivar: true });
    expect(r.body.reactivada).toBe(true);
    expect(mlFetch).toHaveBeenCalledWith(db, CFG, 'put', '/items/MLA1', { status: 'active' });
  });

  it('revisar un id inexistente da 404', async () => {
    const r = await request(app).post('/api/sync/cambios-formato/9999/revisar').send({});
    expect(r.status).toBe(404);
  });
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx vitest run test/vigia-endpoints.test.js`
Expected: FAIL con 404 en el GET (la ruta no existe).

- [ ] **Step 3: Implementar las rutas en `routes/sync.js`**

```javascript
  // Cambios de formato detectados por el vigía, sin revisar. El JOIN con el cache trae el
  // título para que la pantalla no muestre sólo un MLA.
  router.get('/cambios-formato', (_req, res) => {
    const data = db.prepare(`
      SELECT c.id, c.clave, c.item_id, c.sku, c.campo, c.valor_anterior, c.valor_nuevo,
             c.pausada, c.pausa_error, c.detectado_en, p.titulo, p.thumbnail, p.permalink
      FROM ml_publicacion_cambios c
      LEFT JOIN ml_publicaciones_cache p ON p.clave = c.clave
      WHERE c.revisado_en IS NULL
      ORDER BY c.detectado_en DESC, c.id DESC
    `).all();
    res.json({ ok: true, data });
  });

  // Revisar cierra el aviso. Con `reactivar: true` además despausa: es el ÚNICO camino por el
  // que una pausa del vigía se revierte, y siempre lo dispara una persona.
  router.post('/cambios-formato/:id/revisar', async (req, res) => {
    const fila = db.prepare('SELECT * FROM ml_publicacion_cambios WHERE id=?').get(req.params.id);
    if (!fila) return res.status(404).json({ ok: false, error: 'Cambio no encontrado' });
    if (fila.revisado_en) return res.json({ ok: true, ya_revisado: true, reactivada: false });

    let reactivada = false;
    if (req.body?.reactivar === true) {
      // Convención de este router: mlCfgOk valida el CONTENEDOR (`cfg`, con cfg.ml adentro,
      // ver routes/sync.js:179) y mlFetch recibe el cliente ya desestructurado (línea 276).
      // No existe ninguna variable `mlCfg` en syncRouter.
      if (!mlCfgOk(cfg)) return res.status(400).json({ ok: false, error: 'MercadoLibre no configurado' });
      try {
        const r = await mlFetch(db, cfg.ml, 'put', `/items/${fila.item_id}`, { status: 'active' });
        if (r.status < 200 || r.status >= 300) {
          // Fail-closed: si no se pudo reactivar, NO se marca revisado — el aviso sigue vivo.
          return res.status(502).json({ ok: false, error: `ML respondió ${r.status}` });
        }
        reactivada = true;
      } catch (e) {
        return res.status(502).json({ ok: false, error: e?.message || 'No se pudo reactivar' });
      }
    }
    db.prepare('UPDATE ml_publicacion_cambios SET revisado_en=?, revisado_por=? WHERE id=?')
      .run(new Date().toISOString(), req.user?.username || null, fila.id);
    res.json({ ok: true, reactivada });
  });
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `npx vitest run test/vigia-endpoints.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add routes/sync.js test/vigia-endpoints.test.js
git commit -m "feat(vigia): endpoints de listado y revisión de cambios de formato

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: El bloque en pantalla

**Files:**
- Modify: `public/sync-ml/index.html`

**Interfaces:**
- Consumes: `GET /api/sync/cambios-formato`, `POST /api/sync/cambios-formato/:id/revisar`.
- Produces: nada que consuma otra tarea.

- [ ] **Step 1: Agregar el bloque**

Arriba de la sección de publicaciones frenadas, insertar:

```html
  <div class="cambios-formato" id="cambios-formato" hidden>
    <h2>Publicaciones que cambiaron de formato</h2>
    <p class="sub">MercadoLibre cambió qué dice que estás vendiendo en estas publicaciones.
      Se pausaron para que no vendan mal. Revisá el antes y el después antes de reactivarlas.</p>
    <div id="cambios-formato-lista"></div>
  </div>
```

Estilos junto a los existentes del archivo (usar las variables de `theme.css` que ya usa la
página; el aviso va en ámbar, como el resto de las advertencias):

```css
  .cambios-formato{background:var(--surface);border:1px solid rgba(245,185,66,.45);border-radius:12px;padding:14px 16px;margin-bottom:16px;}
  .cambios-formato h2{font-size:14px;margin:0 0 4px;}
  .cf-fila{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:10px 0;border-bottom:1px solid var(--border);}
  .cf-fila:last-child{border-bottom:0;}
  .cf-cambio{font-family:'Courier New',monospace;font-size:12px;}
  .cf-antes{color:var(--muted);text-decoration:line-through;}
  .cf-despues{color:var(--amber,#F5B942);font-weight:700;}
  .cf-acciones{margin-left:auto;display:flex;gap:8px;}
  .cf-acciones .btn{min-height:44px;}
  @media(max-width:600px){.cf-acciones{margin-left:0;width:100%;}}
```

- [ ] **Step 2: Agregar el JS**

```javascript
async function cargarCambiosFormato(){
  var caja=document.getElementById('cambios-formato');
  try{
    var r=await fetch('/api/sync/cambios-formato');
    var d=await r.json();
    var filas=(d&&d.data)||[];
    caja.hidden=!filas.length;
    if(!filas.length)return;
    document.getElementById('cambios-formato-lista').innerHTML=filas.map(function(c){
      var antes=c.valor_anterior==null?'(vacío)':c.valor_anterior;
      var despues=c.valor_nuevo==null?'(vacío)':c.valor_nuevo;
      return '<div class="cf-fila">'
        +'<div><div><b>'+esc(c.titulo||c.item_id)+'</b> · '+esc(c.sku||'')+'</div>'
        +'<div class="cf-cambio">'+esc(c.campo)+': <span class="cf-antes">'+esc(antes)+'</span> → <span class="cf-despues">'+esc(despues)+'</span></div>'
        +(c.pausa_error?'<div style="color:var(--red);font-size:12px">No se pudo pausar: '+esc(c.pausa_error)+'</div>':'')
        +'</div>'
        +'<div class="cf-acciones">'
        +'<button class="btn sec" onclick="revisarCambio('+c.id+',false)">Dejar pausada</button>'
        +'<button class="btn" onclick="revisarCambio('+c.id+',true)">Estaba bien, reactivar</button>'
        +'<a class="btn sec" href="'+esc(c.permalink||'#')+'" target="_blank" rel="noopener">Ver en ML ↗</a>'
        +'</div></div>';
    }).join('');
  }catch(e){ caja.hidden=true; }
}

async function revisarCambio(id, reactivar){
  if(reactivar && !confirm('Vas a reactivar esta publicación en MercadoLibre. ¿El formato es el correcto?'))return;
  try{
    var r=await fetch('/api/sync/cambios-formato/'+id+'/revisar',{method:'POST',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({reactivar:!!reactivar})});
    var d=await r.json();
    if(!d.ok)throw new Error(d.error||'error');
    await cargarCambiosFormato();
  }catch(err){ alert('No se pudo: '+err.message); }
}
```

Llamar `cargarCambiosFormato()` donde la página ya carga sus datos iniciales.

- [ ] **Step 3: Verificar en navegador**

Levantar un servidor de prueba en `:3999` con una **copia** de la base en el scratchpad
(`DB_PATH=<copia> PORT=3999 DISABLE_CRONS=1 node server.js`), sembrar una fila en
`ml_publicacion_cambios` y comprobar a 390px y a 1440px que el bloque se ve entero, que los
botones miden 44px y que reactivar pide confirmación.

**Bajar el servidor por PID exacto** (`ss -lptn 'sport = :3999'`) antes de correr cualquier
suite: un servidor de prueba conviviendo con `npm test` produce fallos falsos.

- [ ] **Step 4: Commit**

```bash
git add public/sync-ml/index.html
git commit -m "feat(vigia): bloque de publicaciones que cambiaron de formato

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Cierre — suite completa, memoria y despliegue

- [ ] **Step 1: Verificar que no queda nada corriendo**

Run: `pgrep -af "vitest|node.*server.js"`
Expected: ningún vitest y ningún servidor de prueba (el de pm2 no cuenta).

- [ ] **Step 2: Correr la suite completa**

Run: `npm test`
Expected: verde. Ante un fallo en un archivo ajeno al cambio, **re-correr ese archivo solo**
antes de creerle.

- [ ] **Step 3: Actualizar la memoria**

- `docs/memory/active.md`: qué vigila el vigía, el umbral de 5 y por qué, y que el reactivador
  saltea los cambios sin revisar.
- `docs/memory/modules/integrations-ml-woo.md`: que `ml_publicaciones_cache` ahora persiste
  `catalog_product_id` y para qué.
- `docs/superpowers/INDEX.md`: marcar la spec como implementada con su fecha.

- [ ] **Step 4: Desplegar**

```bash
pm2 restart herramientas
curl -s -o /dev/null -w "%{http_code}\n" -k https://herramientas.fusionbikes.com.ar/herramientas/
pm2 logs herramientas --lines 20 --nostream | grep -iE "error|escuch"
```

La migración 103 se aplica sola al abrir la base. Verificar después del reinicio:

```bash
node -e "const D=require('better-sqlite3');const db=new D('data/fusion.sqlite');
console.log(db.prepare(\"SELECT 1 FROM _schema_migrations WHERE key='ml_publicacion_cambios_103'\").get());
console.log(db.prepare('PRAGMA table_info(ml_publicaciones_cache)').all().some(c=>c.name==='catalog_product_id'));"
```

- [ ] **Step 5: Primera corrida real, vigilada**

La primera corrida del refresco después de desplegar encuentra `catalog_product_id` en **NULL**
para las 1.140 publicaciones de catálogo, porque nunca se persistió. Todas van a parecer un
cambio `null → MLAxxxx`.

**El freno de mano las va a frenar a todas** (son muchas más de 5): no se pausa ninguna y se abre
un solo incidente. Ese es el comportamiento correcto y esperado, pero hay que confirmarlo:

```bash
node -e "const D=require('better-sqlite3');const db=new D('data/fusion.sqlite');
console.log('cambios:',db.prepare('SELECT COUNT(*) n FROM ml_publicacion_cambios').get());
console.log('pausadas:',db.prepare('SELECT COUNT(*) n FROM ml_publicacion_cambios WHERE pausada=1').get());"
```

`pausadas` **tiene que dar 0**. Si diera cualquier otra cosa, el freno de mano no funcionó:
revertir el despliegue antes de seguir.

Después, marcar esa primera tanda como revisada de una vez —es ruido de arranque, no cambios
reales— para que el reactivador no quede bloqueado:

```bash
node -e "const D=require('better-sqlite3');const db=new D('data/fusion.sqlite');
const r=db.prepare(\"UPDATE ml_publicacion_cambios SET revisado_en=datetime('now'), revisado_por='linea-base' WHERE revisado_en IS NULL\").run();
console.log('marcados como línea base:',r.changes);"
```

A partir de ahí el cache tiene línea base y el vigía entra en régimen.

- [ ] **Step 6: Commit final**

```bash
git add docs/
git commit -m "docs(vigia): memoria e índice actualizados

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```
