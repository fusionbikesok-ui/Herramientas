# Estado activo

Actualizado: 2026-08-22.

## En curso

- C2 — Consulta de Precios: implementación congelada localmente; el plan y contrato de subida
  de GTIN están en `docs/superpowers/plans/2026-08-22-consulta-precios-gtin.md`. Falta el gate
  E2E/auditoría antes de publicarla.
- Entrega 2, conteo confiable + cierre seguro + subida de GTIN C1, en
  `.claude/worktrees/matcher-unificado` (`conteo-confiable-revisado`), integrada en `e4e8bbf`.
  Corrección post-revisión: render pendiente de cantidades, motivo visible del cierre,
  región accesible para la hoja EAN, token de color, mapeo `ean_sku` sin SKU homónimo, contrato
  explícito del reintento `confirmada_con_errores` y dropdowns de asociación fluidos para títulos
  largos en móvil y PC. El merge a `conteo-confiable` quedó publicado en GitHub (`4a12a90`) y
  PM2 `herramientas` fue reiniciado; `/login/` respondió HTTP 200.
- Coordinación Codex↔Claude configurada: Codex orquesta; matriz de modelos en
  `agents/model-routing.md` y router de skills en `agents/skill-routing.md`.
- El controlador `npm run agent:claude` invoca Claude sin copiar/pegar y valida el handoff antes
  de aceptar el siguiente gate.
- `npm run agent:e2e` prepara la instancia aislada (DB temporal sin token ML, crons
  desactivados, URL/puerto/PID/HEAD/base/sesión explícitos), deriva las herramientas declaradas
  del rol, despacha al probador y limpia sus recursos al terminar. Smoke y E2E real: handoff
  válido; no quedaron procesos ni puertos temporales.
- E2E de Entrega 2: `APROBADO` (handoff previo). Conteo manual, cierre seguro, asociación EAN, descarte,
  permisos, consola/red y responsive 1440/768/390 cubiertos. Notas no bloqueantes: redirects
  `/herramientas/` al servir Express directo, mensaje 403 genérico y WooCommerce sin HTTPS en
  el entorno aislado.

## Próximo paso

- Ejecutar E2E/auditoría de C2 y pasar luego a C3 (Preparación). La revisión formal de
  Claude para los dropdowns de C1 queda pendiente hasta que la cuota vuelva a responder.

## Evidencia reciente

- Suites dirigidas: inventario 129/129, códigos 15/15 y wooStock 11/11.
- Suite global con `--testTimeout=60000 --reporter=dot`: 65 archivos, 1326 tests en verde, 1 skip.
- C2: Consulta de Precios 22/22; Códigos + permisos 36/36; Inventario 129/129. Suite global
  serial: 64 archivos verdes, 1332 tests aprobados y 1 skip; `matcherPush` aislado 28/28
  (el timeout de 20s bajo suite completa es intermitente y ya está documentado).

## Bloqueos conocidos

- La cuota de Claude devolvió HTTP 429 y anunció renovación a las 22:50 UTC; la revisión nueva
  no pudo ejecutarse. La batería local sí quedó aprobada: 65 archivos, 1326 tests aprobados y
  1 omitido, además de las pruebas dirigidas de inventario/códigos/stock.
- Los logs de PM2 muestran 429 de ML y fallos de Woo ya existentes en crons; el proceso quedó
  online y el endpoint de login responde correctamente.
- Las notas del E2E no bloquean Entrega 2; el auditor debe decidir si registra el prefijo
  `/herramientas/` y el mensaje de permisos como backlog separado.

## Estado operativo temporal

- El kernel `6.8.0-138-generic` está instalado pero pendiente de activarse mediante reinicio;
  verificar la versión en ejecución antes de actuar o retirar este aviso.

Este archivo debe permanecer breve. Reemplazá estados cerrados u obsoletos; no acumules una
cronología de sesiones.
