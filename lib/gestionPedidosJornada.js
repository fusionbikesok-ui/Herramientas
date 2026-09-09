export const PASOS_JORNADA = ['backup_verificado', 'muestra_reconciliada', 'atencion', 'preparacion', 'despacho', 'recuperacion', 'permisos', 'rollback_verificado'];

export function crearChecklistJornada({ actor, ahora = new Date().toISOString() }) {
  return { actor: String(actor || ''), creado_en: ahora, aceptada: false,
    pasos: Object.fromEntries(PASOS_JORNADA.map(paso => [paso, { estado: 'pendiente', completado_en: null, nota: null }])) };
}

export function completarPasoJornada(checklist, paso, { nota = '', ahora = new Date().toISOString() } = {}) {
  if (!checklist || !PASOS_JORNADA.includes(paso)) return { ok: false, code: 'PASO_INVALIDO' };
  checklist.pasos[paso] = { estado: 'completo', completado_en: ahora, nota: String(nota) };
  return { ok: true, checklist };
}

export function aceptarJornada(checklist, { ahora = new Date().toISOString() } = {}) {
  const faltantes = PASOS_JORNADA.filter(paso => checklist?.pasos?.[paso]?.estado !== 'completo');
  if (faltantes.length) return { ok: false, code: 'JORNADA_INCOMPLETA', faltantes };
  checklist.aceptada = true; checklist.aceptada_en = ahora;
  return { ok: true, checklist };
}
