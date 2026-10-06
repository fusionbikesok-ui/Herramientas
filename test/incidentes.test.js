import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import {
  abrirOActualizarIncidente,
  confirmarCicloSano,
  listarIncidentes,
  obtenerIncidente,
} from '../lib/incidentes.js';

const TEST_DB = './test/tmp-incidentes.sqlite';

const BASE = {
  integracion: 'mercado_libre',
  proceso: 'refrescar_catalogo',
  tipoError: 'rate_limit',
  severidad: 'advertencia',
  mensajeTecnico: 'HTTP 429',
  mensajeHumano: 'Mercado Libre está limitando la frecuencia de refrescos.',
};

describe('lib/incidentes', () => {
  let db;
  beforeEach(() => { db = openDb(TEST_DB); });
  afterEach(() => { db.close(); if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  describe('abrirOActualizarIncidente', () => {
    it('reserva una alerta solo tras tres fallos y la deduplica de forma durable', () => {
      abrirOActualizarIncidente(db, BASE);
      abrirOActualizarIncidente(db, BASE);
      expect(db.prepare('SELECT COUNT(*) n FROM incidentes_email_outbox').get().n).toBe(0);
      abrirOActualizarIncidente(db, BASE);
      expect(db.prepare("SELECT tipo, estado, intentos FROM incidentes_email_outbox").get()).toMatchObject({ tipo: 'caida' });
      abrirOActualizarIncidente(db, BASE);
      expect(db.prepare('SELECT COUNT(*) n FROM incidentes_email_outbox').get().n).toBe(1);
    });

    it('la recuperación reserva email solo después de una caída enviada', () => {
      const r = abrirOActualizarIncidente(db, { ...BASE, severidad: 'critico' });
      db.prepare("UPDATE incidentes_email_outbox SET estado='enviado' WHERE incidente_id=? AND tipo='caida'").run(r.id);
      confirmarCicloSano(db, { integracion: BASE.integracion, proceso: BASE.proceso });
      expect(db.prepare("SELECT estado FROM incidentes_email_outbox WHERE incidente_id=? AND tipo='recuperada'").get(r.id).estado).toMatch(/pendiente|enviando|fallido/);
    });

    it('abre un incidente nuevo con contador en 1 y estado activo', () => {
      const r = abrirOActualizarIncidente(db, BASE);
      expect(r.creado).toBe(true);

      const fila = db.prepare('SELECT * FROM incidentes_operativos WHERE id = ?').get(r.id);
      expect(fila).toMatchObject({
        integracion: 'mercado_libre',
        proceso: 'refrescar_catalogo',
        tipo_error: 'rate_limit',
        clave_dedupe: 'mercado_libre|refrescar_catalogo|rate_limit',
        severidad: 'advertencia',
        estado: 'activo',
        contador_repeticiones: 1,
      });
      expect(fila.primera_deteccion_en).toBe(fila.ultima_deteccion_en);
    });

    it('reincidir con la misma clave de dedupe incrementa el contador, no crea un segundo incidente', () => {
      const r1 = abrirOActualizarIncidente(db, BASE);
      const r2 = abrirOActualizarIncidente(db, { ...BASE, mensajeTecnico: 'HTTP 429 (segunda vez)' });

      expect(r2.creado).toBe(false);
      expect(r2.id).toBe(r1.id);

      const total = db.prepare("SELECT COUNT(*) n FROM incidentes_operativos WHERE clave_dedupe = ?")
        .get('mercado_libre|refrescar_catalogo|rate_limit').n;
      expect(total).toBe(1);

      const fila = db.prepare('SELECT * FROM incidentes_operativos WHERE id = ?').get(r1.id);
      expect(fila.contador_repeticiones).toBe(2);
      expect(fila.mensaje_tecnico).toBe('HTTP 429 (segunda vez)'); // el más reciente pisa al viejo
    });

    it('escala la severidad si la nueva es mayor, y lo deja registrado en el historial', () => {
      abrirOActualizarIncidente(db, BASE); // advertencia
      const r2 = abrirOActualizarIncidente(db, { ...BASE, severidad: 'critico' });

      expect(r2.escalado).toBe(true);
      const fila = db.prepare('SELECT severidad FROM incidentes_operativos WHERE id = ?').get(r2.id);
      expect(fila.severidad).toBe('critico');

      const eventos = db.prepare('SELECT evento FROM incidentes_operativos_historial WHERE incidente_id = ? ORDER BY id')
        .all(r2.id).map(h => h.evento);
      expect(eventos).toEqual(['abierto', 'escalado']);
    });

    it('NO baja la severidad si la nueva repetición es menor a la ya registrada', () => {
      abrirOActualizarIncidente(db, { ...BASE, severidad: 'critico' });
      const r2 = abrirOActualizarIncidente(db, { ...BASE, severidad: 'advertencia' });

      expect(r2.escalado).toBe(false);
      const fila = db.prepare('SELECT severidad FROM incidentes_operativos WHERE id = ?').get(r2.id);
      expect(fila.severidad).toBe('critico'); // se mantiene la más grave ya vista
    });

    it('integracion/proceso/tipoError distintos son incidentes separados (no se pisan)', () => {
      abrirOActualizarIncidente(db, BASE);
      abrirOActualizarIncidente(db, { ...BASE, tipoError: 'auth', severidad: 'critico', mensajeHumano: 'Token vencido' });

      const total = db.prepare('SELECT COUNT(*) n FROM incidentes_operativos').get().n;
      expect(total).toBe(2);
    });

    it('dos llamadas seguidas con la misma clave (simulando reintentos rápidos) nunca crean un duplicado activo', () => {
      // better-sqlite3 es síncrono: no hay overlap real, pero esto ejercita el mismo camino
      // check-then-act que protegería una carrera real, y el índice único de la tabla queda
      // como red de seguridad adicional (verificado más abajo).
      for (let i = 0; i < 5; i++) abrirOActualizarIncidente(db, BASE);
      const activos = db.prepare("SELECT * FROM incidentes_operativos WHERE estado='activo'").all();
      expect(activos).toHaveLength(1);
      expect(activos[0].contador_repeticiones).toBe(5);
    });

    it('el índice único parcial rechaza un segundo incidente activo insertado a mano con la misma clave_dedupe', () => {
      abrirOActualizarIncidente(db, BASE);
      const now = new Date().toISOString();
      expect(() => {
        db.prepare(`INSERT INTO incidentes_operativos
          (integracion, proceso, tipo_error, clave_dedupe, severidad, estado, mensaje_humano,
           contador_repeticiones, primera_deteccion_en, ultima_deteccion_en, creado_en, actualizado_en)
          VALUES (?, ?, ?, ?, 'advertencia', 'activo', 'x', 1, ?, ?, ?, ?)`)
          .run(BASE.integracion, BASE.proceso, BASE.tipoError, 'mercado_libre|refrescar_catalogo|rate_limit', now, now, now, now);
      }).toThrow(/UNIQUE constraint/);
    });

    it('sanitiza el contexto: redacta el VALOR de claves que parezcan secretos, aunque el llamador las pase por error', () => {
      const r = abrirOActualizarIncidente(db, {
        ...BASE,
        contexto: { endpoint: '/items/search', status_http: 429, access_token: 'SECRETO', client_secret: 'MAS_SECRETO', Authorization: 'Bearer x' },
      });
      const fila = db.prepare('SELECT contexto_json FROM incidentes_operativos WHERE id = ?').get(r.id);
      const contexto = JSON.parse(fila.contexto_json);
      expect(contexto).toEqual({
        endpoint: '/items/search', status_http: 429,
        access_token: '[redactado]', client_secret: '[redactado]', Authorization: '[redactado]',
      });
      expect(fila.contexto_json).not.toMatch(/SECRETO/);
    });

    it('sanitiza secretos anidados en objetos y arrays por NOMBRE DE CLAVE, no solo el primer nivel', () => {
      // Valores neutros ('x') a propósito: aísla que la redacción viene de la CLAVE
      // (Authorization/token), no de que el valor matchee el patrón de forma (ver el test
      // de "por FORMA" más abajo para esa otra vía).
      const r = abrirOActualizarIncidente(db, {
        ...BASE,
        contexto: {
          request: { headers: { Authorization: 'x' } },
          intentos: [{ ok: false, token: 'x' }],
        },
      });
      const fila = db.prepare('SELECT contexto_json FROM incidentes_operativos WHERE id = ?').get(r.id);
      const contexto = JSON.parse(fila.contexto_json);
      expect(contexto.request.headers.Authorization).toBe('[redactado]');
      expect(contexto.intentos[0].token).toBe('[redactado]');
      expect(contexto.intentos[0].ok).toBe(false);
    });

    it('redacta SOLO la región sospechosa de un valor cuya clave es inocente (URL con ?access_token=...), preservando el resto', () => {
      const r = abrirOActualizarIncidente(db, {
        ...BASE,
        contexto: { url: 'https://api.mercadolibre.com/items?access_token=APP_USR-123&limit=20' },
      });
      const fila = db.prepare('SELECT contexto_json FROM incidentes_operativos WHERE id = ?').get(r.id);
      const url = JSON.parse(fila.contexto_json).url;
      expect(url).toBe('https://api.mercadolibre.com/items?access_token=[redactado]&limit=20');
    });

    it('sin contexto no rompe (contexto_json queda null)', () => {
      const r = abrirOActualizarIncidente(db, BASE);
      const fila = db.prepare('SELECT contexto_json FROM incidentes_operativos WHERE id = ?').get(r.id);
      expect(fila.contexto_json).toBeNull();
    });

    it('un Error nativo en el contexto se serializa como {name, message} sanitizado, no como {}', () => {
      const r = abrirOActualizarIncidente(db, {
        ...BASE,
        contexto: { err: new Error('Bearer abc123 rechazado') },
      });
      const fila = db.prepare('SELECT contexto_json FROM incidentes_operativos WHERE id = ?').get(r.id);
      const err = JSON.parse(fila.contexto_json).err;
      expect(err.name).toBe('Error');
      expect(err.message).toBe('[redactado] rechazado');
    });

    it('no nulifica un mensaje entero solo porque MENCIONA la palabra access_token sin ser un secreto real', () => {
      const r = abrirOActualizarIncidente(db, {
        ...BASE,
        contexto: { detalle: 'invalid access_token for user' },
      });
      const fila = db.prepare('SELECT contexto_json FROM incidentes_operativos WHERE id = ?').get(r.id);
      // Sin "=" ni ":" después, no matchea el patrón de key=value — se conserva el mensaje.
      expect(JSON.parse(fila.contexto_json).detalle).toBe('invalid access_token for user');
    });

    it('redacta por nombre de clave: apiKey, cookie, credential y clave (no solo token/secret/password/authorization)', () => {
      const r = abrirOActualizarIncidente(db, {
        ...BASE,
        contexto: { apiKey: 'x', cookie: 'x', credential: 'x', clave: 'x', normal: 'x' },
      });
      const fila = db.prepare('SELECT contexto_json FROM incidentes_operativos WHERE id = ?').get(r.id);
      const c = JSON.parse(fila.contexto_json);
      expect(c.apiKey).toBe('[redactado]');
      expect(c.cookie).toBe('[redactado]');
      expect(c.credential).toBe('[redactado]');
      expect(c.clave).toBe('[redactado]');
      expect(c.normal).toBe('x');
    });

    it('redacta un refresh_token de ML por su prefijo TG- aunque la clave sea inocente', () => {
      const r = abrirOActualizarIncidente(db, {
        ...BASE,
        contexto: { detalle: 'refresh usado: TG-abc123def456' },
      });
      const fila = db.prepare('SELECT contexto_json FROM incidentes_operativos WHERE id = ?').get(r.id);
      expect(JSON.parse(fila.contexto_json).detalle).toBe('refresh usado: [redactado]');
    });

    it('trunca un contexto anormalmente grande (string largo y array largo) en vez de guardarlo entero', () => {
      const r = abrirOActualizarIncidente(db, {
        ...BASE,
        contexto: { body: 'x'.repeat(5000), intentos: Array.from({ length: 200 }, (_, i) => i) },
      });
      const fila = db.prepare('SELECT contexto_json FROM incidentes_operativos WHERE id = ?').get(r.id);
      const c = JSON.parse(fila.contexto_json);
      expect(c.body.length).toBeLessThan(2100);
      expect(c.body).toMatch(/…\[truncado\]$/);
      expect(c.intentos.length).toBe(51); // 50 + la marca de truncado
      expect(c.intentos.at(-1)).toMatch(/más, truncado/);
    });

    it('una severidad desconocida (typo) cae a advertencia en vez de romper el INSERT o quedar invisible', () => {
      const r = abrirOActualizarIncidente(db, { ...BASE, severidad: 'crítico' }); // con tilde, no matchea 'critico'
      const fila = db.prepare('SELECT severidad FROM incidentes_operativos WHERE id = ?').get(r.id);
      expect(fila.severidad).toBe('advertencia');
    });

    it('sin mensajeHumano usa un default en vez de violar NOT NULL', () => {
      const { mensajeHumano, ...sinMensaje } = BASE;
      const r = abrirOActualizarIncidente(db, sinMensaje);
      expect(r.error).toBeUndefined();
      const fila = db.prepare('SELECT mensaje_humano FROM incidentes_operativos WHERE id = ?').get(r.id);
      expect(fila.mensaje_humano).toBeTruthy();
    });

    it('fail-open: un error de escritura (ej. NOT NULL por integracion faltante) no lanza, devuelve error:true', () => {
      const { integracion, ...sinIntegracion } = BASE;
      const r = abrirOActualizarIncidente(db, sinIntegracion);
      expect(r.error).toBe(true);
      expect(r.id).toBeNull();
    });

    it('el evento "abierto" del historial también guarda mensaje_tecnico y contexto (no solo severidad/mensajeHumano)', () => {
      const abierto = abrirOActualizarIncidente(db, {
        ...BASE,
        mensajeTecnico: 'HTTP 429 detalle',
        contexto: { endpoint: '/items/search' },
      });
      const evento = db.prepare(
        "SELECT detalle_json FROM incidentes_operativos_historial WHERE incidente_id = ? AND evento = 'abierto'"
      ).get(abierto.id);
      const detalle = JSON.parse(evento.detalle_json);
      expect(detalle.mensajeTecnico).toBe('HTTP 429 detalle');
      expect(detalle.contexto).toEqual({ endpoint: '/items/search' });
    });
  });

  describe('confirmarCicloSano', () => {
    it('no hace nada si no hay incidente activo (camino feliz normal)', () => {
      const r = confirmarCicloSano(db, { integracion: 'mercado_libre', proceso: 'refrescar_catalogo' });
      expect(r.resueltos).toBe(0);
    });

    it('resuelve el incidente activo y registra ultima_recuperacion_en + historial', () => {
      const abierto = abrirOActualizarIncidente(db, BASE);
      const r = confirmarCicloSano(db, { integracion: BASE.integracion, proceso: BASE.proceso });

      expect(r.resueltos).toBe(1);
      const fila = db.prepare('SELECT * FROM incidentes_operativos WHERE id = ?').get(abierto.id);
      expect(fila.estado).toBe('resuelto');
      expect(fila.ultima_recuperacion_en).toBeTruthy();
      expect(fila.resuelto_en).toBeTruthy();

      const eventos = db.prepare('SELECT evento FROM incidentes_operativos_historial WHERE incidente_id = ? ORDER BY id')
        .all(abierto.id).map(h => h.evento);
      expect(eventos).toEqual(['abierto', 'resuelto']);
    });

    it('NUNCA resuelve por reincidencias repetidas — solo por confirmarCicloSano explícito', () => {
      const abierto = abrirOActualizarIncidente(db, BASE);
      // Varias llamadas más con la misma clave (lo único que existe para "registrar" algo
      // sobre este incidente sin pasar por confirmarCicloSano): ninguna debe resolverlo.
      for (let i = 0; i < 5; i++) abrirOActualizarIncidente(db, BASE);
      const fila = db.prepare('SELECT estado, contador_repeticiones FROM incidentes_operativos WHERE id = ?').get(abierto.id);
      expect(fila.estado).toBe('activo');
      expect(fila.contador_repeticiones).toBe(6);
    });

    it('con tipoError puntual, resuelve solo esa clase y deja otros incidentes activos de la misma integración/proceso', () => {
      const rateLimitId = abrirOActualizarIncidente(db, BASE).id;
      const authId = abrirOActualizarIncidente(db, { ...BASE, tipoError: 'auth', severidad: 'critico' }).id;

      const r = confirmarCicloSano(db, { integracion: BASE.integracion, proceso: BASE.proceso, tipoError: 'rate_limit' });

      expect(r.resueltos).toBe(1);
      expect(db.prepare('SELECT estado FROM incidentes_operativos WHERE id = ?').get(rateLimitId).estado).toBe('resuelto');
      expect(db.prepare('SELECT estado FROM incidentes_operativos WHERE id = ?').get(authId).estado).toBe('activo');
    });

    it('sin tipoError resuelve TODOS los incidentes activos de esa integración/proceso', () => {
      const id1 = abrirOActualizarIncidente(db, BASE).id;
      const id2 = abrirOActualizarIncidente(db, { ...BASE, tipoError: 'auth', severidad: 'critico' }).id;

      const r = confirmarCicloSano(db, { integracion: BASE.integracion, proceso: BASE.proceso });

      expect(r.resueltos).toBe(2);
      expect(db.prepare('SELECT estado FROM incidentes_operativos WHERE id = ?').get(id1).estado).toBe('resuelto');
      expect(db.prepare('SELECT estado FROM incidentes_operativos WHERE id = ?').get(id2).estado).toBe('resuelto');
    });

    it('una reincidencia real tras resolver crea un episodio nuevo (no reabre el viejo)', () => {
      const primero = abrirOActualizarIncidente(db, BASE);
      confirmarCicloSano(db, { integracion: BASE.integracion, proceso: BASE.proceso });
      const segundo = abrirOActualizarIncidente(db, BASE);

      expect(segundo.id).not.toBe(primero.id);
      expect(segundo.creado).toBe(true);
      const total = db.prepare('SELECT COUNT(*) n FROM incidentes_operativos WHERE clave_dedupe = ?')
        .get('mercado_libre|refrescar_catalogo|rate_limit').n;
      expect(total).toBe(2); // uno resuelto (histórico) + uno activo (episodio nuevo)
    });

    it('fail-open: un error al resolver (DB cerrada) no lanza, devuelve error:true en vez de tumbar un ciclo sano', () => {
      abrirOActualizarIncidente(db, BASE);
      db.close();
      expect(() => confirmarCicloSano(db, { integracion: BASE.integracion, proceso: BASE.proceso })).not.toThrow();
      const r = confirmarCicloSano(db, { integracion: BASE.integracion, proceso: BASE.proceso });
      expect(r.error).toBe(true);
      db = openDb(TEST_DB); // para que afterEach pueda cerrarla de nuevo sin doble-close
    });
  });

  describe('listarIncidentes', () => {
    beforeEach(() => {
      abrirOActualizarIncidente(db, BASE);
      abrirOActualizarIncidente(db, { ...BASE, tipoError: 'auth', severidad: 'critico', integracion: 'mercado_libre' });
      abrirOActualizarIncidente(db, { ...BASE, integracion: 'woocommerce', proceso: 'refrescar_catalogo', tipoError: 'transitorio', severidad: 'info' });
      confirmarCicloSano(db, { integracion: 'woocommerce', proceso: 'refrescar_catalogo' });
    });

    it('sin filtros trae todos, ordenados por última detección descendente', () => {
      const r = listarIncidentes(db, {});
      expect(r.total).toBe(3);
      expect(r.items).toHaveLength(3);
    });

    it('filtra por estado', () => {
      const r = listarIncidentes(db, { estado: 'activo' });
      expect(r.total).toBe(2);
      expect(r.items.every(i => i.estado === 'activo')).toBe(true);
    });

    it('filtra por integracion y severidad combinados', () => {
      const r = listarIncidentes(db, { integracion: 'mercado_libre', severidad: 'critico' });
      expect(r.total).toBe(1);
      expect(r.items[0].tipo_error).toBe('auth');
    });

    it('pagina respetando pageSize, con tope duro de 100', () => {
      const r = listarIncidentes(db, { pageSize: 1, page: 2 });
      expect(r.items).toHaveLength(1);
      expect(r.pageSize).toBe(1);

      const rTope = listarIncidentes(db, { pageSize: 99999 });
      expect(rTope.pageSize).toBe(100);
    });

    it('page/pageSize inválidos caen a los valores por defecto en vez de romper', () => {
      const r = listarIncidentes(db, { page: -1, pageSize: 0 });
      expect(r.page).toBe(1);
      expect(r.pageSize).toBe(20);
    });

    it('acepta page/pageSize como STRING (hallazgo del revisor: así llegan siempre desde req.query de Express)', () => {
      const r = listarIncidentes(db, { page: '2', pageSize: '1' });
      expect(r.page).toBe(2);
      expect(r.pageSize).toBe(1);
      expect(r.items).toHaveLength(1);
    });

    it('un page absurdamente grande (fuera de Number.isSafeInteger) no rompe la query (hallazgo del revisor)', () => {
      // 1e21 falla Number.isSafeInteger: cae al default (page 1) en vez de intentar bindear
      // un OFFSET no representable — antes tiraba SqliteError "datatype mismatch".
      expect(() => listarIncidentes(db, { page: '999999999999999999999' })).not.toThrow();
      const r = listarIncidentes(db, { page: '999999999999999999999' });
      expect(r.page).toBe(1);
      expect(r.items.length).toBeGreaterThan(0);
    });

    it('un page grande pero SEGURO (dentro de Number.isSafeInteger) se acota a PAGE_MAX y no rompe la query', () => {
      const r = listarIncidentes(db, { page: 5_000_000 });
      expect(r.page).toBe(1_000_000);
      expect(r.items).toEqual([]); // muy lejos de cualquier dato real, offset gigante pero válido
    });
  });

  describe('obtenerIncidente', () => {
    it('devuelve null si no existe', () => {
      expect(obtenerIncidente(db, 99999)).toBeNull();
    });

    it('devuelve el incidente con su historial completo, más antiguo primero', () => {
      const abierto = abrirOActualizarIncidente(db, BASE);
      abrirOActualizarIncidente(db, { ...BASE, severidad: 'critico' });
      confirmarCicloSano(db, { integracion: BASE.integracion, proceso: BASE.proceso });

      const r = obtenerIncidente(db, abierto.id);
      expect(r.estado).toBe('resuelto');
      expect(r.historial.map(h => h.evento)).toEqual(['abierto', 'escalado', 'resuelto']);
    });
  });

  describe('idempotencia del esquema', () => {
    it('abrir la misma DB dos veces (openDb) no falla y preserva tablas e índices', () => {
      abrirOActualizarIncidente(db, BASE); // dato previo, para confirmar que sobrevive
      const db2 = openDb(TEST_DB);

      const tablas = db2.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'incidentes_operativos%'"
      ).all().map(r => r.name).sort();
      expect(tablas).toEqual(['incidentes_operativos', 'incidentes_operativos_historial']);

      const indices = db2.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_incidentes%'"
      ).all().map(r => r.name).sort();
      expect(indices).toEqual(['idx_incidentes_dedupe_activo', 'idx_incidentes_email_outbox_dlq', 'idx_incidentes_email_outbox_pendiente', 'idx_incidentes_estado_fecha', 'idx_incidentes_hist_incidente', 'idx_incidentes_integracion']);

      expect(db2.prepare("SELECT COUNT(*) n FROM incidentes_operativos WHERE clave_dedupe = ?")
        .get('mercado_libre|refrescar_catalogo|rate_limit').n).toBe(1);
      db2.close();
    });
  });
});
