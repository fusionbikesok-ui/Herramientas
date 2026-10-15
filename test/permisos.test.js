import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../db/index.js';
import { HERRAMIENTAS, resolvePermiso, permiteAcceso } from '../lib/permisos.js';

describe('permiso consulta-precios', () => {
  it('está en la lista de herramientas con niveles', () => {
    const h = HERRAMIENTAS.find(x => x.id === 'consulta-precios');
    expect(h).toBeTruthy();
    expect(h.niveles).toBe(true);
  });

  it('GET /consulta-precios/buscar requiere read', () => {
    const req = resolvePermiso('GET', '/consulta-precios/buscar');
    expect(req).toEqual({ anyOf: ['consulta-precios'], nivel: 'read' });
    expect(permiteAcceso([{ herramienta: 'consulta-precios', nivel: 'read' }], req)).toBe(true);
  });

  it('POST /consulta-precios/ean requiere write', () => {
    const req = resolvePermiso('POST', '/consulta-precios/ean');
    expect(req).toEqual({ anyOf: ['consulta-precios'], nivel: 'write' });
    expect(permiteAcceso([{ herramienta: 'consulta-precios', nivel: 'read' }], req)).toBe(false);
    expect(permiteAcceso([{ herramienta: 'consulta-precios', nivel: 'write' }], req)).toBe(true);
  });

  it('POST /consulta-precios/importar requiere write', () => {
    const req = resolvePermiso('POST', '/consulta-precios/importar');
    expect(req).toEqual({ anyOf: ['consulta-precios'], nivel: 'write' });
  });

  it('GET /consulta-precios/buscar-sku requiere read', () => {
    const req = resolvePermiso('GET', '/consulta-precios/buscar-sku');
    expect(req).toEqual({ anyOf: ['consulta-precios'], nivel: 'read' });
  });
});

describe('permiso codigos (Códigos Universales)', () => {
  it('está en la lista de herramientas con niveles', () => {
    const h = HERRAMIENTAS.find(x => x.id === 'codigos');
    expect(h).toBeTruthy();
    expect(h.niveles).toBe(true);
  });

  it('GET /codigos/faltantes requiere read', () => {
    const req = resolvePermiso('GET', '/codigos/faltantes');
    expect(req).toEqual({ anyOf: ['codigos'], nivel: 'read' });
    expect(permiteAcceso([{ herramienta: 'codigos', nivel: 'read' }], req)).toBe(true);
  });

  it('POST /codigos/asignar requiere write', () => {
    const req = resolvePermiso('POST', '/codigos/asignar');
    expect(req).toEqual({ anyOf: ['codigos'], nivel: 'write' });
    expect(permiteAcceso([{ herramienta: 'codigos', nivel: 'read' }], req)).toBe(false);
    expect(permiteAcceso([{ herramienta: 'codigos', nivel: 'write' }], req)).toBe(true);
  });
});

describe('permiso inventario (Contador de Inventario)', () => {
  it('está en la lista de herramientas, sin niveles (checkbox de acceso, no read/write)', () => {
    const h = HERRAMIENTAS.find(x => x.id === 'inventario');
    expect(h).toBeTruthy();
    expect(h.niveles).toBe(false);
  });

  // `inventario` es niveles:false → la UI de Usuarios siempre otorga el permiso con
  // nivel:'read' (checkbox de "acceso", sin selector read/write). Por eso la regla pide
  // explícitamente nivel:'read' sin importar el método HTTP: un operario de depósito
  // no-admin con el permiso tildado tiene que poder escanear/confirmar, no solo mirar.
  it('GET /inventario/sesion-activa requiere el permiso inventario', () => {
    const req = resolvePermiso('GET', '/inventario/sesion-activa');
    expect(req).toEqual({ anyOf: ['inventario'], nivel: 'read' });
    expect(permiteAcceso([{ herramienta: 'inventario', nivel: 'read' }], req)).toBe(true);
  });

  it('POST /inventario/sesiones/1/confirmar también alcanza con el permiso otorgado por la UI (nivel read) — no queda bloqueado el operario no-admin', () => {
    const req = resolvePermiso('POST', '/inventario/sesiones/1/confirmar');
    expect(req).toEqual({ anyOf: ['inventario'], nivel: 'read' });
    expect(permiteAcceso([{ herramienta: 'inventario', nivel: 'read' }], req)).toBe(true);
  });

  it('sin el permiso otorgado, cualquier acción queda bloqueada', () => {
    const req = resolvePermiso('POST', '/inventario/sesiones/1/confirmar');
    expect(permiteAcceso([], req)).toBe(false);
    expect(permiteAcceso([{ herramienta: 'otra-herramienta', nivel: 'write' }], req)).toBe(false);
  });
});

