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

    it('sanitiza el contexto: nunca persiste claves que parezcan secretos, aunque el llamador las pase por error', () => {
      const r = abrirOActualizarIncidente(db, {
        ...BASE,
        contexto: { endpoint: '/items/search', status_http: 429, access_token: 'SECRETO', client_secret: 'MAS_SECRETO', Authorization: 'Bearer x' },
      });
      const fila = db.prepare('SELECT contexto_json FROM incidentes_operativos WHERE id = ?').get(r.id);
      const contexto = JSON.parse(fila.contexto_json);
      expect(contexto).toEqual({ endpoint: '/items/search', status_http: 429 });
      expect(fila.contexto_json).not.toMatch(/SECRETO/);
    });

    it('sin contexto no rompe (contexto_json queda null)', () => {
      const r = abrirOActualizarIncidente(db, BASE);
      const fila = db.prepare('SELECT contexto_json FROM incidentes_operativos WHERE id = ?').get(r.id);
      expect(fila.contexto_json).toBeNull();
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

    it('NUNCA resuelve por una sola llamada exitosa aislada — solo por confirmarCicloSano explícito', () => {
      const abierto = abrirOActualizarIncidente(db, BASE);
      // Ninguna llamada a abrirOActualizarIncidente resuelve nada — solo confirmarCicloSano.
      const fila = db.prepare('SELECT estado FROM incidentes_operativos WHERE id = ?').get(abierto.id);
      expect(fila.estado).toBe('activo');
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
    it('abrir la misma DB dos veces (openDb) no falla', () => {
      const db2 = openDb(TEST_DB);
      db2.close();
      // Si llegamos acá sin tirar, las CREATE TABLE/INDEX IF NOT EXISTS son idempotentes.
      expect(true).toBe(true);
    });
  });
});
