# Estado activo

Actualizado: 2026-09-05.

## Fuente de verdad

- Especificación vigente: `/opt/fusionbikes/herramientas/docs/superpowers/plans/plan-maestro-v2.md`.
- Índice de planificación: `/opt/fusionbikes/herramientas/docs/superpowers/INDEX.md`.
- Progreso verificable: `/opt/fusionbikes/herramientas/docs/superpowers/deliveries/README.md` y fichas E0–E24.
- E0 fue aprobada por el usuario el 2026-09-02 y figura `aceptada` en el índice de entregas. No implica despliegue de código.
- La App remota `feature/stock-flow-ui` alineó `README.md` y `docs/backend-sync/README.md` en `ac4c48f` y `380640f`; no se publicó build móvil.
- El VPS `/opt/fusionbikes/herramientas` es producción real y sirve `conteo-confiable`.

## Base y cambios preservados

La reconstrucción partió de `bc13898f9faeffcde00f49616ce6cb858eff03a3` y se integró por fast-forward. Los cambios ajenos no confirmados en `db/index.js`, `routes/inventario.js`, `test/inventario.test.js` y `migrations/041_stock_rollout_skus.sql` conservaron exactamente sus hashes antes/después.

## Estado funcional verificado, no aceptación

- Preparación posee cola, claims, escaneo, fotos/evidencia y despacho idempotente. E1 tiene correcciones locales para arrastre entre jornadas, elegibilidad efectiva, transición/polling de claims, aviso de vencimiento, compatibilidad 042→043 y ventanas SLA confirmadas. E2 suma perfiles versionados, snapshot de requisitos, idempotencia/fingerprint, auditoría atómica, limpieza compensatoria, retención con holds y recuperación de cola por lease; suite 246/246 y E2E verde. Queda validación operativa real, dispositivo/hardware, piloto y aceptación.
- E1 registra además la confirmación de horarios de apertura por operador, rechaza una negativa explícita, bloquea asignaciones si `items_json` no es verificable, restringe la configuración de zonas y ayudas, detecta cambios externos o snapshots ausentes en pedidos ya tomados, crea retornos físicos pendientes para unidades asignadas y reproduce asignaciones idempotentemente antes de validar versión; `test/jornada.test.js` queda en 53/53.
- Etiquetas posee cola interna y endpoints/agente candidato; falta relevamiento y validación con impresora real.
- E3 está en desarrollo: el agente admite Bearer JWT revocable, el permiso `etiquetas` y recuperación de leases; faltan modelo/driver/puerto, Windows e impresora real.
- E4 está en desarrollo: lotes separados ML/Web, miembros congelados, tracking, escaneo idempotente, confirmación de salida física, auditoría propia y worker Woo con reintento/dead-letter tienen migraciones 050–056, API/UI, pruebas de integración y E2E visual aislada (`npm run e2e:e4`); falta revisión independiente, tracking integrado con Woo/transportista y piloto.
- E5 aún no puede iniciar en la App: `/opt/fusionbikes/FusionBikes-App` no existe; HTTPS requiere autenticación y SSH respondió `Repository not found` el 2026-09-03. No se guardaron credenciales. El lado VPS valida contrato móvil 1.0.0 (42 rutas, SHA-256 `a01d188a3b875f93143e708f7809c9fd003a9fa69ef692bb54572af44dea9267`) y auth/dispositivo 13/13, pero falta checkout y iPhone real.
- Backend móvil posee auth, dispositivos, notificaciones/inbox y contrato `/api/v1` parcial. La App remota tiene conexión real parcial; falta iPhone físico, contrato generado definitivo y offline común.
- Consulta rápida y movimientos/transferencias tienen implementaciones candidatas locales, pero no equivalen a E8–E10 aceptadas.
- Conteos, recepción e integraciones existen como herramientas legacy; aún no comparten el modelo E0–E24.

## Próxima acción

E2 conserva pendientes externos de revisión independiente y piloto/jornada observada; E3 ya está en desarrollo técnico con autenticación del agente validada, pero requiere relevamiento de impresora, prueba Windows/hardware, revisión y piloto antes de candidata. No desplegar runtime mientras las entregas sigan sin aceptación.