describe('permiso matcher (herramienta unificada, entrega 1 — absorbe cobertura y vínculos)', () => {
  // Matcher unificado (2026-08-14): 'cobertura' dejó de ser un permiso aparte, se absorbió
  // en 'matcher' (niveles:true, a diferencia del extinto 'cobertura' con niveles:false).
  it('cobertura ya no existe como herramienta separada', () => {
    const h = HERRAMIENTAS.find(x => x.id === 'cobertura');
    expect(h).toBeUndefined();
  });

  it('GET /cobertura/resumen requiere el permiso matcher, nivel read', () => {
    const req = resolvePermiso('GET', '/cobertura/resumen');
    expect(req).toEqual({ anyOf: ['matcher'], nivel: 'read' });
    expect(permiteAcceso([{ herramienta: 'matcher', nivel: 'read' }], req)).toBe(true);
  });

  it('POST /cobertura/productos/1/confirmar exige nivel write (matcher es niveles:true, ya no niveles:false)', () => {
    const req = resolvePermiso('POST', '/cobertura/productos/1/confirmar');
    expect(req).toEqual({ anyOf: ['matcher'], nivel: 'write' });
    expect(permiteAcceso([{ herramienta: 'matcher', nivel: 'write' }], req)).toBe(true);
    expect(permiteAcceso([{ herramienta: 'matcher', nivel: 'read' }], req)).toBe(false);
  });

  it('POST /cobertura/multi-publicacion/:clave/pausar (escritura a ML) exige nivel write; la restricción admin-only vive en el handler, no acá', () => {
    const req = resolvePermiso('POST', '/cobertura/multi-publicacion/MLA1|/pausar');
    expect(req).toEqual({ anyOf: ['matcher'], nivel: 'write' });
  });

  it('sin el permiso otorgado, cualquier acción queda bloqueada', () => {
    const req = resolvePermiso('POST', '/cobertura/productos/1/confirmar');
    expect(permiteAcceso([], req)).toBe(false);
    expect(permiteAcceso([{ herramienta: 'otra-herramienta', nivel: 'write' }], req)).toBe(false);
  });

  it('GET /sync/buscar-sku (Buscar producto, absorbido de Vínculos) alcanza con matcher, sin necesitar sync-ml', () => {
    const req = resolvePermiso('GET', '/sync/buscar-sku');
    expect(req).toEqual({ anyOf: ['config-ml', 'sync-ml', 'matcher'], nivel: 'read' });
    expect(permiteAcceso([{ herramienta: 'matcher', nivel: 'read' }], req)).toBe(true);
  });
});

describe('permiso config-ml masivo (reservas locales por lote)', () => {
  it('GET /sync/catalogo-config acepta config-ml o sync-ml, nivel read (misma regla que buscar-sku)', () => {
    const req = resolvePermiso('GET', '/sync/catalogo-config');
    expect(req).toEqual({ anyOf: ['config-ml', 'sync-ml'], nivel: 'read' });
    expect(permiteAcceso([{ herramienta: 'config-ml', nivel: 'read' }], req)).toBe(true);
    expect(permiteAcceso([{ herramienta: 'sync-ml', nivel: 'read' }], req)).toBe(true);
    expect(permiteAcceso([], req)).toBe(false);
  });

  it('un usuario con solo config-ml (sin sync-ml) puede acceder a catalogo-config para poder usar el lote', () => {
    const req = resolvePermiso('GET', '/sync/catalogo-config');
    expect(permiteAcceso([{ herramienta: 'config-ml', nivel: 'read' }], req)).toBe(true);
  });

  it('POST /sync/config-ml/lote exige config-ml con nivel write (igual que el alta unitaria)', () => {
    const req = resolvePermiso('POST', '/sync/config-ml/lote');
    expect(req).toEqual({ anyOf: ['config-ml'], nivel: 'write' });
    expect(permiteAcceso([{ herramienta: 'config-ml', nivel: 'read' }], req)).toBe(false);
    expect(permiteAcceso([{ herramienta: 'config-ml', nivel: 'write' }], req)).toBe(true);
    expect(permiteAcceso([{ herramienta: 'sync-ml', nivel: 'write' }], req)).toBe(false);
  });
});

