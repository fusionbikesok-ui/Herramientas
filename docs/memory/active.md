# Estado activo

Actualizado: 2026-08-31.

## Fuente de verdad

- El único plan activo es `docs/superpowers/plans/plan-maestro-v2.md`.
- Producción sirve `conteo-confiable`; `master` permanece separado hasta ejecutar la
  consolidación controlada del plan maestro.
- El despliegue y la publicación siguen fuera de esta integración local.

## En curso

- Hito U0 vence el 2026-09-04 y tiene precedencia: cerrar Conteo de Inventario y Preparación de
  Pedidos de punta a punta en el VPS, y congelar contrato/UX de ambos módulos para la app.
- El cierre móvil de U0 es definición, no publicación. La ejecución queda en el orden Base común →
  Preparación → Inventario → Consolidación.
- P0.1 Claims acepta `claims` y `post_purchase`, consulta el recurso autoritativo y conserva
  el comportamiento fail-open con diagnóstico durable; la corrección actual sigue pendiente
  de revisión final.
- P1 Claims aporta el diseño de eventos/jobs durables, inbox, conversaciones, notificaciones
  lógicas, entregas push y lectura operativa móvil; la implementación actual sigue pendiente
  de revisión final y el acceso exige permiso `notificaciones-ml`.
- Hito 7 aporta una única autenticación móvil JWT con refresh ligado al dispositivo, rutas
  `/api/v1/devices` y `/api/v1/notifications`, preferencias, FCM HTTP v1 y reservas de envío
  idempotentes. Claims usa el mismo middleware móvil; el panel web conserva cookies.
- Claims ocupa la migración `029`; el lease incremental de integration jobs usa la migración
  `035` sin modificar 029; Hito 7 conserva su migración `030` según el plan.
- El proveedor push real está configurado como FCM en el entorno de producción; sus credenciales
  permanecen solo en `.env`; en producción `PUSH_REAL_ENABLED=true` habilita envíos y su ausencia o
  valor distinto pausa ambos workers sin consumir intentos; test/development conserva el proveedor
  mock cuando la variable está ausente.
  `mock` queda reservado para desarrollo y pruebas.

## Estado de cierre

- **P1.5 (lease/backoff/DLQ de `integration_jobs`) desplegado en producción.** Commit `7d3b9f9`
  sobre `conteo-confiable` (push a `origin/conteo-confiable` hecho), `pm2 restart` aplicado,
  migración `035_integration_jobs_lease_token.sql` verificada aplicada (`lease_token` presente en
  `integration_jobs`). Pasó pipeline completo (revisor → hard-worker → tester →
  auditor-despliegue) en 6 rondas — incluyó cerrar `isClaim` sin gate de `action`, normalización
  de `resource_id` de claims a forma canónica, ACK del webhook `/api/ml/notificacion` siempre
  `200` (decisión explícita: ML documenta 200 como único ACK válido), cuenta ajena sin persistir,
  gate `PUSH_REAL_ENABLED` fail-closed sin depender de `NODE_ENV`, y saneo anti log-injection en
  los 4 logs de error. Suite global 1855/1855 verde antes del deploy. Verificado post-deploy con
  PM2 `online` estable y prueba real del webhook (400 con log saneado).
- **Incidente durante el pipeline (2026-08-30):** otro proceso/sesión trabajando en paralelo sobre
  este mismo checkout reescribió partes de `server.js` (revirtió el ACK a `202`) y un agente
  auditor con la sesión cortada modificó `vitest.config.js`/`package.json` sin autorización
  (agregó `--no-file-parallelism`). Ambos se detectaron verificando código literal en vez de
  confiar en resúmenes, y se revirtieron antes del deploy final. Lección: en este repo puede haber
  más de un agente/sesión escribiendo sobre el mismo working tree a la vez — verificar el diff
  real antes de cada gate, no solo el resumen del paso anterior.
- Pendiente para el próximo ciclo (no bloqueante): rate limiting en `/api/ml/notificacion`
  (endpoint público sin límite de tasa), y revisar si quedó backlog sin consumidor en
  `ml_reclamos` tras dar de baja el cron legacy `reintentarReclamosSinConsultar`.
- P0.2 tiene configuración local verificada para JWT, HMAC Woo, ML y FCM; la URL operativa de ML es
  `/api/ml/notificacion` bajo el dominio de producción y los topics fueron confirmados por el
  responsable operativo. `PUSH_REAL_ENABLED=true` fue agregado al `.env` real del VPS (no
  versionado) con autorización explícita del usuario, para que el nuevo gate fail-closed no
  apagara las push reales al desplegar.
