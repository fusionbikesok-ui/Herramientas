/**
 * Contrato del retiro de Cobertura legacy (decisión del usuario, 2026-09-05).
 *
 * UM1 convirtió Cobertura en consulta histórica: su lugar lo ocupa Identidad de productos.
 * Sus botones anteriores podían escribir decisiones, seller_sku o pausas sin caso, sin
 * responsable, sin operación durable y sin retención de ventas — exactamente lo que UM1
 * existe para impedir.
 *
 * Este archivo es el que queda vivo de ese retiro. Los tests que afirmaban las mutaciones
 * viejas están en pausa (`it.skip`) en sus archivos originales, con el motivo escrito: si
 * alguna vez se revive la interfaz unificada, esa cobertura vuelve a hacer falta.
 *
 * Lo que se fija acá: la lectura sigue funcionando, la mutación responde 410 con una
 * indicación de a dónde ir, y el refresco manual sobrevive como alias compatible porque es
 * la misma lectura completa que usa Guardia ML.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import { openDb } from '../db/index.js';
import { coberturaRouter } from '../routes/cobertura.js';

const TEST_DB = './test/tmp-cobertura-legacy-retirada.sqlite';

function app(db) {
  const a = express();
  a.use(express.json());
  // Admin: el 410 no depende del permiso — no es una negativa de autorización, es que el
  // endpoint ya no existe. Con el usuario más privilegiado tiene que dar 410 igual.
  a.use((req, _res, next) => { req.user = { username: 'admin', is_admin: true, permisos: [] }; next(); });
  a.use('/api/cobertura', coberturaRouter(db));
  return a;
}

describe('Cobertura legacy — retirada a modo consulta', () => {
  let db;
  afterEach(() => {
    db?.close();
    for (const f of [TEST_DB, `${TEST_DB}-journal`]) if (fs.existsSync(f)) fs.unlinkSync(f);
  });

  const mutaciones = [
    ['post', '/api/cobertura/productos/100/confirmar'],
    ['post', '/api/cobertura/productos/100/omitir'],
    ['post', '/api/cobertura/solo-ml/MLA1%7C/vincular'],
    ['post', '/api/cobertura/solo-ml/MLA1%7C/pausar'],
    ['post', '/api/cobertura/multi-publicacion/MLA1%7C/desvincular'],
    ['post', '/api/cobertura/multi-publicacion/MLA1%7C/marcar-correcta'],
    ['post', '/api/cobertura/vinculos/MLA1%7C/deshacer'],
    ['post', '/api/cobertura/vinculos/revisado'],
    ['delete', '/api/cobertura/exclusiones/100/revertir'],
  ];

  it.each(mutaciones)('%s %s responde 410 y dice a dónde ir', async (metodo, ruta) => {
    db = openDb(TEST_DB);
    const res = await request(app(db))[metodo](ruta).send({});
    expect(res.status).toBe(410);
    expect(res.body.ok).toBe(false);
    // El 410 sin salida es una pared: tiene que decir dónde se hace ahora.
    expect(res.body.migracion).toMatch(/Guardia ML|Identidad/i);
  });

  it('la lectura sigue viva: el cruce responde 200', async () => {
    db = openDb(TEST_DB);
    const res = await request(app(db)).get('/api/cobertura/cruce');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('el refresco manual sobrevive como alias compatible, no cae en el 410', async () => {
    db = openDb(TEST_DB);
    const res = await request(app(db)).post('/api/cobertura/actualizar-ml').send({});
    expect(res.status).not.toBe(410);
  });
});
