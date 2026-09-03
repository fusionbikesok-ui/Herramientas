import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { migrateMlClaims } from '../migrations/028_ml_reclamos_campos_tipo_razon.mjs';
import { migrateClaimsBackbone } from '../migrations/029_claims_backbone_p1.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function aplicarMigracionHito7(db) {
  try {
    db.transaction(() => {
      // Todo el esquema Hito 7, incluidos sus índices, se aplica como una unidad. Un
      // conflicto de unicidad o cualquier otro error hace rollback y deja user_version
      // en la versión anterior.
      db.exec(`CREATE TABLE IF NOT EXISTS device_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token TEXT NOT NULL,
        plataforma TEXT NOT NULL CHECK(plataforma IN ('ios', 'android', 'web')),
        nombre_dispositivo TEXT,
        creado_en TEXT NOT NULL,
        actualizado_en TEXT NOT NULL,
        revocado_en TEXT
      )`);
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_device_tokens_unique_active
        ON device_tokens(token) WHERE revocado_en IS NULL`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_device_tokens_usuario_activo
        ON device_tokens(user_id, revocado_en) WHERE revocado_en IS NULL`);

      db.exec(`CREATE TABLE IF NOT EXISTS preferencias_notificacion (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        incidentes_criticos INTEGER NOT NULL DEFAULT 1,
        actualizado_en TEXT NOT NULL
      )`);

      db.exec(`CREATE TABLE IF NOT EXISTS notificaciones_enviadas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_token_id INTEGER NOT NULL REFERENCES device_tokens(id) ON DELETE CASCADE,
        tipo TEXT NOT NULL,
        incidente_id INTEGER REFERENCES incidentes_operativos(id) ON DELETE SET NULL,
        estado TEXT NOT NULL,
        intentos INTEGER NOT NULL DEFAULT 1,
        error TEXT,
        creado_en TEXT NOT NULL
      )`);
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_notificaciones_dedupe
        ON notificaciones_enviadas(device_token_id, tipo, incidente_id)
        WHERE tipo IN ('nuevo', 'resuelto')`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_notificaciones_pendientes
        ON notificaciones_enviadas(device_token_id, estado, creado_en)
        WHERE estado IN ('pendiente', 'fallido', 'agotado')`);

      db.exec(`CREATE TABLE IF NOT EXISTS notificaciones_usuario (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        tipo TEXT NOT NULL,
        titulo TEXT NOT NULL,
        cuerpo TEXT NOT NULL,
        deep_link TEXT,
        leida INTEGER NOT NULL DEFAULT 0,
        incidente_id INTEGER REFERENCES incidentes_operativos(id) ON DELETE SET NULL,
        creado_en TEXT NOT NULL
      )`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_notificaciones_usuario_no_leidas
        ON notificaciones_usuario(user_id, leida, creado_en DESC)`);
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_notificaciones_usuario_dedupe
        ON notificaciones_usuario(user_id, tipo, incidente_id)`);

      // Una base de una versión anterior puede tener esta tabla con device_id nullable.
      // Se reconstruye dentro de esta misma transacción; ningún huérfano se descarta.
      db.exec(`CREATE TABLE IF NOT EXISTS mobile_refresh_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_hash TEXT NOT NULL UNIQUE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        device_id INTEGER NOT NULL REFERENCES device_tokens(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        revocado_en TEXT,
        reemplazado_por TEXT,
        creado_en TEXT NOT NULL
      )`);
      let refreshColumns = db.prepare('PRAGMA table_info(mobile_refresh_tokens)').all();
      if (!refreshColumns.some((column) => column.name === 'reemplazado_por')) {
        db.exec('ALTER TABLE mobile_refresh_tokens ADD COLUMN reemplazado_por TEXT');
        refreshColumns = db.prepare('PRAGMA table_info(mobile_refresh_tokens)').all();
      }
      const refreshDevice = refreshColumns.find((column) => column.name === 'device_id');
      if (!refreshDevice || refreshDevice.notnull !== 1) {
        const orphaned = db.prepare(
          'SELECT COUNT(*) AS count FROM mobile_refresh_tokens WHERE device_id IS NULL'
        ).get().count;
        if (orphaned > 0) {
          throw new Error(`hay ${orphaned} refresh token(s) huérfano(s); no se puede aplicar NOT NULL`);
        }
        db.exec(`
          DROP INDEX IF EXISTS idx_mobile_refresh_device;
          DROP TABLE IF EXISTS mobile_refresh_tokens_nueva;
          CREATE TABLE mobile_refresh_tokens_nueva (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            token_hash TEXT NOT NULL UNIQUE,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            device_id INTEGER NOT NULL REFERENCES device_tokens(id) ON DELETE CASCADE,
            expires_at TEXT NOT NULL,
            revocado_en TEXT,
            reemplazado_por TEXT,
            creado_en TEXT NOT NULL
          );
          INSERT INTO mobile_refresh_tokens_nueva
            (id, token_hash, user_id, device_id, expires_at, revocado_en, reemplazado_por, creado_en)
          SELECT id, token_hash, user_id, device_id, expires_at, revocado_en, reemplazado_por, creado_en
            FROM mobile_refresh_tokens;
          DROP TABLE mobile_refresh_tokens;
          ALTER TABLE mobile_refresh_tokens_nueva RENAME TO mobile_refresh_tokens;
        `);
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_mobile_refresh_device
        ON mobile_refresh_tokens(device_id, revocado_en)`);

      const sentColumns = db.prepare('PRAGMA table_info(notificaciones_enviadas)').all()
        .map((column) => column.name);
      if (!sentColumns.includes('idempotencia')) {
        db.exec('ALTER TABLE notificaciones_enviadas ADD COLUMN idempotencia TEXT');
      }
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_notificaciones_idempotencia
        ON notificaciones_enviadas(idempotencia) WHERE idempotencia IS NOT NULL`);

      // Solo se alcanza después de aplicar tablas, reconstrucción y todos los índices.
      db.pragma('user_version = 30');
    })();
  } catch (err) {
    throw new Error(`Migración 030 no aplicada: ${err.message}`, { cause: err });
  }
}

