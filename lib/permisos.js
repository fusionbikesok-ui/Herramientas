// Matriz de permisos: mapea (método + path de /api) a la herramienta y nivel requeridos.
// El enforcement real vive acá; el frontend solo replica esto para la UX.

// Las 9 herramientas controlables (unidades de permiso).
export const HERRAMIENTAS = [
  { id: 'stock',      label: 'Stock',             niveles: true  },
  { id: 'etiquetas',  label: 'Etiquetas',         niveles: false },
  { id: 'inventario', label: 'Inventario',        niveles: false },
  { id: 'matcher',    label: 'Matcher',           niveles: true  },
  { id: 'recepcion',  label: 'Recepción',         niveles: true  },
  { id: 'pedidos',    label: 'Pedidos',           niveles: true  },
  { id: 'cobertura',  label: 'Cobertura',         niveles: false },
  { id: 'config-ml',  label: 'Config ML',         niveles: true  },
  { id: 'sync-ml',    label: 'Sync ML',           niveles: true  },
  { id: 'precios',    label: 'Precios ML',        niveles: true  },
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
  { re: /^\/matcher\/push-skus-pendientes\/count$/, methods: ['GET'], resolve: () => ({ auth: true }) },

  // ── Stock (incluye el flujo de "nuevos productos") ──
  { re: /^\/woo\//,             resolve: (m) => ({ anyOf: ['stock'], nivel: nivelDe(m) }) },
  { re: /^\/mapeo(\/|$)/,       resolve: (m) => ({ anyOf: ['stock'], nivel: nivelDe(m) }) },
  { re: /^\/csv(\/|$)/,         resolve: () => ({ anyOf: ['stock'], nivel: 'write' }) },
  { re: /^\/nuevos-productos(\/|$)/, resolve: () => ({ anyOf: ['stock'], nivel: 'write' }) },

  // ── Gemini: usado por Stock y Recepción ──
  { re: /^\/gemini(\/|$)/,      resolve: () => ({ anyOf: ['stock', 'recepcion'], nivel: 'write' }) },

  // ── Matcher (publicaciones también lo lee Cobertura; decisiones también las escribe Sync-detalle) ──
  { re: /^\/matcher\/publicaciones/, methods: ['GET'], resolve: () => ({ anyOf: ['matcher', 'cobertura'], nivel: 'read' }) },
  { re: /^\/matcher(\/|$)/,     resolve: (m) => ({ anyOf: ['matcher', 'sync-ml'], nivel: nivelDe(m) }) },

  // ── Recepción / Pedidos / Cobertura ──
  { re: /^\/recepciones(\/|$)/, resolve: (m) => ({ anyOf: ['recepcion'], nivel: nivelDe(m) }) },
  { re: /^\/pedidos(\/|$)/,     resolve: (m) => ({ anyOf: ['pedidos'], nivel: nivelDe(m) }) },
  { re: /^\/cobertura(\/|$)/,   resolve: (m) => ({ anyOf: ['cobertura'], nivel: nivelDe(m) }) },

  // ── Sync ML / Config ML (comparten prefijo /sync) ──
  { re: /^\/sync\/buscar-sku/,  methods: ['GET'], resolve: () => ({ anyOf: ['config-ml', 'sync-ml'], nivel: 'read' }) },
  { re: /^\/sync\/config-ml(\/|$)/, resolve: (m) => ({ anyOf: ['config-ml'], nivel: nivelDe(m) }) },
  { re: /^\/sync\/(ml-auth-url|ml-bootstrap)(\/|$)/, resolve: () => ({ anyOf: ['config-ml'], nivel: 'write' }) },
  { re: /^\/sync(\/|$)/,        resolve: (m) => ({ anyOf: ['sync-ml'], nivel: nivelDe(m) }) },

  // ── Precios ML (auditoría de neto vs precio web) ──
  { re: /^\/precios(\/|$)/,     resolve: (m) => ({ anyOf: ['precios'], nivel: nivelDe(m) }) },
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
