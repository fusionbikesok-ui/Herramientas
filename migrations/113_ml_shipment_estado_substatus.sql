-- 113_ml_shipment_estado_substatus.sql
--
-- Agrega `substatus` a ml_shipment_estado. Incidente real (2026-09-24): el pack
-- 2000015175820985 (orden ML 2000018610145024, xd_drop_off) ya se había entregado en el
-- punto de despacho pero ML seguía devolviendo `status='ready_to_ship'` -- el dato de que
-- ya salió estaba en `substatus='dropped_off'`, que hasta ahora no se guardaba ni se miraba.
-- Ver lib/preparacion.js#envioMlYaSalio (única función que decide "ya salió") y su uso en
-- clasificarElegibilidadMl, lib/gestionPedidos.js#estadoOperativoAPersistir y
-- routes/preparacion.js#estadoDelCanal.
--
-- Aplicación: igual convención que 001_*.sql -- este proyecto no usa runner de migraciones
-- ni PRAGMA user_version; todas son idempotentes y corren al arrancar (db/index.js,
-- ALTER TABLE envuelto en try/catch). Este .sql queda como registro auditable y para
-- aplicarlo a mano si hiciera falta.

ALTER TABLE ml_shipment_estado ADD COLUMN substatus TEXT;