## Hallazgo agregado

- Woo ya tiene webhook durable de catálogo en `/api/woo/webhook/product`: persiste/deduplica
  `product.created`, `product.updated` y `product.deleted` antes del ACK y relee desde Woo el
  padre con sus variaciones. El cron completo cada cinco minutos mantiene la reconciliación.
  El webhook histórico de pedidos conserva su camino background no durable; ML mantiene sus
  propios eventos durables/audit-only.

## UM1 — Identidad de productos (2026-09-05)

- UM1 dejó de ser «Guardia ML»: es el programa de Identidad de productos UM1.1–UM1.6 (PM-031).
  Especificación en `docs/superpowers/plans/2026-09-04-identidad-productos.md`, sección 18.1 del
  maestro y fichas UM1.1–UM1.6. Reemplaza Matcher/Cobertura/Guardia; no los arregla.
- Producción sirve `2ef15a1` (incluye el webhook durable de catálogo Woo y la corrección que
  impide degradar identidades ajenas); el camino directo sin cero está desplegado y observado.
- El canario 1 completado no vuelve a la cola cuando únicamente aparece una contradicción de
  GTIN: conserva `verificado` si ML mantiene el mismo SKU y Producto Fusion; el conflicto queda
  clasificado y auditado. Si el SKU cambia o desaparece, reabre urgente. Test dirigido 34/34.
- Una operación `shadow` que cambia de identidad antes de cualquier efecto remoto queda obsoleta,
  no admite reintento y libera el caso a `urgente`; una operación ya intentada conserva
  intervención. La sección 18.1 documenta el camino directo sin stock cero.
- El rollout soporta hasta dos claves canario explícitas (separadas por coma) y dos operaciones
  por corrida. El canario de dos publicaciones fue retirado y el procesamiento general quedó
  habilitado con `canario_ml_key=''`, `modo='enforced'`, escrituras activas y lote 2.
- Despliegue técnico del camino directo realizado el 2026-09-05: merge `a0a6b6d`, commit de
  actualización `f2ddb22`, PM2 reiniciado, marcador `identidad_sin_cero_085` presente y endpoint
  en `:3001` responde 401 sin sesión. Backup consistente:
  `data/fusion.sqlite.bak-um11-directo-20260905-005000`.
- Canario directo de dos publicaciones completado el 2026-09-05 01:00 UTC con configuración
  `MLA798189569|,MLA1541702013|`, lote 2. Ambas operaciones terminaron `completada`,
  `sin_cero=1`, y la relectura autenticada confirmó `FB-10376`/stock 1 y
  `FB-50396`/stock 6, respectivamente. No se tocó una tercera publicación. Backup previo:
  `data/fusion.sqlite.bak-um11-canario2-20260905-010000`.
- Retirada del canario y habilitación general el 2026-09-05 01:07 UTC:
  `canario_ml_key=''`, `modo='enforced'`, `escrituras_remotas_habilitadas=1`, `lote_max=2`.
  En el primer tick se tomaron dos operaciones antiguas y ambas fueron a `intervencion` por el
  umbral de 15 minutos; no hubo fallo remoto. Backups: `data/fusion.sqlite.bak-um11-retirar-
  canario-20260905T010521Z` y `data/fusion.sqlite.bak-um11-habilitar-general-20260905T010721Z`.
- Webhook durable de catálogo Woo desplegado y configurado el 2026-09-05: suscripciones activas
  para crear, actualizar y borrar; una entrega firmada real para el producto 1732 completó el
  job `catalog.woo_product_sync` y releyó padre + variaciones. No escribe Woo ni ML.
- Corrección inmediata: la primera versión disparaba una auditoría global con
  `lecturaConfiable=false` y devolvió 1056 SKU exactos a `stock_no_verificado`. Esa llamada fue
  retirada. La auditoría confiable restauró 1055 casos: el universo quedó en 1055 verificadas,
  34 urgentes y 1 esperando operación (`conciliado=true`). Una segunda entrega firmada terminó
  sin cambiar esos conteos. Backup: `data/fusion.sqlite.bak-um12-restaurar-cola-
  20260905T013950Z`.
