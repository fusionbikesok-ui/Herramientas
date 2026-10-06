-- 006_ml_shipment_estado.sql
--
-- Registra el último status conocido de cada envío ML consultado desde pendientesMl
-- (routes/preparacion.js). Un envío que llegó a un estado terminal (shipped, delivered,
-- cancelled) no vuelve nunca a ready_to_ship, así que dejamos de gastar un GET
-- /shipments/:id por él en cada corrida (cada 10 minutos, 137 órdenes de 30 días) mientras
-- el cacheo sea reciente (< 7 días; después se re-verifica contra ML). 'not_delivered' NO
-- se trata como terminal: es una visita fallida con reintento, y para envíos locales
-- (self_service/Flex) el envío puede volver a ready_to_ship.
-- Decisión vigente consolidada en docs/superpowers/plans/plan-maestro-v2.md.
--
-- Aplicación: igual convención que 001_*.sql — este proyecto no usa runner de migraciones ni
-- PRAGMA user_version; todas son idempotentes y corren al arrancar (db/index.js, CREATE TABLE
-- IF NOT EXISTS envuelto en try/catch). Este .sql queda como registro auditable y para
-- aplicarlo a mano si hiciera falta.

CREATE TABLE IF NOT EXISTS ml_shipment_estado (
  shipment_id    TEXT PRIMARY KEY,
  status         TEXT NOT NULL,
  logistic_type  TEXT,
  actualizado_en TEXT NOT NULL
);
