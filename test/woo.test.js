import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import {
  wooFetch, wooFetchConReintento, wooFetchConCircuito, categorizarErrorWoo, circuitoWooAbierto,
  _resetCircuitoWooParaTests, refrescarCatalogo, refrescarProductoPuntual, getCatalogo, wooRouter, registrarAlertasStockNegativo,
} from '../routes/woo.js';
import axios from 'axios';
import express from 'express';
import request from 'supertest';

vi.mock('axios');
vi.mock('../routes/sync.js', async () => {
  const actual = await vi.importActual('../routes/sync.js');
  return {
    ...actual,
    syncSkuPuntual: vi.fn(),
  };
});

const TEST_DB = './test/tmp-woo.sqlite';

describe('woo route', () => {
  afterEach(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    vi.resetAllMocks();
  });

  it('wooFetch calls WooCommerce REST API with basic auth header', async () => {
    axios.request.mockResolvedValue({ status: 200, data: [{ id: 1 }], headers: {} });
    const cfg = { url: 'https://fusionbikes.com.ar', ck: 'ck_x', cs: 'cs_x' };
    await wooFetch(cfg, '/products?per_page=1');
    expect(axios.request).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://fusionbikes.com.ar/wp-json/wc/v3/products?per_page=1',
      method: 'get',
      auth: { username: 'ck_x', password: 'cs_x' }
    }));
  });

  describe('wooFetchConReintento — resiliencia ante 5xx transitorios (incidente 2026-08-27)', () => {
    const cfg = { url: 'https://fusionbikes.com.ar', ck: 'ck_x', cs: 'cs_x' };

    it('reintenta ante 500 y devuelve OK si un intento posterior tiene éxito', async () => {
      vi.useFakeTimers();
      try {
        let llamada = 0;
        axios.request.mockImplementation(async () => {
          llamada += 1;
          if (llamada < 3) return { status: 500, data: null, headers: {} };
          return { status: 200, data: [{ id: 1 }], headers: {} };
        });
        const p = wooFetchConReintento(cfg, '/products?per_page=1');
        await vi.runAllTimersAsync();
        const resp = await p;
        expect(resp.status).toBe(200);
        expect(llamada).toBe(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it('agota los reintentos y tira si el 500/503 persiste (no cuelga para siempre)', async () => {
      vi.useFakeTimers();
      try {
        axios.request.mockResolvedValue({ status: 503, data: null, headers: {} });
        // Enganchar el matcher de rechazo ANTES de avanzar los timers falsos: si el
        // rechazo real ocurre durante runAllTimersAsync sin que nada esté "escuchando"
        // todavía la promesa, Node lo marca como unhandled rejection (contamina otros
        // tests del archivo, aunque este test en sí pase).
        const esperado = expect(wooFetchConReintento(cfg, '/products?per_page=1'))
          .rejects.toThrow('WooCommerce API error 503');
        await vi.runAllTimersAsync();
        await esperado;
        expect(axios.request).toHaveBeenCalledTimes(4); // 1 intento + 3 reintentos
      } finally {
        vi.useRealTimers();
      }
    });

    it('NO reintenta un 404 — falla en el primer intento (no es un error transitorio)', async () => {
      axios.request.mockResolvedValue({ status: 404, data: null, headers: {} });
      await expect(wooFetchConReintento(cfg, '/products/999')).rejects.toThrow('WooCommerce API error 404');
      expect(axios.request).toHaveBeenCalledTimes(1);
    });

    // Test de CABLEADO (hallazgo del revisor): los tests de arriba prueban wooFetchConReintento
    // aislada — este prueba que _refrescarCatalogo de verdad la usa en el loop de /products.
    // Si alguien revierte routes/woo.js:205 a wooFetch a secas, este test detecta la
    // regresión; los de arriba no la detectarían.
    it('refrescarCatalogo sobrevive a un 500 transitorio en /products y persiste el catálogo completo', async () => {
      vi.useFakeTimers();
      try {
        let llamada = 0;
        axios.request.mockImplementation(async () => {
          llamada += 1;
          if (llamada === 1) return { status: 500, data: null, headers: {} };
          return {
            status: 200,
            headers: {},
            data: [{ id: 20, name: 'Producto resiliente', sku: 'RES-1', type: 'simple', parent_id: 0, stock_quantity: 3 }],
          };
        });
        const db = openDb(TEST_DB);
        const p = refrescarCatalogo(db, cfg);
        await vi.runAllTimersAsync();
        await p;

        const fila = db.prepare('SELECT sku FROM catalogo_cache WHERE id_woo=?').get(20);
        expect(fila?.sku).toBe('RES-1'); // antes del fix, el 500 abortaba el ciclo y esto quedaba undefined
        expect(llamada).toBe(2); // 1 falla + 1 reintento exitoso, sin agotar el backoff completo
        db.close();
      } finally {
        vi.useRealTimers();
      }
    });
  });


  describe('Hito 3 — Retry-After, categorización, circuit breaker, métricas e incidentes (2026-08-27)', () => {
    const cfg = { url: 'https://fusionbikes.com.ar', ck: 'ck_x', cs: 'cs_x' };
    let db;
    beforeEach(() => { db = openDb(TEST_DB); vi.clearAllMocks(); _resetCircuitoWooParaTests(); });
    afterEach(() => { db.close(); if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); _resetCircuitoWooParaTests(); });

    describe('Retry-After', () => {
      // Estos tests verifican el valor REAL del backoff (piso de 500 ms): sin la espera rápida
      // de la suite (lib/esperas.js).
      let esperasRapidas;
      beforeEach(() => { esperasRapidas = process.env.FUSION_ESPERAS_RAPIDAS; delete process.env.FUSION_ESPERAS_RAPIDAS; });
      afterEach(() => { if (esperasRapidas !== undefined) process.env.FUSION_ESPERAS_RAPIDAS = esperasRapidas; });

      it('respeta Retry-After en segundos en vez del backoff fijo', async () => {
        vi.useFakeTimers();
        try {
          let llamada = 0;
          axios.request.mockImplementation(async () => {
            llamada += 1;
            if (llamada === 1) return { status: 429, data: null, headers: { 'retry-after': '2' } };
            return { status: 200, data: [], headers: {} };
          });
          const p = wooFetchConReintento(cfg, '/products?per_page=1');
          await vi.advanceTimersByTimeAsync(1999);
          expect(llamada).toBe(1); // todavía no pasaron los 2s pedidos
          await vi.advanceTimersByTimeAsync(2);
          await p;
          expect(llamada).toBe(2);
        } finally {
          vi.useRealTimers();
        }
      });

      it('un Retry-After más largo que el techo razonable aborta en vez de bloquear el ciclo', async () => {
        axios.request.mockResolvedValue({ status: 429, data: null, headers: { 'retry-after': '120' } }); // > RETRY_AFTER_MAX_MS (60s)
        await expect(wooFetchConReintento(cfg, '/products?per_page=1')).rejects.toThrow('WooCommerce API error 429');
        expect(axios.request).toHaveBeenCalledTimes(1); // ni siquiera intenta un reintento
      });

      it('sin header Retry-After, sigue usando el backoff fijo (comportamiento previo intacto)', async () => {
        vi.useFakeTimers();
        try {
          let llamada = 0;
          axios.request.mockImplementation(async () => {
            llamada += 1;
            if (llamada === 1) return { status: 429, data: null, headers: {} };
            return { status: 200, data: [], headers: {} };
          });
          const p = wooFetchConReintento(cfg, '/products?per_page=1');
          await vi.runAllTimersAsync();
          await p;
          expect(llamada).toBe(2);
        } finally {
          vi.useRealTimers();
        }
      });

      // Hallazgo BLOQUEANTE del revisor (B2): Number('') / Number('  ') / Number([]) dan 0
      // (no NaN), así que un header vacío o malformado pasaba el `>= 0` y devolvía 0ms — con
      // eso, el reintento dormía 0ms en vez del backoff, disparando 3 reintentos casi
      // inmediatos justo contra un Woo que pidió frenar.
      it('un Retry-After vacío o malformado NO dispara reintentos inmediatos (cae al backoff fijo)', async () => {
        vi.useFakeTimers();
        try {
          for (const valorMalformado of ['', '   ', '-5', 'no-es-una-fecha']) {
            let llamada = 0;
            const inicios = [];
            axios.request.mockImplementation(async () => {
              llamada += 1;
              inicios.push(Date.now());
              if (llamada === 1) return { status: 429, data: null, headers: { 'retry-after': valorMalformado } };
              return { status: 200, data: [], headers: {} };
            });
            const p = wooFetchConReintento(cfg, '/products?per_page=1');
            await vi.runAllTimersAsync();
            await p;
            expect(llamada).toBe(2);
            // Con fake timers, si hubiera dormido 0ms el segundo intento ocurriría en el mismo
            // tick — el backoff fijo (500ms el primer intento) garantiza una diferencia real.
            expect(inicios[1] - inicios[0]).toBeGreaterThanOrEqual(500);
          }
        } finally {
          vi.useRealTimers();
        }
      });

      it('un Retry-After:"0" (legal, "reintentá ya") respeta igual el piso del backoff normal', async () => {
        vi.useFakeTimers();
        try {
          let llamada = 0;
          const inicios = [];
          axios.request.mockImplementation(async () => {
            llamada += 1;
            inicios.push(Date.now());
            if (llamada === 1) return { status: 429, data: null, headers: { 'retry-after': '0' } };
            return { status: 200, data: [], headers: {} };
          });
          const p = wooFetchConReintento(cfg, '/products?per_page=1');
          await vi.runAllTimersAsync();
          await p;
          expect(inicios[1] - inicios[0]).toBeGreaterThanOrEqual(500);
        } finally {
          vi.useRealTimers();
        }
      });
    });

    describe('categorizarErrorWoo', () => {
      it('clasifica 429 como rate_limit, 401/403 como auth, 5xx como transitorio, 400/404 como datos', async () => {
        const casos = [
          [429, 'rate_limit'], [401, 'auth'], [403, 'auth'],
          [500, 'transitorio'], [503, 'transitorio'],
          [400, 'datos'], [404, 'datos'], [422, 'datos'],
        ];
        for (const [status, esperado] of casos) {
          axios.request.mockResolvedValue({ status, data: null, headers: {} });
          try { await wooFetch(cfg, '/x'); } catch (e) {
            expect(categorizarErrorWoo(e)).toBe(esperado);
          }
        }
      });

      it('una excepción sin status HTTP (red/timeout) se clasifica como transitorio', () => {
        expect(categorizarErrorWoo(new Error('ECONNRESET'))).toBe('transitorio');
      });

      it('sigue funcionando con errores viejos que no tienen .status (solo el mensaje con el número)', () => {
        // Compatibilidad hacia atrás: mocks existentes en otros archivos de test construyen
        // `new Error('WooCommerce API error 500')` a mano, sin `.status`.
        expect(categorizarErrorWoo(new Error('WooCommerce API error 500'))).toBe('transitorio');
        expect(categorizarErrorWoo(new Error('WooCommerce API error 404'))).toBe('datos');
      });

      // Hallazgo del revisor (A5): un error con `.categoria` ya calculada (ej. el circuito
      // abierto, que sintetiza un error propio sin `.status` real) se respeta tal cual en vez
      // de inferirla — más precisa que cualquier heurística por status/mensaje.
      it('respeta e.categoria si ya viene calculada, sin importar el status/mensaje', () => {
        const err = new Error('Circuito de WooCommerce abierto...');
        err.categoria = 'rate_limit';
        expect(categorizarErrorWoo(err)).toBe('rate_limit');
      });
    });

    describe('circuit breaker (wooFetchConCircuito)', () => {
      // Un 500 dispara el backoff completo de wooFetchConReintento ([500,1500,4000]ms reales
      // por llamada) — con fake timers, cada "llamada que falla" de este describe se resuelve
      // en microsegundos en vez de ~6s reales × N llamadas.
      async function fallaTransitoria() {
        const p = wooFetchConCircuito(cfg, '/x').catch(e => e);
        await vi.runAllTimersAsync();
        const err = await p;
        expect(err).toBeInstanceOf(Error);
      }

      // Hallazgo del revisor (MEDIO-2, 4ta pasada): el mecanismo de generación (M6+MEDIO-2)
      // llevaba 3 pasadas sin un test que protegiera específicamente el caso M6 — revertir
      // `_circuitoWoo.abiertoHasta = 0` a incondicional (deshaciendo el guard de generación)
      // dejaba el resto de la suite en verde igual.
      it('un éxito tardío de un worker que arrancó ANTES de la apertura no cierra el circuito', async () => {
        vi.useFakeTimers();
        try {
          let resolverLlamadaVieja;
          const llamadaVieja = new Promise((resolve) => { resolverLlamadaVieja = resolve; });
          // Worker "viejo": arranca con el circuito cerrado (generación 0), pero su respuesta
          // queda pendiente — simula una llamada en vuelo cuando otros workers abren el circuito.
          axios.request.mockImplementationOnce(() => llamadaVieja);
          const pViejo = wooFetchConCircuito(cfg, '/x').catch(e => e);

          // Otros 5 workers fallan y abren el circuito (nueva generación) mientras el viejo sigue en vuelo.
          axios.request.mockResolvedValue({ status: 500, data: null, headers: {} });
          for (let i = 0; i < 5; i++) await fallaTransitoria();
          expect(circuitoWooAbierto()).toBe(true);

          // Ahora el worker viejo por fin responde 200 — de una generación ya vieja.
          resolverLlamadaVieja({ status: 200, data: [], headers: {} });
          await vi.runAllTimersAsync();
          await pViejo;

          expect(circuitoWooAbierto()).toBe(true); // NO debe haberse cerrado por el éxito tardío
        } finally {
          vi.useRealTimers();
        }
      });

      it('tras 5 fallos transitorios consecutivos, la siguiente llamada NO sale a la red', async () => {
        vi.useFakeTimers();
        try {
          axios.request.mockResolvedValue({ status: 500, data: null, headers: {} });
          for (let i = 0; i < 5; i++) await fallaTransitoria();

          axios.request.mockClear();
          await expect(wooFetchConCircuito(cfg, '/x')).rejects.toThrow(/[Cc]ircuito/);
          expect(axios.request).not.toHaveBeenCalled(); // el circuito cortó antes de la red
        } finally {
          vi.useRealTimers();
        }
      });

      it('manual:true saltea el circuito abierto (un admin que aprieta "recargar" no espera al sistema)', async () => {
        vi.useFakeTimers();
        try {
          axios.request.mockResolvedValue({ status: 500, data: null, headers: {} });
          for (let i = 0; i < 5; i++) await fallaTransitoria();

          axios.request.mockClear();
          axios.request.mockResolvedValue({ status: 200, data: [], headers: {} });
          const resp = await wooFetchConCircuito(cfg, '/x', 'get', null, { manual: true });
          expect(resp.status).toBe(200);
          expect(axios.request).toHaveBeenCalledTimes(1); // sí salió a la red pese al circuito abierto
        } finally {
          vi.useRealTimers();
        }
      });

      // Hallazgo del revisor (MEDIO-2, 3ra pasada): la primera versión de M6 solo comparaba
      // contra `Date.now() >= abiertoHasta`, así que un éxito DELIBERADO de una prueba manual
      // (mientras el circuito seguía abierto) quedaba indistinguible de un éxito TARDÍO de un
      // worker paralelo — ninguno cerraba el circuito hasta que el cooldown venciera solo,
      // pese a tener en la mano la prueba de que Woo ya respondía bien.
      it('un éxito manual mientras el circuito está abierto SÍ lo cierra (no solo lo saltea)', async () => {
        vi.useFakeTimers();
        try {
          axios.request.mockResolvedValue({ status: 500, data: null, headers: {} });
          for (let i = 0; i < 5; i++) await fallaTransitoria();
          expect(circuitoWooAbierto()).toBe(true);

          axios.request.mockClear();
          axios.request.mockResolvedValue({ status: 200, data: [], headers: {} });
          await wooFetchConCircuito(cfg, '/x', 'get', null, { manual: true });

          // El circuito ya no debe seguir abierto: un solo fallo aislado después no debería
          // reabrirlo de entrada (fallosConsecutivos quedó en 0, no en el umbral - 1).
          expect(circuitoWooAbierto()).toBe(false);
          axios.request.mockClear();
          axios.request.mockResolvedValue({ status: 500, data: null, headers: {} });
          await fallaTransitoria();
          expect(circuitoWooAbierto()).toBe(false); // 1 solo fallo no alcanza para reabrir
        } finally {
          vi.useRealTimers();
        }
      });

      it('un éxito resetea el contador de fallos consecutivos', async () => {
        vi.useFakeTimers();
        try {
          axios.request.mockResolvedValue({ status: 500, data: null, headers: {} });
          for (let i = 0; i < 4; i++) await fallaTransitoria(); // 4, uno menos que el umbral

          axios.request.mockReset();
          axios.request.mockResolvedValue({ status: 200, data: [], headers: {} });
          await wooFetchConCircuito(cfg, '/x'); // éxito: resetea

          axios.request.mockResolvedValue({ status: 500, data: null, headers: {} });
          for (let i = 0; i < 4; i++) await fallaTransitoria(); // otros 4 — sin el reset, esto abriría el circuito

          axios.request.mockClear();
          axios.request.mockResolvedValue({ status: 200, data: [], headers: {} });
          const resp = await wooFetchConCircuito(cfg, '/x'); // si el circuito estuviera abierto, esto rechazaría sin red
          expect(resp.status).toBe(200);
          expect(axios.request).toHaveBeenCalledTimes(1);
        } finally {
          vi.useRealTimers();
        }
      });

      it('errores de "datos" (4xx normales) NO cuentan para abrir el circuito', async () => {
        axios.request.mockResolvedValue({ status: 404, data: null, headers: {} });
        for (let i = 0; i < 10; i++) { // muchos más que el umbral de 5
          await expect(wooFetchConCircuito(cfg, '/x')).rejects.toThrow();
        }
        axios.request.mockClear();
        axios.request.mockResolvedValue({ status: 200, data: [], headers: {} });
        const resp = await wooFetchConCircuito(cfg, '/x');
        expect(resp.status).toBe(200);
        expect(axios.request).toHaveBeenCalledTimes(1); // el circuito nunca se abrió
      });
    });

    describe('métricas de ciclo + incidentes', () => {
      it('un ciclo exitoso escribe una fila en metricas_ciclo_sync con procesados>0 y fallidos=0', async () => {
        axios.request.mockResolvedValue({
          status: 200, headers: {},
          data: [{ id: 30, name: 'Prod', sku: 'FB-30', type: 'simple', parent_id: 0, stock_quantity: 1 }],
        });
        await refrescarCatalogo(db, cfg);

        const fila = db.prepare("SELECT * FROM metricas_ciclo_sync WHERE integracion='woocommerce' ORDER BY id DESC LIMIT 1").get();
        expect(fila).toBeTruthy();
        expect(fila.proceso).toBe('refrescar_catalogo');
        expect(fila.procesados).toBeGreaterThan(0);
        expect(fila.fallidos).toBe(0);
        expect(fila.duracion_ms).toBeGreaterThanOrEqual(0);
      });

      it('un ciclo fallido escribe fallidos=1 y ABRE un incidente clasificado', async () => {
        axios.request.mockResolvedValue({ status: 500, data: null, headers: {} });
        await expect(refrescarCatalogo(db, cfg)).rejects.toThrow();

        const metrica = db.prepare("SELECT * FROM metricas_ciclo_sync WHERE integracion='woocommerce' ORDER BY id DESC LIMIT 1").get();
        expect(metrica.fallidos).toBe(1);

        const incidente = db.prepare(
          "SELECT * FROM incidentes_operativos WHERE integracion='woocommerce' AND proceso='refrescar_catalogo' AND estado='activo'"
        ).get();
        expect(incidente).toBeTruthy();
        expect(incidente.tipo_error).toBe('transitorio');
      }, 10000);

      it('un ciclo sano DESPUÉS de uno fallido resuelve el incidente activo', async () => {
        axios.request.mockResolvedValue({ status: 500, data: null, headers: {} });
        await expect(refrescarCatalogo(db, cfg)).rejects.toThrow();
        expect(db.prepare("SELECT estado FROM incidentes_operativos WHERE integracion='woocommerce'").get().estado).toBe('activo');

        axios.request.mockReset();
        axios.request.mockResolvedValue({
          status: 200, headers: {},
          data: [{ id: 31, name: 'Prod', sku: 'FB-31', type: 'simple', parent_id: 0, stock_quantity: 1 }],
        });
        await refrescarCatalogo(db, cfg);

        expect(db.prepare("SELECT estado FROM incidentes_operativos WHERE integracion='woocommerce'").get().estado).toBe('resuelto');
      }, 20000);

      it('reincidir con el mismo tipo de error incrementa el contador en vez de duplicar el incidente', async () => {
        axios.request.mockResolvedValue({ status: 500, data: null, headers: {} });
        await expect(refrescarCatalogo(db, cfg)).rejects.toThrow();
        await expect(refrescarCatalogo(db, cfg)).rejects.toThrow();

        const total = db.prepare("SELECT COUNT(*) n FROM incidentes_operativos WHERE integracion='woocommerce'").get().n;
        expect(total).toBe(1);
        const fila = db.prepare("SELECT contador_repeticiones FROM incidentes_operativos WHERE integracion='woocommerce'").get();
        expect(fila.contador_repeticiones).toBe(2);
      }, 20000);

      // Hallazgo BLOQUEANTE del revisor (B1): un barrido COMPLETO con 0 productos (el guard
      // fail-closed) caía en la rama de ÉXITO y resolvía cualquier incidente activo en
      // silencio — justo el caso ("Woo fallando en silencio") que este sistema existe para
      // detectar quedaba marcado como "recuperado" sin haberse recuperado.
      it('un ciclo COMPLETO con 0 productos (guard sospechoso) NO resuelve un incidente activo', async () => {
        // Primero, un fallo real que abre un incidente.
        axios.request.mockResolvedValue({ status: 500, data: null, headers: {} });
        await expect(refrescarCatalogo(db, cfg, { forzarCompleto: true })).rejects.toThrow();
        expect(db.prepare("SELECT estado FROM incidentes_operativos WHERE integracion='woocommerce'").get().estado).toBe('activo');

        // Ahora Woo "responde" 200 pero con el catálogo vacío (el caso sospechoso).
        axios.request.mockReset();
        axios.request.mockResolvedValue({ status: 200, data: [], headers: {} });
        const resultado = await refrescarCatalogo(db, cfg, { forzarCompleto: true });

        expect(resultado).toMatchObject({ total: 0, sospechoso: true });
        // El incidente del 500 real sigue activo — NO se confirmó ciclo sano por esto.
        expect(db.prepare("SELECT estado FROM incidentes_operativos WHERE integracion='woocommerce'").get().estado).toBe('activo');
      }, 20000);

      // Hallazgo del revisor (M2, BAJO-5 en la 3ra pasada): el fix de M2 no tenía test propio
      // — un revert accidental a tipoError:'datos' (el bug original que este fix cerró)
      // pasaba en verde igual, porque el test de arriba solo verifica la forma del resultado.
      it('el incidente de catálogo vacío usa la clave de dedupe catalogo_vacio, no datos', async () => {
        axios.request.mockResolvedValue({ status: 200, data: [], headers: {} });
        const resultado = await refrescarCatalogo(db, cfg, { forzarCompleto: true });
        expect(resultado).toMatchObject({ total: 0, sospechoso: true });
        const incidente = db.prepare("SELECT tipo_error FROM incidentes_operativos WHERE integracion='woocommerce'").get();
        expect(incidente.tipo_error).toBe('catalogo_vacio');
      });

      // Hallazgo del revisor (M5, 2da pasada): un incremental con 0 productos es tan
      // ambiguo como el caso completo de B1 (¿nada cambió, o Woo está degradado en
      // silencio?) — confirmar ciclo sano en ese caso resolvía en silencio un incidente
      // `transitorio` real que seguía activo, con Woo simplemente pasando de tirar 500s a
      // responder 200 con lista vacía en vez de recuperarse de verdad.
      it('un incremental con 0 productos tampoco resuelve un incidente activo', async () => {
        vi.useFakeTimers();
        try {
          // Simula que ya corrió un completo hace instantes para forzar el camino incremental.
          const ahora = new Date().toISOString();
          for (const clave of ['catalogo_ultimo_completo', 'catalogo_ultimo_refresco']) {
            db.prepare(`INSERT INTO sync_estado (clave, valor, actualizado_en) VALUES (?, ?, ?)
              ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en`)
              .run(clave, ahora, ahora);
          }
          axios.request.mockResolvedValue({ status: 500, data: null, headers: {} });
          await fallaRefresco();
          expect(db.prepare("SELECT estado FROM incidentes_operativos WHERE integracion='woocommerce'").get().estado).toBe('activo');

          axios.request.mockResolvedValue({ status: 200, headers: {}, data: [] });
          const total = await refrescarCatalogo(db, cfg);
          expect(total).toBe(0);
          expect(db.prepare("SELECT estado FROM incidentes_operativos WHERE integracion='woocommerce'").get().estado).toBe('activo');
        } finally {
          vi.useRealTimers();
        }
      }, 20000);

      // Hallazgo del revisor (A3): categorizarErrorWoo nunca devuelve 'interno' por sí sola —
      // sin esta distinción en refrescarCatalogo, un bug PROPIO (no un error de Woo) se
      // reportaba como "WooCommerce no responde", mandando al operador a mirar el lugar
      // equivocado.
      it('un bug propio (no un error de Woo) se clasifica como interno, no transitorio', async () => {
        // status 200 (no pasa por el throw de wooFetch) pero data=null: `resp.data.length`
        // explota con un TypeError propio, no un error HTTP de Woo.
        axios.request.mockResolvedValue({ status: 200, headers: {}, data: null });
        await expect(refrescarCatalogo(db, cfg)).rejects.toThrow(TypeError);

        const incidente = db.prepare("SELECT tipo_error FROM incidentes_operativos WHERE integracion='woocommerce'").get();
        // Si esto da 'transitorio', la excepción SÍ tenía forma de error HTTP de Woo — el test
        // no estaría probando el camino 'interno'. Documentado como guía de mantenimiento.
        expect(incidente.tipo_error).toBe('interno');
      });

      // Hallazgo del revisor (A1, 2da pasada — regresión introducida por el fix de A3):
      // la primera versión de A3 usaba una allowlist ("¿tiene status/circuitoAbierto/matchea
      // el mensaje de Woo?") para decidir 'interno' — pero un timeout real de axios (o un
      // ECONNRESET) no tiene `.status` (axios solo lo setea si hubo respuesta HTTP) y no
      // matchea "WooCommerce API error N", así que el outage más común de Woo (la red, no un
      // status code) terminaba reportado como 'interno' ("bug propio") en vez de
      // 'transitorio' — justo el diagnóstico que este hito existe para acertar.
      it('un timeout de red real (sin status) se clasifica como transitorio, no interno', async () => {
        const timeoutErr = Object.assign(new Error('timeout of 20000ms exceeded'), { code: 'ECONNABORTED' });
        axios.request.mockRejectedValue(timeoutErr);
        await expect(refrescarCatalogo(db, cfg)).rejects.toThrow('timeout of 20000ms exceeded');

        const incidente = db.prepare("SELECT tipo_error FROM incidentes_operativos WHERE integracion='woocommerce'").get();
        expect(incidente.tipo_error).toBe('transitorio');
      }, 20000);

      // Hallazgo del revisor (MEDIO-1, 3ra pasada, sin test propio hasta la 4ta): un WOO_URL
      // sin HTTPS (típico tras un deploy con .env mal cargado) es un error de configuración
      // permanente, no un problema de Woo — debe reportarse distinto de 'transitorio'/'interno'
      // y nunca debe abrir el circuit breaker (no dice nada sobre la salud del servicio).
      it('un WOO_URL sin HTTPS se clasifica como config, crítico, y no abre el circuito', async () => {
        const cfgInvalida = { ...cfg, url: 'http://fusionbikes.com.ar' };
        axios.request.mockResolvedValue({ status: 200, data: [], headers: {} }); // no debería ni llegar a llamarse
        await expect(refrescarCatalogo(db, cfgInvalida)).rejects.toThrow('WooCommerce URL debe usar HTTPS');

        const incidente = db.prepare("SELECT tipo_error, severidad FROM incidentes_operativos WHERE integracion='woocommerce'").get();
        expect(incidente.tipo_error).toBe('config');
        expect(incidente.severidad).toBe('critico');
        expect(circuitoWooAbierto()).toBe(false);
      });

      // Hallazgo del revisor (A4): test de CABLEADO — si alguien revierte los 2 call sites
      // internos de wooFetchConCircuito a wooFetchConReintento a secas, el circuito queda
      // desconectado en silencio y toda la suite anterior de "circuit breaker" (que llama
      // wooFetchConCircuito directo) sigue en verde igual. Este test pasa por refrescarCatalogo
      // de punta a punta para detectar esa regresión.
      async function fallaRefresco(opts) {
        const p = refrescarCatalogo(db, cfg, opts).catch(e => e);
        await vi.runAllTimersAsync();
        return p;
      }

      it('CABLEADO: refrescarCatalogo abre el circuito tras fallos sostenidos y bloquea sin salir a red', async () => {
        vi.useFakeTimers();
        try {
          axios.request.mockResolvedValue({ status: 500, data: null, headers: {} });
          for (let i = 0; i < 5; i++) expect(await fallaRefresco()).toBeInstanceOf(Error);

          axios.request.mockClear();
          const err = await fallaRefresco();
          expect(err.message).toMatch(/[Cc]ircuito/);
          expect(axios.request).not.toHaveBeenCalled(); // si no estuviera cableado, esto saldría a la red
        } finally {
          vi.useRealTimers();
        }
      });

      it('CABLEADO: forzarCompleto:true saltea el circuito abierto (el botón manual sí sale a la red)', async () => {
        vi.useFakeTimers();
        try {
          axios.request.mockResolvedValue({ status: 500, data: null, headers: {} });
          for (let i = 0; i < 5; i++) expect(await fallaRefresco()).toBeInstanceOf(Error);

          axios.request.mockClear();
          axios.request.mockResolvedValue({ status: 200, data: [], headers: {} });
          const p = refrescarCatalogo(db, cfg, { forzarCompleto: true });
          await vi.runAllTimersAsync();
          await p;
          expect(axios.request).toHaveBeenCalled(); // sí salió a la red pese al circuito abierto
        } finally {
          vi.useRealTimers();
        }
      });

      // Hallazgo del revisor (A5): con el circuito abierto por rate_limit sostenido, el
      // incidente reportado debía decir 'rate_limit', no 'transitorio' (el error sintético del
      // circuito no tiene .status real).
      it('CABLEADO: el incidente abierto por el circuito conserva la categoría real (rate_limit), no "transitorio" genérico', async () => {
        vi.useFakeTimers();
        try {
          axios.request.mockResolvedValue({ status: 429, data: null, headers: {} });
          for (let i = 0; i < 5; i++) expect(await fallaRefresco()).toBeInstanceOf(Error);

          axios.request.mockClear();
          const err = await fallaRefresco();
          expect(err.message).toMatch(/[Cc]ircuito/);

          const incidente = db.prepare(
            "SELECT tipo_error FROM incidentes_operativos WHERE integracion='woocommerce' ORDER BY id DESC LIMIT 1"
          ).get();
          expect(incidente.tipo_error).toBe('rate_limit');
        } finally {
          vi.useRealTimers();
        }
      });
    });
  });

  it('refrescarCatalogo writes fetched products into catalogo_cache', async () => {
    axios.request.mockResolvedValue({
      status: 200,
      headers: {},
      data: [{ id: 10, name: 'Casco Bell L', sku: 'CBL', type: 'simple', parent_id: 0, stock_quantity: 4 }]
    });
    const db = openDb(TEST_DB);
    const cfg = { url: 'https://fusionbikes.com.ar', ck: 'ck_x', cs: 'cs_x' };
    await refrescarCatalogo(db, cfg);
    const rows = getCatalogo(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].nombre).toBe('Casco Bell L');
    db.close();
  });

  // Hallazgo del revisor (2026-08-03): el contado de una venta ML se calcula sobre el precio
  // de LISTA (regular_price), no sobre el vigente (que puede ser sale_price en oferta).
  // refrescarCatalogo tiene que persistir regular_price por separado de precio.
  it('refrescarCatalogo persiste regular_price (precio de LISTA) separado de precio (vigente)', async () => {
    axios.request.mockResolvedValue({
      status: 200,
      headers: {},
      data: [{
        id: 16, name: 'Bici en oferta', sku: 'BO-1', type: 'simple', parent_id: 0,
        stock_quantity: 2, price: '800000', regular_price: '1000000',
      }],
    });
    const db = openDb(TEST_DB);
    const cfg = { url: 'https://fusionbikes.com.ar', ck: 'ck_x', cs: 'cs_x' };
    await refrescarCatalogo(db, cfg);
    const fila = db.prepare('SELECT precio, regular_price FROM catalogo_cache WHERE id_woo = 16').get();
    expect(fila.precio).toBe(800000);
    expect(fila.regular_price).toBe(1000000);
    db.close();
  });

  it('refrescarCatalogo borra de catalogo_cache los productos que ya no vienen en WooCommerce (borrados)', async () => {
    // Incidente real 2026-07-25: dos productos borrados en WooCommerce hacía tiempo seguían
    // en catalogo_cache para siempre (el upsert solo agrega/actualiza, nunca borraba), y
    // terminaron compartiendo SKU con un producto real vigente — WooCommerce no permite SKUs
    // duplicados de verdad, así que esa fila fantasma solo podía venir de un borrado no
    // limpiado. refrescarCatalogo ahora debe podar lo que no vino en el fetch actual.
    const db = openDb('./test/tmp-woo.sqlite');
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, actualizado_en) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(999, 'Producto borrado en WC hace tiempo', 'CBL', 'simple', null, 3, now);

    axios.request.mockResolvedValue({
      status: 200,
      headers: {},
      data: [{ id: 10, name: 'Casco Bell L', sku: 'CBL', type: 'simple', parent_id: 0, stock_quantity: 4 }]
    });
    const cfg = { url: 'https://fusionbikes.com.ar', ck: 'ck_x', cs: 'cs_x' };
    await refrescarCatalogo(db, cfg);

    const rows = getCatalogo(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].id_woo).toBe(10);
    const fantasma = db.prepare('SELECT * FROM catalogo_cache WHERE id_woo = 999').get();
    expect(fantasma).toBeUndefined();
    db.close();
  });

  it('refrescarCatalogo poda una variación fantasma (tipo=variation, con id_padre) igual que un producto simple', async () => {
    // La poda es por id_woo, no por tipo — pero hay que confirmar explícitamente que una
    // variación borrada en WC (que además arrastra id_padre) se limpia igual, y no queda
    // "protegida" por tener un padre que sí sigue vigente.
    const db = openDb('./test/tmp-woo.sqlite');
    const now = new Date().toISOString();
    // Variación fantasma: el padre (id_woo 5) sigue vigente, pero esta variación (id_woo 998)
    // ya no viene en el fetch.
    db.prepare(
      'INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, actualizado_en) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(998, 'Casco X — Rojo / M (borrada)', 'FB-998', 'variation', 5, 2, now);

    axios.request
      .mockResolvedValueOnce({ status: 200, headers: {}, data: [
        { id: 5, name: 'Casco X', sku: '', type: 'variable', parent_id: 0, stock_quantity: 0 },
      ] })
      .mockResolvedValueOnce({ status: 200, headers: {}, data: [
        { id: 21, sku: 'FB-21', stock_quantity: 3, attributes: [{ name: 'Color', option: 'Rojo' }] },
      ] })
      .mockResolvedValue({ status: 200, headers: {}, data: [] });
    const cfg = { url: 'https://fusionbikes.com.ar', ck: 'ck_x', cs: 'cs_x' };
    await refrescarCatalogo(db, cfg);

    const fantasma = db.prepare('SELECT * FROM catalogo_cache WHERE id_woo = 998').get();
    expect(fantasma).toBeUndefined();
    const vigente = db.prepare('SELECT * FROM catalogo_cache WHERE id_woo = 21').get();
    expect(vigente).toBeTruthy();
    db.close();
  });

  it('refrescarCatalogo poda filas fantasma aunque ninguna tenga SKU (SKU vacío/null no las protege)', async () => {
    // La poda usa id_woo NOT IN (...), no el SKU — confirma que un fantasma sin SKU (ej. un
    // producto 'variable' padre borrado, que nunca tiene SKU propio) se limpia igual.
    const db = openDb('./test/tmp-woo.sqlite');
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, actualizado_en) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(997, 'Producto variable borrado (sin SKU)', null, 'variable', null, 0, now);
    db.prepare(
      'INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, actualizado_en) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(996, 'Otro producto borrado (sin SKU)', '', 'simple', null, 0, now);

    axios.request.mockResolvedValue({
      status: 200,
      headers: {},
      data: [{ id: 10, name: 'Casco Bell L', sku: 'CBL', type: 'simple', parent_id: 0, stock_quantity: 4 }]
    });
    const cfg = { url: 'https://fusionbikes.com.ar', ck: 'ck_x', cs: 'cs_x' };
    await refrescarCatalogo(db, cfg);

    const rows = getCatalogo(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].id_woo).toBe(10);
    db.close();
  });

  it('refrescarCatalogo NO borra catalogo_cache si WooCommerce responde 200 con 0 productos (fail-closed)', async () => {
    // Hallazgo del revisor: "id_woo NOT IN (<conjunto vacío>)" es siempre verdadero en SQL —
    // sin este guard, un fetch de 0 productos (corte/permiso raro en WC, sin ser un error que
    // wooFetch propague) borraría el 100% del catálogo real en la próxima poda.
    const db = openDb('./test/tmp-woo.sqlite');
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, actualizado_en) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(10, 'Casco Bell L', 'CBL', 'simple', null, 4, now);

    axios.request.mockResolvedValue({ status: 200, headers: {}, data: [] });
    const cfg = { url: 'https://fusionbikes.com.ar', ck: 'ck_x', cs: 'cs_x' };
    await refrescarCatalogo(db, cfg);

    const rows = getCatalogo(db);
    expect(rows).toHaveLength(1); // el producto real previo sigue ahí, no se vació el catálogo
    expect(rows[0].id_woo).toBe(10);
    db.close();
  });

  it('el guard de fetch vacío es solo para esa corrida: la corrida siguiente con datos reales poda normalmente', async () => {
    // El guard evita que UN fetch vacío borre todo el catálogo, pero no debe dejarlo
    // "congelado" para siempre: en cuanto WooCommerce vuelve a responder con productos
    // reales, la poda normal debe seguir funcionando y limpiar lo que ya no viene.
    const db = openDb('./test/tmp-woo.sqlite');
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, actualizado_en) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(10, 'Casco Bell L', 'CBL', 'simple', null, 4, now);
    db.prepare(
      'INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, actualizado_en) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(999, 'Producto borrado en WC hace tiempo', 'CBL', 'simple', null, 3, now);
    const cfg = { url: 'https://fusionbikes.com.ar', ck: 'ck_x', cs: 'cs_x' };

    // Corrida 1: WC responde 0 productos (corte/permiso raro) -> guard, no se toca nada.
    axios.request.mockResolvedValueOnce({ status: 200, headers: {}, data: [] });
    await refrescarCatalogo(db, cfg);
    expect(getCatalogo(db)).toHaveLength(2); // ambos siguen ahí, incluido el fantasma

    // Corrida 2: WC vuelve a responder con productos reales -> la poda debe correr normal.
    axios.request.mockResolvedValueOnce({
      status: 200, headers: {},
      data: [{ id: 10, name: 'Casco Bell L', sku: 'CBL', type: 'simple', parent_id: 0, stock_quantity: 4 }]
    });
    await refrescarCatalogo(db, cfg);
    const rows = getCatalogo(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].id_woo).toBe(10);
    const fantasma = db.prepare('SELECT * FROM catalogo_cache WHERE id_woo = 999').get();
    expect(fantasma).toBeUndefined();
    db.close();
  });

  it('refrescarCatalogo persiste atributos estructurados de variaciones (H-06)', async () => {
    axios.request
      .mockResolvedValueOnce({ status: 200, headers: {}, data: [
        { id: 20, name: 'Casco X', sku: '', type: 'variable', parent_id: 0, stock_quantity: 0 },
      ] })
      .mockResolvedValueOnce({ status: 200, headers: {}, data: [
        { id: 21, sku: 'FB-21', stock_quantity: 3, attributes: [
          { name: 'Color', option: 'Rojo' }, { name: 'Talle', option: 'M' },
        ] },
      ] })
      .mockResolvedValue({ status: 200, headers: {}, data: [] });
    const db = openDb(TEST_DB);
    await refrescarCatalogo(db, { url: 'https://fusionbikes.com.ar', ck: 'x', cs: 'y' });
    const v = getCatalogo(db).find(r => r.sku === 'FB-21');
    expect(v).toBeTruthy();
    expect(JSON.parse(v.atributos_json)).toEqual([
      { name: 'Color', option: 'Rojo' }, { name: 'Talle', option: 'M' },
    ]);
    db.close();
  });

  it('refrescarCatalogo persiste la marca desde brands', async () => {
    axios.request.mockResolvedValue({
      status: 200, headers: {},
      data: [{ id: 40, name: 'Cinta SUPACAZ', sku: 'FB-40', type: 'simple', parent_id: 0,
        stock_quantity: 2, brands: [{ id: 9, name: 'SUPACAZ', slug: 'supacaz' }] }],
    });
    const db = openDb(TEST_DB);
    await refrescarCatalogo(db, { url: 'https://fusionbikes.com.ar', ck: 'x', cs: 'y' });
    const row = getCatalogo(db).find(r => r.sku === 'FB-40');
    expect(row.marca).toBe('SUPACAZ');
    db.close();
  });

  it('getCatalogo respeta limit/offset (tope defensivo)', () => {
    const db = openDb(TEST_DB);
    const now = new Date().toISOString();
    const ins = db.prepare('INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, stock, actualizado_en) VALUES (?,?,?,?,?,?)');
    for (let i = 1; i <= 5; i++) ins.run(i, 'P' + i, 'FB-' + i, 'simple', 1, now);
    expect(getCatalogo(db)).toHaveLength(5);          // sin límite explícito: todo
    expect(getCatalogo(db, { limit: 2 })).toHaveLength(2);
    expect(getCatalogo(db, { limit: 2, offset: 4 })).toHaveLength(1);
    db.close();
  });

  // Helper: mockea axios ruteando por URL. `variables` es un mapa id -> array de variaciones.
  // Cuenta llamadas concurrentes a endpoints de variaciones para verificar el límite.
  function mockCatalogoConVariables(variables, { fallarId = null, tracker = null } = {}) {
    const padres = Object.keys(variables).map((id) => ({
      id: Number(id), name: 'Padre ' + id, sku: '', type: 'variable', parent_id: 0, stock_quantity: 0,
    }));
    axios.request.mockImplementation(async ({ url }) => {
      // Listado de productos
      const mProducts = url.match(/\/products\?per_page=100&page=(\d+)/);
      if (mProducts) {
        const page = Number(mProducts[1]);
        return { status: 200, headers: {}, data: page === 1 ? padres : [] };
      }
      // Variaciones de un padre
      const mVar = url.match(/\/products\/(\d+)\/variations\?per_page=100&page=(\d+)/);
      if (mVar) {
        const id = Number(mVar[1]);
        const page = Number(mVar[2]);
        if (tracker) {
          tracker.enVuelo++;
          tracker.max = Math.max(tracker.max, tracker.enVuelo);
        }
        // pequeña espera para que las tareas se solapen y el tracker mida concurrencia real
        await new Promise((r) => setTimeout(r, 5));
        if (tracker) tracker.enVuelo--;
        if (fallarId != null && id === fallarId) {
          return { status: 500, headers: {}, data: {} };
        }
        return { status: 200, headers: {}, data: page === 1 ? (variables[id] || []) : [] };
      }
      return { status: 200, headers: {}, data: [] };
    });
  }

  it('refrescarCatalogo paraleliza variaciones respetando WOO_CONCURRENCIA_MAX', async () => {
    // 10 productos variables, cada uno con 1 variación -> con límite 4 nunca debe haber >4 en vuelo
    const variables = {};
    for (let i = 1; i <= 10; i++) {
      variables[i] = [{ id: 100 + i, sku: 'FB-' + i, stock_quantity: 1, attributes: [] }];
    }
    const tracker = { enVuelo: 0, max: 0 };
    mockCatalogoConVariables(variables, { tracker });
    const db = openDb(TEST_DB);
    const total = await refrescarCatalogo(db, { url: 'https://fusionbikes.com.ar', ck: 'x', cs: 'y' });
    expect(tracker.max).toBeGreaterThan(1);         // efectivamente hubo paralelismo
    expect(tracker.max).toBeLessThanOrEqual(4);     // pero acotado a WOO_CONCURRENCIA_MAX
    // 10 padres + 10 variaciones persistidas
    expect(total).toBe(20);
    expect(getCatalogo(db)).toHaveLength(20);
    db.close();
  });

  it('refrescarCatalogo persiste TODAS las variaciones de todos los padres (equivalente al serial)', async () => {
    const variables = {
      1: [{ id: 201, sku: 'A-1', stock_quantity: 3, attributes: [] }, { id: 202, sku: 'A-2', stock_quantity: 1, attributes: [] }],
      2: [{ id: 203, sku: 'B-1', stock_quantity: 5, attributes: [] }],
    };
    mockCatalogoConVariables(variables);
    const db = openDb(TEST_DB);
    await refrescarCatalogo(db, { url: 'https://fusionbikes.com.ar', ck: 'x', cs: 'y' });
    const skus = getCatalogo(db).map((r) => r.sku).filter(Boolean).sort();
    expect(skus).toEqual(['A-1', 'A-2', 'B-1']);
    db.close();
  });

  it('refrescarCatalogo falla fail-closed si una variación falla (no persiste parcial)', async () => {
    const variables = {
      1: [{ id: 301, sku: 'OK-1', stock_quantity: 1, attributes: [] }],
      2: [{ id: 302, sku: 'BAD-2', stock_quantity: 1, attributes: [] }],
      3: [{ id: 303, sku: 'OK-3', stock_quantity: 1, attributes: [] }],
    };
    // fallarId:2 falla SIEMPRE (no un único 500 transitorio): con wooFetchConReintento
    // (incidente 2026-08-27) esa llamada agota sus 3 reintentos con backoff real
    // ([500,1500,4000]ms ≈ 6s) antes de fallar-cerrado — de ahí el timeout extendido.
    mockCatalogoConVariables(variables, { fallarId: 2 });
    const db = openDb(TEST_DB);
    await expect(
      refrescarCatalogo(db, { url: 'https://fusionbikes.com.ar', ck: 'x', cs: 'y' })
    ).rejects.toThrow(/WooCommerce API error 500/);
    // Como en el comportamiento serial anterior: si falla una llamada, no se persiste nada
    expect(getCatalogo(db)).toHaveLength(0);
    db.close();
  }, 10000);

  // Test de CABLEADO (hallazgo del revisor, 2026-08-27): los tests de wooFetchConReintento
  // aislada no detectan si el loop de variaciones deja de usarla. Si alguien revierte
  // routes/woo.js y ese loop vuelve a llamar `wooFetch` a secas, este test lo detecta —
  // el 500 transitorio (una sola vez) abortaría todo el refresco en vez de recuperarse.
  it('refrescarCatalogo sobrevive a un 500 transitorio en /products/{id}/variations y persiste el catálogo completo', async () => {
    vi.useFakeTimers();
    try {
      let llamadaVar = 0;
      axios.request.mockImplementation(async ({ url }) => {
        if (/\/products\?per_page=100&page=(\d+)/.test(url)) {
          const page = Number(url.match(/[?&]page=(\d+)/)[1]);
          return {
            status: 200, headers: {},
            data: page === 1 ? [{ id: 40, name: 'Padre', sku: '', type: 'variable', parent_id: 0, stock_quantity: 0 }] : [],
          };
        }
        if (/\/products\/40\/variations/.test(url)) {
          llamadaVar += 1;
          if (llamadaVar === 1) return { status: 500, headers: {}, data: {} };
          return {
            status: 200, headers: {},
            data: [{ id: 41, sku: 'RES-VAR-1', stock_quantity: 2, attributes: [] }],
          };
        }
        return { status: 200, headers: {}, data: [] };
      });
      const db = openDb(TEST_DB);
      const p = refrescarCatalogo(db, { url: 'https://fusionbikes.com.ar', ck: 'x', cs: 'y' });
      await vi.runAllTimersAsync();
      await p;

      const fila = db.prepare('SELECT sku FROM catalogo_cache WHERE id_woo=?').get(41);
      expect(fila?.sku).toBe('RES-VAR-1'); // antes del fix, el 500 abortaba el ciclo entero
      expect(llamadaVar).toBe(2); // 1 falla + 1 reintento exitoso
      db.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('openDb crea la tabla ean_sku', () => {
    const db = openDb(TEST_DB);
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ean_sku'").get();
    expect(t).toBeTruthy();
    db.close();
  });
});

// Paso 2 del plan 2026-08-10-codigos-frescura-y-catalogo-incremental.md: refresco incremental.
describe('refrescarCatalogo — modo incremental', () => {
  const TEST_DB2 = './test/tmp-woo-incremental.sqlite';
  const cfg = { url: 'https://fusionbikes.com.ar', ck: 'ck_x', cs: 'cs_x' };

  afterEach(() => {
    if (fs.existsSync(TEST_DB2)) fs.unlinkSync(TEST_DB2);
    vi.resetAllMocks();
  });

  function marcarComoRecienCompleto(db) {
    // Simula que ya corrió un barrido completo hace instantes, para que la próxima corrida
    // tome el camino incremental (completo = false).
    const ahora = new Date().toISOString();
    db.prepare(`
      INSERT INTO sync_estado (clave, valor, actualizado_en) VALUES (?, ?, ?)
      ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en
    `).run('catalogo_ultimo_completo', ahora, ahora);
    db.prepare(`
      INSERT INTO sync_estado (clave, valor, actualizado_en) VALUES (?, ?, ?)
      ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en
    `).run('catalogo_ultimo_refresco', ahora, ahora);
  }

  // Criterio 1: en régimen estable (nada cambió en Woo), una corrida incremental hace UNA
  // sola llamada a /products y CERO llamadas de variaciones. Es el criterio que da sentido
  // a todo el cambio: si esto se rompe, volvemos al costo original de ~584 llamadas.
  //
  // Mutation testing: comenté `if (idsActuales.length === 0) { ... return 0; }`'s rama
  // `completo` (forzando siempre el camino de poda/tx) — sin la rama incremental temprana,
  // el test de abajo que cuenta llamadas seguía en 1 (no dispara variaciones porque no hay
  // productos variables en el fixture), así que el mutation real que prueba esta rama es
  // revertir `completo` a `forzarCompleto` puro (sacar `!ultimoCompleto` / el chequeo de
  // tiempo) — ver el test de fallback más abajo, que sí lo cubre en rojo.
  it('en régimen estable hace 1 sola llamada a /products y 0 de variaciones', async () => {
    const db = openDb(TEST_DB2);
    marcarComoRecienCompleto(db);
    // El mock distingue completo (sin modified_after) de incremental: si por un mutante
    // `completo` quedara pegado en `true`, esta consulta SÍ traería un padre variable con
    // variaciones — el test lo detectaría por la cantidad de llamadas y por `total`.
    axios.request.mockImplementation(async ({ url }) => {
      if (url.includes('modified_after')) return { status: 200, headers: {}, data: [] };
      if (url.includes('/products?')) {
        return { status: 200, headers: {}, data: [
          { id: 99, name: 'Padre existente', sku: '', type: 'variable', parent_id: 0, stock_quantity: 0 },
        ] };
      }
      return { status: 200, headers: {}, data: [{ id: 991, sku: 'FB-991', stock_quantity: 1, attributes: [] }] };
    });

    const total = await refrescarCatalogo(db, cfg);

    expect(total).toBe(0);
    expect(axios.request).toHaveBeenCalledTimes(1);
    const [[llamada]] = axios.request.mock.calls;
    expect(llamada.url).toMatch(/\/products\?per_page=100&page=1&status=any/);
    expect(llamada.url).toMatch(/modified_after=/);
    expect(llamada.url).not.toMatch(/variations/);
    db.close();
  });

  // Criterio 5: dates_are_gmt=true no es opcional en una consulta con modified_after.
  it('la corrida incremental manda dates_are_gmt=true junto con modified_after', async () => {
    const db = openDb(TEST_DB2);
    marcarComoRecienCompleto(db);
    axios.request.mockResolvedValue({ status: 200, headers: {}, data: [] });

    await refrescarCatalogo(db, cfg);

    const [[llamada]] = axios.request.mock.calls;
    expect(llamada.url).toMatch(/modified_after=/);
    expect(llamada.url).toMatch(/dates_are_gmt=true/);
    db.close();
  });

  // Criterio 2: un cambio en una variación se refleja en catalogo_cache en la siguiente
  // corrida incremental (solo se traen variaciones de los padres que volvió la consulta).
  it('trae variaciones solo de los padres devueltos por la consulta incremental', async () => {
    const db = openDb(TEST_DB2);
    marcarComoRecienCompleto(db);
    // Un padre "modificado" existente ya en catalogo_cache, y otro padre no tocado que NO
    // debería disparar una llamada de variaciones.
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, actualizado_en) VALUES (?,?,?,?,?,?,?)'
    ).run(50, 'Padre no tocado', '', 'variable', null, 0, now);

    axios.request
      .mockResolvedValueOnce({ status: 200, headers: {}, data: [
        { id: 60, name: 'Padre modificado', sku: '', type: 'variable', parent_id: 0, stock_quantity: 0 },
      ] })
      .mockResolvedValueOnce({ status: 200, headers: {}, data: [
        { id: 61, sku: 'FB-61', stock_quantity: 9, attributes: [] },
      ] })
      .mockResolvedValue({ status: 200, headers: {}, data: [] });

    await refrescarCatalogo(db, cfg);

    const llamadas = axios.request.mock.calls.map(([c]) => c.url);
    expect(llamadas.some(u => u.includes('/products/60/variations'))).toBe(true);
    expect(llamadas.some(u => u.includes('/products/50/variations'))).toBe(false);
    const v = db.prepare('SELECT * FROM catalogo_cache WHERE id_woo=?').get(61);
    expect(v).toBeTruthy();
    expect(v.stock).toBe(9);
    db.close();
  });

  // Criterio 3: la poda de borrados SOLO corre en el barrido completo. Una corrida
  // incremental con universo parcial no debe borrar productos que simplemente no vinieron
  // porque no cambiaron desde la marca.
  it('la corrida incremental NO poda productos que no vinieron en su consulta parcial', async () => {
    const db = openDb(TEST_DB2);
    marcarComoRecienCompleto(db);
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, actualizado_en) VALUES (?,?,?,?,?,?,?)'
    ).run(70, 'Producto no tocado (no vino en el incremental)', 'FB-70', 'simple', null, 3, now);

    axios.request.mockResolvedValue({
      status: 200, headers: {},
      data: [{ id: 71, name: 'Producto modificado', sku: 'FB-71', type: 'simple', parent_id: 0, stock_quantity: 5 }],
    });

    await refrescarCatalogo(db, cfg);

    const rows = getCatalogo(db);
    expect(rows.map(r => r.id_woo).sort()).toEqual([70, 71]);
    db.close();
  });

  // Criterio 3 (parte 2): el barrido completo SÍ sigue podando como siempre.
  it('un barrido completo (forzarCompleto) poda un producto borrado en Woo', async () => {
    const db = openDb(TEST_DB2);
    marcarComoRecienCompleto(db);
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, actualizado_en) VALUES (?,?,?,?,?,?,?)'
    ).run(80, 'Producto borrado en Woo', 'FB-80', 'simple', null, 3, now);

    axios.request.mockResolvedValue({
      status: 200, headers: {},
      data: [{ id: 81, name: 'Producto vigente', sku: 'FB-81', type: 'simple', parent_id: 0, stock_quantity: 5 }],
    });

    await refrescarCatalogo(db, cfg, { forzarCompleto: true });

    const rows = getCatalogo(db);
    expect(rows.map(r => r.id_woo)).toEqual([81]);
    // Y no manda modified_after: es un barrido completo real.
    const [[llamada]] = axios.request.mock.calls;
    expect(llamada.url).not.toMatch(/modified_after/);
    db.close();
  });

  // Criterio 4: si una llamada a Woo falla, la marca no avanza y no se persiste catálogo
  // parcial (fail-closed).
  it('si la corrida falla, la marca catalogo_ultimo_refresco NO avanza', async () => {
    const db = openDb(TEST_DB2);
    marcarComoRecienCompleto(db);
    const marcaVieja = db.prepare("SELECT valor FROM sync_estado WHERE clave='catalogo_ultimo_refresco'").get().valor;

    axios.request
      .mockResolvedValueOnce({ status: 200, headers: {}, data: [
        { id: 90, name: 'Padre', sku: '', type: 'variable', parent_id: 0, stock_quantity: 0 },
      ] })
      // falla la llamada de variaciones SIEMPRE (no un único 500 transitorio): con
      // wooFetchConReintento (incidente 2026-08-27) esa llamada agota sus 3 reintentos
      // con backoff real (~6s) antes de fallar-cerrado — de ahí el timeout extendido.
      .mockResolvedValue({ status: 500, headers: {}, data: {} });

    await expect(refrescarCatalogo(db, cfg)).rejects.toThrow(/WooCommerce API error 500/);

    const marcaNueva = db.prepare("SELECT valor FROM sync_estado WHERE clave='catalogo_ultimo_refresco'").get().valor;
    expect(marcaNueva).toBe(marcaVieja);
    db.close();
  }, 10000);

  // Fallback de marca: si por algún motivo faltara catalogo_ultimo_refresco (no debería
  // pasar en operación normal: completo=false implica que ya hubo un barrido completo
  // previo, que siempre deja las dos marcas), la corrida incremental no debe explotar ni
  // caer a "sin marca" (que equivaldría a un completo disfrazado): usa catalogo_ultimo_completo.
  it('si falta catalogo_ultimo_refresco, la incremental usa catalogo_ultimo_completo como base', async () => {
    const db = openDb(TEST_DB2);
    const ahora = new Date().toISOString();
    db.prepare(`
      INSERT INTO sync_estado (clave, valor, actualizado_en) VALUES ('catalogo_ultimo_completo', ?, ?)
    `).run(ahora, ahora);
    axios.request.mockResolvedValue({ status: 200, headers: {}, data: [] });

    await refrescarCatalogo(db, cfg);

    const [[llamada]] = axios.request.mock.calls;
    expect(llamada.url).toMatch(/modified_after=/);
    db.close();
  });

  // El barrido completo periódico (red de seguridad) se dispara solo cuando ya pasó
  // INTERVALO_COMPLETO_MS (1h, provisorio — ver comentario en routes/woo.js) desde el
  // último completo, aunque no se fuerce por parámetro.
  it('dispara un barrido completo automático si pasó más de 1h desde el último completo', async () => {
    const db = openDb(TEST_DB2);
    const hace2h = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    db.prepare(`
      INSERT INTO sync_estado (clave, valor, actualizado_en) VALUES ('catalogo_ultimo_completo', ?, ?)
    `).run(hace2h, hace2h);
    db.prepare(`
      INSERT INTO sync_estado (clave, valor, actualizado_en) VALUES ('catalogo_ultimo_refresco', ?, ?)
    `).run(hace2h, hace2h);
    // Con productos reales (no vacío): el guard fail-closed de "0 productos" es para el caso
    // sospechoso, no aplica acá y no debe tapar que la marca sí avanza en un completo normal.
    axios.request.mockResolvedValue({
      status: 200, headers: {},
      data: [{ id: 95, name: 'Producto', sku: 'FB-95', type: 'simple', parent_id: 0, stock_quantity: 1 }],
    });

    await refrescarCatalogo(db, cfg); // sin forzarCompleto: debe detectar solo que toca completo

    const [[llamada]] = axios.request.mock.calls;
    expect(llamada.url).not.toMatch(/modified_after/);
    const marcaCompleto = db.prepare("SELECT valor FROM sync_estado WHERE clave='catalogo_ultimo_completo'").get();
    expect(marcaCompleto.valor).not.toBe(hace2h); // se actualizó
    db.close();
  });

  // Hallazgo del revisor: margen de solape sin cubrir. Si SOLAPE_INCREMENTAL_MS se rompiera
  // a 0, la marca guardada se usaría tal cual como `modified_after` — este test lo detecta
  // afirmando que el `modified_after` enviado es estrictamente ANTERIOR a la marca (por lo
  // menos los 5 min de margen), no igual a ella.
  it('el modified_after enviado tiene el margen de solape de ~5 min respecto de la marca guardada', async () => {
    const db = openDb(TEST_DB2);
    const marca = new Date(Date.now() - 20 * 60 * 1000).toISOString(); // hace 20 min, bien dentro de la ventana incremental (< 1h)
    db.prepare(`
      INSERT INTO sync_estado (clave, valor, actualizado_en) VALUES ('catalogo_ultimo_completo', ?, ?)
    `).run(marca, marca);
    db.prepare(`
      INSERT INTO sync_estado (clave, valor, actualizado_en) VALUES ('catalogo_ultimo_refresco', ?, ?)
    `).run(marca, marca);
    axios.request.mockResolvedValue({ status: 200, headers: {}, data: [] });

    await refrescarCatalogo(db, cfg);

    const [[llamada]] = axios.request.mock.calls;
    const m = llamada.url.match(/modified_after=([^&]+)/);
    expect(m).toBeTruthy();
    const modifiedAfter = new Date(decodeURIComponent(m[1])).getTime();
    const marcaMs = new Date(marca).getTime();
    expect(modifiedAfter).toBeLessThan(marcaMs); // no manda la marca tal cual
    const solapeMinutos = (marcaMs - modifiedAfter) / 60000;
    expect(solapeMinutos).toBeCloseTo(5, 1); // ~5 min de margen
    db.close();
  });

  // Hallazgo del revisor (BLOQUEANTE): con 0 resultados en incremental, la marca NO debe
  // avanzar — 0 es indistinguible entre "nada cambió" y "Woo falló en silencio", y avanzar
  // la marca en ese caso salteaba la ventana para siempre sin dejar rastro.
  it('con 0 resultados en incremental, catalogo_ultimo_refresco NO avanza (la ventana se reintenta)', async () => {
    const db = openDb(TEST_DB2);
    marcarComoRecienCompleto(db);
    const marcaVieja = db.prepare("SELECT valor FROM sync_estado WHERE clave='catalogo_ultimo_refresco'").get().valor;
    axios.request.mockResolvedValue({ status: 200, headers: {}, data: [] });

    const total = await refrescarCatalogo(db, cfg);

    expect(total).toBe(0);
    const marcaNueva = db.prepare("SELECT valor FROM sync_estado WHERE clave='catalogo_ultimo_refresco'").get().valor;
    expect(marcaNueva).toBe(marcaVieja);
    db.close();
  });
});

