-- E1 T4 · tarea 4: estado durable de cada artefacto firmado.
-- Las tablas de T1 (audit.audit_daily_manifests, integrations.daily_shadow_reports) exigen clave de objeto
-- y versión de B2 NOT NULL, así que no tienen dónde representar "firmado pero todavía no subido". Sin ese
-- estado, un fallo de red obliga a inventar identificadores o a perder la idempotencia (hallazgo 1 de la
-- revisión externa del 2026-09-17).
CREATE SCHEMA informes;

-- Dos estados independientes, no una cadena: con un solo camino, un email enviado daba por terminado un
-- artefacto que nunca se subió, y el reintento de B2 moría ahí (hallazgo 1 de la revisión del plan).
CREATE TABLE informes.entregas (
  tipo              text NOT NULL CHECK (tipo IN ('manifiesto', 'reporte')),
  fecha             date NOT NULL,
  estado_deposito   text NOT NULL DEFAULT 'generado' CHECK (estado_deposito IN ('generado', 'firmado', 'subido')),
  estado_aviso      text NOT NULL DEFAULT 'pendiente' CHECK (estado_aviso IN ('pendiente', 'avisado')),
  hash_contenido    text NOT NULL CHECK (hash_contenido ~ '^[0-9a-f]{64}$'),
  kid               text,
  ruta_pendiente    text,
  b2_object_key     text,
  b2_version_id     text,
  -- La retención se fija al confirmar la subida, no al armar el contenido: si se calculara sobre el día
  -- reportado, recuperar días viejos dejaría menos de 365 días reales (hallazgo 3).
  retention_until   timestamptz,
  intentos_deposito integer NOT NULL DEFAULT 0 CHECK (intentos_deposito >= 0),
  intentos_aviso    integer NOT NULL DEFAULT 0 CHECK (intentos_aviso >= 0),
  ultimo_error      text,
  -- El candado de sesión del scheduler no alcanza: al perder la conexión, el proceso viejo puede seguir
  -- subiendo y enviando. Cada efecto se reclama con este testigo, verificado antes y después.
  testigo           uuid,
  lease_hasta       timestamptz,
  generado_en       timestamptz NOT NULL DEFAULT now(),
  firmado_en        timestamptz,
  subido_en         timestamptz,
  avisado_en        timestamptz,
  PRIMARY KEY (tipo, fecha),
  CONSTRAINT entregas_subido_check CHECK (
    (estado_deposito = 'subido') = (b2_object_key IS NOT NULL AND b2_version_id IS NOT NULL AND retention_until IS NOT NULL))
);

CREATE INDEX entregas_deposito_pendiente ON informes.entregas (fecha) WHERE estado_deposito <> 'subido';
CREATE INDEX entregas_aviso_pendiente ON informes.entregas (fecha) WHERE estado_aviso = 'pendiente';

-- El esquema de T1 fijaba `retention_mode = 'governance'`, que contradice la decisión de José del 2026-09-17
-- (compliance: que nadie, ni con la clave maestra, pueda acortar la retención). Se amplía el CHECK y se deja
-- compliance como el modo de producción. No hay filas que convertir: la tabla nunca se usó.
ALTER TABLE audit.audit_daily_manifests DROP CONSTRAINT audit_daily_manifests_retention_mode_check;
ALTER TABLE audit.audit_daily_manifests
  ADD CONSTRAINT audit_daily_manifests_retention_mode_check CHECK (retention_mode IN ('governance', 'compliance'));

-- Los GRANT por defecto de 0002_permisos.sql cubren core, security, audit e integrations: un esquema nuevo
-- necesita los suyos. Sin DELETE: una entrega es evidencia de lo que pasó ese día.
GRANT USAGE ON SCHEMA informes TO plataforma_app;
GRANT SELECT, INSERT, UPDATE ON informes.entregas TO plataforma_app;
ALTER DEFAULT PRIVILEGES FOR ROLE plataforma_migrador IN SCHEMA informes GRANT SELECT, INSERT, UPDATE ON TABLES TO plataforma_app;
