import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { openDb } from '../db/index.js';

const FILE = './test/tmp-woo-cadencia.sqlite';
const ISO = '2026-09-07T00:00:00.000Z';

// El intervalo vive dentro de routes/woo.js y no se exporta; se comprueba su efecto sobre la
// decisión, que es lo que importa: cada cuánto se dispara el barrido completo.
function intervaloEsperado(db) {
  const f = db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN status <> 'active' THEN 1 ELSE 0 END) AS caidos
    FROM woo_webhooks_estado WHERE propio = 1 AND topic LIKE 'product.%'`).get();
  if (!f || !f.total) return 60 * 60 * 1000;
  return f.caidos > 0 ? 60 * 60 * 1000 : 6 * 60 * 60 * 1000;
}

function webhook(db, { id, topic, status }) {
  db.prepare(`INSERT INTO woo_webhooks_estado (id,topic,status,delivery_url,propio,visto_en,status_desde)
    VALUES (?,?,?,'https://herramientas/x',1,?,?)`).run(id, topic, status, ISO, ISO);
}

describe('cadencia del barrido completo de Woo', () => {
  let db;
  beforeEach(() => { db = openDb(FILE); });
  afterEach(() => {
    try { db.close(); } catch { /* ya estaba cerrada */ }
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(`${FILE}${s}`)) fs.unlinkSync(`${FILE}${s}`);
  });

  it('con los webhooks entregando, el completo se espacia a 6 horas', () => {
    // Cada barrido son ~628 llamadas seguidas y el hosting las corta con 403. Los webhooks
    // cubren los cambios; el completo pasa a ser la red, no la vía principal.
    webhook(db, { id: 8, topic: 'product.created', status: 'active' });
    webhook(db, { id: 9, topic: 'product.updated', status: 'active' });
    expect(intervaloEsperado(db)).toBe(6 * 60 * 60 * 1000);
  });

  it('con un webhook de producto caído, vuelve a una hora', () => {
    // Woo desactiva un webhook por su cuenta y no avisa: sin esto el catálogo quedaría
    // desactualizado hasta seis horas sin que nada lo note.
    webhook(db, { id: 8, topic: 'product.created', status: 'active' });
    webhook(db, { id: 9, topic: 'product.updated', status: 'disabled' });
    expect(intervaloEsperado(db)).toBe(60 * 60 * 1000);
  });

  it('`paused` cuenta igual que `disabled`', () => {
    webhook(db, { id: 9, topic: 'product.updated', status: 'paused' });
    expect(intervaloEsperado(db)).toBe(60 * 60 * 1000);
  });

  it('un webhook de pedidos caído no acorta el barrido de catálogo', () => {
    // `order.updated` no trae cambios de producto: acortar por él sería castigar al catálogo
    // por un problema que no lo afecta.
    webhook(db, { id: 8, topic: 'product.created', status: 'active' });
    webhook(db, { id: 7, topic: 'order.updated', status: 'disabled' });
    expect(intervaloEsperado(db)).toBe(6 * 60 * 60 * 1000);
  });

  it('sin ningún webhook conocido todavía, NO se relaja', () => {
    // Antes de la primera lectura no hay evidencia de que cubran, y relajar por defecto sería
    // relajar a ciegas. La vigilancia corre cada hora, así que la espera es corta.
    expect(intervaloEsperado(db)).toBe(60 * 60 * 1000);
  });
});
