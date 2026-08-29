import { describe, it, expect } from 'vitest';
import { openDb } from '../db/index.js';

describe('backbone durable de Claims P1', () => {
  it('crea todas las tablas y restricciones base en una DB nueva', () => {
    const db = openDb(':memory:');
    const tablas = db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table'
        AND name IN ('integration_events','integration_jobs','integration_event_history',
          'inbox_items','conversations','conversation_messages','user_notifications',
          'notification_deliveries') ORDER BY name
    `).all().map(row => row.name);
    expect(tablas).toEqual([
      'conversation_messages', 'conversations', 'inbox_items',
      'integration_event_history', 'integration_events', 'integration_jobs',
      'notification_deliveries', 'user_notifications',
    ]);
    expect(db.pragma('user_version', { simple: true })).toBe(30);

    const insert = db.transaction(() => {
      db.prepare(`INSERT INTO integration_events
        (event_id,event_type,channel,source,received_at,correlation_id,dedupe_key)
        VALUES (?,?,?,?,?,?,?)`).run('evt-1', 'claim.received', 'ml', 'mercadolibre',
        '2026-08-29T00:00:00.000Z', 'corr-1', 'ml:claim:1:v1');
      db.prepare(`INSERT INTO integration_jobs
        (event_id,job_type,available_at) VALUES (?,?,?)`).run('evt-1', 'project.claim', '2026-08-29T00:00:00.000Z');
    });
    insert();
    expect(db.prepare('SELECT COUNT(*) AS n FROM integration_jobs WHERE event_id = ?').get('evt-1').n).toBe(1);
    expect(() => insert()).toThrow(/UNIQUE/);
    db.close();
  });
});