// Hallazgo del revisor (BLOQUEANTE): candado anti-solape en memoria, mismo patrón que
// _mlToWcEnCurso/_wcToMlEnCurso/_reconciliarStockEnCurso de routes/sync.js.
describe('refrescarCatalogo — candado anti-solape', () => {
  const TEST_DB3 = './test/tmp-woo-candado.sqlite';
  const cfg = { url: 'https://fusionbikes.com.ar', ck: 'ck_x', cs: 'cs_x' };

  afterEach(() => {
    if (fs.existsSync(TEST_DB3)) fs.unlinkSync(TEST_DB3);
    vi.resetAllMocks();
  });

  it('una segunda corrida disparada mientras la primera sigue en vuelo se omite (no duplica llamadas a Woo)', async () => {
    const db = openDb(TEST_DB3);
    let resolverPrimeraLlamada;
    const primeraLlamadaColgada = new Promise((r) => { resolverPrimeraLlamada = r; });
    let llamadas = 0;
    axios.request.mockImplementation(async () => {
      llamadas++;
      if (llamadas === 1) await primeraLlamadaColgada; // la 1ra corrida queda "en vuelo"
      return { status: 200, headers: {}, data: [] };
    });

    const p1 = refrescarCatalogo(db, cfg); // arranca y se cuelga en la 1ra llamada a Woo
    // Deja que arranque de verdad antes de disparar la segunda (microtask flush).
    await new Promise((r) => setTimeout(r, 0));
    const r2 = await refrescarCatalogo(db, cfg); // debe omitirse: la 1ra sigue en curso

    expect(r2).toMatchObject({ omitido: true, motivo: 'en_curso' });
    expect(llamadas).toBe(1); // la 2da corrida no llegó a pegarle a Woo

    resolverPrimeraLlamada();
    await p1; // deja terminar la 1ra corrida, no queda una promesa colgada
    db.close();
  });

  it('el candado se libera al terminar: una corrida posterior (ya no solapada) sí corre normal', async () => {
    const db = openDb(TEST_DB3);
    axios.request.mockResolvedValue({ status: 200, headers: {}, data: [] });

    const r1 = await refrescarCatalogo(db, cfg);
    const r2 = await refrescarCatalogo(db, cfg);

    expect(r1).not.toMatchObject({ omitido: true });
    expect(r2).not.toMatchObject({ omitido: true });
    db.close();
  });

  it('POST /catalogo/recargar devuelve {ok:true, omitido:true} si ya había una corrida en curso, no un falso total:0', async () => {
    const db = openDb(TEST_DB3);
    let resolverPrimeraLlamada;
    const primeraLlamadaColgada = new Promise((r) => { resolverPrimeraLlamada = r; });
    let llamadas = 0;
    axios.request.mockImplementation(async () => {
      llamadas++;
      if (llamadas === 1) await primeraLlamadaColgada;
      return { status: 200, headers: {}, data: [] };
    });
    const app = express();
    app.use(express.json());
    app.use('/api/woo', wooRouter(db, cfg));

    // Deja una corrida "en vuelo" llamando directo a la función (el candado es un mutex de
    // módulo, no depende de si se dispara por HTTP o por cron), y recién ahí golpea la ruta.
    const primeraEnVuelo = refrescarCatalogo(db, cfg, { forzarCompleto: true });
    await new Promise((r) => setTimeout(r, 10));
    const r2 = await request(app).post('/api/woo/catalogo/recargar');

    expect(r2.body).toMatchObject({ ok: true, omitido: true, motivo: 'en_curso' });
    expect(r2.body.total).toBeUndefined();

    resolverPrimeraLlamada();
    await primeraEnVuelo;
    db.close();
  });
});