- P0.3: la suite global serial sobre la base de ejecución `b7fb85c` pasó `91 archivos, 1872 tests y
  1 omitido`, código 0, en `1173,54 s` (19m33s). El gate dirigido de Preparación sobre esa base
  pasó `212/212`. Falta auditoría final y verificación post-despliegue.
- P0.1 Claims: el 2026-08-31 pasaron `51/51` tests dirigidos en cuatro archivos, cubriendo
  `claims`, `post_purchase`, paths autoritativos, `opened/closed`, deduplicación, reintentos y
  fail-open. Sigue pendiente la verificación con una notificación real y la auditoría final.
- P0.2/P1.6: el 2026-08-31 pasaron `61/61` tests dirigidos en cinco archivos para auth móvil,
  dispositivos, binding y notificaciones push lógica. Sigue pendiente FCM real y background en
  dispositivo.
- Barrido vigente adicional: PM2 `online`, Node en `*:3001`, migraciones del backbone presentes
  (incluido `lease_token`), `/api/v1/inbox` sin token devuelve `401`, ML inválido devuelve `400`
  y Woo con firma inválida devuelve `401`. Esto valida routing, autenticación básica y esquema;
  aún no prueba lectura autenticada ni E2E móvil.
- Alertas de conexión ML/Woo: el incidente se persiste desde el primer fallo y la caída se reserva
  en el outbox durable `incidentes_email_outbox` tras 3 repeticiones (o inmediatamente si es crítica),
  independiente del cooldown en memoria; la unicidad por incidente/tipo evita duplicados y la
  recuperación solo se reserva después de una caída enviada. SMTP Zoho y los destinatarios viven
  únicamente en `.env` de producción.
- La vista/contador de errores de sync filtra el historial append-only por el último resultado de
  cada identidad `(dirección, clave)`, comparando `(creado_en,id)`; el `NULL` de `pedidos_cache` se
  trata como identidad válida y un `ml_stock_estado` viejo no oculta un error posterior. Las
  reservas ML→Woo retenidas (`wc_order_id=0`, `retenido_en` no nulo) permanecen visibles.
- El cliente móvil Claims queda subordinado a App 3 para no desplazar U0; su handoff UX sigue en
  `docs/superpowers/specs/claims-p2-mobile-ux.md`.
- App 0 y el cliente móvil pertenecen al otro chat/repositorio. Este repo conserva únicamente los
  contratos backend; no se atribuyen aquí builds, tests ni artefactos móviles.

## Higiene de ramas (2026-08-30)

Se auditaron las 49 ramas locales y todos los worktrees (`.claude/worktrees/*`, `/tmp/fusion-*`,
`/root/.claude/jobs/*`) comparando contenido real (no solo mensajes de commit) contra
`conteo-confiable`. Resultado, para no repetir esta auditoría:

- **Quedan 3 ramas locales:** `conteo-confiable` (producción), `master` (pendiente de
  consolidación, Prioridad 6) y `prep-horarios-corte` (ver abajo). `prep-cola-instantanea` está
  integrada en la base de ejecución verificada `b7fb85c` desde el 2026-08-31.
- **~38 ramas se borraron sin tag** (`git branch -d`): contenido 100% mergeado en
  `conteo-confiable`, verificado por `git merge-base --is-ancestor`. Sin pérdida de historia.
- **9 ramas viejas/reemplazadas se archivaron como tag `archive/<nombre>` antes de borrarse**
  (`c3-preparacion-gtin`, `entrega-a-ingreso-matcher`, `fix-nombre-truncado-inventario`,
  `fix-preparacion-huerfana`, `fase4-planificador-ciclos`, `integracion-master-conteo`,
  `hito7-push-backend`, `worktree-matcher-unificado-v2`, `p0-claims-real`): tenían commits únicos
  pero su base de merge era de 2026-08-19/25, muy anterior a la consolidación del plan maestro
  actual, y su contenido ya está superado por `conteo-confiable`. Recuperables con
  `git checkout -b <nombre> archive/<nombre>` si hiciera falta, pero no deberían revisarse de
  nuevo salvo pedido explícito.
- `codex/u0b-despacho` y `codex/u0b-despacho-fix` se borraron sin tag: su contenido resultó
  byte-a-byte idéntico (`git diff` vacío) al ya mergeado en `conteo-confiable` bajo otro hash.
- Se removieron ~29 worktrees redundantes (mismo contenido que arriba, incluidos varios con
  cambios sin commitear que resultaron ser WIP ya superado o solo `node_modules`).
