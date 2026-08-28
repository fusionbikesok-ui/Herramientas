import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function openDb(dbPath) {
  const dir = path.dirname(dbPath);
  if (dir !== '.' && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath);
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  // Incremental migrations — safe to run every startup
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

  return db;
}
