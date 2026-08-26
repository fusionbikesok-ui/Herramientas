// Matriz de permisos: mapea (método + path de /api) a la herramienta y nivel requeridos.
// El enforcement real vive acá; el frontend solo replica esto para la UX.

// Las 9 herramientas controlables (unidades de permiso).
export const HERRAMIENTAS = [
  { id: 'stock',      label: 'Stock',             niveles: true  },
  { id: 'etiquetas',  label: 'Etiquetas',         niveles: false },
  { id: 'inventario', label: 'Inventario',        niveles: false },
  // 'matcher' es la herramienta unificada (entrega 1, 2026-08-14): antes 'cobertura'
  // (WC→ML) era un permiso aparte, niveles:false — se absorbió acá. Ver
  // docs/superpowers/plans/2026-08-11-matcher-unificado.md, "Permiso único". La migración
  // 014 traslada sola el permiso: quien tuviera 'cobertura' recibe 'matcher' con el mismo
  // nivel (si ya tenía 'matcher', ese gana), y las filas de 'cobertura' se borran. Es
  // defensivo a propósito: en staging nadie quedaría afuera, pero producción es otra base
  // que se pasa a mano y no se puede verificar desde acá — sin la migración, alguien podría
  // perder el acceso en silencio al desplegar.
  { id: 'matcher',    label: 'Matcher',           niveles: true  },
  { id: 'recepcion',  label: 'Recepción',         niveles: true  },
  { id: 'pedidos',    label: 'Pedidos',           niveles: true  },
  { id: 'config-ml',  label: 'Config ML',         niveles: true  },
  { id: 'sync-ml',    label: 'Sync ML',           niveles: true  },
  { id: 'precios',    label: 'Precios ML',        niveles: true  },
  { id: 'preparacion', label: 'Preparación',      niveles: true  },
  { id: 'consulta-precios', label: 'Consulta de Precios', niveles: true  },
  { id: 'codigos',    label: 'Códigos Universales', niveles: true  },
];
export const HERRAMIENTA_IDS = HERRAMIENTAS.map(h => h.id);

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const nivelDe = (method) => (READ_METHODS.has(method) ? 'read' : 'write');

