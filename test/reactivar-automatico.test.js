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

/**
 * Responde al multiget /items?ids=... (reactivarItems, paso 3 del plan ahorro-llamadas-ml)
 * a partir de un mapa itemId -> datos del item. Un id ausente de `itemsById` simula "no
 * devuelto por ML" (code !== 200), para probar el camino fail-closed.
 */
function respMultiget(itemsById) {
  return (path) => {
    const ids = path.match(/ids=([^&]*)/)[1].split(',');
    return {
      status: 200,
      data: ids.map(id => itemsById[id]
        ? { code: 200, body: { id, ...itemsById[id] } }
        : { code: 404, body: null }),
    };
  };
}

let db;

/** Siembra una publicación pausada por out_of_stock, mapeada, con stock web disponible. */
function sembrarReactivable({ clave = 'MLA1|', itemId = 'MLA1', sku = 'FB-1', stockWc = 3, precioWc = 300000, titulo = null, sinPrecioWeb = false } = {}) {
  // sinPrecioWeb: sigue con stock > 0 (así hay reactivable de verdad y la corrida avanza
  // hasta chequearNetoReactivar) pero con precio NULL, para que precioWebClave devuelva
  // null y dispare el bloqueo "Sin precio web mapeado" en vez de vaciar getReactivablesRows.
  // regular_price (precio de LISTA) igual a precio (vigente): sin oferta en estos escenarios,
  // así el contado de referencia sigue siendo el mismo que antes de separar los dos campos.
  db.prepare(`INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, stock, precio, regular_price, actualizado_en)
    VALUES (?, ?, ?, 'simple', ?, ?, ?, '2026-07-30T00:00:00Z')`)
    .run(Math.floor(Math.random() * 1e6), 'Producto ' + sku, sku, stockWc,
      sinPrecioWeb ? null : precioWc, sinPrecioWeb ? null : precioWc);
  db.prepare(`INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en)
    VALUES (?, ?, ?, 'asignar', '2026-07-30T00:00:00Z')`).run(clave, sku, 'Producto ' + sku);
  db.prepare(`INSERT INTO ml_publicaciones_cache (clave, item_id, variation_id, titulo, status, sub_status, es_variante, actualizado_en)
    VALUES (?, ?, '', ?, 'paused', 'out_of_stock', 0, '2026-07-30T00:00:00Z')`).run(clave, itemId, titulo ?? ('Pub ' + sku));
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
      if (metodo === 'get' && path.startsWith('/items?ids=')) {
        return respMultiget({ MLA1: { status: 'paused', sub_status: ['out_of_stock'], price: 400000, category_id: 'MLA1234', listing_type_id: 'gold_special', shipping: { free_shipping: false } } })(path);
      }
      if (metodo === 'get' && path.includes('listing_prices')) return { status: 200, data: { sale_fee_amount: 40000 } };
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
      if (metodo === 'get' && path.startsWith('/items?ids=')) {
        return respMultiget({ MLA1: { status: 'paused', sub_status: ['out_of_stock'], price: 200000, category_id: 'MLA1234', listing_type_id: 'gold_special', shipping: { free_shipping: false } } })(path);
      }
      if (metodo === 'get' && path.includes('listing_prices')) return { status: 200, data: { sale_fee_amount: 30000 } };
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
      if (metodo === 'get' && path.startsWith('/items?ids=')) {
        return respMultiget({ MLA1: { status: 'paused', sub_status: ['out_of_stock'], price: 400000, category_id: 'MLA1234', listing_type_id: 'gold_special', shipping: { free_shipping: false } } })(path);
      }
      if (metodo === 'get' && path.includes('listing_prices')) return { status: 200, data: { sale_fee_amount: 40000 } };
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

  it('fail-closed: "no se pudo calcular la comisión" no registra frenada (deficitPct null pero clave no nula)', async () => {
    sembrarReactivable({ precioWc: 300000 });
    mlFetch.mockImplementation(async (_db, _cfg, metodo, path) => {
      if (metodo === 'get' && path.startsWith('/items/MLA1?')) {
        return { status: 200, data: { id: 'MLA1', status: 'paused', sub_status: ['out_of_stock'], price: 400000, category_id: 'MLA1234', listing_type_id: 'gold_special', shipping: { free_shipping: false } } };
      }
      // El GET de comisión falla: chequearNetoReactivar devuelve bloqueo con clave no nula
      // pero deficitPct: null — no es un problema de precio, no debe registrarse.
      if (metodo === 'get' && path.includes('listing_prices')) return { status: 500, data: null };
      return { status: 200, data: {} };
    });

    const r = await reactivarAutomatico(db, CFG);
    expect(r.reactivadas).toBe(0);
    expect(r.frenadas).toBe(0);
    expect(db.prepare('SELECT COUNT(*) n FROM ml_reactivacion_frenada').get().n).toBe(0);
  });

  it('fail-closed: sin precio web mapeado no registra frenada (deficitPct null pero clave no nula)', async () => {
    sembrarReactivable({ sinPrecioWeb: true });
    mlFetch.mockImplementation(async (_db, _cfg, metodo, path) => {
      if (metodo === 'get' && path.startsWith('/items?ids=')) {
        return respMultiget({ MLA1: { status: 'paused', sub_status: ['out_of_stock'], price: 400000, category_id: 'MLA1234', listing_type_id: 'gold_special', shipping: { free_shipping: false } } })(path);
      }
      if (metodo === 'get' && path.includes('listing_prices')) return { status: 200, data: { sale_fee_amount: 40000 } };
      return { status: 200, data: {} };
    });

    const r = await reactivarAutomatico(db, CFG);
    // Blindaje: si getReactivablesRows volviera a devolver vacío (test vacuo), mlFetch nunca
    // se llamaría y este assert lo detectaría antes que los de abajo.
    expect(mlFetch).toHaveBeenCalled();
    expect(r.reactivadas).toBe(0);
    expect(r.frenadas).toBe(0);
    // Contador observable (2026-08-03): este es justo el modo de falla mudo que server.js
    // ahora loguea — sin este contador, este ciclo se ve idéntico a "no había nada que hacer".
    expect(r.sin_precio_web).toBe(1);
    expect(db.prepare('SELECT COUNT(*) n FROM ml_reactivacion_frenada').get().n).toBe(0);
  });

  it('sin_precio_web queda en 0 cuando el bloqueo es por otro motivo (comisión no calculable)', async () => {
    // Contraprueba: el contador NO debe subir con el bloqueo "no se pudo calcular la
    // comisión" (mismo test de la línea 117), para no mezclar los dos motivos fail-closed.
    sembrarReactivable({ precioWc: 300000 });
    mlFetch.mockImplementation(async (_db, _cfg, metodo, path) => {
      if (metodo === 'get' && path.startsWith('/items?ids=')) {
        return respMultiget({ MLA1: { status: 'paused', sub_status: ['out_of_stock'], price: 400000, category_id: 'MLA1234', listing_type_id: 'gold_special', shipping: { free_shipping: false } } })(path);
      }
      if (metodo === 'get' && path.includes('listing_prices')) return { status: 500, data: null };
      return { status: 200, data: {} };
    });

    const r = await reactivarAutomatico(db, CFG);
    expect(r.sin_precio_web).toBe(0);
  });

  it('lote mixto: sin_precio_web y frenadas por déficit real coexisten sin mezclarse', async () => {
    // MLA1 sin precio web mapeado (sin_precio_web). MLB1 con precio web real pero neto que
    // no lo alcanza (frenada de verdad, con deficit_pct). Un contador no debe pisar al otro.
    sembrarReactivable({ clave: 'MLA1|', itemId: 'MLA1', sku: 'FB-1', sinPrecioWeb: true });
    sembrarReactivable({ clave: 'MLB1|', itemId: 'MLB1', sku: 'FB-B1', precioWc: 900000 });
    mlFetch.mockImplementation(async (_db, _cfg, metodo, path) => {
      if (metodo === 'get' && path.startsWith('/items?ids=')) {
        return respMultiget({
          MLA1: { status: 'paused', sub_status: ['out_of_stock'], price: 400000, category_id: 'MLA1234', listing_type_id: 'gold_special', shipping: { free_shipping: false } },
          MLB1: { status: 'paused', sub_status: ['out_of_stock'], price: 200000, category_id: 'MLA1234', listing_type_id: 'gold_special', shipping: { free_shipping: false } },
        })(path);
      }
      if (metodo === 'get' && path.includes('listing_prices')) return { status: 200, data: { sale_fee_amount: 30000 } };
      return { status: 200, data: {} };
    });

    const r = await reactivarAutomatico(db, CFG);
    expect(r.sin_precio_web).toBe(1);
    expect(r.frenadas).toBe(1);
    expect(r.reactivadas).toBe(0);
    const frenada = db.prepare('SELECT clave FROM ml_reactivacion_frenada').get();
    expect(frenada.clave).toBe('MLB1|'); // solo la de déficit real, no la de sin precio web
  });

  it('candado: si ya hay una corrida en curso, la segunda no llama a ML y devuelve omitido', async () => {
    sembrarReactivable();
    let resolveFetch;
    mlFetch.mockImplementation(() => new Promise(res => { resolveFetch = res; }));

    const p1 = reactivarAutomatico(db, CFG); // arranca, llega al await de ML y queda pendiente
    const r2 = await reactivarAutomatico(db, CFG); // corre mientras la primera sigue en curso

    expect(r2).toEqual({ omitido: true });

    resolveFetch({ status: 500, data: null }); // libera la primera corrida para no dejarla colgada
    await p1;
  });

  it('barrido de huérfanas: borra una frenada cuya publicación ya no está entre las reactivables', async () => {
    sembrarReactivable({ clave: 'MLA1|', itemId: 'MLA1', sku: 'FB-1', precioWc: 300000 });
    // Frenada huérfana: no corresponde a ninguna fila reactivable vigente (otra clave/sku).
    db.prepare(`INSERT INTO ml_reactivacion_frenada (clave, sku, motivo, neto, precio_contado, deficit_pct, detectado_en)
      VALUES ('MLA999|', 'FB-999', 'vieja', 1, 2, 0.5, '2026-07-29T00:00:00Z')`).run();
    mlFetch.mockImplementation(async (_db, _cfg, metodo, path) => {
      if (metodo === 'get' && path.startsWith('/items?ids=')) {
        return respMultiget({ MLA1: { status: 'paused', sub_status: ['out_of_stock'], price: 400000, category_id: 'MLA1234', listing_type_id: 'gold_special', shipping: { free_shipping: false } } })(path);
      }
      if (metodo === 'get' && path.includes('listing_prices')) return { status: 200, data: { sale_fee_amount: 40000 } };
      return { status: 200, data: {} };
    });

    await reactivarAutomatico(db, CFG);
    expect(db.prepare("SELECT COUNT(*) n FROM ml_reactivacion_frenada WHERE clave='MLA999|'").get().n).toBe(0);
  });

  it('barrido de huérfanas: si no hay reactivables, limpia todas las frenadas existentes', async () => {
    db.prepare(`INSERT INTO ml_reactivacion_frenada (clave, sku, motivo, neto, precio_contado, deficit_pct, detectado_en)
      VALUES ('MLA999|', 'FB-999', 'vieja', 1, 2, 0.5, '2026-07-29T00:00:00Z')`).run();

    const r = await reactivarAutomatico(db, CFG);
    expect(r.reactivadas).toBe(0);
    expect(db.prepare('SELECT COUNT(*) n FROM ml_reactivacion_frenada').get().n).toBe(0);
  });

  it('anti-starvation: una publicación sin frenada y de título tardío entra en el lote aunque haya más de LOTE_MAX frenadas crónicas con título temprano', async () => {
    const LOTE_MAX = 50;
    // 50 publicaciones "crónicamente frenadas" con títulos alfabéticamente tempranos.
    for (let i = 0; i < LOTE_MAX; i++) {
      const n = String(i).padStart(2, '0');
      const clave = `MLA_A${n}|`;
      const itemId = `MLA_A${n}`;
      sembrarReactivable({ clave, itemId, sku: `FB-A${n}`, precioWc: 300000, titulo: `A${n} - producto viejo` });
      db.prepare(`INSERT INTO ml_reactivacion_frenada (clave, sku, motivo, neto, precio_contado, deficit_pct, detectado_en)
        VALUES (?, ?, 'crónica', 1, 2, 0.5, '2026-07-29T00:00:00Z')`).run(clave, `FB-A${n}`);
    }
    // Una publicación nueva, sin frenada, con título alfabéticamente TARDÍO (quedaría en la
    // posición 51 si no se reordenara — nunca entraría al lote de LOTE_MAX=50).
    sembrarReactivable({ clave: 'MLA_ZZZ|', itemId: 'MLA_ZZZ', sku: 'FB-ZZZ', precioWc: 300000, titulo: 'ZZZ - producto nuevo con stock' });

    const itemsConsultados = new Set();
    mlFetch.mockImplementation(async (_db, _cfg, metodo, path) => {
      if (metodo === 'get' && path.startsWith('/items?ids=')) {
        const ids = path.match(/ids=([^&]*)/)[1].split(',');
        for (const id of ids) itemsConsultados.add(id);
        return {
          status: 200,
          data: ids.map(id => ({
            code: 200,
            body: { id, status: 'paused', sub_status: ['out_of_stock'], price: 400000, category_id: 'MLA1234', listing_type_id: 'gold_special', shipping: { free_shipping: false } },
          })),
        };
      }
      if (metodo === 'get' && path.includes('listing_prices')) return { status: 200, data: { sale_fee_amount: 40000 } };
      return { status: 200, data: {} };
    });

    await reactivarAutomatico(db, CFG);

    expect(itemsConsultados.has('MLA_ZZZ')).toBe(true);
  });

  // Paso 4 del plan ahorro-llamadas-ml: si ninguno de los dos precios (web/ML) cambió desde
  // que se registró la frenada, no hay que gastar una sola llamada para reconfirmarlo.
  describe('evaluación local (paso 4): saltear ML cuando nada cambió desde la frenada', () => {
    function sembrarFrenadaConInsumos({ clave = 'MLA1|', sku = 'FB-1', precioMlEvaluado = 400000, precioWebEvaluado = 300000, detectadoEn = now() } = {}) {
      db.prepare(`INSERT INTO ml_reactivacion_frenada
          (clave, sku, motivo, neto, precio_contado, deficit_pct, detectado_en, precio_ml_evaluado, precio_web_evaluado)
        VALUES (?, ?, 'bajo', 350000, ?, 0.1, ?, ?, ?)`)
        .run(clave, sku, precioWebEvaluado, detectadoEn, precioMlEvaluado, precioWebEvaluado);
    }
    function now() { return new Date().toISOString(); }

    it('sin cambios: 0 llamadas a ML, la frenada sigue vigente', async () => {
      // precioContado(300000) sería el resultado esperado si el sku tuviera regular_price=300000,
      // pero acá seedeamos directamente los valores evaluados para que coincidan con el estado actual.
      sembrarReactivable({ precioWc: 300000 }); // precio de contado real hoy: precioContado(300000)
      // Precio ML conocido e IGUAL en ambos lados (columna local y frenada evaluada): caso
      // realista de "nada cambió". Antes este test sembraba precioMlEvaluado:null sin tocar
      // ml_publicaciones_cache.precio (también NULL), así que pasaba por `null === null` —
      // el bug que consagraba el agujero del BLOQUEANTE 2 (sin ninguna información sobre el
      // precio de ML, se decidía que "no cambió"). Con un valor conocido e igual, el caso de
      // verdad "no cambió" se prueba sin depender de esa comparación rota.
      db.prepare("UPDATE ml_publicaciones_cache SET precio = 400000 WHERE clave = 'MLA1|'").run();
      // Insumos evaluados = exactamente lo que hoy calcularía precioWebClave/ml_publicaciones_cache.precio.
      const contadoActual = 200000; // 300000 * 2/3
      sembrarFrenadaConInsumos({ precioMlEvaluado: 400000, precioWebEvaluado: contadoActual });

      const r = await reactivarAutomatico(db, CFG);
      expect(mlFetch).not.toHaveBeenCalled();
      expect(r.reactivadas).toBe(0);
      expect(r.frenadas).toBe(0); // no se re-evaluó nada: la frenada existente sigue tal cual
      expect(db.prepare('SELECT COUNT(*) n FROM ml_reactivacion_frenada').get().n).toBe(1);
    });

    it('cambió el precio web: entra al lote (llama a ML)', async () => {
      sembrarReactivable({ precioWc: 300000 });
      // precio_web_evaluado distinto del contado actual (200000) → forzar re-chequeo.
      sembrarFrenadaConInsumos({ precioMlEvaluado: null, precioWebEvaluado: 999999 });
      mlFetch.mockImplementation(async (_db, _cfg, metodo, path) => {
        if (metodo === 'get' && path.startsWith('/items?ids=')) {
          return { status: 200, data: [{ code: 200, body: { id: 'MLA1', status: 'paused', sub_status: ['out_of_stock'], price: 400000, category_id: 'MLA1234', listing_type_id: 'gold_special', shipping: { free_shipping: false } } }] };
        }
        if (metodo === 'get' && path.includes('listing_prices')) return { status: 200, data: { sale_fee_amount: 40000 } };
        return { status: 200, data: {} };
      });

      await reactivarAutomatico(db, CFG);
      expect(mlFetch).toHaveBeenCalled();
    });

    it('cambió el precio ML conocido: entra al lote (llama a ML)', async () => {
      sembrarReactivable({ precioWc: 300000 });
      // Sembrar un precio ML distinto en ml_publicaciones_cache al que se evaluó la frenada.
      db.prepare("UPDATE ml_publicaciones_cache SET precio = 111111 WHERE clave = 'MLA1|'").run();
      sembrarFrenadaConInsumos({ precioMlEvaluado: 999999, precioWebEvaluado: 200000 });
      mlFetch.mockImplementation(async (_db, _cfg, metodo, path) => {
        if (metodo === 'get' && path.startsWith('/items?ids=')) {
          return { status: 200, data: [{ code: 200, body: { id: 'MLA1', status: 'paused', sub_status: ['out_of_stock'], price: 400000, category_id: 'MLA1234', listing_type_id: 'gold_special', shipping: { free_shipping: false } } }] };
        }
        if (metodo === 'get' && path.includes('listing_prices')) return { status: 200, data: { sale_fee_amount: 40000 } };
        return { status: 200, data: {} };
      });

      await reactivarAutomatico(db, CFG);
      expect(mlFetch).toHaveBeenCalled();
    });

    it('precio ML desconocido en ambos lados (NULL local y NULL evaluado): se reevalúa, no se lee como "no cambió" (BLOQUEANTE 2)', async () => {
      // ml_publicaciones_cache.precio nunca se sembró (queda NULL por defecto) y la frenada
      // también se guardó con precio_ml_evaluado: null. `null !== null` da `false` en JS, así
      // que sin la guarda explícita esto pasaba como "no cambió" y saltaba el recheck sin
      // ninguna base real — exactamente el bug que encontró el revisor.
      sembrarReactivable({ precioWc: 300000 });
      const contadoActual = 200000;
      sembrarFrenadaConInsumos({ precioMlEvaluado: null, precioWebEvaluado: contadoActual });
      mlFetch.mockImplementation(async (_db, _cfg, metodo, path) => {
        if (metodo === 'get' && path.startsWith('/items?ids=')) {
          return { status: 200, data: [{ code: 200, body: { id: 'MLA1', status: 'paused', sub_status: ['out_of_stock'], price: 400000, category_id: 'MLA1234', listing_type_id: 'gold_special', shipping: { free_shipping: false } } }] };
        }
        if (metodo === 'get' && path.includes('listing_prices')) return { status: 200, data: { sale_fee_amount: 40000 } };
        return { status: 200, data: {} };
      });

      await reactivarAutomatico(db, CFG);
      expect(mlFetch).toHaveBeenCalled();
    });

    it('red de seguridad: frenada de más de 2h se re-evalúa igual aunque nada haya cambiado', async () => {
      sembrarReactivable({ precioWc: 300000 });
      const contadoActual = 200000;
      const hace3h = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
      sembrarFrenadaConInsumos({ precioMlEvaluado: null, precioWebEvaluado: contadoActual, detectadoEn: hace3h });
      mlFetch.mockImplementation(async (_db, _cfg, metodo, path) => {
        if (metodo === 'get' && path.startsWith('/items?ids=')) {
          return { status: 200, data: [{ code: 200, body: { id: 'MLA1', status: 'paused', sub_status: ['out_of_stock'], price: 400000, category_id: 'MLA1234', listing_type_id: 'gold_special', shipping: { free_shipping: false } } }] };
        }
        if (metodo === 'get' && path.includes('listing_prices')) return { status: 200, data: { sale_fee_amount: 40000 } };
        return { status: 200, data: {} };
      });

      await reactivarAutomatico(db, CFG);
      expect(mlFetch).toHaveBeenCalled(); // pasaron >2h desde detectado_en: se re-evalúa igual
    });

    it('regular_price nulo (precio web actual desconocido): no es "cambió" ni "no cambió" — se reevalúa (fail-closed hacia no bloquear en silencio)', async () => {
      sembrarReactivable({ sinPrecioWeb: true });
      sembrarFrenadaConInsumos({ precioMlEvaluado: null, precioWebEvaluado: 200000 });
      mlFetch.mockImplementation(async (_db, _cfg, metodo, path) => {
        if (metodo === 'get' && path.startsWith('/items?ids=')) {
          return { status: 200, data: [{ code: 200, body: { id: 'MLA1', status: 'paused', sub_status: ['out_of_stock'], price: 400000, category_id: 'MLA1234', listing_type_id: 'gold_special', shipping: { free_shipping: false } } }] };
        }
        if (metodo === 'get' && path.includes('listing_prices')) return { status: 200, data: { sale_fee_amount: 40000 } };
        return { status: 200, data: {} };
      });

      const r = await reactivarAutomatico(db, CFG);
      expect(mlFetch).toHaveBeenCalled();
      expect(r.sin_precio_web).toBe(1); // cae en el camino existente, no contamina ni bloquea para siempre
    });
  });

  // IMPORTANTE 3 (hallazgo del revisor): un item con varias variaciones mapeadas debe
  // persistir una frenada POR CADA variación bloqueada, no solo la primera — si no, la
  // variación sin frenada nunca satisface necesitaRecheck y el item entero vuelve a
  // re-consultarse en cada corrida para siempre.
  describe('multi-variación: todas las variaciones bloqueadas quedan frenadas', () => {
    it('persiste una frenada por cada variación con neto bajo del mismo item', async () => {
      const sku1 = 'FB-V1', sku2 = 'FB-V2';
      db.prepare(`INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, stock, precio, regular_price, actualizado_en)
        VALUES (1, 'Producto V1', ?, 'simple', 3, 900000, 900000, '2026-07-30T00:00:00Z')`).run(sku1);
      db.prepare(`INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, stock, precio, regular_price, actualizado_en)
        VALUES (2, 'Producto V2', ?, 'simple', 3, 900000, 900000, '2026-07-30T00:00:00Z')`).run(sku2);
      db.prepare(`INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en)
        VALUES ('MLA1|var10', ?, 'Producto V1', 'asignar', '2026-07-30T00:00:00Z')`).run(sku1);
      db.prepare(`INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en)
        VALUES ('MLA1|var20', ?, 'Producto V2', 'asignar', '2026-07-30T00:00:00Z')`).run(sku2);
      db.prepare(`INSERT INTO ml_publicaciones_cache (clave, item_id, variation_id, titulo, status, sub_status, es_variante, actualizado_en)
        VALUES ('MLA1|var10', 'MLA1', 'var10', 'Pub V1', 'paused', 'out_of_stock', 1, '2026-07-30T00:00:00Z')`).run();
      db.prepare(`INSERT INTO ml_publicaciones_cache (clave, item_id, variation_id, titulo, status, sub_status, es_variante, actualizado_en)
        VALUES ('MLA1|var20', 'MLA1', 'var20', 'Pub V2', 'paused', 'out_of_stock', 1, '2026-07-30T00:00:00Z')`).run();

      mlFetch.mockImplementation(async (_db, _cfg, metodo, path) => {
        if (metodo === 'get' && path.startsWith('/items?ids=')) {
          return {
            status: 200,
            data: [{
              code: 200,
              body: {
                id: 'MLA1', status: 'paused', sub_status: ['out_of_stock'],
                price: 200000, category_id: 'MLA1234', listing_type_id: 'gold_special',
                shipping: { free_shipping: false },
                variations: [{ id: 'var10', price: 200000 }, { id: 'var20', price: 210000 }],
              },
            }],
          };
        }
        if (metodo === 'get' && path.includes('listing_prices')) return { status: 200, data: { sale_fee_amount: 30000 } };
        return { status: 200, data: {} };
      });

      const r = await reactivarAutomatico(db, CFG);
      expect(r.reactivadas).toBe(0);
      expect(r.frenadas).toBe(2);
      const claves = db.prepare('SELECT clave FROM ml_reactivacion_frenada ORDER BY clave').all().map(f => f.clave);
      expect(claves).toEqual(['MLA1|var10', 'MLA1|var20']);
    });
  });

  // Paso 5: revalidación en vivo antes de activar, aunque haya caché persistente fresca.
  describe('revalidación en vivo antes de activar (paso 5)', () => {
    it('consulta ML aunque ml_precios_cache tenga una fila fresca de comisión', async () => {
      sembrarReactivable({ precioWc: 300000 });
      let llamadasListingPrices = 0;
      mlFetch.mockImplementation(async (_db, _cfg, metodo, path) => {
        if (metodo === 'get' && path.startsWith('/items?ids=')) {
          return { status: 200, data: [{ code: 200, body: { id: 'MLA1', status: 'paused', sub_status: ['out_of_stock'], price: 400000, category_id: 'MLA1234', listing_type_id: 'gold_special', shipping: { free_shipping: false } } }] };
        }
        if (metodo === 'get' && path.includes('listing_prices')) {
          llamadasListingPrices++;
          return { status: 200, data: { sale_fee_amount: 40000 } };
        }
        return { status: 200, data: {} };
      });

      // Fila fresca ya cacheada para exactamente la misma combinación precio/categoría/listing.
      db.prepare(`INSERT INTO ml_precios_cache (clave, valor, actualizado_en)
        VALUES ('fee:400000:MLA1234:gold_special', 1, ?)`).run(new Date().toISOString());

      await reactivarAutomatico(db, CFG);
      // Se consultó igual: chequearNetoReactivar (revalidación previa al PUT) usa
      // saltarCachePersistente:true, no la fila fresca.
      expect(llamadasListingPrices).toBe(1);
    });

    it('fail-closed: un fallo en la revalidación en vivo impide el PUT de activación', async () => {
      sembrarReactivable({ precioWc: 300000 });
      mlFetch.mockImplementation(async (_db, _cfg, metodo, path) => {
        if (metodo === 'get' && path.startsWith('/items?ids=')) {
          return { status: 200, data: [{ code: 200, body: { id: 'MLA1', status: 'paused', sub_status: ['out_of_stock'], price: 400000, category_id: 'MLA1234', listing_type_id: 'gold_special', shipping: { free_shipping: false } } }] };
        }
        if (metodo === 'get' && path.includes('listing_prices')) return { status: 500, data: null }; // ML caído en la revalidación
        return { status: 200, data: {} };
      });

      const r = await reactivarAutomatico(db, CFG);
      expect(r.reactivadas).toBe(0);
      expect(db.prepare("SELECT status FROM ml_publicaciones_cache WHERE clave='MLA1|'").get().status).toBe('paused');
    });
  });

  // Hallazgo del revisor (IMPORTANTE, 2026-08-06): una frenada que entra por la ventana de 2h
  // (VENTANA_REVALIDACION_FRENADA_MS) tiene que hacer SCREENING en vivo — si releyera
  // ml_precios_cache (TTL 7 días) estaría comparando contra el mismo valor cacheado que
  // produjo la frenada original, y la red de seguridad no serviría para nada.
  describe('red de seguridad de 2h: screening en vivo, no releer ml_precios_cache (IMPORTANTE)', () => {
    it('una frenada que entra por la ventana de 2h consulta ML en vivo en el screening aunque ml_precios_cache tenga fila fresca', async () => {
      sembrarReactivable({ precioWc: 300000 }); // contado = 200000 (2/3 de 300000)
      const hace3h = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
      db.prepare(`INSERT INTO ml_reactivacion_frenada
          (clave, sku, motivo, neto, precio_contado, deficit_pct, detectado_en, precio_ml_evaluado, precio_web_evaluado)
        VALUES ('MLA1|', 'FB-1', 'bajo', 100000, 200000, 0.5, ?, 400000, 200000)`).run(hace3h);

      // Fila fresca (TTL 7 días) con una comisión BAJA que daría neto=370000 (>200000, 'ok'):
      // si el screening la usara, no bloquearía y el item pasaría a la revalidación final ya
      // "aprobado". Con la fila más chica de comisión el neto queda ok, algo que la corrida en
      // vivo (comisión más alta) no confirma.
      db.prepare(`INSERT INTO ml_precios_cache (clave, valor, actualizado_en)
        VALUES ('fee:400000:MLA1234:gold_special', 30000, ?)`).run(new Date().toISOString());

      let llamadasListingPrices = 0;
      mlFetch.mockImplementation(async (_db, _cfg, metodo, path) => {
        if (metodo === 'get' && path.startsWith('/items?ids=')) {
          return { status: 200, data: [{ code: 200, body: { id: 'MLA1', status: 'paused', sub_status: ['out_of_stock'], price: 400000, category_id: 'MLA1234', listing_type_id: 'gold_special', shipping: { free_shipping: false } } }] };
        }
        if (metodo === 'get' && path.includes('listing_prices')) {
          llamadasListingPrices++;
          // Comisión real EN VIVO más alta que la cacheada: neto=400000-250000=150000, por
          // debajo del 95% de 200000 → sigue bloqueada.
          return { status: 200, data: { sale_fee_amount: 250000 } };
        }
        return { status: 200, data: {} };
      });

      const r = await reactivarAutomatico(db, CFG);

      // Si el screening hubiera usado la fila cacheada (30000), el item habría pasado a la
      // revalidación final y esa SÍ es siempre en vivo (2da llamada), pero la clave del bug es
      // que el screening en sí mismo no debe leer la caché para publicaciones de esta ventana:
      // por eso listing_prices se llama, como mínimo, una vez con el valor en vivo (250000) y
      // el veredicto final sigue bloqueado con ese valor, no con el cacheado.
      expect(llamadasListingPrices).toBeGreaterThanOrEqual(1);
      expect(r.reactivadas).toBe(0);
      expect(r.frenadas).toBe(1);
      const f = db.prepare('SELECT * FROM ml_reactivacion_frenada WHERE clave = ?').get('MLA1|');
      expect(f.precio_ml_evaluado).toBe(400000);
      // El neto persistido tiene que corresponder a la comisión EN VIVO (250000), no a la
      // cacheada (30000): 400000 - 250000 = 150000. Si el screening hubiera confiado en la
      // caché, este valor habría dado 370000 (comisión 30000) y el test lo detectaría.
      expect(f.neto).toBe(150000);
      expect(db.prepare("SELECT status FROM ml_publicaciones_cache WHERE clave='MLA1|'").get().status).toBe('paused');
    });
  });
});