describe('POST /stock/aplicar', () => {
  const DB_PATH = './test/tmp-woo-aplicar.sqlite';
  let db;

  function app() {
    const a = express();
    a.use(express.json());
    a.use('/api/woo', wooRouter(db, { url: 'https://fusionbikes.com.ar', ck: 'ck_x', cs: 'cs_x' }));
    return a;
  }

  beforeEach(() => {
    if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
    db = openDb(DB_PATH);
    db.prepare("INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, actualizado_en) VALUES (?,?,?,?,?,?,?)")
      .run(29985, 'Venzo Raptor Negro/Rojo L', 'FB-29985', 'variation', 24452, 0, '2026-08-03T00:00:00.000Z');
    db.prepare("INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, actualizado_en) VALUES (?,?,?,?,?,?,?)")
      .run(1001, 'Producto simple', 'FB-1001', 'simple', null, 0, '2026-08-03T00:00:00.000Z');
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
    vi.resetAllMocks();
  });

  it('usa el endpoint de variaciones para un producto variation (regresión del 404)', async () => {
    axios.request.mockResolvedValue({ status: 200, data: {}, headers: {} });
    const r = await request(app()).post('/api/woo/stock/aplicar')
      .send({ updates: [{ sku: 'FB-29985', id_woo: 29985, stock_nuevo: 4 }] });

    expect(r.body).toMatchObject({ ok: true, aplicados: 1, errores: 0 });
    expect(axios.request).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://fusionbikes.com.ar/wp-json/wc/v3/products/24452/variations/29985',
      method: 'put',
      data: { stock_quantity: 4, manage_stock: true }
    }));
    expect(db.prepare('SELECT stock FROM catalogo_cache WHERE id_woo=?').get(29985).stock).toBe(4);
  });

  it('usa /products/{id} para un producto simple', async () => {
    axios.request.mockResolvedValue({ status: 200, data: {}, headers: {} });
    const r = await request(app()).post('/api/woo/stock/aplicar')
      .send({ updates: [{ sku: 'FB-1001', id_woo: 1001, stock_nuevo: 7 }] });

    expect(r.body.aplicados).toBe(1);
    expect(axios.request).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://fusionbikes.com.ar/wp-json/wc/v3/products/1001'
    }));
  });

  it('falla cerrado si el producto no está en catalogo_cache', async () => {
    axios.request.mockResolvedValue({ status: 200, data: {}, headers: {} });
    const r = await request(app()).post('/api/woo/stock/aplicar')
      .send({ updates: [{ sku: 'FB-9999', id_woo: 9999, stock_nuevo: 3 }] });

    expect(r.body).toMatchObject({ ok: false, aplicados: 0, errores: 1 });
    expect(r.body.resultados[0].error).toMatch(/catalogo_cache/);
    expect(axios.request).not.toHaveBeenCalled();
  });

  it('incluye sync_ml en la respuesta al aplicar stock', async () => {
    const { syncSkuPuntual } = await import('../routes/sync.js');

    // Mock syncSkuPuntual
    syncSkuPuntual.mockImplementation(async (db, cfg, sku) => {
      if (sku === 'FB-29985') {
        return { sku: 'FB-29985', estado: 'sincronizado', detalle: 'Stock actualizado: 4' };
      }
      if (sku === 'FB-1001') {
        return { sku: 'FB-1001', estado: 'sin_cambios', detalle: 'Sin cambios pendientes en ML' };
      }
      return { sku, estado: 'error', detalle: 'Unknown SKU' };
    });

    axios.request.mockResolvedValue({ status: 200, data: {}, headers: {} });

    const r = await request(app()).post('/api/woo/stock/aplicar')
      .send({
        updates: [
          { sku: 'FB-29985', id_woo: 29985, stock_nuevo: 4 },
          { sku: 'FB-1001', id_woo: 1001, stock_nuevo: 7 }
        ]
      });

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.sync_ml).toBeDefined();
    expect(Array.isArray(r.body.sync_ml)).toBe(true);
    expect(r.body.sync_ml).toHaveLength(2);

    // Verificar el contenido de sync_ml
    const sku1 = r.body.sync_ml.find(s => s.sku === 'FB-29985');
    expect(sku1).toBeTruthy();
    expect(sku1.estado).toBe('sincronizado');
    expect(sku1.detalle).toContain('Stock actualizado');

    const sku2 = r.body.sync_ml.find(s => s.sku === 'FB-1001');
    expect(sku2).toBeTruthy();
    expect(sku2.estado).toBe('sin_cambios');

    // syncSkuPuntual debe haber sido llamado para ambos SKUs
    expect(syncSkuPuntual).toHaveBeenCalledTimes(2);
  });

  it('fail-open: si syncSkuPuntual rechaza, el stock igual quedó aplicado en WC y la respuesta sigue en 200', async () => {
    const { syncSkuPuntual } = await import('../routes/sync.js');
    syncSkuPuntual.mockRejectedValue(new Error('ML caído'));
    axios.request.mockResolvedValue({ status: 200, data: {}, headers: {} });

    const r = await request(app()).post('/api/woo/stock/aplicar')
      .send({ updates: [{ sku: 'FB-29985', id_woo: 29985, stock_nuevo: 4 }] });

    // El endpoint no debe tirar abajo la respuesta por un fallo de ML: el PATCH a WC
    // ya se hizo, eso es lo que importa para el status 200/ok.
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.resultados[0].ok).toBe(true);
  });

  it('SKU repetido en el mismo lote: un solo push a ML, con el stock FINAL (no el del primer renglón)', async () => {
    const { syncSkuPuntual } = await import('../routes/sync.js');
    syncSkuPuntual.mockClear();
    syncSkuPuntual.mockResolvedValue({ sku: 'FB-29985', estado: 'sincronizado', detalle: 'ok' });
    axios.request.mockResolvedValue({ status: 200, data: {}, headers: {} });

    // Mismo id_woo dos veces con distinto stock_nuevo: el segundo renglón es el que
    // manda (última escritura gana), y el dedup no debe pushear el valor intermedio.
    const r = await request(app()).post('/api/woo/stock/aplicar')
      .send({
        updates: [
          { sku: 'FB-29985', id_woo: 29985, stock_nuevo: 4 },
          { sku: 'FB-29985', id_woo: 29985, stock_nuevo: 9 },
        ]
      });

    expect(r.status).toBe(200);
    expect(db.prepare('SELECT stock FROM catalogo_cache WHERE id_woo=?').get(29985).stock).toBe(9);
    expect(syncSkuPuntual).toHaveBeenCalledTimes(1);
    expect(syncSkuPuntual).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'FB-29985');
    expect(r.body.sync_ml).toHaveLength(1);
  });

  it('NO llama a syncSkuPuntual cuando aplicar a WC falló para ese SKU', async () => {
    const { syncSkuPuntual } = await import('../routes/sync.js');
    syncSkuPuntual.mockClear();
    axios.request.mockResolvedValue({ status: 500, data: {}, headers: {} });

    const r = await request(app()).post('/api/woo/stock/aplicar')
      .send({ updates: [{ sku: 'FB-29985', id_woo: 29985, stock_nuevo: 4 }] });

    expect(r.body.resultados[0].ok).toBe(false);
    expect(syncSkuPuntual).not.toHaveBeenCalled();
  });
});