// Reglas ordenadas: la primera cuyo `re` matchea el path (y el método, si está acotado) gana.
// resolve puede devolver: { auth:true } (cualquier autenticado) | { anyOf:[tools], nivel }.
// Si `nivel` no se fija, se deriva del método (GET→read, resto→write).
const REGLAS = [
  // ── Compartidas de solo-lectura: cualquier usuario autenticado ──
  { re: /^\/woo\/catalogo$/,                 methods: ['GET'], resolve: () => ({ auth: true }) },
  // Banner de estado del token ML en el Home: cualquier autenticado puede verlo.
  { re: /^\/ml\/token-estado$/,              methods: ['GET'], resolve: () => ({ auth: true }) },
  { re: /^\/matcher\/push-skus-pendientes\/count$/, methods: ['GET'], resolve: () => ({ auth: true }) },

  // ── Stock (incluye el flujo de "nuevos productos") ──
  { re: /^\/woo\//,             resolve: (m) => ({ anyOf: ['stock'], nivel: nivelDe(m) }) },
  { re: /^\/mapeo(\/|$)/,       resolve: (m) => ({ anyOf: ['stock'], nivel: nivelDe(m) }) },
  { re: /^\/csv(\/|$)/,         resolve: () => ({ anyOf: ['stock'], nivel: 'write' }) },
  { re: /^\/nuevos-productos(\/|$)/, resolve: () => ({ anyOf: ['stock'], nivel: 'write' }) },

  // ── Gemini: usado por Stock y Recepción ──
  { re: /^\/gemini(\/|$)/,      resolve: () => ({ anyOf: ['stock', 'recepcion'], nivel: 'write' }) },

  // ── Matcher (publicaciones también lo lee Cobertura; decisiones también las escribe Sync-detalle) ──
  { re: /^\/matcher\/publicaciones/, methods: ['GET'], resolve: () => ({ anyOf: ['matcher'], nivel: 'read' }) },
  { re: /^\/matcher(\/|$)/,     resolve: (m) => ({ anyOf: ['matcher', 'sync-ml'], nivel: nivelDe(m) }) },

  // "Buscar producto" (absorbido de Vínculos, entrega 1 del Matcher unificado) reusa este
  // autocomplete de Sync ML — se agrega 'matcher' al anyOf en vez de duplicar el endpoint.
  { re: /^\/sync\/buscar-sku$/, methods: ['GET'], resolve: () => ({ anyOf: ['config-ml', 'sync-ml', 'matcher'], nivel: 'read' }) },

  // ── Recepción / Pedidos ──
  { re: /^\/recepciones(\/|$)/, resolve: (m) => ({ anyOf: ['recepcion'], nivel: nivelDe(m) }) },
  { re: /^\/pedidos(\/|$)/,     resolve: (m) => ({ anyOf: ['pedidos'], nivel: nivelDe(m) }) },

  // ── Cobertura (dirección WC→ML del Matcher unificado, entrega 1 — mismo router en
  // routes/cobertura.js, mismo permiso único 'matcher' que el resto de la herramienta;
  // incluye los endpoints absorbidos de Vínculos bajo /cobertura/vinculos*). `nivelDe(m)`
  // real (no fijo en 'read'): 'matcher' es niveles:true, a diferencia del extinto
  // 'cobertura' (niveles:false) — ver el aviso arriba en HERRAMIENTAS. Las dos acciones
  // admin-only (pausar publicación, desvincular) NO se resuelven acá: las bloquea
  // `requireAdmin` dentro de routes/cobertura.js, porque resolvePermiso no distingue por
  // sub-ruta con esa granularidad.
  { re: /^\/cobertura(\/|$)/,   resolve: (m) => ({ anyOf: ['matcher'], nivel: nivelDe(m) }) },

  // ── Contador de Inventario (sesiones de conteo + ajuste de stock) ──
  // `inventario` es niveles:false → la UI de Usuarios solo otorga un checkbox de "acceso"
  // (guarda nivel:'read' siempre, no hay selector read/write). Por eso acá se pide
  // explícitamente nivel:'read' sin importar el método: tener el permiso alcanza para
  // escanear/confirmar, no queda bloqueado el operario de depósito (que es no-admin por
  // diseño) en las escrituras. Mismo criterio que `etiquetas` (niveles:false, sin siquiera
  // ruta protegida — acceso total una vez adentro).
  { re: /^\/inventario(\/|$)/,  resolve: () => ({ anyOf: ['inventario'], nivel: 'read' }) },
  // `etiquetas` — mismo criterio que `inventario`: niveles:false, acceso total una vez
  // adentro (no hay selector read/write en Usuarios para esta herramienta).
  { re: /^\/etiquetas(\/|$)/,   resolve: () => ({ anyOf: ['etiquetas'], nivel: 'read' }) },
  // Fase 3 — infraestructura de rotación/criticidad, sin pantalla propia todavía:
  // mismo permiso que inventario (lo consume el planificador de ciclos en Fase 4).
  { re: /^\/criticidad(\/|$)/, resolve: () => ({ anyOf: ['inventario'], nivel: 'read' }) },
  // Fase 5 — auditoría de calidad de publicación ML:
  { re: /^\/auditoria(\/|$)/, resolve: () => ({ anyOf: ['inventario'], nivel: 'read' }) },

  // ── Sync ML / Config ML (comparten prefijo /sync) ──
  // NOTA: /sync/buscar-sku ya se resolvió arriba (regla agregada junto a /matcher, para que
  // 'matcher' también pueda usarlo desde "Buscar producto") — no repetirla acá, la primera
  // regla que matchea gana y dejaría esta muerta.
  // catalogo-config es de solo lectura (el catch-all de /sync más abajo la agarraría como
  // sync-ml, pero quien solo tiene Config ML también necesita ver esta pestaña para poder
  // usar el POST /config-ml/lote de más abajo, que sí exige config-ml — mismo criterio que
  // /sync/buscar-sku).
  { re: /^\/sync\/catalogo-config$/, methods: ['GET'], resolve: () => ({ anyOf: ['config-ml', 'sync-ml'], nivel: 'read' }) },
  { re: /^\/sync\/config-ml(\/|$)/, resolve: (m) => ({ anyOf: ['config-ml'], nivel: nivelDe(m) }) },
  { re: /^\/sync\/(ml-auth-url|ml-bootstrap)(\/|$)/, resolve: () => ({ anyOf: ['config-ml'], nivel: 'write' }) },
  { re: /^\/sync(\/|$)/,        resolve: (m) => ({ anyOf: ['sync-ml'], nivel: nivelDe(m) }) },

  // ── Precios ML (auditoría de neto vs precio web) ──
  { re: /^\/precios(\/|$)/,     resolve: (m) => ({ anyOf: ['precios'], nivel: nivelDe(m) }) },

  // ── Consulta de Precios (lookup por SKU/EAN; write = enseñar/importar EANs) ──
  { re: /^\/consulta-precios(\/|$)/, resolve: (m) => ({ anyOf: ['consulta-precios'], nivel: nivelDe(m) }) },

  // ── Códigos Universales (cargar el GTIN de cada producto; write = asignar el código) ──
  { re: /^\/codigos(\/|$)/, resolve: (m) => ({ anyOf: ['codigos'], nivel: nivelDe(m) }) },

  // ── Preparación de pedidos (despacho web + ML) ──
  { re: /^\/preparacion(\/|$)/, resolve: (m) => ({ anyOf: ['preparacion'], nivel: nivelDe(m) }) },
];

// Resuelve el permiso requerido para un request. `path` es relativo a /api (sin el prefijo).
// Default deny para non-admin ante rutas /api no mapeadas ({ anyOf: [] }); el admin siempre pasa aparte.
export function resolvePermiso(method, path) {
  const m = String(method || 'GET').toUpperCase();
  for (const regla of REGLAS) {
    if (regla.methods && !regla.methods.includes(m)) continue;
    if (regla.re.test(path)) return regla.resolve(m);
  }
  return { anyOf: [], nivel: 'write' };
}

// ¿El set de permisos del usuario satisface el requerimiento?
export function permiteAcceso(permisos, req) {
  if (req.auth) return true;
  if (!Array.isArray(req.anyOf) || req.anyOf.length === 0) return false;
  const necesitaWrite = req.nivel === 'write';
  return req.anyOf.some((tool) => {
    const p = permisos.find((x) => x.herramienta === tool);
    if (!p) return false;
    return necesitaWrite ? p.nivel === 'write' : true; // read lo cubre read o write
  });
}