- `user_version` no numera migraciones: es la compuerta de Hito 7 (PM-034). Ninguna migración
  nueva puede escribirlo o la base queda sin `device_tokens` y cae la auth móvil.
- Cada avance sobre UM1 actualiza en el mismo commit estado, evidencia, handoff y decisiones.

## Reglas inmediatas

- **Un backup previo a un despliegue se guarda como `fusion-<AAAAMMDD>-<HHMMSS>-predeploy.sqlite.gz`,
  en `/opt/fusionbikes/backups/db/`.** La rotación de `backups/backup.sh` borra a los 14 días lo que
  coincide con `fusion-*.sqlite.gz`; cualquier otro nombre —o el mismo sin comprimir— queda en disco
  para siempre. Pasó el 2026-09-06: tres backups pre-despliegue sin `.gz` sumaban 292 MB que ninguna
  regla iba a limpiar. Nunca dejar copias en `data/`, que es donde vive la base productiva: ahí se
  habían acumulado 22 copias ad-hoc de sesiones anteriores, 1,6 GB. El sistema de backups **sí tiene
  retención** (14 días local, 30 en la nube, con snapshot consistente y DR cifrado); lo que faltaba
  era respetar su convención de nombres.

- **Nunca matar procesos por patrón de cmdline; siempre por PID verificado.** El 2026-09-06 se
  corrió `pkill -f "node server.js"` para bajar un servidor de prueba, y ése es exactamente el
  cmdline del servidor productivo. No lo mató por casualidad —pm2 lo lanza vía `start.sh`—, no
  por criterio: si ese script hiciera `exec node server.js`, habría tirado producción. El
  procedimiento es identificar el proceso (`pgrep -af`, y confirmar con `/proc/<pid>/environ` y
  `/proc/<pid>/cwd` qué puerto y qué directorio usa) y recién entonces `kill <pid>`. Vale también
  para `pkill -f vitest`, que alcanza corridas de otras sesiones.

- **No correr la suite completa salvo que se vaya a desplegar** (instrucción del usuario,
  2026-09-06, explícita como excepción al gate habitual: «no quiero que corras la suite completa
  hasta que diga que vamos a hacer un despliegue»). Motivo práctico: tarda ~20 min, bloquea el
  worktree —no se puede editar mientras corre sin invalidar la medición— y sus flaky por timeout
  agregan ruido. Durante el desarrollo se corren sólo los archivos afectados y `npm run lint:diff`;
  la suite completa vuelve como gate de despliegue, cuando el usuario lo pida.

- **Hay tests que fallan sólo en la corrida completa y pasan aislados.** Es contención, no un bug
  del cambio en curso: la suite tarda ~20 min y algunos casos cruzan su `testTimeout` de 5 s bajo
  carga. Vistos así: `inventario.test.js` y, el 2026-09-06, `workshop-stock.test.js` («registra
  consumo idempotente desde ubicación», timeout a 5000 ms en la suite, 475 ms aislado) y
  `consultaPrecios.test.js` («rechaza id_woo inexistente», 5681 ms en la suite, 38/38 aislado).
  Dos corridas seguidas fallaron en un test **distinto** cada vez: eso es contención, no un bug.
  Cuando el archivo que falla consume algo que el cambio tocó —`consultaPrecios` usa
  `looksLikeGtin`—, pasar aislado no alcanza: hay que probar la equivalencia del comportamiento
  (se comparó la implementación vieja contra la nueva sobre 2481 valores reales, 0 divergencias). Antes de
  atribuirlo a la interferencia hay que descartar haber ralentizado la suite: comparar la duración
  total contra corridas previas —esa vez bajó de 1289 s a 1195 s con más tests, así que el cambio
  no era la causa—. La deuda de fondo sigue abierta: los timeouts dependen de la máquina.

