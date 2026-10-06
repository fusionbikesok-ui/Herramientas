/** Preflight determinista para la publicación controlada de Gestión de pedidos. */
export const VARIABLES_PUBLICACION = ['DB_PATH', 'SESSION_SECRET', 'BASIC_AUTH_USER', 'BASIC_AUTH_PASS'];

export function validarConfiguracionPublicacion(env = process.env) {
  const faltantes = VARIABLES_PUBLICACION.filter((nombre) => !String(env?.[nombre] || '').trim());
  const secreto = String(env?.SESSION_SECRET || '');
  const secretoDebil = secreto.length < 32 || /cambiar-por-uno|change-me|password/i.test(secreto);
  const accesoRestringido = Boolean(String(env?.BASIC_AUTH_USER || '').trim() && String(env?.BASIC_AUTH_PASS || '').trim());
  return {
    ok: faltantes.length === 0 && !secretoDebil && accesoRestringido,
    faltantes,
    secreto_debil: secretoDebil,
    acceso_restringido: accesoRestringido,
  };
}

export function validarBackupPublicacion(backup) {
  const pedidos = Number(backup?.pedidos);
  return {
    ok: backup?.ok === true && backup?.integridad === 'ok' && Number.isInteger(pedidos) && pedidos >= 0,
    integridad: backup?.integridad || null,
    pedidos: Number.isInteger(pedidos) ? pedidos : null,
  };
}

export function validarMigracionesPublicacion({ aplicadas = [], requeridas = [] } = {}) {
  const conjunto = new Set(aplicadas);
  const faltantes = requeridas.filter((migracion) => !conjunto.has(migracion));
  return { ok: faltantes.length === 0, faltantes, requeridas: [...requeridas] };
}

export function validarGatePublicacion({ configuracion, backup, migraciones, muestra, permisos, smoke } = {}) {
  const controles = { configuracion, backup, migraciones, muestra, permisos, smoke };
  const faltantes = Object.entries(controles).filter(([, resultado]) => resultado?.ok !== true).map(([nombre]) => nombre);
  return { ok: faltantes.length === 0, faltantes, controles };
}