describe('permisos taller y garantías (migración 134)', () => {
  it('están en HERRAMIENTAS con niveles', () => {
    for (const id of ['taller', 'garantias']) expect(HERRAMIENTAS.find(x => x.id === id)?.niveles).toBe(true);
  });

  it('/workshop y /warranties piden taller / garantias, no pedidos ni stock-exceptions', () => {
    expect(resolvePermiso('GET', '/workshop')).toEqual({ anyOf: ['taller'], nivel: 'read' });
    expect(resolvePermiso('POST', '/workshop/1')).toEqual({ anyOf: ['taller'], nivel: 'write' });
    expect(resolvePermiso('GET', '/warranties')).toEqual({ anyOf: ['garantias'], nivel: 'read' });
    expect(resolvePermiso('POST', '/warranties/3/adjuntos')).toEqual({ anyOf: ['garantias'], nivel: 'write' });
    expect(permiteAcceso([{ herramienta: 'pedidos', nivel: 'write' }], resolvePermiso('GET', '/workshop'))).toBe(false);
    expect(permiteAcceso([{ herramienta: 'garantias', nivel: 'read' }], resolvePermiso('POST', '/warranties'))).toBe(false);
  });

  it('las tarjetas del home usan ids que existen en HERRAMIENTAS y Posventa ya no es solo-admin', () => {
    const html = fs.readFileSync(path.resolve(__dirname, '../public/home/index.html'), 'utf8');
    const ids = new Set(HERRAMIENTAS.map(h => h.id));
    for (const t of ['taller', 'garantias', 'stock-exceptions', 'pedidos']) expect(ids.has(t)).toBe(true);
    expect(html).toMatch(/tool: 'pedidos', href: 'gestion-pedidos'/);
    expect(html).not.toMatch(/tool: 'excepciones'|tool: 'gestion-pedidos'/);
    // Excepciones: la API acepta stock-exceptions o stock, la tarjeta se ve con cualquiera de los dos.
    expect(html).toMatch(/tools: \['stock-exceptions', 'stock'\], href: 'excepciones'/);
    expect(html).toContain('(x.tools || []).some(tienePermiso)');
  });

  it('Gestión de pedidos oculta «Enviar a preparación» sin preparacion:write (admin siempre puede)', () => {
    const html = fs.readFileSync(path.resolve(__dirname, '../public/gestion-pedidos/index.html'), 'utf8');
    const fn = html.match(/function puedeCrearLote\(me\) \{[\s\S]*?\n  \}/)[0];
    const puede = new Function(`${fn}; return puedeCrearLote;`)();
    expect(puede({ ok: true, is_admin: true })).toBe(true);
    expect(puede({ ok: true, permisos: [{ herramienta: 'preparacion', nivel: 'write' }] })).toBe(true);
    expect(puede({ ok: true, permisos: [{ herramienta: 'preparacion', nivel: 'read' }] })).toBe(false);
    expect(puede({ ok: true, permisos: [{ herramienta: 'pedidos', nivel: 'write' }] })).toBe(false);
    expect(puede(null)).toBe(false);
    expect(html).toContain("$('btn-lote').style.display = 'none'");
    expect(html).not.toMatch(/titulo: 'Posventa'[^\n]*adminOnly/);
  });

  describe('la migración copia el acceso', () => {
    const FILE = './test/tmp-permisos-134.sqlite';
    let db;
    const SQL = fs.readFileSync(path.resolve(__dirname, '../migrations/134_permisos_taller_garantias.sql'), 'utf8');
    beforeEach(() => { db = openDb(FILE); });
    afterEach(() => { try { db.close(); } catch { /* ya cerrada */ } for (const s of ['', '-wal', '-shm']) if (fs.existsSync(`${FILE}${s}`)) fs.unlinkSync(`${FILE}${s}`); });
    const usuario = (n) => db.prepare("INSERT INTO users (username,pass_hash,is_admin,activo,creado_en,actualizado_en) VALUES (?,'x',0,1,'t','t')").run(n).lastInsertRowid;
    const dar = (u, h, n) => db.prepare('INSERT INTO user_permisos (user_id,herramienta,nivel) VALUES (?,?,?)').run(u, h, n);
    const de = (u) => Object.fromEntries(db.prepare("SELECT herramienta,nivel FROM user_permisos WHERE user_id=? AND herramienta IN ('taller','garantias')").all(u).map(r => [r.herramienta, r.nivel]));

    it('no baja un write existente aunque las fuentes sean read', () => {
      const u = usuario('w');
      dar(u, 'pedidos', 'read'); dar(u, 'taller', 'write');
      db.exec(SQL);
      expect(de(u)).toEqual({ taller: 'write', garantias: 'read' });
    });

    it('queda registrada al abrir la base', () => {
      expect(db.prepare("SELECT 1 FROM _schema_migrations WHERE key='permisos_taller_garantias_134'").get()).toBeTruthy();
    });

    it('write gana entre pedidos y stock-exceptions, no pisa lo existente, no toca a otros e es idempotente', () => {
      const a = usuario('a'), b = usuario('b'), c = usuario('c'), d = usuario('d'), e = usuario('e');
      dar(a, 'pedidos', 'read'); dar(a, 'stock-exceptions', 'write');
      dar(b, 'pedidos', 'read');
      dar(c, 'pedidos', 'write'); dar(c, 'taller', 'read');
      dar(d, 'stock', 'write');
      dar(e, 'stock-exceptions', 'read'); dar(e, 'pedidos', 'read');
      db.exec(SQL);
      expect(de(a)).toEqual({ taller: 'write', garantias: 'write' });
      expect(de(b)).toEqual({ taller: 'read', garantias: 'read' });
      expect(de(c)).toEqual({ taller: 'write', garantias: 'write' });   // read existente se eleva; nunca se baja
      expect(de(d)).toEqual({});
      expect(de(e)).toEqual({ taller: 'read', garantias: 'read' });
      db.exec(SQL);
      expect(de(a)).toEqual({ taller: 'write', garantias: 'write' });
    });
  });
});
