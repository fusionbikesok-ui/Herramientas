// Catálogo compartido por Usuarios y el gateway. No concede permisos automáticamente.
export const VPS_APPLICATIONS = [
  { id: 'gestion-ventas', label: 'Panel de ventas', niveles: false, grupo: 'Aplicaciones del VPS', descripcion: 'Consultar ventas, rankings y exportar informes.' },
  { id: 'gestion-stock', label: 'Stock y reposición', niveles: false, grupo: 'Aplicaciones del VPS', descripcion: 'Consultar existencias, cobertura y reportes de reposición.' },
  { id: 'gestion-alertas', label: 'Configurar alertas de stock', niveles: false, grupo: 'Aplicaciones del VPS', descripcion: 'Incluye el informe de stock y permite cambiar destinatarios, horario y activación de los avisos por WhatsApp.' },
  { id: 'gestion-clientes', label: 'Clientes y pedidos', niveles: false, grupo: 'Aplicaciones del VPS', descripcion: 'Consultar el directorio compartido y el historial de pedidos.' },
  { id: 'gestion-andreani', label: 'Envíos Andreani', niveles: false, grupo: 'Aplicaciones del VPS', descripcion: 'Consultar y editar destinatarios y bultos, configurar y exportar planillas de envíos.' },
  { id: 'pdf-etiquetas', label: 'Corregir etiquetas PDF', niveles: false, grupo: 'Aplicaciones del VPS', descripcion: 'Corregir, imprimir y descargar etiquetas; consultar el historial compartido.' },
  { id: 'gestion-taller', label: 'Servicio técnico · consulta', niveles: false, grupo: 'Aplicaciones del VPS', descripcion: 'Consultar la copia del taller, sus clientes y los precios del catálogo. No habilita operaciones que el taller todavía no admite.' },
  { id: 'acceso-pos-web', label: 'Acceso a POS de la tienda', niveles: false, grupo: 'Accesos a la tienda', externo: true, descripcion: 'Muestra el enlace al POS. El usuario y los permisos dentro de la tienda se administran en WordPress.' },
  { id: 'acceso-facturador-web', label: 'Acceso a Facturador de la tienda', niveles: false, grupo: 'Accesos a la tienda', externo: true, descripcion: 'Muestra el enlace al Facturador ARCA. No concede permisos fiscales ni acceso dentro de WordPress.' },
];

const IDS = VPS_APPLICATIONS.map(app => app.id);
const STOCK = ['gestion-stock', 'gestion-alertas'];
const read = method => ['GET', 'HEAD'].includes(method);
const shortcut = module => ({ pos: 'acceso-pos-web', facturador: 'acceso-facturador-web' })[module];

export function hasVpsPermission(user, ids) {
  if (user?.is_admin === true) return true;
  return Array.isArray(user?.permisos) && user.permisos.some(p =>
    ids.includes(p?.herramienta) && ['read', 'write'].includes(p?.nivel));
}

// Recibe exclusivamente un destino previamente validado por allowedTarget.
// Las rutas sin clasificación quedan reservadas a administradores.
export function managementPermissions(target, method = 'GET', salesLocation = 'vps') {
  if (!target) return [];
  const url = new URL(target.local || '/', 'http://private.invalid');
  switch (target.kind) {
    case 'home': return read(method) ? IDS : [];
    case 'web-sales': return read(method) ? [shortcut(target.module)].filter(Boolean) : [];
    case 'directory': case 'directory-api': return read(method) ? ['gestion-clientes'] : [];
    case 'metrics': return read(method) ? ['gestion-ventas'] : [];
    case 'metrics-api':
      if (!read(method) || url.searchParams.getAll('mode').length > 1) return [];
      return url.searchParams.get('mode') === 'stock' ? STOCK : ['gestion-ventas'];
    case 'stock-page': return read(method) ? STOCK : [];
    case 'stock-alert-settings': return ['GET', 'POST'].includes(method) ? ['gestion-alertas'] : [];
    case 'pdf-page': case 'pdf-history': case 'pdf-file': return read(method) ? ['pdf-etiquetas'] : [];
    case 'pdf-api': return method === 'POST' ? ['pdf-etiquetas'] : [];
    case 'andreani': case 'andreani-download': return read(method) ? ['gestion-andreani'] : [];
    case 'andreani-api': return method === 'POST' ? ['gestion-andreani'] : [];
    case 'asset': {
      if (!read(method)) return [];
      const p = url.pathname;
      if (p === '/assets/management.css') return IDS;
      if (p === '/assets/catalog-ui.js') return ['gestion-taller'];
      if (p.startsWith('/assets/pdf')) return ['pdf-etiquetas'];
      if (p.startsWith('/assets/andreani')) return ['gestion-andreani'];
      if (p.startsWith('/assets/directory')) return ['gestion-clientes'];
      if (p.startsWith('/assets/stock-alert-settings')) return ['gestion-alertas'];
      if (p.startsWith('/assets/stock-report')) return STOCK;
      if (p === '/assets/sales-core.js') return ['gestion-ventas', ...STOCK];
      if (p.startsWith('/assets/metrics')) return ['gestion-ventas'];
      return [];
    }
    case 'proxy': {
      if (!read(method)) return [];
      const module = url.searchParams.get('fm_module');
      if (module === 'taller') return ['gestion-taller'];
      if (salesLocation === 'web' && shortcut(module)) return [shortcut(module)];
      const route = url.searchParams.get('rest_route') || '';
      if (route.startsWith('/fusion-taller/v1/')) return ['gestion-taller'];
      if (url.pathname.startsWith('/wp-content/plugins/fusion-taller/') || url.pathname.startsWith('/wp-includes/')) return ['gestion-taller'];
      return [];
    }
    default: return [];
  }
}

export function canUseManagement(user, target, method = 'GET', salesLocation = 'vps') {
  return hasVpsPermission(user, managementPermissions(target, method, salesLocation));
}
