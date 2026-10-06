import { describe, expect, it } from 'vitest';
import { PASOS_JORNADA, aceptarJornada, completarPasoJornada, crearChecklistJornada, validarAccionesPermisos } from '../lib/gestionPedidosJornada.js';

describe('checklist de jornada GP9', () => {
  it('no acepta una jornada incompleta y acepta cuando todos los pasos están auditados', () => {
    const checklist = crearChecklistJornada({ actor: 'supervisor' });
    expect(aceptarJornada(checklist).code).toBe('JORNADA_INCOMPLETA');
    for (const paso of PASOS_JORNADA) expect(completarPasoJornada(checklist, paso, { nota: `ok ${paso}` }).ok).toBe(true);
    expect(aceptarJornada(checklist)).toMatchObject({ ok: true, checklist: { aceptada: true } });
  });
  it('rechaza pasos desconocidos', () => expect(completarPasoJornada(crearChecklistJornada({ actor: 'x' }), 'inventado').code).toBe('PASO_INVALIDO'));
  it('detecta acciones ejecutadas sin usuario autorizado', () => {
    expect(validarAccionesPermisos([{ accion: 'editar', usuario: 'ana', autorizado: true }, { accion: 'enviar', usuario: '', autorizado: false }])).toMatchObject({ ok: false, total: 2, invalidas: [{ accion: 'enviar', usuario: null }] });
  });
});
