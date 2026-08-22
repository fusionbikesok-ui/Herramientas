# Estado activo

Actualizado: 2026-08-21.

## En curso

- Entrega 2, conteo confiable + cierre seguro + subida de GTIN C1, en
  `.claude/worktrees/matcher-unificado` (`conteo-confiable-revisado`), commit `448b679`.
  El bloqueo de foco del conflicto GTIN, el reintento fail-closed y la guarda de SKU homónimo
  fueron corregidos.
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

- Entrega 2 integrada en `conteo-confiable` mediante merge `6cd89e7`, publicada en GitHub y
  con PM2 `herramientas` reiniciado (PID 2334035, online). El endpoint local `/login/` respondió
  200. El reintento del agente Claude quedó temporalmente bloqueado porque `claude -p` no
  respondió en 30 s; no se inventó un handoff nuevo.

## Evidencia reciente

- Suites dirigidas: inventario 129/129, códigos 15/15 y wooStock 11/11.
- Suite global con `--testTimeout=60000 --reporter=dot`: 65 archivos, 1326 tests en verde, 1 skip.

## Bloqueos conocidos

- Revisión formal nueva de Claude y auditoría independiente pendientes: el reintento del
  2026-08-22 terminó por timeout controlado. Diagnóstico: autenticación Pro vigente, pero
  `api.anthropic.com` devuelve `getaddrinfo ETIMEOUT`; el sandbox también bloquea escrituras
  en `/root/.claude` con `EROFS`. No hay evidencia de cuota agotada.
- Los logs de PM2 muestran 429 de ML y fallos de Woo ya existentes en crons; el proceso quedó
  online y el endpoint de login responde correctamente.
- Las notas del E2E no bloquean Entrega 2; el auditor debe decidir si registra el prefijo
  `/herramientas/` y el mensaje de permisos como backlog separado.

## Estado operativo temporal

- El kernel `6.8.0-138-generic` está instalado pero pendiente de activarse mediante reinicio;
  verificar la versión en ejecución antes de actuar o retirar este aviso.

Este archivo debe permanecer breve. Reemplazá estados cerrados u obsoletos; no acumules una
cronología de sesiones.
