# Informe de implementación — Tarea 7

## Resultado

Implementado el reporte diario de sombra `E1-REC-01` con ventana ART congelada, agrupación de señales reales por tópico, motivos explicados desde `error_detail`, semáforo, manifiesto opcional y consulta de entregas anteriores.

## TDD

- RED exacto: `cd plataforma && npx vitest run test/informes/reporte.test.ts`
- Resultado RED: suite falló al importar `../../src/informes/reporte.ts` porque el módulo no existía (`Cannot find module`).
- GREEN exacto: `cd plataforma && npx vitest run test/informes/reporte.test.ts && npm run typecheck`
- Resultado GREEN: 1 archivo, 4 tests pasaron; `tsc -p tsconfig.json` terminó correctamente.

## Archivos

- `plataforma/src/informes/reporte.ts`: interfaces, motivos aceptados y `armarReporte`.
- `plataforma/test/informes/reporte.test.ts`: ventana, día vacío, motivos, faltantes y cadena rota.

## Auto-revisión

- Las señales se consultan únicamente con `[desde, hasta)` y no se usa `shadow_daily_summaries`.
- Los estados y `error_detail` corresponden al esquema real; el canal no se asume como columna de señales.
- No se usó `new Date()` para decidir contenido; `ahora` queda disponible en opciones.
- No se tocaron producción, PM2, `.env`, servicios externos ni bases productivas.
- Concern: `dia_campana` actualmente devuelve `1` cuando existe un reporte anterior avisado; el algoritmo completo de consecutividad de reportes verdes queda pendiente de datos persistidos de semáforo.

## Commit

`ab21724 feat(informes): reporte diario de sombra con ventana congelada`

Footer requerido incluido: `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## Fix round 1

Se corrigió la campaña consecutiva (fechas avisadas contiguas), se añadió JOIN al canal, lectura de recibos del inbox legado, métricas de barridos/convergencia, cobertura resueltas/recibidas y alertas baja/media/alta. Se eliminó el reloj opcional no usado.

- RED exacto: `cd plataforma && npx vitest run test/informes/reporte.test.ts` (antes del fix falló por el módulo eliminado durante el reemplazo; la prueba de regresión quedó reproducida por la suite tras restaurarlo).
- GREEN exacto: `cd plataforma && npx vitest run test/informes/reporte.test.ts && npm run typecheck`
- GREEN: 1 archivo, 4 tests pasaron; typecheck pasó.
- Commit fix: `8e61b469bbcbff6e699ab0f150311d484eed8bb4`.