export function openDb(dbPath) {
  const dir = path.dirname(dbPath);
  if (dir !== '.' && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath);
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  // Incremental migrations — safe to run every startup
  // Reclamos ML: las bases existentes ya tienen ml_reclamos sin estos campos; el
  // CREATE TABLE IF NOT EXISTS del router no puede ampliar una tabla existente.
  migrateMlClaims(db);
  migrateClaimsBackbone(db);
  // Horarios de despacho: migración independiente para bases que ya alcanzaron user_version=30.
  const horarioMigration = db.prepare("SELECT 1 FROM _schema_migrations WHERE key='despacho_horarios_032'").get();
  if (!horarioMigration) {
    const aplicarHorarios = db.transaction(() => {
      db.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', '032_despacho_horarios.sql'), 'utf8'));
      let columnas = db.prepare('PRAGMA table_info(pedidos_cache)').all().map((c) => c.name);
      if (columnas.length && !columnas.includes('fecha_despacho')) {
        db.exec('ALTER TABLE pedidos_cache ADD COLUMN fecha_despacho TEXT');
        columnas = db.prepare('PRAGMA table_info(pedidos_cache)').all().map((c) => c.name);
      }
      db.exec(`CREATE TABLE IF NOT EXISTS despacho_horarios_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL DEFAULT 1, actualizado_en TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS despacho_horarios_auditoria (
        id INTEGER PRIMARY KEY AUTOINCREMENT, usuario TEXT, valores_anteriores_json TEXT NOT NULL,
        valores_nuevos_json TEXT NOT NULL, version_anterior INTEGER NOT NULL, version_nueva INTEGER NOT NULL,
        creado_en TEXT NOT NULL
      );
      INSERT OR IGNORE INTO despacho_horarios_meta (id, version, actualizado_en)
        VALUES (1, 1, CURRENT_TIMESTAMP);`);
      db.prepare("INSERT INTO _schema_migrations (key) VALUES ('despacho_horarios_032')").run();
    });
    aplicarHorarios();
  }
  const despachoMigration = db.prepare("SELECT 1 FROM _schema_migrations WHERE key='control_despacho_033'").get();
  if (!despachoMigration) {
    const aplicarDespacho = db.transaction(() => {
      db.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', '033_control_despacho.sql'), 'utf8'));
      db.prepare("INSERT INTO _schema_migrations (key) VALUES ('control_despacho_033')").run();
    });
    aplicarDespacho();
  }
  const despachoIdempotenciaMigration = db.prepare("SELECT 1 FROM _schema_migrations WHERE key='control_despacho_idempotencia_034'").get();
  if (!despachoIdempotenciaMigration) {
    const aplicarDespachoIdempotencia = db.transaction(() => {
      const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '034_control_despacho_idempotencia.sql'), 'utf8');
      for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) {
        try { db.exec(statement); }
        catch (error) {
          // Una caída entre DDL y el marcador puede dejar una columna aplicada. En ese
          // caso la migración se reanuda; cualquier otro error aborta toda la transacción.
          if (!/ALTER TABLE .* ADD COLUMN/i.test(statement) || !/duplicate column name/i.test(error.message)) throw error;
        }
      }
      db.prepare("INSERT INTO _schema_migrations (key) VALUES ('control_despacho_idempotencia_034')").run();
    });
    aplicarDespachoIdempotencia();
  }
  const integrationLeaseMigration = db.prepare("SELECT 1 FROM _schema_migrations WHERE key='integration_jobs_lease_token_035'").get();
  if (!integrationLeaseMigration) {
    const aplicarLease = db.transaction(() => {
      const hasColumn = db.prepare('PRAGMA table_info(integration_jobs)').all().some((c) => c.name === 'lease_token');
      if (!hasColumn) db.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', '035_integration_jobs_lease_token.sql'), 'utf8'));
      db.prepare("INSERT INTO _schema_migrations (key) VALUES ('integration_jobs_lease_token_035')").run();
    });
    aplicarLease();
  }
  const incidentEmailOutboxMigration = db.prepare("SELECT 1 FROM _schema_migrations WHERE key='incidentes_email_outbox_036'").get();
  if (!incidentEmailOutboxMigration) {
    const aplicarIncidentEmailOutbox = db.transaction(() => {
      db.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', '036_incidentes_email_outbox.sql'), 'utf8'));
      db.prepare("INSERT INTO _schema_migrations (key) VALUES ('incidentes_email_outbox_036')").run();
    });
    aplicarIncidentEmailOutbox();
  }
  const incidentEmailDlqMigration = db.prepare("SELECT 1 FROM _schema_migrations WHERE key='incidentes_email_outbox_dlq_037'").get();
  if (!incidentEmailDlqMigration) {
    const aplicarIncidentEmailDlq = db.transaction(() => {
      const tieneDlq = db.prepare('PRAGMA table_info(incidentes_email_outbox)').all().some((c) => c.name === 'dlq');
      if (!tieneDlq) db.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', '037_incidentes_email_outbox_dlq.sql'), 'utf8'));
      db.prepare("INSERT INTO _schema_migrations (key) VALUES ('incidentes_email_outbox_dlq_037')").run();
    });
    aplicarIncidentEmailDlq();
  }
  const fotosUploadMigration = db.prepare("SELECT 1 FROM _schema_migrations WHERE key='preparacion_fotos_upload_id_038'").get();
  if (!fotosUploadMigration) {
    const aplicarFotosUpload = db.transaction(() => {
      const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='preparacion_fotos'").get();
      if (!table) return;
      const hasColumn = db.prepare('PRAGMA table_info(preparacion_fotos)').all().some((c) => c.name === 'upload_id');
      if (!hasColumn) db.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', '038_preparacion_fotos_upload_id.sql'), 'utf8'));
      else db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_preparacion_fotos_upload ON preparacion_fotos(preparacion_id, upload_id) WHERE upload_id IS NOT NULL');
      db.prepare("INSERT INTO _schema_migrations (key) VALUES ('preparacion_fotos_upload_id_038')").run();
    });
    aplicarFotosUpload();
  }
  const etiquetasIdempotenciaMigration = db.prepare("SELECT 1 FROM _schema_migrations WHERE key='etiquetas_idempotencia_039'").get();
  if (!etiquetasIdempotenciaMigration) {
    const aplicarEtiquetasIdempotencia = db.transaction(() => {
      const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='etiquetas_cola'").get();
      if (!table) return;
      const hasColumn = db.prepare('PRAGMA table_info(etiquetas_cola)').all().some((c) => c.name === 'idempotencia');
      if (!hasColumn) db.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', '039_etiquetas_idempotencia.sql'), 'utf8'));
      else db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_etiquetas_idempotencia ON etiquetas_cola(idempotencia) WHERE idempotencia IS NOT NULL');
      db.prepare("INSERT INTO _schema_migrations (key) VALUES ('etiquetas_idempotencia_039')").run();
    });
    aplicarEtiquetasIdempotencia();
  }
  const stockMovementMigration = db.prepare("SELECT 1 FROM _schema_migrations WHERE key='stock_movements_locations_040'").get();
  if (!stockMovementMigration) {
    const aplicarStockMovements = db.transaction(() => {
      db.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', '040_stock_movements_locations.sql'), 'utf8'));
      db.prepare("INSERT INTO _schema_migrations (key) VALUES ('stock_movements_locations_040')").run();
    });
    aplicarStockMovements();
  }
  const stockRolloutMigration = db.prepare("SELECT 1 FROM _schema_migrations WHERE key='stock_rollout_skus_041'").get();
  if (!stockRolloutMigration) {
    db.transaction(() => {
      db.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', '041_stock_rollout_skus.sql'), 'utf8'));
      db.prepare("INSERT INTO _schema_migrations (key) VALUES ('stock_rollout_skus_041')").run();
    })();
  }
  const operationalWavesMigration = db.prepare("SELECT 1 FROM _schema_migrations WHERE key='operational_day_waves_042'").get();
  if (!operationalWavesMigration) {
    db.transaction(() => {
      db.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', '042_operational_day_waves.sql'), 'utf8'));
      db.prepare("INSERT INTO _schema_migrations (key) VALUES ('operational_day_waves_042')").run();
    })();
  }
  const operationalWaveScopeMigration = db.prepare("SELECT 1 FROM _schema_migrations WHERE key='operational_day_wave_item_scope_043'").get();
  if (!operationalWaveScopeMigration) {
    db.transaction(() => {
      const hasOperationalDayId = db.prepare('PRAGMA table_info(pick_wave_items)').all()
        .some((column) => column.name === 'operational_day_id');
      if (!hasOperationalDayId) {
        db.exec('ALTER TABLE pick_wave_items ADD COLUMN operational_day_id INTEGER REFERENCES operational_days(id)');
      }
      db.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', '043_operational_day_wave_item_scope.sql'), 'utf8'));
      db.prepare("INSERT INTO _schema_migrations (key) VALUES ('operational_day_wave_item_scope_043')").run();
    })();
  }
  const slaOperativoMigration = db.prepare("SELECT 1 FROM _schema_migrations WHERE key='sla_operativo_preparacion_044'").get();
  if (!slaOperativoMigration) {
    db.transaction(() => {
      const columnas = db.prepare('PRAGMA table_info(pedidos_cache)').all().map((c) => c.name);
      for (const [nombre, sql] of [
        ['fecha_despacho_limite', 'ALTER TABLE pedidos_cache ADD COLUMN fecha_despacho_limite TEXT'],
        ['estado_despacho', "ALTER TABLE pedidos_cache ADD COLUMN estado_despacho TEXT NOT NULL DEFAULT 'activo'"],
        ['despacho_motivo', 'ALTER TABLE pedidos_cache ADD COLUMN despacho_motivo TEXT'],
        ['shipment_limite_original', 'ALTER TABLE pedidos_cache ADD COLUMN shipment_limite_original TEXT'],
      ]) {
        if (columnas.length && !columnas.includes(nombre)) db.exec(sql);
      }
      db.prepare("INSERT INTO _schema_migrations (key) VALUES ('sla_operativo_preparacion_044')").run();
    })();
  }
  const perfilVersionMigration = db.prepare("SELECT 1 FROM _schema_migrations WHERE key='preparacion_perfil_version_045'").get();
  if (!perfilVersionMigration) {
    db.transaction(() => {
      const agregar = (tabla, columna) => {
        const tablaExiste = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(tabla);
        if (!tablaExiste) return;
        const existe = db.prepare(`PRAGMA table_info(${tabla})`).all().some((c) => c.name === columna);
        if (!existe) db.exec(`ALTER TABLE ${tabla} ADD COLUMN ${columna} ${tabla === 'preparacion_items' ? 'INTEGER NOT NULL DEFAULT 1' : 'INTEGER NOT NULL DEFAULT 1'}`);
      };
      agregar('preparacion_perfiles', 'version');
      agregar('preparacion_perfiles_sku', 'version');
      agregar('preparacion_items', 'perfil_version');
      db.prepare("INSERT INTO _schema_migrations (key) VALUES ('preparacion_perfil_version_045')").run();
    })();
  }
  const requisitosSnapshotMigration = db.prepare("SELECT 1 FROM _schema_migrations WHERE key='preparacion_requisitos_snapshot_046'").get();
  if (!requisitosSnapshotMigration) {
    db.transaction(() => {
      const existe = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='preparacion_items'").get();
      const columnas = existe ? db.prepare('PRAGMA table_info(preparacion_items)').all() : [];
      if (existe && !columnas.some((c) => c.name === 'requisitos_json_snapshot')) db.exec('ALTER TABLE preparacion_items ADD COLUMN requisitos_json_snapshot TEXT');
      db.prepare("INSERT INTO _schema_migrations (key) VALUES ('preparacion_requisitos_snapshot_046')").run();
    })();
  }
  const fotosHoldsMigration = db.prepare("SELECT 1 FROM _schema_migrations WHERE key='preparacion_fotos_holds_047'").get();
  if (!fotosHoldsMigration) {
    db.transaction(() => {
      db.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', '047_preparacion_fotos_holds.sql'), 'utf8'));
      db.prepare("INSERT INTO _schema_migrations (key) VALUES ('preparacion_fotos_holds_047')").run();
    })();
  }
  const jornadaPickingMigration = db.prepare("SELECT 1 FROM _schema_migrations WHERE key='jornada_picking_operativo_048'").get();
  if (!jornadaPickingMigration) {
    db.transaction(() => {
      const existePickWaves = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pick_waves'").get();
      if (existePickWaves) {
        const columnas = db.prepare('PRAGMA table_info(pick_waves)').all().map((c) => c.name);
        if (!columnas.includes('estado_operativo')) db.exec("ALTER TABLE pick_waves ADD COLUMN estado_operativo TEXT NOT NULL DEFAULT 'disponible'");
        if (!columnas.includes('expected_version')) db.exec("ALTER TABLE pick_waves ADD COLUMN expected_version INTEGER NOT NULL DEFAULT 1");
      }
      db.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', '048_jornada_picking_operativo.sql'), 'utf8'));
      try { db.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', '057_pick_wave_helper_entrega.sql'), 'utf8')); } catch (e) { if (!/duplicate column name/i.test(e.message)) throw e; }
      const shortageColumns = db.prepare('PRAGMA table_info(pick_wave_shortages)').all().map((c) => c.name);
      if (!shortageColumns.includes('estado')) db.exec("ALTER TABLE pick_wave_shortages ADD COLUMN estado TEXT NOT NULL DEFAULT 'pendiente'");
      if (!shortageColumns.includes('resuelto_por')) db.exec('ALTER TABLE pick_wave_shortages ADD COLUMN resuelto_por TEXT');
      if (!shortageColumns.includes('resuelto_en')) db.exec('ALTER TABLE pick_wave_shortages ADD COLUMN resuelto_en TEXT');
      const waveItemColumns = db.prepare('PRAGMA table_info(pick_wave_items)').all().map((c) => c.name);
      if (!waveItemColumns.includes('estado_operativo')) db.exec("ALTER TABLE pick_wave_items ADD COLUMN estado_operativo TEXT NOT NULL DEFAULT 'elegible'");
      if (!waveItemColumns.includes('bloqueo_motivo')) db.exec('ALTER TABLE pick_wave_items ADD COLUMN bloqueo_motivo TEXT');
      const assignmentColumns = db.prepare('PRAGMA table_info(pick_wave_assignments)').all().map((c) => c.name);
      if (!assignmentColumns.includes('motivo')) db.exec('ALTER TABLE pick_wave_assignments ADD COLUMN motivo TEXT');
      db.prepare("INSERT INTO _schema_migrations (key) VALUES ('jornada_picking_operativo_048')").run();
    })();
  }
  const etiquetasAgenteMigration = db.prepare("SELECT 1 FROM _schema_migrations WHERE key='etiquetas_agente_claim_resultado_049'").get();
  if (!etiquetasAgenteMigration) {
    db.transaction(() => {
      const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='etiquetas_cola'").get();
      if (table) {
        const columns = new Set(db.prepare('PRAGMA table_info(etiquetas_cola)').all().map(column => column.name));
        const additions = [
          ['agente_id', 'TEXT'],
          ['claim_token', 'TEXT'],
          ['claim_hasta', 'TEXT'],
          ['ultimo_error', 'TEXT'],
          ['error_en', 'TEXT'],
          ['ultimo_claim_token', 'TEXT'],
          ['ultimo_resultado', 'TEXT'],
        ];
        for (const [name, type] of additions) {
          if (!columns.has(name)) db.exec(`ALTER TABLE etiquetas_cola ADD COLUMN ${name} ${type}`);
        }
        db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_etiquetas_claim_token ON etiquetas_cola(claim_token) WHERE claim_token IS NOT NULL');
      }
      db.prepare("INSERT INTO _schema_migrations (key) VALUES ('etiquetas_agente_claim_resultado_049')").run();
    })();
  }
  const despachoLotesMigration = db.prepare("SELECT 1 FROM _schema_migrations WHERE key='despacho_lotes_050'").get();
  if (!despachoLotesMigration) {
    db.transaction(() => {
      db.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', '050_despacho_lotes.sql'), 'utf8'));
      db.prepare("INSERT INTO _schema_migrations (key) VALUES ('despacho_lotes_050')").run();
    })();
  }
  const despachoLoteScanMigration = db.prepare("SELECT 1 FROM _schema_migrations WHERE key='despacho_lote_scan_idempotencia_051'").get();
  if (!despachoLoteScanMigration) {
    db.transaction(() => {
      const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='despacho_lote_items'").get();
      if (table && !db.prepare('PRAGMA table_info(despacho_lote_items)').all().some(column => column.name === 'ultima_idempotencia')) {
        db.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', '051_despacho_lote_scan_idempotencia.sql'), 'utf8'));
      } else if (table) db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_despacho_lote_item_idempotencia ON despacho_lote_items(lote_id, ultima_idempotencia) WHERE ultima_idempotencia IS NOT NULL');
      db.prepare("INSERT INTO _schema_migrations (key) VALUES ('despacho_lote_scan_idempotencia_051')").run();
    })();
  }
  const despachoLoteTrackingMigration = db.prepare("SELECT 1 FROM _schema_migrations WHERE key='despacho_lote_tracking_052'").get();
  if (!despachoLoteTrackingMigration) {
    db.transaction(() => {
      const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='despacho_lote_items'").get();
      if (table && !db.prepare('PRAGMA table_info(despacho_lote_items)').all().some(column => column.name === 'tracking')) {
        db.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', '052_despacho_lote_tracking.sql'), 'utf8'));
      } else if (table) db.exec('CREATE INDEX IF NOT EXISTS idx_despacho_lote_items_tracking ON despacho_lote_items(tracking) WHERE tracking IS NOT NULL');
      db.prepare("INSERT INTO _schema_migrations (key) VALUES ('despacho_lote_tracking_052')").run();
    })();
  }
  const despachoLoteSalidaMigration = db.prepare("SELECT 1 FROM _schema_migrations WHERE key='despacho_lote_salida_053'").get();
  if (!despachoLoteSalidaMigration) {
    db.transaction(() => {
      const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='despacho_lotes'").get();
      if (table) {
        const columns = new Set(db.prepare('PRAGMA table_info(despacho_lotes)').all().map(column => column.name));
        for (const name of ['salida_confirmada_por', 'salida_confirmada_en', 'salida_idempotencia']) {
          if (!columns.has(name)) db.exec(`ALTER TABLE despacho_lotes ADD COLUMN ${name} TEXT`);
        }
        db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_despacho_lote_salida_idem ON despacho_lotes(salida_idempotencia) WHERE salida_idempotencia IS NOT NULL');
      }
      db.prepare("INSERT INTO _schema_migrations (key) VALUES ('despacho_lote_salida_053')").run();
    })();
  }
  const despachoLoteIdemMigration = db.prepare("SELECT 1 FROM _schema_migrations WHERE key='despacho_lote_idempotencia_054'").get();
  if (!despachoLoteIdemMigration) {
    db.transaction(() => {
      const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='despacho_lotes'").get();
      if (table) {
        const columns = new Set(db.prepare('PRAGMA table_info(despacho_lotes)').all().map(column => column.name));
        if (!columns.has('idempotencia')) db.exec('ALTER TABLE despacho_lotes ADD COLUMN idempotencia TEXT');
        db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_despacho_lote_idempotencia ON despacho_lotes(idempotencia) WHERE idempotencia IS NOT NULL');
      }
      db.prepare("INSERT INTO _schema_migrations (key) VALUES ('despacho_lote_idempotencia_054')").run();
    })();
  }
  const despachoLoteControlMigration = db.prepare("SELECT 1 FROM _schema_migrations WHERE key='despacho_lote_control_unico_055'").get();
  if (!despachoLoteControlMigration) {
    db.transaction(() => {
      const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='despacho_lote_items'").get();
      if (table) db.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', '055_despacho_lote_control_unico.sql'), 'utf8'));
      db.prepare("INSERT INTO _schema_migrations (key) VALUES ('despacho_lote_control_unico_055')").run();
    })();
  }
  const despachoLoteEventosMigration = db.prepare("SELECT 1 FROM _schema_migrations WHERE key='despacho_lote_eventos_056'").get();
  if (!despachoLoteEventosMigration) {
    db.transaction(() => {
      db.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', '056_despacho_lote_eventos.sql'), 'utf8'));
      db.prepare("INSERT INTO _schema_migrations (key) VALUES ('despacho_lote_eventos_056')").run();
    })();
  }
  const jornadaPausaMigration = db.prepare("SELECT 1 FROM _schema_migrations WHERE key='jornada_pausa_058'").get();
  if (!jornadaPausaMigration) {
    db.transaction(() => {
      const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pick_wave_claims'").get();
      if (table) {
        for (const ddl of ['ALTER TABLE pick_wave_claims ADD COLUMN pausada_en TEXT', 'ALTER TABLE pick_wave_claims ADD COLUMN pausada_por TEXT', 'ALTER TABLE pick_wave_claims ADD COLUMN motivo_pausa TEXT']) {
          try { db.exec(ddl); } catch (error) { if (!/duplicate column name/i.test(error.message)) throw error; }
        }
      }
      db.prepare("INSERT INTO _schema_migrations (key) VALUES ('jornada_pausa_058')").run();
    })();
  }
  const guardiaMlMigration = db.prepare("SELECT 1 FROM _schema_migrations WHERE key='guardia_ml_cobertura_059'").get();
  if (!guardiaMlMigration) {
    db.transaction(() => {
      db.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', '059_guardia_ml_cobertura.sql'), 'utf8'));
      db.prepare("INSERT INTO _schema_migrations (key) VALUES ('guardia_ml_cobertura_059')").run();
    })();
  }
  const guardiaMlPedidosMigration = db.prepare("SELECT 1 FROM _schema_migrations WHERE key='guardia_ml_pedidos_060'").get();
  if (!guardiaMlPedidosMigration) {
    db.transaction(() => {
      const columnasGuardia = db.prepare('PRAGMA table_info(guardia_ml_casos)').all().map((c) => c.name);
      if (!columnasGuardia.includes('pedido_ml_order_id')) db.exec('ALTER TABLE guardia_ml_casos ADD COLUMN pedido_ml_order_id TEXT');
      db.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', '060_guardia_ml_pedidos.sql'), 'utf8'));
      db.prepare("INSERT INTO _schema_migrations (key) VALUES ('guardia_ml_pedidos_060')").run();
    })();
  }
  const guardiaMlClaimMigration = db.prepare("SELECT 1 FROM _schema_migrations WHERE key='guardia_ml_claim_061'").get();
  if (!guardiaMlClaimMigration) {
    db.transaction(() => {
      const columnasOperaciones = db.prepare('PRAGMA table_info(guardia_ml_operaciones)').all().map((c) => c.name);
      if (!columnasOperaciones.includes('claim_hasta')) db.exec('ALTER TABLE guardia_ml_operaciones ADD COLUMN claim_hasta TEXT');
      if (!columnasOperaciones.includes('operador')) db.exec('ALTER TABLE guardia_ml_operaciones ADD COLUMN operador TEXT');
      if (!columnasOperaciones.includes('caso_version')) db.exec('ALTER TABLE guardia_ml_operaciones ADD COLUMN caso_version INTEGER');
      db.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', '061_guardia_ml_claim.sql'), 'utf8'));
      db.prepare("INSERT INTO _schema_migrations (key) VALUES ('guardia_ml_claim_061')").run();
    })();
  }
  // Migraciones históricas de preparación usan una secuencia propia (062–065).
  // 019–022 quedan reservadas para incidentes, métricas y dispositivos; no se
  // reutilizan números aunque la base nueva ya cree estas columnas.
  const preparacionPackMigration = db.prepare("SELECT 1 FROM _schema_migrations WHERE key='preparacion_pack_062_065'").get();
  if (!preparacionPackMigration) {
    db.transaction(() => {
      const existe = (tabla) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(tabla);
      const columnas = (tabla) => new Set(db.prepare(`PRAGMA table_info(${tabla})`).all().map((c) => c.name));
      if (existe('pedidos_cache') && existe('preparaciones')) {
        const pedidos = columnas('pedidos_cache');
        const preparaciones = columnas('preparaciones');
        if (!pedidos.has('pack_id')) db.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', '062_preparacion_pedidos_cache_pack_id.sql'), 'utf8'));
        if (!preparaciones.has('pack_id')) db.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', '063_preparacion_pack_id.sql'), 'utf8'));
        if (!preparaciones.has('woo_paso1_incierto')) db.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', '064_seguimiento_paso1_incierto.sql'), 'utf8'));
        db.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', '065_backfill_preparaciones_pack_id.sql'), 'utf8'));
      }
      db.prepare("INSERT INTO _schema_migrations (key) VALUES ('preparacion_pack_062_065')").run();
    })();
  }
  const stockExceptionsMigration = db.prepare("SELECT 1 FROM _schema_migrations WHERE key='stock_exceptions_066'").get();
  if (!stockExceptionsMigration) {
    db.transaction(() => {
      db.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', '066_stock_exceptions.sql'), 'utf8'));
      db.prepare("INSERT INTO _schema_migrations (key) VALUES ('stock_exceptions_066')").run();
    })();
  }
  const stockReturnsMigration = db.prepare("SELECT 1 FROM _schema_migrations WHERE key='stock_exception_returns_067'").get();
  if (!stockReturnsMigration) {
    const aplicarStockReturns = db.transaction(() => {
      db.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', '067_stock_exception_returns.sql'), 'utf8'));
      db.prepare("INSERT INTO _schema_migrations (key) VALUES ('stock_exception_returns_067')").run();
    });
    aplicarStockReturns();
  }
  const stockExceptionWooOutboxMigration = db.prepare("SELECT 1 FROM _schema_migrations WHERE key='stock_exception_woo_outbox_068'").get();
  if (!stockExceptionWooOutboxMigration) {
    const aplicarStockExceptionWooOutbox = db.transaction(() => {
      db.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', '068_stock_exception_woo_outbox.sql'), 'utf8'));
      db.prepare("INSERT INTO _schema_migrations (key) VALUES ('stock_exception_woo_outbox_068')").run();
    });
    aplicarStockExceptionWooOutbox();
  }
  const supplierReturnsMigration = db.prepare("SELECT 1 FROM _schema_migrations WHERE key='supplier_returns_disposals_069'").get();
  if (!supplierReturnsMigration) {
    const aplicarSupplierReturns = db.transaction(() => {
      db.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', '069_supplier_returns_disposals.sql'), 'utf8'));
      db.prepare("INSERT INTO _schema_migrations (key) VALUES ('supplier_returns_disposals_069')").run();
    });
    aplicarSupplierReturns();
  }
  try { db.exec('ALTER TABLE catalogo_cache ADD COLUMN categorias_json TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE catalogo_cache ADD COLUMN img TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE catalogo_cache ADD COLUMN precio REAL'); } catch (_) {}
  // Precio de LISTA de Woo (regular_price), separado del vigente (precio, que puede ser
  // sale_price si el producto está en oferta). El contado de una venta ML se calcula
  // siempre sobre LISTA (decisión del usuario, 2026-08-03) — ver precioContado() en
  // routes/sync.js. Queda NULL hasta el próximo refresco de catálogo tras desplegar esto.
  try { db.exec('ALTER TABLE catalogo_cache ADD COLUMN regular_price REAL'); } catch (_) {}
  // Atributos estructurados de la variación WC (color/talle) — evita re-parsear el nombre en el matcher.
  try { db.exec('ALTER TABLE catalogo_cache ADD COLUMN atributos_json TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE catalogo_cache ADD COLUMN marca TEXT'); } catch (_) {}
  // Código universal (GTIN/EAN/UPC) del producto — campo nativo de Woo global_unique_id.
  try { db.exec('ALTER TABLE catalogo_cache ADD COLUMN gtin TEXT'); } catch (_) {}
  // Consulta de Precios ── puente EAN→SKU (el EAN no vive en Woo); aprende de a uno.
  try { db.exec(`CREATE TABLE IF NOT EXISTS ean_sku (
    ean TEXT PRIMARY KEY,
    sku TEXT NOT NULL,
    actualizado_en TEXT NOT NULL
  )`); } catch (_) {}
  try { db.exec('ALTER TABLE recepciones ADD COLUMN confirmado_en TEXT'); } catch (_) {}
  try { db.exec(`CREATE TABLE IF NOT EXISTS skus_config_ml (
    sku TEXT PRIMARY KEY,
    nombre TEXT,
    modo TEXT NOT NULL DEFAULT 'reserva',
    reserva INTEGER NOT NULL DEFAULT 0,
    actualizado_en TEXT NOT NULL
  )`); } catch (_) {}
  try { db.exec(`CREATE TABLE IF NOT EXISTS ordenes_ml_wc_pedidos (
    ml_order_id TEXT PRIMARY KEY,
    wc_order_id INTEGER NOT NULL,
    comprador_json TEXT,
    creado_en TEXT NOT NULL
  )`); } catch (_) {}
  try { db.exec('ALTER TABLE ordenes_ml_wc_pedidos ADD COLUMN cancelado_en TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE ordenes_ml_wc_pedidos ADD COLUMN retenido_en TEXT'); } catch (_) {}
  try { db.exec(`CREATE TABLE IF NOT EXISTS ml_publicaciones_cache (
    clave TEXT PRIMARY KEY,
    item_id TEXT NOT NULL,
    variation_id TEXT,
    titulo TEXT,
    status TEXT,
    es_variante INTEGER NOT NULL DEFAULT 0,
    color TEXT,
    talle TEXT,
    seller_sku TEXT,
    variations_texto TEXT,
    actualizado_en TEXT NOT NULL
  )`); } catch (_) {}
  try { db.exec('ALTER TABLE ml_publicaciones_cache ADD COLUMN sub_status TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE ml_publicaciones_cache ADD COLUMN thumbnail TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE ml_publicaciones_cache ADD COLUMN permalink TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE ml_publicaciones_cache ADD COLUMN catalogo INTEGER'); } catch (_) {}

  // Precio y stock de ML cacheados en el mismo barrido del matcher (el multiget ya trae el
  // item completo). Habilitan el listado de vínculos sospechosos como query local, sin una
  // llamada a la API por publicación. precio_actualizado_en permite mostrar la antigüedad
  // del dato en la UI en vez de fingir que es en vivo.
  try { db.exec('ALTER TABLE ml_publicaciones_cache ADD COLUMN precio REAL'); } catch (_) {}
  try { db.exec('ALTER TABLE ml_publicaciones_cache ADD COLUMN available_quantity INTEGER'); } catch (_) {}
  try { db.exec('ALTER TABLE ml_publicaciones_cache ADD COLUMN precio_actualizado_en TEXT'); } catch (_) {}

  // Publicaciones que recuperaron stock pero la reactivación automática NO reactivó porque
  // el neto de ML quedaría por debajo del precio de contado. Se limpia sola: cuando el precio
  // pasa el chequeo, se reactiva y se borra la fila.
  try { db.exec(`CREATE TABLE IF NOT EXISTS ml_reactivacion_frenada (
    clave TEXT PRIMARY KEY,
    sku TEXT,
    motivo TEXT,
    neto REAL,
    precio_contado REAL,
    deficit_pct REAL,
    detectado_en TEXT NOT NULL
  )`); } catch (_) {}

  // Descartes de vínculos sospechosos ("revisado OK"). Guarda el VALOR descartado, no solo la
  // clave: si el dato cambia (ej. el precio de ML se mueve otra vez), el sospechoso reaparece.
  // PK compuesta porque una publicación puede tener una señal descartada y otra vigente.
  try { db.exec(`CREATE TABLE IF NOT EXISTS ml_vinculos_revisados (
    clave TEXT NOT NULL,
    senal TEXT NOT NULL,
    valor_revisado TEXT,
    revisado_por TEXT,
    revisado_en TEXT NOT NULL,
    PRIMARY KEY (clave, senal)
  )`); } catch (_) {}

  // Auditoría de precios ML: neto (precio − comisión − envío) vs precio web por publicación.
  try { db.exec(`CREATE TABLE IF NOT EXISTS ml_precio_auditoria (
    clave TEXT PRIMARY KEY,
    item_id TEXT NOT NULL,
    titulo TEXT,
    sku TEXT,
    precio_ml REAL,
    sale_fee REAL,
    envio REAL,
    neto REAL,
    precio_web REAL,
    deficit_pct REAL,
    estado TEXT,
    actualizado_en TEXT NOT NULL
  )`); } catch (_) {}

  // Errores de sync descartados a mano (no accionables: sin stock real, pausa manual, etc.)
  try { db.exec(`CREATE TABLE IF NOT EXISTS errores_descartados (
    clave TEXT PRIMARY KEY,
    motivo TEXT,
    creado_en TEXT NOT NULL
  )`); } catch (_) {}

  // Cobertura ── productos WC marcados a mano como "solo local" (no deben publicarse en ML)
  try { db.exec(`CREATE TABLE IF NOT EXISTS cobertura_exclusiones (
    id_woo INTEGER PRIMARY KEY,
    sku TEXT,
    nombre TEXT,
    motivo TEXT NOT NULL DEFAULT 'solo_local',
    creado_en TEXT NOT NULL
  )`); } catch (_) {}

  // Gestor de usuarios ── cuentas + permisos por herramienta
  try { db.exec(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pass_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    activo INTEGER NOT NULL DEFAULT 1,
    email TEXT,
    creado_en TEXT NOT NULL,
    actualizado_en TEXT NOT NULL
  )`); } catch (_) {}
  // Migración: agregar email a users si existe sin esa columna
  try { db.exec('ALTER TABLE users ADD COLUMN email TEXT'); } catch (_) {}
  // Tokens de reset de contraseña (un solo uso, expiran en 1h)
  try { db.exec(`CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`); } catch (_) {}
  try { db.exec(`CREATE TABLE IF NOT EXISTS user_permisos (
    user_id INTEGER NOT NULL,
    herramienta TEXT NOT NULL,
    nivel TEXT NOT NULL DEFAULT 'write',
    PRIMARY KEY (user_id, herramienta),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`); } catch (_) {}
  // Matcher: push automático de SKU a ML — fallos por publicación (backoff exponencial,
  // ver migrations/002_ml_sku_push_fallos.sql y lib/matcherPush.js).
  try { db.exec(`CREATE TABLE IF NOT EXISTS ml_sku_push_fallos (
    clave              TEXT PRIMARY KEY,
    sku                TEXT NOT NULL,
    intentos           INTEGER NOT NULL DEFAULT 0,
    ultimo_error       TEXT,
    ultimo_status      INTEGER,
    proximo_intento_en TEXT,
    actualizado_en     TEXT NOT NULL
  )`); } catch (_) {}

  // Caché persistente de comisión/envío de ML (ver migrations/004_ml_precios_cache.sql y
  // lib/mlPrecios.js) — evita repetir listing_prices/shipping_options/free que dan siempre
  // el mismo valor dentro de la ventana de vigencia (7 días, aplicado en código).
  try { db.exec(`CREATE TABLE IF NOT EXISTS ml_precios_cache (
    clave          TEXT PRIMARY KEY,
    valor          REAL NOT NULL,
    actualizado_en TEXT NOT NULL
  )`); } catch (_) {}

  // Último status conocido de cada envío ML (ver migrations/006_ml_shipment_estado.sql y
  // routes/preparacion.js#pendientesMl) — un envío en estado terminal (shipped/delivered/
  // cancelled) no vuelve nunca a ready_to_ship, así que dejamos de repreguntar su GET
  // /shipments/:id en cada corrida mientras el cacheo sea reciente (< 7 días).
  try { db.exec(`CREATE TABLE IF NOT EXISTS ml_shipment_estado (
    shipment_id    TEXT PRIMARY KEY,
    status         TEXT NOT NULL,
    logistic_type  TEXT,
    actualizado_en TEXT NOT NULL
  )`); } catch (_) {}

  // Insumos con los que se tomó la decisión de frenar una reactivación por precio (ver
  // migrations/005_reactivacion_frenada_insumos.sql): permiten re-evaluar localmente sin
  // pegarle a ML cuando ninguno de los dos precios cambió desde que se detectó la frenada.
  try { db.exec('ALTER TABLE ml_reactivacion_frenada ADD COLUMN precio_ml_evaluado REAL'); } catch (_) {}
  try { db.exec('ALTER TABLE ml_reactivacion_frenada ADD COLUMN precio_web_evaluado REAL'); } catch (_) {}

  // Store de sesiones (better-sqlite3-session-store crea su propia tabla 'sessions' al iniciar)

  // Cobertura accionable (migrations/007_cobertura_cola.sql) — ver ese archivo para el porqué
  // de qué SÍ y qué NO tiene tabla propia (vinculado/descartado reutilizan tablas existentes).
  try { db.exec(`CREATE TABLE IF NOT EXISTS cobertura_hay_que_publicar (
    id_woo INTEGER PRIMARY KEY,
    sku TEXT,
    nombre TEXT,
    marca TEXT,
    valor REAL,
    tachado INTEGER NOT NULL DEFAULT 0,
    creado_en TEXT NOT NULL
  )`); } catch (_) {}
  try { db.exec(`CREATE TABLE IF NOT EXISTS cobertura_salteados (
    id_woo INTEGER PRIMARY KEY,
    marca TEXT,
    creado_en TEXT NOT NULL
  )`); } catch (_) {}
  // Forma NUEVA para instalaciones limpias: así una base nueva nunca depende de que el bloque
  // de migración de abajo corra bien (hallazgo del revisor). El bloque 012 queda solo como
  // camino de upgrade para las bases que ya tienen el singleton viejo.
  try { db.exec(`CREATE TABLE IF NOT EXISTS cobertura_sesion (
    user_id INTEGER NOT NULL,
    direccion TEXT NOT NULL DEFAULT 'wc_ml',
    marca_actual TEXT,
    actualizado_en TEXT NOT NULL,
    PRIMARY KEY (user_id, direccion)
  )`); } catch (_) {}
  // migrations/012_cobertura_sesion_por_usuario.sql — "seguir donde quedé" era un singleton
  // (id=1) compartido por TODOS los usuarios: con Cobertura sola y un solo operario no
  // molestaba, pero con el Matcher unificado (Joaco gana acceso) dos personas trabajando la
  // cola al mismo tiempo se pisarían el progreso. Recreación (no ALTER: sqlite no soporta
  // cambiar la PRIMARY KEY) a (user_id, direccion) — direccion queda fija en 'wc_ml' en esta
  // entrega (solo existe esa dirección), pero la columna ya está para la entrega 2 (ML→WC).
  // Se pierde la marca "en trabajo" que hubiera en el singleton viejo (dato de conveniencia,
  // no de negocio) — aceptable, nadie pierde nada más que "seguir donde quedé" una vez.
  // En TRANSACCIÓN y con DROP IF EXISTS de la tabla intermedia (hallazgo del revisor): sin
  // eso, un corte entre el DROP y el RENAME —un kill de PM2 a destiempo— dejaba la base sin
  // `cobertura_sesion`; al reiniciar se recreaba con el esquema viejo, el CREATE de la
  // intermedia fallaba por "ya existe", el catch mudo se lo comía, y `tocarSesion` reventaba
  // en CADA carga de la cola: 500 en la pantalla principal, para siempre y sin log que lo
  // explicara. sqlite soporta DDL transaccional, así que o pasa entero o no pasa nada.
  try {
    const colsSesion = db.prepare("PRAGMA table_info(cobertura_sesion)").all().map((c) => c.name);
    if (colsSesion.length && !colsSesion.includes('user_id')) {
      db.transaction(() => {
        db.exec(`
          DROP TABLE IF EXISTS cobertura_sesion_nueva;
          CREATE TABLE cobertura_sesion_nueva (
            user_id INTEGER NOT NULL,
            direccion TEXT NOT NULL DEFAULT 'wc_ml',
            marca_actual TEXT,
            actualizado_en TEXT NOT NULL,
            PRIMARY KEY (user_id, direccion)
          );
          DROP TABLE cobertura_sesion;
          ALTER TABLE cobertura_sesion_nueva RENAME TO cobertura_sesion;
        `);
      })();
    }
  } catch (_) {}
  try { db.exec(`CREATE TABLE IF NOT EXISTS cobertura_marcados_correcto (
    clave TEXT PRIMARY KEY,
    seccion TEXT NOT NULL,
    marcado_en TEXT NOT NULL
  )`); } catch (_) {}

  // migrations/008_decisiones_origen.sql — distingue decisiones de Cobertura vs Matcher ML→WC.
  try { db.exec('ALTER TABLE sku_matcher_decisiones ADD COLUMN origen TEXT'); } catch (_) {}
  // migrations/013_decisiones_confirmado_por.sql — quién confirmó, para la concurrencia
  // optimista del Matcher unificado (dos personas pueden abrir el mismo ítem de la cola
  // priorizada; al confirmar se revalida y, si ya lo resolvió otra persona, la respuesta
  // dice quién y qué se decidió en vez de un 409 mudo). Username, no user_id: es solo para
  // mostrar en pantalla, no hay FK a `users` acá y el usuario puede borrarse después.
  try { db.exec('ALTER TABLE sku_matcher_decisiones ADD COLUMN confirmado_por TEXT'); } catch (_) {}
  // migrations/014_permiso_cobertura_a_matcher.sql — `cobertura` deja de existir como permiso
  // y queda cubierta por `matcher`. Sin esto, quien tuviera SOLO `cobertura` perdería el
  // acceso en silencio al desplegar. En staging no le pasa a nadie, pero producción es otra
  // base que se pasa a mano y no se puede verificar desde acá: la migración es defensiva.
  // Otorga `write`, NO el nivel guardado: `cobertura` era niveles:false y grabó siempre
  // 'read', pero ese 'read' habilitaba toda la herramienta. Con el nivel derivado del método,
  // copiarlo tal cual dejaría al usuario viendo la cola y con 403 en cada botón — una pérdida
  // de acceso silenciosa, peor que la visible que esta migración vino a evitar.
  // Si ya tiene `matcher`, ese gana (bajarlo sería quitarle acceso que hoy usa).
  try {
    db.exec(`
      INSERT INTO user_permisos (user_id, herramienta, nivel)
      SELECT c.user_id, 'matcher', 'write'
        FROM user_permisos c
       WHERE c.herramienta = 'cobertura'
         AND NOT EXISTS (
              SELECT 1 FROM user_permisos m
               WHERE m.user_id = c.user_id AND m.herramienta = 'matcher'
         );
      DELETE FROM user_permisos WHERE herramienta = 'cobertura';
    `);
  } catch (_) {}

  // Fase 0 (higiene) — Tarea 1: productos "no contables" (servicios, cargos, gift cards)
  // que ensucian el universo de inventario físico. Nunca se borran ni se excluyen del
  // catálogo en general: solo se sacan del alcance de una sesión de conteo.
  try { db.exec('ALTER TABLE catalogo_cache ADD COLUMN no_contable INTEGER NOT NULL DEFAULT 0'); } catch (_) {}

  // Fase 0 — Tarea 2: auditoría de diferencias detectadas al confirmar una sesión de
  // inventario, y freno explícito para sobrantes grandes (ver routes/inventario.js
  // /sesiones/:id/confirmar y /diferencias/*). stock_inicial_usado permite reconstruir
  // el llamado a setStockWcDelta al aprobar un sobrante frenado, sin volver a leer nada.
  try { db.exec(`CREATE TABLE IF NOT EXISTS inventario_diferencias (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sesion_id INTEGER NOT NULL,
    sku TEXT NOT NULL,
    cantidad_esperada INTEGER NOT NULL,
    cantidad_contada INTEGER NOT NULL,
    diferencia INTEGER NOT NULL,
    valor_diferencia REAL,
    tipo TEXT NOT NULL,
    requiere_revision INTEGER NOT NULL DEFAULT 0,
    revisado_en TEXT,
    revisado_por TEXT,
    creado_en TEXT NOT NULL
  )`); } catch (_) {}
  try { db.exec('ALTER TABLE inventario_diferencias ADD COLUMN stock_inicial_usado INTEGER'); } catch (_) {}

  // Fase 0 — Tarea 3: alertas de stock negativo detectadas en cada refresco de catálogo
  // (ver routes/woo.js refrescarCatalogo, log "[woo] calidad catálogo"). Una fila abierta
  // (resuelto_en IS NULL) por SKU mientras siga en negativo entre refrescos sucesivos.
  try { db.exec(`CREATE TABLE IF NOT EXISTS stock_negativo_alertas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sku TEXT NOT NULL,
    stock INTEGER NOT NULL,
    detectado_en TEXT NOT NULL,
    resuelto_en TEXT
  )`); } catch (_) {}

  // Fase 0 — Tarea 4 (medición de ritmo): las columnas nuevas de inventario_sesiones se
  // agregan en routes/inventario.js#ensureTables, NO acá — esa tabla la crea ese módulo
  // (ver migrarSesionesAlcanceMulti), no db/schema.sql, así que un ALTER acá correría antes
  // de que la tabla exista en una base nueva y se lo comería el catch mudo para siempre.

  // Sistema de incidentes operativos (2026-08-27): un administrador podía tardar horas en
  // enterarse de que ML o Woo llevaban tiempo fallando — no había ningún registro persistente
  // de fallos de integración, solo logs de PM2 que nadie mira en vivo. Ver lib/incidentes.js
  // para la lógica de apertura/dedupe/resolución; acá solo el esquema.
  //
  // clave_dedupe = `${integracion}|${proceso}|${tipo_error}` — agrupa lo suficiente sin
  // perder distinción entre causas raíz distintas (un rate-limit y un error de auth en el
  // mismo proceso son incidentes separados, no deben pisarse el mensaje entre sí). El índice
  // único es PARCIAL (solo sobre estado='activo'): solo puede haber UN incidente activo por
  // clave de dedupe a la vez, pero múltiples episodios históricos resueltos con la misma
  // clave a lo largo del tiempo (reincidencias reales tras confirmarse recuperación antes).
  try { db.exec(`CREATE TABLE IF NOT EXISTS incidentes_operativos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    integracion TEXT NOT NULL,
    proceso TEXT NOT NULL,
    tipo_error TEXT NOT NULL,
    clave_dedupe TEXT NOT NULL,
    severidad TEXT NOT NULL,
    estado TEXT NOT NULL,
    mensaje_tecnico TEXT,
    mensaje_humano TEXT NOT NULL,
    contexto_json TEXT,
    contador_repeticiones INTEGER NOT NULL DEFAULT 1,
    primera_deteccion_en TEXT NOT NULL,
    ultima_deteccion_en TEXT NOT NULL,
    ultima_recuperacion_en TEXT,
    resuelto_en TEXT,
    creado_en TEXT NOT NULL,
    actualizado_en TEXT NOT NULL
  )`); } catch (_) {}
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_incidentes_dedupe_activo
    ON incidentes_operativos(clave_dedupe) WHERE estado = 'activo'`); } catch (_) {}
  // Cubre la consulta más frecuente del panel (WHERE estado='activo' ORDER BY
  // ultima_deteccion_en DESC) — hace redundante un índice simple sobre solo `estado`
  // (columna de 2 valores, poco selectiva por sí sola).
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_incidentes_estado_fecha ON incidentes_operativos(estado, ultima_deteccion_en DESC)'); } catch (_) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_incidentes_integracion ON incidentes_operativos(integracion, proceso)'); } catch (_) {}

  // Historial append-only de cada incidente (abierto/repetido/escalado/resuelto) — auditoría
  // de qué pasó y cuándo, separado de la fila "viva" de arriba que se pisa en cada update.
  try { db.exec(`CREATE TABLE IF NOT EXISTS incidentes_operativos_historial (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    incidente_id INTEGER NOT NULL REFERENCES incidentes_operativos(id),
    evento TEXT NOT NULL,
    detalle_json TEXT,
    creado_en TEXT NOT NULL
  )`); } catch (_) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_incidentes_hist_incidente ON incidentes_operativos_historial(incidente_id)'); } catch (_) {}

  // Métricas de ciclo de sync (Hito 3/4 del plan de confiabilidad, 2026-08-27): una fila por
  // corrida de un ciclo de sync completo (refresco de catálogo Woo, refresco de publicaciones
  // ML, etc.), complementa — no reemplaza — el estado en memoria que cada módulo ya trackea
  // para "hay una corrida en curso ahora" (`_refrescarCatalogoEnCurso` en routes/woo.js,
  // `_refresco` en routes/matcher.js). Esto es historia persistida para poder ver tendencias
  // (¿empeoró esta semana?), no el candado de concurrencia.
  try { db.exec(`CREATE TABLE IF NOT EXISTS metricas_ciclo_sync (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    integracion TEXT NOT NULL,
    proceso TEXT NOT NULL,
    iniciado_en TEXT NOT NULL,
    finalizado_en TEXT,
    duracion_ms INTEGER,
    procesados INTEGER NOT NULL DEFAULT 0,
    fallidos INTEGER NOT NULL DEFAULT 0,
    reintentados INTEGER NOT NULL DEFAULT 0,
    circuito_abierto INTEGER NOT NULL DEFAULT 0,
    creado_en TEXT NOT NULL
  )`); } catch (_) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_metricas_ciclo_integracion ON metricas_ciclo_sync(integracion, proceso, iniciado_en)'); } catch (_) {}

  // Hito 7: la migración completa es atómica y no silencia errores. Esto cubre tanto una
  // base pre-Hito7 como una instalación que ya tenía el refresh legacy con device_id nullable.
  // `user_version` solo cambia después de que tablas, reconstrucción e índices terminaron.
  if (db.pragma('user_version', { simple: true }) < 30) {
    try {
      aplicarMigracionHito7(db);
    } catch (err) {
      db.close();
      throw err;
    }
  }

  return db;
}
