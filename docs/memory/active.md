# Estado activo

Actualizado: 2026-08-22.

## En curso

- C2 — Consulta de Precios: implementación congelada y publicada en GitHub (`0c4a445`); el
  plan y contrato de subida de GTIN están en `docs/superpowers/plans/2026-08-22-consulta-precios-gtin.md`.
  Falta el gate E2E/auditoría antes de reiniciar PM2.
- C3 — Preparación de pedidos: implementación terminada y commit aislado `5ef0257` en
  `.claude/worktrees/preparacion-gtin` (`c3-preparacion-gtin`), sin tocar C2. Un GTIN válido
  desconocido devuelve candidatos y exige asociación explícita; hay conflicto de GTIN/mapa,
  auditoría del escaneo, mapa local fail-open ante Woo caído y UI móvil con títulos largos.
  Falta revisión formal/E2E antes de integrar a `conteo-confiable` y reiniciar PM2.
- Entrega 2, conteo confiable + cierre seguro + subida de GTIN C1, en
  `.claude/worktrees/matcher-unificado` (`conteo-confiable-revisado`), integrada en `e4e8bbf`.
  Corrección post-revisión: render pendiente de cantidades, motivo visible del cierre,
  región accesible para la hoja EAN, token de color, mapeo `ean_sku` sin SKU homónimo, contrato
  explícito del reintento `confirmada_con_errores` y dropdowns de asociación fluidos para títulos
  largos en móvil y PC. El merge a `conteo-confiable` quedó publicado en GitHub (`4a12a90`) y
  PM2 `herramientas` fue reiniciado; `/login/` respondió HTTP 200.
- Coordinación Codex↔Claude configurada: Codex orquesta; matriz de modelos en
  `agents/model-routing.md` y router de skills en `agents/skill-routing.md`.
- Política operativa vigente solicitada por el usuario (2026-08-28): Codex ejecuta directamente
  los roles y gates del pipeline, sin depender de despachos ni handoffs de Claude, hasta nuevo
  aviso. Los resultados se documentan con evidencia reproducible y solo se actualizan hechos
  durables en esta memoria.
- Bloque 4 de API móvil: JWT HS256 de acceso (15 min), refresh opaco rotativo (90 días),
  asociación obligatoria del refresh al dispositivo en `/api/v1/devices` y revocación de su
  familia al eliminarlo. Requiere configurar `MOBILE_JWT_SECRET` (mínimo 32 caracteres) en
  cada entorno; el valor real no se versiona.
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

- Ejecutar E2E/auditoría de C2 y revisar/integrar C3 (Preparación). La revisión formal de
  Claude para los dropdowns de C1 y el E2E de C3 quedan pendientes hasta que la cuota vuelva a
  responder; no se reinicia PM2 con C3 mientras esos gates sigan abiertos.

## Evidencia reciente

- Suites dirigidas: inventario 129/129, códigos 15/15 y wooStock 11/11.
- Suite global con `--testTimeout=60000 --reporter=dot`: 65 archivos, 1326 tests en verde, 1 skip.
- C2: Consulta de Precios 22/22; Códigos + permisos 36/36; Inventario 129/129. Suite global
  serial: 64 archivos verdes, 1332 tests aprobados y 1 skip; `matcherPush` aislado 28/28
  (el timeout de 20s bajo suite completa es intermitente y ya está documentado).
- C3: tests dirigidos de candidatos, asociación local, subida Woo, conflicto de GTIN y
  conflicto de mapa `ean_sku`: 5/5. La suite completa de Preparación se ejecutó serializada
  fuera del sandbox; dentro del sandbox Supertest falla por `listen EPERM` y puede dejar falsos
  errores de SQLite al borrar su DB temporal.

## Bloqueos conocidos

- La cuota de Claude devolvió HTTP 429 y anunció renovación a las 22:50 UTC; la revisión nueva
  no pudo ejecutarse. La batería local sí quedó aprobada: 65 archivos, 1326 tests aprobados y
  1 omitido, además de las pruebas dirigidas de inventario/códigos/stock.
- Los logs de PM2 muestran 429 de ML y fallos de Woo ya existentes en crons; el proceso quedó
  online y el endpoint de login responde correctamente.
- El E2E local de C2 quedó bloqueado por la instalación disponible: el CLI Playwright no pudo
  importar el paquete desde Node y el navegador root del wrapper no ofrece una opción segura
  de `--no-sandbox`; no se inventó un veredicto. La instancia temporal se cerró y limpió.
- Las notas del E2E no bloquean Entrega 2; el auditor debe decidir si registra el prefijo
  `/herramientas/` y el mensaje de permisos como backlog separado.

## Estado operativo temporal

- El kernel `6.8.0-138-generic` está instalado pero pendiente de activarse mediante reinicio;
  verificar la versión en ejecución antes de actuar o retirar este aviso.

Este archivo debe permanecer breve. Reemplazá estados cerrados u obsoletos; no acumules una
cronología de sesiones.