- **`git clean -f -x` borra los tests nuevos que todavía no se commitearon.** Pasó el 2026-09-06:
  se usó como higiene antes de correr la suite y se llevó puesto un archivo de test recién escrito
  y sin `git add`. Antes de limpiar, `git status --porcelain` y `git add` de lo que se quiera
  conservar; o limpiar sólo los residuos conocidos en vez de todo lo no rastreado.
- **No editar el worktree mientras corre la suite.** Vuelve inválida la medición, y ese día pasó
  dos veces: la segunda, además, la corrida tuvo que descartarse entera (`exit=143`) y repetirse.
  Si hay que seguir trabajando, se espera el cierre o se corre sobre una copia.
- **Una migración ya desplegada es inmutable; una que todavía no, se corrige en su lugar.** El
  registro en `_schema_migrations` impide que vuelva a ejecutarse, así que cambiar su `.sql`
  después de que corrió deja las bases viejas con un esquema distinto al de las nuevas. Corolario
  operativo: las copias de prueba hay que regenerarlas desde el backup cuando la migración cambia,
  o se prueba contra un esquema que ya no existe.

- **Verificar el artefacto, no la señal que lo representa.** Es el error que más veces se repitió
  el 2026-09-05/06, siempre con la misma forma: un test verde no prueba que el código se ejecute
  (un `catch` se tragaba un `ReferenceError` y la función nunca corría); un `200` de ML no prueba
  que la escritura se aplicó (el sync logueaba `ok` sobre publicaciones que nunca cambiaban); un
  script que imprime `ok` no prueba que el archivo quedó válido (tres archivos rotos con `,,`
  por el mismo patrón de inserción de imports por regex, que hay que dejar de usar). Después de
  cada edición hay que mirar la cosa —`node --check` sobre TODOS los archivos tocados, incluidos
  los de test; el valor leído de vuelta, no el mensaje de la herramienta—, sin excepciones por
  categoría: aplicar la verificación solo a los archivos "importantes" es peor que no tenerla,
  porque da sensación de cobertura.
- **Toda hipótesis se contrasta contra un número y contra la documentación oficial de ML o Woo**
  (regla del usuario, 2026-09-06). Las tres causas raíz que resultaron falsas ese día —«es por
  `user_product_id`» (lo tiene el 94%), «es por `catalog_listing`» (uno de tres), «los dead
  letters son de un solo día» (seguían llegando)— cayeron todas contra una medición, no contra
  un razonamiento. Si una causa raíz se enuncia sin un número al lado, todavía no está probada.
- No declarar terminada una entrega por existir código o numeración previa.
- Los agentes son especialistas opt-in: no hay pipeline, handoff formal, modelo/esfuerzo prescrito
  ni gates automáticos. Diseño se invoca al diseñar; revisión, testing, E2E y auditoría solo de
  forma individual cuando el riesgo o incertidumbre lo justifica. Los scripts `agent:*` y su
  configuración de enrutamiento quedaron retirados y no se usan para trabajo nuevo.
- No iniciar `node server.js` contra la base real ni ejecutar suites concurrentes.
- Backend/web solo podrán publicarse automáticamente cuando el pipeline definido por el maestro esté implementado y verde; hoy una tarea documental no autoriza push, migración, PM2 ni deploy.
- Windows, hardware y App Store siempre exigen autorización explícita.
- No almacenar secretos, PII, conversaciones ni logs en memoria.

## Decisiones E1 incorporadas

- E1 queda especificada, pero no implementada con estas nuevas reglas: ola inicial de elegibles, mini-olas normales, ML urgente en ola activa, búsqueda por zonas manuales, ayuda física registrada y escaneo unitario en mesa.
- PC muestra tablero operativo; celular web muestra una tarea; tablet futura es tablero compartido sin PII. E1 permanece `desarrollo` y la demo sintética solo puede llevarla a `candidata`.
- La documentación separa E1 (jornada/olas/búsqueda/mesa) de E2 (embalaje/fotos/aprobación/listo para despacho). No se autoriza cambio de código en esta actualización documental.