- `p0-claims-real` (archivada) traía un esqueleto `mobile/` de 6 archivos (App.tsx, package.json)
  que no está en `conteo-confiable`. Es un prototipo temprano de App 0 abandonado; no contradice
  la regla de que este repo no declara artefactos móviles propios porque nunca se integró.

### Pendiente real detectado (actualizado 2026-08-31)

- La feature `prep-cola-instantanea` ya no está pendiente: está integrada en el estado vigente
  `b7fb85c`. El gate dirigido posterior pasó `212/212` pruebas en
  tres archivos. Sus reglas de elegibilidad y conservación de casos inconclusos quedaron dentro
  de la integración.
- **`prep-horarios-corte`** (rama viva, sin worktree temporal activo): no integrable en su estado
  actual. La revisión aislada del 2026-08-31 encontró migración `022` duplicada frente a `032`, UI
  sin `expected_version/409`, contrato SLA ML incompleto, cobertura HTTP/E2E insuficiente y tests
  no reproducibles desde un checkout limpio. Debe corregirse y repetir gates sobre la base actual.

## Incidente abierto: bloqueo de red contra WooCommerce (2026-08-30, pendiente para el usuario)

**No es una caída de `fusionbikes.com.ar` ni un bug de este deploy.** Es un bloqueo específico
contra la IP saliente de este VPS (`179.197.74.83`).

- Síntoma reportado: la app muestra dos errores de sync (`Error refrescando catálogo` y
  `Error sincronizando pedidos_cache`), ambos por no poder hablar con WooCommerce (timeouts de
  20s, 503/521/508). El sistema de alertas lo tiene registrado como incidente activo
  `incidentes_operativos` id 7 (`woocommerce | refrescar_catalogo`), primera detección
  2026-08-30T19:31:07Z, 33+ repeticiones, sin resolver. El circuito de WooCommerce está abierto
  (pausa reintentos para no insistir contra un origen que rechaza).
- Diagnóstico verificado: desde este VPS, `https://fusionbikes.com.ar` da 503 (a veces
  instantáneo, <0.1s — típico de un edge de Cloudflare devolviendo el error, no del origen
  real) o timeout total; probado con curl normal y con User-Agent de navegador, mismo
  resultado. En cambio Google y la API de MercadoLibre responden normal desde el mismo VPS
  (internet del servidor está bien). El usuario confirmó que el sitio le carga bien desde su
  propia conexión.
- **Conclusión: muy probablemente Cloudflare (o un plugin de seguridad de WordPress, ej.
  Wordfence) está bloqueando el rango de IPs de datacenter/hosting de este VPS específico**,
  lo que corta también las llamadas legítimas de la integración ML↔Woo, no solo la navegación.
- **Efecto colateral:** el pedido ML `2000018195106388` quedó con la reserva RETENIDA en
  fail-closed porque no se pudo verificar contra Woo si ya existía — revisar manualmente en
  cuanto se restablezca el acceso.
- **Acción pendiente (usuario, no resoluble desde este repo):** entrar al panel de Cloudflare
  de `fusionbikes.com.ar` (Security → Events) o al plugin de seguridad de WordPress, buscar
  bloqueos contra `179.197.74.83`, y agregarla a la lista de permitidos. Es la IP fija de este
  VPS — la usa constantemente la integración.

## Dónde se está trabajando

- Único checkout activo de desarrollo: `/opt/fusionbikes/herramientas` sobre `conteo-confiable`
  (rama que sirve producción).
- El único trabajo de rama pendiente registrado es `prep-horarios-corte`; la cola instantánea ya
  está integrada en la base de ejecución `b7fb85c`.
- No hay ningún otro worktree, rama local ni proceso de test corriendo en este momento.
- La suite global completa tarda al menos **13 minutos** en el entorno actual; la última corrida
  completa (2026-08-31: 89 archivos, 1859 aprobados, 1 omitido, código 0) duró **1119,29 s
  (18 min 39 s)**. No debe
  detenerse por parecer inactiva: reservar una ventana de al menos 20 minutos y esperar el resumen
  final. Para una corrida silenciosa, consultar la sesión una vez aproximadamente un minuto antes
  de la duración observada (14 min 39 s) y otra vez al final, no cada 60–90 segundos. Si la terminal
  no permite una espera tan larga, dejar el proceso persistente; solo interrumpir ante un error
  inequívoco.
- Ningún ítem de U0 está autorizado a desplegarse sin pipeline completo: cada cambio futuro
  conserva revisión, tests, E2E, auditoría y aprobación previa a modificar producción.
