/**
 * routes/incidentes.js — API administrativa para el sistema de incidentes operativos.
 * Expone lectura paginada y filtrada del registro de fallos de integración (ML/Woo)
 * reservada a administradores. Ver lib/incidentes.js para la lógica de negocio.
 */

import express from 'express';
import { listarIncidentes, obtenerIncidente, enteroValido } from '../lib/incidentes.js';
import { requireAdmin } from '../lib/auth.js';

/**
 * Filtra un incidente para exponer solo los campos públicos de la API.
 * Excluye `clave_dedupe` (detalle interno del mecanismo de dedupe).
 */
function incidenteAPublico(inc) {
  if (!inc) return null;
  const { clave_dedupe, ...publico } = inc;
  return publico;
}

/**
 * Filtra un historial de incidente.
 */
function historialAPublico(historial) {
  return historial ? historial.map(incidenteAPublico) : [];
}

export function incidentesRouter(db, _cfg) {
  const router = express.Router();

  /**
   * GET /api/incidentes — Lista incidentes con filtros opcionales y paginación.
   *
   * Query params:
   *  - estado: filtrar por 'activo' o 'resuelto'
   *  - integracion: filtrar por nombre de integración (ej. 'mercadolibre', 'woocommerce')
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
      let { estado, integracion, severidad, page, pageSize } = req.query;

      // Normalizar query params repetidos (Express devuelve arrays si hay duplicados).
      // Tomamos el último valor si hay array (ej. ?estado=activo&estado=resuelto → usamos 'resuelto').
      if (Array.isArray(estado)) estado = estado[estado.length - 1];
      if (Array.isArray(integracion)) integracion = integracion[integracion.length - 1];
      if (Array.isArray(severidad)) severidad = severidad[severidad.length - 1];
      if (Array.isArray(page)) page = page[page.length - 1];
      if (Array.isArray(pageSize)) pageSize = pageSize[pageSize.length - 1];

      // Validar y convertir page y pageSize a números seguros
      const pageNum = enteroValido(page, 1);
      const pageSizeNum = enteroValido(pageSize, 20, 100);

      // Delegar a lib/incidentes.js
      const resultado = listarIncidentes(db, {
        estado: estado || undefined,
        integracion: integracion || undefined,
        severidad: severidad || undefined,
        page: pageNum,
        pageSize: pageSizeNum,
      });

      // Filtra los campos públicos (excluye clave_dedupe, detalle interno)
      res.json({
        ok: true,
        data: resultado.items.map(incidenteAPublico),
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

      // Filtra los campos públicos (excluye clave_dedupe del incidente y del historial)
      const publicoConHistorial = {
        ...incidenteAPublico(incidente),
        historial: historialAPublico(incidente.historial),
      };
      res.json({ ok: true, data: publicoConHistorial });
    } catch (e) {
      console.error('[incidentes-api] error obteniendo incidente:', e.message);
      res.status(500).json({ ok: false, error: 'Error interno al obtener incidente' });
    }
  });

  return router;
}