// Fase 0 (higiene), Tarea 3: alertas de stock negativo abiertas/cerradas en cada refresco.
describe('registrarAlertasStockNegativo', () => {
  const DB_ALERTAS = './test/tmp-woo-alertas.sqlite';
  afterEach(() => {
    if (fs.existsSync(DB_ALERTAS)) fs.unlinkSync(DB_ALERTAS);
  });

  it('un SKU nuevo en negativo genera una fila de alerta abierta', () => {
    const db = openDb(DB_ALERTAS);
    db.prepare(
      "INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, stock, actualizado_en) VALUES (1,'Prod','FB-1','simple',-3,?)"
    ).run(new Date().toISOString());

    registrarAlertasStockNegativo(db, '2026-08-25T10:00:00.000Z');

    const abiertas = db.prepare('SELECT * FROM stock_negativo_alertas WHERE resuelto_en IS NULL').all();
    expect(abiertas).toHaveLength(1);
    expect(abiertas[0]).toMatchObject({ sku: 'FB-1', stock: -3 });
    db.close();
  });

  it('no duplica fila para el mismo SKU en refrescos sucesivos mientras siga negativo', () => {
    const db = openDb(DB_ALERTAS);
    db.prepare(
      "INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, stock, actualizado_en) VALUES (1,'Prod','FB-1','simple',-3,?)"
    ).run(new Date().toISOString());

    registrarAlertasStockNegativo(db, '2026-08-25T10:00:00.000Z');
    registrarAlertasStockNegativo(db, '2026-08-25T10:15:00.000Z');
    registrarAlertasStockNegativo(db, '2026-08-25T10:30:00.000Z');

    const abiertas = db.prepare('SELECT * FROM stock_negativo_alertas WHERE resuelto_en IS NULL').all();
    expect(abiertas).toHaveLength(1);
    db.close();
  });

  it('un SKU que deja de estar en negativo cierra su alerta abierta con resuelto_en', () => {
    const db = openDb(DB_ALERTAS);
    db.prepare(
      "INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, stock, actualizado_en) VALUES (1,'Prod','FB-1','simple',-3,?)"
    ).run(new Date().toISOString());
    registrarAlertasStockNegativo(db, '2026-08-25T10:00:00.000Z');

    db.prepare('UPDATE catalogo_cache SET stock=5 WHERE id_woo=1').run();
    registrarAlertasStockNegativo(db, '2026-08-25T11:00:00.000Z');

    const fila = db.prepare('SELECT * FROM stock_negativo_alertas WHERE sku=?').get('FB-1');
    expect(fila.resuelto_en).toBe('2026-08-25T11:00:00.000Z');

    // Si vuelve a caer en negativo después, abre una fila NUEVA (la vieja ya está resuelta).
    db.prepare('UPDATE catalogo_cache SET stock=-1 WHERE id_woo=1').run();
    registrarAlertasStockNegativo(db, '2026-08-25T12:00:00.000Z');
    const abiertas = db.prepare('SELECT * FROM stock_negativo_alertas WHERE resuelto_en IS NULL').all();
    expect(abiertas).toHaveLength(1);
    expect(abiertas[0].detectado_en).toBe('2026-08-25T12:00:00.000Z');
    db.close();
  });

  it('relee un padre variable puntual y reemplaza solo sus variaciones locales', async () => {
    const db = openDb(DB_ALERTAS);
    db.prepare("INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,id_padre,stock,actualizado_en) VALUES (1732,'Viejo','FB-1732','variable',NULL,0,?)").run(new Date().toISOString());
    db.prepare("INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,id_padre,stock,actualizado_en) VALUES (9999,'Hija vieja','FB-9999','variation',1732,1,?)").run(new Date().toISOString());
    axios.request.mockResolvedValueOnce({ status: 200, headers: {}, data: {
      id: 1732, name: 'Casco Rembrandt Para Niños', sku: 'FB-1732', type: 'variable', stock_quantity: 0,
      categories: [], attributes: [], images: [], brands: [],
    } }).mockResolvedValueOnce({ status: 200, headers: {}, data: [{
      id: 7247, sku: 'FB-7247', stock_quantity: 1, attributes: [{ name: 'Diseño', option: 'Halcón' }], image: null,
    }] });
    const r = await refrescarProductoPuntual(db, { url: 'https://fusionbikes.com.ar', ck: 'ck', cs: 'cs' }, { productoId: 1732 });
    expect(r).toMatchObject({ producto_id: 1732, filas: 2 });
    expect(db.prepare('SELECT sku FROM catalogo_cache WHERE id_woo=7247').get().sku).toBe('FB-7247');
    expect(db.prepare('SELECT 1 FROM catalogo_cache WHERE id_woo=9999').get()).toBeUndefined();
    db.close();
  });

  it('un webhook de variación borrada solo retira esa variación del cache', async () => {
    const db = openDb(DB_ALERTAS);
    const ts = new Date().toISOString();
    db.prepare("INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,id_padre,stock,actualizado_en) VALUES (1732,'Padre','FB-1732','variable',NULL,0,?)").run(ts);
    db.prepare("INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,id_padre,stock,actualizado_en) VALUES (7247,'Halcón','FB-7247','variation',1732,1,?)").run(ts);
    db.prepare("INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,id_padre,stock,actualizado_en) VALUES (7248,'Hermana','FB-7248','variation',1732,1,?)").run(ts);
    await refrescarProductoPuntual(db, { url: 'https://fusionbikes.com.ar', ck: 'ck', cs: 'cs' }, { productoId: 7247, parentId: 1732, eliminado: true });
    expect(db.prepare('SELECT 1 FROM catalogo_cache WHERE id_woo=7247').get()).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM catalogo_cache WHERE id_woo=7248').get()).toBeTruthy();
    expect(db.prepare('SELECT 1 FROM catalogo_cache WHERE id_woo=1732').get()).toBeTruthy();
    db.close();
  });
});
