/**
 * routes/incidentes.js — API administrativa para el sistema de incidentes operativos.
 * Expone lectura paginada y filtrada del registro de fallos de integración (ML/Woo)
 * reservada a administradores. Ver lib/incidentes.js para la lógica de negocio.
 */

import express from 'express';
import { listarIncidentes, obtenerIncidente } from '../lib/incidentes.js';
import { requireAdmin } from '../lib/auth.js';

export function incidentesRouter(db, _cfg) {
  const router = express.Router();

  /**
   * GET /api/incidentes — Lista incidentes con filtros opcionales y paginación.
   *
   * Query params:
   *  - estado: filtrar por 'activo' o 'resuelto'
   *  - integracion: filtrar por nombre de integración (ej. 'ml', 'woo')
   *  - severidad: filtrar por severidad ('info', 'advertencia', 'critico')
   *  - page: número de página (1-based, default 1)
   *  - pageSize: elementos por página (1-100, default 20)
   *
   * Response: { ok: true, data: [...], page, pageSize, total }
   * RequireAdmin: sí
   */
  router.get('/', requireAdmin, (req, res) => {
    try {
      // Extraer y validar parámetros de query
      const { estado, integracion, severidad, page, pageSize } = req.query;

      // Validar y convertir page y pageSize a números seguros
      const pageNum = validarEntero(page, 1);
      const pageSizeNum = validarEntero(pageSize, 20, 100);

      // Delegar a lib/incidentes.js
      const resultado = listarIncidentes(db, {
        estado: estado || undefined,
        integracion: integracion || undefined,
        severidad: severidad || undefined,
        page: pageNum,
        pageSize: pageSizeNum,
      });

      // No expongas nada más que lo que ya sanitizó lib/incidentes.js
      res.json({
        ok: true,
        data: resultado.items,
        page: resultado.page,
        pageSize: resultado.pageSize,
        total: resultado.total,
      });
    } catch (e) {
      console.error('[incidentes-api] error listando incidentes:', e.message);
      res.status(500).json({ ok: false, error: 'Error interno al listar incidentes' });
    }
  });

  /**
   * GET /api/incidentes/:id — Detalle de un incidente específico con su historial.
   *
   * Response: { ok: true, data: { ...incidente, historial: [...] } }
   *           { ok: false, error: 'no encontrado' } [404]
   * RequireAdmin: sí
   */
  router.get('/:id', requireAdmin, (req, res) => {
    try {
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isSafeInteger(id) || id <= 0) {
        return res.status(400).json({ ok: false, error: 'ID inválido' });
      }

      const incidente = obtenerIncidente(db, id);
      if (!incidente) {
        return res.status(404).json({ ok: false, error: 'no encontrado' });
      }

      // No expongas nada más que lo que ya sanitizó lib/incidentes.js
      res.json({ ok: true, data: incidente });
    } catch (e) {
      console.error('[incidentes-api] error obteniendo incidente:', e.message);
      res.status(500).json({ ok: false, error: 'Error interno al obtener incidente' });
    }
  });

  return router;
}

/**
 * Valida y convierte un valor a entero positivo de forma segura.
 * - Acepta string o number (req.query siempre da strings)
 * - Rechaza valores no finitos, muy grandes o negativos
 * - Retorna el valor entre 1 y máximo, o el default si está fuera de rango
 *
 * @param {string|number} valor - Entrada potencialmente no segura
 * @param {number} porDefecto - Valor si la entrada es inválida
 * @param {number} maximo - Tope superior (clamping)
 * @returns {number} Entero válido
 */
function validarEntero(valor, porDefecto, maximo = Number.MAX_SAFE_INTEGER) {
  const n = typeof valor === 'string' ? Number.parseInt(valor, 10) : valor;
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, maximo) : porDefecto;
}
