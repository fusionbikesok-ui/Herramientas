# Estado activo

Actualizado: 2026-09-20.

## Fuente de verdad

- Especificación y arquitectura vigentes: `/opt/fusionbikes/herramientas/docs/superpowers/plan-maestro.md`.
- La ejecución usa un DAG explícito E0–E26; el número identifica la entrega y no implica depender de la anterior. Las fichas históricas y líneas P/UM/GP están archivadas y sólo aportan evidencia mediante el crosswalk.
- **Congelamiento del legado (PM-160):** sólo arreglos de bugs que pierden plata o bloquean la operación; ninguna función nueva en áreas que reemplaza una vertical. La corrección de conteos espera al libro (P3).
- **App iPhone (PM-162):** no se rehace; `/api/v1` queda como fachada sobre v2 y la App migra por OTA. Falta verificar que la build instalada tenga `expo-updates` y que un OTA de prueba llegue.
- Índice de planificación: `/opt/fusionbikes/herramientas/docs/superpowers/INDEX.md`.
- Progreso verificable: `/opt/fusionbikes/herramientas/docs/superpowers/deliveries/README.md` y fichas E0–E26.
- E0 fue aceptada por decisión de José tras sus verificaciones de DR; conserva su número y no se reabre por una inferencia documental. E1 tiene los tramos 1 y 2 implementados y verificados sólo en infraestructura efímera (`E1_TRAMO=2 npm run test:e1` verde el 2026-09-16); la entrega E1 aún no está aceptada ni desplegada.
- La App remota `feature/stock-flow-ui` alineó `README.md` y `docs/backend-sync/README.md` en `ac4c48f` y `380640f`; no se publicó build móvil.
- El VPS `/opt/fusionbikes/herramientas` es producción real y sirve `conteo-confiable`.

## Base y cambios preservados

La reconstrucción partió de `bc13898f9faeffcde00f49616ce6cb858eff03a3` y se integró por fast-forward. Los cambios ajenos no confirmados en `db/index.js`, `routes/inventario.js`, `test/inventario.test.js` y `migrations/041_stock_rollout_skus.sql` conservaron exactamente sus hashes antes/después.

## Estado funcional verificado, no aceptación

- Preparación posee lista de recolección consolidada por producto con imagen y cantidades, cola continua priorizada, claims por preparación, checklist con escaneo unitario, fotos/evidencia y despacho idempotente. El 2026-09-08 se retiraron las olas del runtime, UI y contrato de pendientes por falta de adopción; sus datos históricos se preservan. E2 mantiene perfiles versionados, snapshot de requisitos, idempotencia/fingerprint, auditoría atómica, limpieza compensatoria, retención con holds y recuperación de cola por lease. Quedan pruebas focalizadas, validación operativa real, dispositivo/hardware, piloto y aceptación.
- Decisión de arquitectura: Gestión de pedidos será la herramienta del Home para importar y administrar todos los pedidos de Woo/ML del último mes, incluidas ventas físicas de local; Gestión de envíos conserva la operación logística. Solo pedidos Woo en “listo para enviar Andreani” o derivados manualmente pasan a la cola de envíos. Gestión de pedidos puede consultar las fotos de preparación de pedidos enviados.
- Etiquetas posee cola interna y endpoints/agente candidato; falta relevamiento y validación con impresora real.
- E3 está en desarrollo: el agente admite Bearer JWT revocable, el permiso `etiquetas` y recuperación de leases; faltan modelo/driver/puerto, Windows e impresora real.
- E4 está en desarrollo: lotes separados ML/Web, miembros congelados, tracking, escaneo idempotente, confirmación de salida física, auditoría propia y worker Woo con reintento/dead-letter tienen migraciones 050–056, API/UI, pruebas de integración y E2E visual aislada (`npm run e2e:e4`); falta revisión independiente, tracking integrado con Woo/transportista y piloto.
- E5 aún no puede iniciar en la App: `/opt/fusionbikes/FusionBikes-App` no existe; HTTPS requiere autenticación y SSH respondió `Repository not found` el 2026-09-03. No se guardaron credenciales. El lado VPS valida contrato móvil 1.0.0 (42 rutas, SHA-256 `a01d188a3b875f93143e708f7809c9fd003a9fa69ef692bb54572af44dea9267`) y auth/dispositivo 13/13, pero falta checkout y iPhone real.
- Backend móvil posee auth, dispositivos, notificaciones/inbox y contrato `/api/v1` parcial. La App remota tiene conexión real parcial; falta iPhone físico, contrato generado definitivo y offline común.
- Consulta rápida y movimientos/transferencias tienen implementaciones candidatas locales, pero no equivalen a E8–E10 aceptadas.
- Conteos, recepción e integraciones existen como herramientas legacy; aún no comparten el modelo E0–E24.

## Próxima acción

**Siguiente paso de programa: implementar E1, tramo 2, en aislamiento.** El commit `2dc9ca4` incorporó `plataforma/`; `8b9303d` cerró la revisión de T1. José aprobó el 2026-09-15 el diseño T2 y, mediante PM-178, la retención de 400 días para observaciones/relaciones técnicas sin PII. Spec: `docs/superpowers/specs/2026-09-15-e1-tramo2-barridos-design.md`; plan: `docs/superpowers/plans/2026-09-15-e1-tramo2-barridos.md`. No autoriza roles, migraciones sobre E0, canales reales ni servicios persistentes en el VPS.

Avance T2 (verificado con la suite de `plataforma/`): cortes 1 (SQL y cifrado), 2 (programación y leases) y 3 (motor transaccional) implementados, sin desplegar. Contratos del motor (`plataforma/src/reconciliacion/motor.ts`): el adaptador declara `versionKind` `temporal` (instantes UTC) o `hash` (versión distinta siempre reemplaza: la relectura GET es autoridad); la ventana `window_from/window_to` se congela en el primer intento y los reintentos de la misma corrida la reutilizan; el lease se renueva entre páginas cada 25 s; una página con un recurso inválido se rechaza completa con `ErrorPaginaInvalida` (terminal); una versión atrasada sólo registra avistamiento y no cambia `lifecycle`; las bajas `deleted:<run-id>` sólo se declaran dentro del cierre exitoso de una vuelta completa y un recurso que reaparece vuelve a observarse.

Corte 4 implementado: `plataforma/src/reconciliacion/cliente-http.ts` (sólo GET, allowlist `127.0.0.1|localhost|[::1]|simulator`, redirección terminal, timeout 5 s, 10 MiB, 4 conexiones, header `x-fusion-plano: canal`, errores sin query ni cuerpos; 401/403/4xx terminal, 408/429/5xx/red/corte reintentable con `Retry-After` ≤300 s) y `adaptadores/ml.ts` + `adaptadores/woo.ts` con los ocho tópicos. Versiones: temporales en órdenes ML/Woo, envíos, items y productos Woo; hash `sha256:` de la proyección en preguntas, reclamos y mensajes (404 individual → `deleted`). `scripts/qa/simulador-canales.mjs` acepta `crearSimulador({fixture})` en memoria (`alLlamar` muta datos vivos entre páginas; fallas `modo: cortar|cortar-despues` y `demoraMs`) sin cambiar el modo SQLite legado; importa `better-sqlite3` sólo en modo CLI. Brechas conocidas frente a la matriz, a resolver antes de cerrar T2: `woo.products` sólo tiene la vuelta completa (falta la corriente incremental de modificados cada 10 min, porque el worker indexa procesadores por tópico y no por `cursor_kind`); `woo.orders` no tiene la diferencia semanal de IDs; `worker/main.ts` todavía no registra adaptadores (requiere URLs y keyring por configuración, corte 5); paginar `/orders/search` por offset puede saltear una orden si otra sale de la ventana congelada durante el paginado.
Decisiones de José del 2026-09-15 sobre T2, ya implementadas (suite de `plataforma/` verde, 73 pruebas): una corriente es cuenta + tópico + `cursor_kind`, con `state_sweep` para la ventana incremental y `full_scan` para la vuelta completa que declara bajas; `ml.items` sólo tiene `full_scan` porque su API no filtra por modificación. Los procesadores del worker se indexan `topic|cursor_kind` (`claveCorriente`) y `reclamarCorridas` recibe pares, así que un worker de la corriente incremental no toca la vuelta completa del mismo tópico. Las vueltas completas de Woo son de sólo presencia (`modo: 'presencia'`, `_fields=id`): enumeran IDs, no encolan ni reescriben versión/payload, y sólo declaran ausentes; la de productos enumera padres y lleva `alcanceBajas: 'no_variaciones'`, de modo que una variación borrada se detecta cuando su padre se relee, no por la vuelta. La migración `0004_corrientes.sql` siembra las diez corrientes por cuenta: incrementales de 10 min (ml.orders, woo.orders, woo.products), 15 min (ml.shipments, convergencia) y 20 min (ml.questions, ml.messages, ml.claims); vueltas completas a las 04:00 (ml.items), 04:15 (woo.products) y domingos 04:30 (woo.orders), hora de Argentina, escalonadas para no competir por cuota.

Tramo 2 completo y verificado el 2026-09-16 con `E1_TRAMO=2 npm run test:e1` (diez corrientes barridas por el worker real en Docker, ocho tópicos con inbox, todo payload cifrado, 139 llamadas de canal todas GET, cero contenedores restantes). Piezas durables del arnés y del cierre:

- El alta de corrientes vive en `integrations.sembrar_corrientes(cuenta)` (creada por 0004 y reflejada en `specs/e1/schema.sql`): la migración la usa para las cuentas existentes, y el ensayo y el alta de cuentas de T3 para las nuevas. Es idempotente y devuelve cuántas creó.
- El worker se configura por entorno, todo o nada: desde T3 C4 son `BARRIDOS_REGISTRO_FILE` (registro de cuentas) y `BARRIDOS_KEYRING_FILE`; sin ellas no registra procesadores y no reclama nada. La configuración T2 de cuenta única se retiró (ver C4 más abajo). El keyring es JSON con claves de 32 bytes en base64, se rechaza si el archivo es legible por grupo u otros, y se monta como carpeta read-only (el contenedor corre con uid 1000; montar carpetas, no archivos sueltos).
- El gate de escenarios es `scripts/qa/gate-e1.mjs`: exige que cada ID del tramo aparezca en el título de una prueba que pasó del reporte JSON de vitest, más los que verifica el arnés (`--verificado E1-SVC-01`). Los ocho barridos por tópico se numeran `E1-SWP-01..08` y `E1-SWP-09` es la caída en página 3. `E1_SKIP_UNIT=1` saltea suite y gate y lo declara: esa corrida no es contractual.
- El ensayo barre en dos olas porque envíos y mensajes descubren sus recursos por las relaciones que dejan las órdenes, y las vueltas de presencia necesitan observaciones para poder declarar una baja. Con una sola ola, envíos enumeraba 0.
- Woo no parte la ventana en segmentos: pagina por número de página sobre la ventana congelada. Los segmentos de 6 h son sólo de ML, por el tope de offset de `/orders/search`. Con segmentos, `woo.products` enumeraba 720 recursos de un fixture de 6 y la deduplicación tapaba el síntoma; el simulador ahora filtra `/products` por `modified_after`, `modified_before` y `status`, como el controlador real, para que una consulta de más se note.
- `/orders/search` relee el segmento completo si el `total` cambia durante el paginado (hasta 3 veces); si no se estabiliza, la corrida queda reintentable con `SEGMENTO_INESTABLE` y el cursor no se mueve.

Semántica de `status` de Woo, verificada el 2026-09-16 en el código de WooCommerce y de WordPress: en pedidos el parámetro tiene `default => 'any'` y su enum incluye `'trash'`; `trash` se registra como estado interno, hereda `exclude_from_search => true` y por eso `post_status='any'` lo excluye (el legado ya dependía de eso en `routes/sync.js:467` y `routes/woo.js:283`). Consecuencia para los barridos: un pedido cancelado sí lo trae la pasada `any`, pero uno papelereado exige una segunda pasada con `status=trash`, tanto en la corriente incremental como en la vuelta de presencia; sin ella la vuelta lo veía ausente y lo declaraba borrado, confundiendo papelera con borrado definitivo. En productos la asimetría es deliberada: la vuelta no consulta `trash` porque, para el catálogo, un producto papelereado está fuera y la baja es la señal correcta.

La revisión independiente de T2 quedó **aprobada el 2026-09-16**, después de corregir su único hallazgo Alto (el filtro `status` de pedidos Woo, commit `aa42f3f`). Dos invariantes que esa revisión confirmó y conviene no volver a discutir: un recurso que cambia después de congelarse `window_to` queda fuera de las dos pasadas de esa corrida pero entra en la siguiente con solape, así que es demora de un intervalo y no pérdida; y las dos pasadas de una vuelta de presencia corren dentro de la misma `corrida.id`, por lo que la unión de IDs vistos cuenta como presencia y sólo el borrado definitivo queda declarado como baja.

La suite legacy completa, que comparte el simulador de canales, dio 2631/2683 el 2026-09-16 con un único fallo: `test/preparacion.test.js` ("cola de fotos", dependiente de tiempo) esperaba `listo` y encontró `procesando`. Corrido solo, ese archivo pasa 245/245, no importa el simulador y nada del diff de T2 toca `routes/`, `lib/`, `db/` ni `utils/`: es el falso fallo que ya describe CLAUDE.md cuando la suite completa corre con el servidor de producción arriba, no una regresión.

**T3 corte C1 implementado el 2026-09-16** (contrato y migraciones, sin conexión real ni flags):

- Legado: migración `104_sombra_ciclo_eventos.sql` + su registro en `db/index.js` con la clave
  `sombra_ciclo_104`. Agrega a `integration_events` ocho columnas nulables del ciclo de sombra
  (`shadow_status`, `shadow_reason`, `ack_at`, `enqueue_at`, `completed_at`, `boot_id`, `attempt_id`,
  `shadow_imported_at`) y tres índices parciales: activa, purga y descartes sin importar. **SQLite no
  puede agregar un CHECK a una tabla existente** sin reconstruirla, y esa tabla es caliente, así que los
  valores válidos los impone el código del corte C2, no el esquema. Ojo: el legado aplica sus
  migraciones **en cada arranque**, así que commitear una migración toca producción en el próximo
  reinicio; por eso columnas nulables y sin default.
- Plataforma: migración `0005_senales.sql` con `integrations.reconciliation_signals` (unicidad por aviso
  cuenta+tópico+fingerprint, índice único parcial de una sola señal activa por recurso, mismo contrato
  de lease que colas y corridas, checks de tópico/fuente/estado) y `sembrar_corrientes` reescrita en
  plpgsql: consulta `core.channel_accounts.channel`, siembra sólo las corrientes de ese canal (6 para ML,
  4 para Woo) y **falla** si la cuenta no existe o el canal no tiene corrientes definidas. La misma
  migración deshabilita —sin borrar— las corrientes cruzadas que 0004 había sembrado, sólo si no tienen
  éxito previo ni corrida activa.
- Los permisos de `plataforma_app` sobre tablas nuevas se heredan por `ALTER DEFAULT PRIVILEGES` del rol
  migrador (0002): una tabla nueva no necesita GRANT explícito.
- El cuerpo de una función en PostgreSQL se guarda textualmente, así que `schema.sql` y la migración
  tienen que ser **idénticos byte a byte**: el test que compara `pg_dump` de la base migrada contra la
  referencia falla por un cambio de indentación. Empalmar el bloque con un script es más seguro que
  editarlo a mano.
- Al agregar una migración de plataforma hay que actualizar la lista exacta de `migraciones.test.ts`, y
  el test del hueco de numeración usa el número siguiente al último (hoy `0007_salto.sql`).

Falta para cerrar E1: los tramos 3 (sombra en vivo) y 4 (seguridad y reporte). E1 queda en `desarrollo`, no en `candidata`: T2 verificado no acepta la entrega, y nada de esto está desplegado.

E2 conserva pendientes externos de revisión independiente y piloto/jornada observada; E3 ya está en desarrollo técnico con autenticación del agente validada, pero requiere relevamiento de impresora, prueba Windows/hardware, revisión y piloto antes de candidata. No desplegar runtime mientras las entregas sigan sin aceptación.

## Gestión de pedidos (2026-09-09)

- **La pantalla era una maqueta.** GP4–GP8 figuraban `publicada` con backend real y probado,
  pero `public/gestion-pedidos/index.html` seguía siendo el prototipo de GP1: pedidos
  hardcodeados, `alert('Demo: …')` y checklist en `localStorage`. Sólo Recuperar ventas
  llamaba a la API. Se reescribió contra la API real (tres pills, buscador, vista rápida,
  detalle en URL propia, selección múltiple y envío a preparación).
- **El gate `PEDIDOS_PREVIEW_USER` se retiró.** Limitaba la pantalla a un único nombre de
  usuario y dejaba afuera a Joaco y Santi, que ya tenían `pedidos:write`. Ahora la página
  exige el mismo permiso `pedidos` que su API.
- **El importador no persistía importes ni entrega.** Los 706 pedidos importados tenían
  `total_centavos` NULL, `gestion_pedido_entregas` vacía y las líneas Woo sin precio. Se
  extendieron `normalizarPedidoWc`/`normalizarOrdenMl` y `upsertGestionPedido`. Los pedidos
  ya importados sólo muestran importes después de una reconciliación.
- **Los importes de ML no se mapean por el nombre del campo.** `total_amount` es la suma de
  los ítems (el subtotal) y `paid_amount` es lo pagado, que en un cancelado con reembolso
  queda en 0. El total del pedido se arma como ítems + envío; lo pagado o devuelto lo cuenta
  `pago_estado`. Tomarlos literalmente daba subtotal mayor que total, y "Total $0" en ventas
  reembolsadas que sí existieron.
- **La entrega de un pedido ML no se escribe** hasta importar su shipment: afirmar
  `domicilio` clasificaba mal los Flex y los retiros en sucursal.
- **`gestion_pedido_items.id` no es estable:** el importador borra e inserta las líneas en
  cada corrida, y con el cron eso ocurre cada 10 minutos. Cualquier referencia a una línea
  (por ejemplo, remover un producto en GP14) tiene que ser por SKU, no por id.
- **El estado real del canal no se guardaba.** La 095 sólo tenía clasificaciones propias y
  625 de 723 pedidos caían en la misma combinación, así que la columna de estado no
  distinguía nada. La migración 099 agrega `estado_canal` crudo: los valores reales son
  `enviadoandreani`, `retiradoenfusion`, `paid`, `mercadolibre`, `serviceterminado`.
- **Cierre por estado del canal** (decisión del usuario, 2026-09-09): `enviadoandreani`,
  `retiradoenfusion`, `completed` y `serviceterminado` cierran el pedido y lo sacan de
  "Requieren atención" — de 497 a 175. `paid` de ML NO cierra: sólo dice que ML cobró, y
  saber si salió exige importar el shipment, que sigue pendiente.
- **El estado de una orden de ML es de cobro, no de logística:** se queda en `paid` aunque
  el paquete ya haya salido, y por eso ventas despachadas seguían en "Requieren atención".
  El estado logístico ya vivía en `ml_shipment_estado` (migración 006, la mantiene el flujo
  de preparación); faltaba el puente, porque esa tabla se indexa por `shipment_id` y no se
  guardaba. La migración 100 agrega `ml_shipment_id`, que la orden trae en `shipping.id`.
  `shipped` y `delivered` cierran el pedido; `ready_to_ship` no, porque está listo pero
  todavía no salió. Sin dato de envío el pedido queda abierto: no saber si salió nunca puede
  esconder una venta sin despachar. Con esto "Requieren atención" bajó de 175 a 77.
- **El estado del envío ML lo refresca el cron `5-59/10` de `syncPedidosCache`**, que por
  cada orden `paid` de los últimos 30 días consulta `/shipments/:id` y actualiza
  `ml_shipment_estado`. Un estado terminal queda cacheado 7 días y se saltea; uno en
  `ready_to_ship` se vuelve a consultar cada 10 minutos.
- **`pendientesMl` salteaba el GET de shipment cuando la preparación local estaba
  `completada`.** Ahorraba cuota, pero congelaba el estado en `ready_to_ship` justo para los
  pedidos que ya habían pasado por el depósito: 39 de las 42 ventas de ML que Gestión de
  pedidos mostraba como pendientes. Ahora se consulta igual y el pedido **no** vuelve a la
  cola de preparación; el costo se acota solo porque al pasar a terminal se cachea 7 días.
- **La importación pisaba el estado operativo local.** Recalculaba y escribía sin mirar el
  anterior, así que con el cron un pedido mandado a preparar volvía solo a `importado` a los
  diez minutos. Ahora los estados locales se conservan y el canal sólo gana cuando informa un
  cierre.
- **Una venta de ML entraba dos veces:** la orden de ML y su pedido espejo en Woo (142 de
  723). No se detectaban cruzando datos porque el espejo trae el nombre real en vez del
  nickname, otra hora y **otro importe** (usa el precio de contado de la web, por la regla de
  negocio). El vínculo determinista es la meta `_ml_order_id` de Woo, que el normalizador ya
  leía y no se persistía. Se muestra la fila de ML, con el número de Woo del depósito a la
  vista; el espejo sólo se oculta si su orden de ML está importada.
- **El estado de un pedido de ML lo manda ML** (instrucción del usuario): no se toma del
  espejo de Woo ni se modifica localmente; los cambios se traen por la API.
- **`NULL != 'valor'` en SQL no es verdadero, es NULL.** Las exclusiones de la bandeja
  (`on-hold` antiguos, `fusion`) comparaban `estado_canal` directo, así que un pedido sin
  estado del canal desaparecía de "Requieren atención" en silencio. Se comparan con
  `COALESCE(estado_canal,'')`.
- **El esquema se define en migraciones, no con `ALTER` en línea.** `datos_ml_json` se creaba
  dentro del importador, así que una base creada desde las migraciones —despliegue nuevo,
  backup restaurado, entorno de prueba— no tenía la columna y el listado respondía 500 hasta
  que alguien importara. Migración 101.
- **Los tests con fechas fijas se rompen solos al cambiar el día.** Los de Recuperar ventas
  usaban `2026-09-08` y la oportunidad vence al cierre del día hábil siguiente: pasaban el día
  que se escribieron y fallaban al siguiente. Se anclan con `haceHoras()`.
- **`enviar-woo` nunca pudo actualizar Woo:** llamaba a `wooFetch` pasando
  `{ method, data }` en la posición de `method`. Los tests no lo detectaban porque siempre
  inyectan `actualizarWooOverride`. Corregido a la firma real `(cfg, path, method, body)`.
- **La importación ahora tiene cron** (`9-59/10`, ventana `GESTION_PEDIDOS_VENTANA_HORAS`,
  48 h por defecto), compartiendo `lib/gestionPedidosSync.js` con el botón manual de
  reconciliación de 30 días.
- **Sólo se editan los pedidos nativos de Woo** (decisión del usuario, 2026-09-09). Los de ML
  no se modifican, y tampoco los espejo (`espejo_ml`, meta `_ml_order_id`), que son ventas de
  ML viviendo en Woo y caen bajo la regla de negocio vigente. `gestion_pedidos` todavía no
  persiste `espejo_ml`: hay que agregar la columna antes de habilitar la edición.
- **El contrato de cuotas con Master Control está escrito y sin desplegar.**
  `fusion-pricing/v1/cotizacion` en `includes/Controllers/ApiController.php` del plugin, de
  sólo lectura, autenticado con `X-Fusion-Token` contra la constante `FUSION_API_TOKEN` de
  `wp-config.php`; cliente del VPS en `lib/masterControlPricing.js`, fail-closed, variable
  `MASTER_CONTROL_TOKEN`. El WordPress **no está en este VPS**: `fusionbikes.com.ar` está en
  Hostinger detrás de Cloudflare, y desde acá sólo hay claves REST de Woo (`wc/v3`), que no
  autorizan a desplegar código. La subida del plugin es manual. Ese WordPress ya sirve
  namespaces propios (`fusion-abandoned/v1`, `fusion-chat/v1`) cuyo código no está versionado
  en ningún repositorio conocido.
- **Un `<base>` insertado por script no aplica a los `<link>` del markup.** Se probó y falló:
  la herramienta calcula la raíz y escribe las rutas de `lib/` ya resueltas, porque el
  detalle vive en `/gestion-pedidos/pedidos/{id}` y `../lib/` apunta mal desde ahí.

## Preparación (2026-09-10)

- **Una preparación en curso podía quedar inalcanzable.** Sólo se reabría desde su tarjeta en
  la cola, y la cola muestra únicamente pedidos vigentes del canal; la pantalla no usaba
  `pushState` ni hash, así que no había URL. Cuando el pedido avanzaba —envío ML a `shipped`,
  pedido web fuera de `lpaandreani`— la tarjeta desaparecía y el trabajo quedaba encerrado: ni
  en la cola, ni en el historial. Así se acumularon 38.
- **Arreglado con tres piezas:** `GET /api/preparacion/abiertas` y un bloque "Preparaciones
  abiertas sin terminar" arriba de la cola; URL propia `?pedido=N` con recarga, botón atrás y
  link compartible; y aviso en el detalle cuando el canal informa que el pedido ya salió o se
  canceló (se avisa y se deja terminar: la evidencia se guarda igual).
- **La URL usa query param y no `/preparacion/pedido/N`** a propósito: la página carga
  `format.js`, `api.js` y `scanner.js` (módulo) con rutas `../lib/`, que desde un nivel más
  profundo darían 404. Mismo problema que se resolvió en Gestión de pedidos con `document.write`;
  acá se evitó por completo.
- **Sólo ve el detalle quien tiene el claim vigente** (`puedeVerDetallePreparacion`), y las
  encerradas lo tenían vencido: al abrirlas desde la vista nueva o por URL se toma el claim
  primero, como ya hacían las tarjetas de la cola.
- **Las 36 encerradas se cerraron** con `scripts/cerrar-preparaciones-despachadas.mjs`, que
  reusa `marcarPreparacionEnviada` en vez de inventar un cierre: decide `completada` si estaba
  verificada y `despachada_sin_verificar` si no, y registra el evento. Quedaron 67 ítems y 29
  fotos conservados. **Dos ML canceladas se dejaron a mano**: marcarlas "enviada" sería falso.
  El script saltea las que tienen claim vigente.

## Conteo de inventario (2026-09-10)

- **La herramienta está completa, pero la parte de ubicaciones tenía cero uso:** 0 de 33
  sesiones con ubicación, 1 sola ubicación creada (`Mostrador/Molicsyn`, bootstrap) y 0
  productos mapeados. La causa: elegir ubicación era **mutuamente excluyente** con
  categoría/marca y obligaba a un barrido completo de la zona, y en la tienda se cuenta por
  marca. El código que asocia SKU→ubicación al escanear (`capturarUbicacion`) ya existía y
  estaba bien cableado; nunca se disparaba porque ninguna sesión tenía ubicación.
- **Se levantó la exclusión** (decisión del usuario, 2026-09-10): la categoría/marca dice QUÉ
  se cuenta y la ubicación DÓNDE está parado el operario. La ubicación sola sigue siendo
  barrido completo. El anti-solape sólo considera la ubicación cuando ella define el alcance:
  dos personas contando marcas distintas en el mismo estante ya no se pisan.
- **Universo real a controlar: 1.605 SKUs con stock**, no los 5.168 del catálogo. De ésos
  **1.213 (76%) nunca se contaron**. `sku_ultimo_conteo` (433 filas) guarda cuándo se contó
  cada SKU y qué diferencia dio: es la base para priorizar el conteo cíclico.
- **El contador de inventario se rediseñó el 2026-09-11.** Una sola lista de productos con
  foto y un campo numérico que se tipea; contar NO mueve la fila. **Conteo a ciegas**: con la
  sesión abierta la API no manda la cantidad esperada ni el bloque `con_stock`/`sin_stock` de un
  producto sin contar, y reordena para que el orden tampoco lo delate. La lógica de la lista
  vive en `public/lib/conteoLista.js` con tests propios. En escritorio (≥1024 px) son **dos
  paneles** con flujo de teclado: ↑↓ mueven, Enter guarda y avanza, Esc vuelve al campo.
- **El escaneo suena distinto según lo que pasó** (2026-09-11): 880 Hz al leer, 660→990 en la
  primera unidad de un producto, 990·990 cuando **ya estaba contado**, 240 Hz grave si el código
  no está asociado. Ese contraste es la señal que faltaba en el incidente del casco Giro.
  **No se usa vibración**: Safari en iOS no soporta la Vibration API de forma confiable y desde
  iOS 18.4 exige una interacción táctil que caduca en 1 s — un escaneo con lector nunca entra en
  esa ventana, y el conteo se hace 100% en iPhone. Lo que llama `navigator.vibrate` en
  preparación es un no-op en esos equipos.
- **Preparación ya acepta códigos de barras** (2026-09-11): `POST /api/preparacion/:id/escanear`
  resolvía el código solo contra `preparacion_items.sku`, así que leer el EAN del producto daba
  "no coincide" y obligaba a tipear el SKU. Ahora traduce a SKUs candidatos por `ean_sku` y por
  `catalogo_cache.gtin`, probando las formas equivalentes del mismo GTIN (UPC-12 / EAN-13 con
  cero adelante / canónico de 14 de `lib/gtin.js`). 7 tests nuevos en `test/preparacion.test.js`.
- **Tipear una cantidad a mano no guardaba nada** (2026-09-11, corregido y desplegado el
  2026-09-12): la ficha del contador rediseñada leía el resultado del control como
  `decision.cantidad`, propiedad que `conteoCantidad.js` nunca expuso — se llama `valorEnviar`.
  El PATCH viajaba con el cuerpo vacío, el servidor contestaba 400 y el número volvía solo al
  valor anterior, en teléfono y en escritorio. El módulo estaba bien: lo que estaba mal era quién
  lo leía, así que la guarda nueva en `test/conteoCantidad.test.js` verifica el **call site** —
  que la pantalla no lea ninguna propiedad que la decisión no devuelva.
- **El panel de escritorio del conteo (`#cd-caja`) no entraba en la guarda de re-render**, así
  que un refresco de fondo borraba lo que se estaba tipeando y devolvía el foco al lector.
  Además sólo guardaba con Enter (no al salir del campo) y no tenía botón de restar. Los tres
  corregidos el 2026-09-11.
- **Vigía de formato de publicaciones** (desplegado el 2026-09-12): compara `catalog_product_id`,
  `UNITS_PER_PACK` y `SALE_FORMAT` de cada publicación contra lo último guardado, en el upsert del
  cache (`routes/matcher.js`). Si alguno CAMBIA, pausa la publicación y abre incidente crítico
  (email + push). Detecta el cambio, no el valor: en Woo no hay ningún campo que diga cuántas
  unidades trae un producto, así que ninguna regla puede saber si un "Pack de 2" está bien.
  Freno de mano: más de 5 publicaciones en una corrida → no pausa ninguna y abre un solo
  incidente. `getReactivablesRows` saltea las que tienen un cambio sin revisar, o el reactivador
  desharía el trabajo del vigía en silencio.
- **Al agregar un campo vigilado hay que cargar su LÍNEA BASE antes de desplegar.** El refresco
  acotado corre de a UN ítem desde el worker de webhooks, así que un `null → valor` recién
  estrenado queda por debajo del umbral y pausa publicaciones sanas de a una. El 2026-09-12 se
  hizo el backfill de `catalog_product_id` (3.955 ítems) antes del reinicio, y la primera corrida
  dio 0 cambios y 0 pausadas.
- **La suite completa cuesta ~4,5 minutos** (259 s y 264 s, dos corridas verdes 2026-09-13; eran
  ~50 min antes de la base rápida y ~10 min después). Dos ajustes más del 2026-09-13:
  `maxWorkers: 2` en `vitest.config.js` (con 2 CPU vitest corría los archivos de a uno; no hay
  archivos que compartan base temporal) y `FUSION_ESPERAS_RAPIDAS=1`, que vía `lib/esperas.js`
  acorta a 1 ms los backoff de reintento de Woo/ML/verificación y las pausas entre llamadas a ML
  (`routes/woo.js`, `routes/matcher.js`, `routes/sync.js`, `lib/matcherPush.js`). Se lee en cada
  llamada: los tests que verifican el valor real la apagan en su `describe` (piso de 500 ms del
  Retry-After en `woo.test.js`, corte por tiempo en `matcherPush.test.js`). No se tocaron las
  esperas de fotos, identidad, reconciliación de stock ni el limitador de ML (sus tests miden el
  valor real). Producción nunca define la variable.
- **Base rápida de la suite** (2026-09-12). Cada test abre una base nueva y
  corre las 68 migraciones, pero el 90% de ese costo es **fsync**, no las migraciones: `openDb`
  tarda 1.681 ms en disco, 175 ms con el journal en memoria y 160 ms sobre tmpfs. `vitest.config.js`
  setea `SQLITE_UNSAFE_FAST=1` y `db/index.js` pone `journal_mode=MEMORY` + `synchronous=OFF` sólo
  con esa bandera. **Nunca en producción**: ahí se escribe el stock real y un corte de luz
  corrompería la base. No está en `.env`, ni en `ecosystem.config.cjs`, ni en el entorno de pm2.
- **Dos tests dependían de que la máquina fuera lenta** y la base rápida los destapó: sembraban
  filas seguidas confiando en que `new Date()` diera timestamps distintos. En el mismo
  milisegundo el `ORDER BY` empata y lo desempata SQLite. Regla: si un test depende del orden o
  de que una fecha cambió, la fecha va **explícita** o el reloj va fijado con `vi.setSystemTime`.
- **Un 403 de ML no es un problema de credenciales.** 401 y 403 estaban en la misma categoría
  `auth`, así que un 403 abría un incidente crítico que mandaba a revisar el Client ID. 403 pasó
  a la categoría `permiso` (advertencia). El fallo real del refresh de token setea
  `.categoria='auth'` explícitamente y sigue siendo crítico.
- **Choque de clases en el contador**: la ficha usa `class="pf-res dif"` y `.dif` existe aparte
  como componente de la lista de diferencias (`display:flex`, `padding:12px 0`). Le inflaba la
  altura a todas las fichas en todos los anchos. Al mirar CSS de esa pantalla, ojo también con el
  **orden**: los bloques `@media` van DESPUÉS de las reglas base o la base gana por orden de
  aparición — pasó tres veces.
- **El contado de referencia sale SIEMPRE de `catalogo_cache.regular_price`, nunca de `precio`**
  (regresión reintroducida y corregida el 2026-09-11 en `POST /api/precios/objetivo`). `precio` es
  el VIGENTE y ya trae el `sale_price`: usarlo descuenta dos veces. El SKU de una publicación sale
  de `sku_matcher_decisiones`, no de `p.seller_sku` (difieren en 2). Es el mismo bug que ya se
  había corregido una vez en `auditarPrecios`: si aparece un tercer call site, revisar esto primero.
- **El precio objetivo de ML apunta al contado exacto** (2026-09-11): `precioObjetivoMl()` de
  `lib/mlPrecios.js` resuelve en dos fases (punto fijo sobre comisión+envío, luego cubre en pasos
  de $100) el precio de publicación cuyo neto iguala el precio de contado de la web. El envío se
  cotiza al precio nuevo (`item_price` + `listing_type_id`), no al viejo; el 5% es solo tolerancia
  de juicio, no el objetivo. Se dispara a mano desde el reactivador de publicaciones
  ("Corregir precio y reactivar"), nunca automáticamente.
- **El bug de las filas partidas estaba en `/asociar`, no en `/escanear`.** `/escanear` deduplica
  por SKU desde el 2026-08-25; `/asociar` ponía el SKU sobre la fila del EAN sin mirar si ya
  había otra fila con ese SKU en la sesión. Así el casco Giro `FB-67121` (sesión 33) quedó en dos
  filas, generó dos faltantes y **se publicó en 0 teniendo las 3 unidades**. Corregido: ahora
  funde. Las 4 filas partidas históricas (sesiones 31 y 33) NO se tocaron — su stock ya se aplicó
  y rehacerlas no lo devolvería; `FB-67121` hay que corregirlo en Woo a mano.
- **Sólo el 17% del catálogo tiene código cargado** (800 de 4.588, más 321 EAN asociados a mano):
  por eso no se puede escanear. El 99% sí tiene foto (4.560), y ninguna pantalla de conteo la
  usaba. Hasta 21 productos comparten la misma imagen (talles), así que en variantes el
  talle/color manda sobre el nombre.
- **El conteo se hace 100% desde el teléfono**: las 12 sesiones de los últimos 14 días se
  abrieron desde un iPhone. Pero el escritorio es el 37% del tráfico y hace dos trabajos propios
  — **asociar códigos** (176 contra 86) y **cerrar la sesión** (42).
- **Los sobrantes esperaban autorización que nadie podía dar.** `/diferencias/pendientes`,
  `/aprobar` y `/rechazar` existían desde el 2026-08-27 y **ninguna pantalla los llamaba**. La
  sesión 33 (Joaco, 8/9) quedó en `confirmada_con_errores` con 3 sobrantes por $814.950, y una
  sesión trabada en ese estado bloquea el anti-solape de cualquier alcance que se cruce. Se
  agregó la tarjeta "Esperan tu autorización" en el inicio de conteo (2026-09-10). Autorizar y
  descartar son admin (`requireAdmin`).
- **Una preparación cancelada con producto ya levantado abre una tarea de devolución**
  (2026-09-10). Antes la única forma de cerrar una preparación era declararla enviada, y para un
  pedido cancelado eso era falso: por eso quedaban abiertas para siempre mientras el producto
  seguía fuera de su estante. Ahora pasa a `cancelada_pendiente_devolucion`, aparece en "Volver
  a su lugar" arriba de la cola, y sólo se cierra como `cancelada_devuelta` cuando alguien
  confirma a qué estante volvió cada producto. Decisiones del usuario: una confirmación por
  pedido, ubicación concreta (no "exhibición/depósito"), sin nada escaneado no se pide nada, las
  post-despacho quedan fuera, y **los estantes los carga el admin** — el preparador sólo elige.
  Depende de que existan ubicaciones activas: hoy hay 1 y la pantalla lo dice explícitamente.
  La devolución además mapea `producto_ubicacion`, igual que el conteo.
- **El anti-solape compara alcances REALES (Y), no la unión (O)** — cambiado el 2026-09-10.
  Antes usaba `productoEnAlcanceOr` sobre el catálogo entero, marcado "NO TOCAR" por ser
  conservador. El efecto real era frenar por productos que **ninguna de las dos sesiones iba a
  contar**: una ronda Shimano·TRANSMISIÓN quedó bloqueada por la sesión 33 (CASCOS·Giro) a
  causa de `FB-2419`, `FB-4751` y `FB-5530`, repuestos Shimano categorizados en CASCOS. Con
  alcance real (`skusDeAlcance`, mismo criterio que `congelarAlcance`: `productoEnAlcance`
  sobre `SQL_CATALOGO_CONTABLE`) ninguna de las dos los toca. El caso que justificaba el O
  sigue protegido: "categoría Cascos" y "marca Bell" comparten el Casco Bell y ese SKU está en
  los dos conjuntos reales, así que chocan igual. Verificado sobre la base de producción:
  Shimano·TRANSMISIÓN pasa (151 productos) y CASCOS entero sigue frenando por 87.
- **El 409 dice qué productos cruzan** (`productos_en_comun` + `ejemplos`) y la pantalla los
  lista: antes decía "se cruza" sin decir con qué y había que ir a buscarlo a la base.
- **Las categorías de `FB-2419`, `FB-4751` y `FB-5530` siguen mal en Woo** (repuestos Shimano
  en CASCOS). Ya no bloquean, pero ensucian cualquier conteo de CASCOS.
- **`rechazar` una diferencia recalcula el estado de la sesión** (2026-09-10). Antes no lo hacía
  a propósito, asumiendo que quien contaba iba a reintentar `/confirmar`; con la pantalla de
  autorización quien resuelve es el admin desde otra vista y nunca pasa por ahí, así que la
  sesión quedaba con 0 conteos sin ajustar pero seguía en `confirmada_con_errores` bloqueando
  el anti-solape. Como consecuencia, `POST /sesiones/:id/confirmar` sobre una sesión ya
  `confirmada` responde **200 idempotente** (`ya_confirmada:true`) en vez de 400: la sesión
  puede cerrarse sola mientras el operario todavía tiene el botón a la vista.
- **Los faltantes se ajustan solos y así queda** (decisión del usuario, 2026-09-10: "dejarlo
  como está pero dejando información para auditar"). La asimetría es real y consciente: un
  sobrante de $248.850 espera aprobación y un faltante de $23.985.000 se aplica solo. Medido al
  2026-09-10: **77 productos, 92 unidades, $138.311.232**, de los cuales **48 estaban marcados
  `requiere_revision=1` y se aplicaron igual**. Pesa más porque hay movimiento depósito↔salón
  que nadie asienta: un "faltante" puede ser un producto que está en el otro lado.
  `GET /api/inventario/diferencias/aplicadas?dias=N` es la información para auditarlo (sólo
  `tipo='faltante'`, orden por valor, `en_cero` separa el ajuste total del parcial), y se ve en
  "Faltantes ajustados solos" del inicio de conteo.
- **`inventario_sesiones.segundos_activos` no sirve para medir ritmo**: cuenta la sesión
  abierta, y hay una de 22 horas. La referencia útil es la sesión más reciente — 24 productos
  en 21 minutos, ~52 s por producto.
- **Ronda sugerida** (`GET /api/inventario/ronda-sugerida`): dice qué contar ahora y llena el
  alcance de un toque. La unidad es la marca, o marca+categoría cuando la marca no entra en
  una ronda — coincide con cómo se cuenta y con cómo está acomodado el local. El alcance de
  sesión ya combina marca y categoría con **Y** (`productoEnAlcance`), así que la sugerencia
  se inicia sin tocar el modelo.
- **El orden es por proporción sin contar, no por cantidad.** Un grupo con 86 nuevos sobre 134
  obliga a recontar 48 que ya estaban al día, y ese tiempo no avanza la cobertura; uno de
  60 sobre 60 rinde el 100%. Se mide sobre los que tienen stock: un grupo entero en cero no
  aporta cobertura.
- **La sugerencia usa `SQL_CATALOGO_CONTABLE`**, la misma definición que el alcance de la
  sesión (excluye `tipo='variable'`, los padres de variaciones). Con un filtro propio prometía
  152 y la sesión traía 151.
- **Objetivo fijado por el usuario: 160 productos por ronda diaria** (~2 h 20 al ritmo real),
  que cubre los 1.605 con stock en unos 10 días hábiles.

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

- Preparación: volver a la cola conserva la preparación propia y permite reingresar mediante `/tomar`; la tarjeta cambia de “Preparar” a “Continuar”. El E2 de navegador cubre salida y reingreso.

## Decisiones E1 incorporadas

- E1 queda redefinida como cola continua, checklist por pedido y escaneo de cada unidad. PC y celular abren directamente el pedido priorizado; E1 permanece `desarrollo` hasta validar el recorrido responsive y una operación real.
- E2 conserva embalaje, fotos, aprobación y listo para despacho como continuación de la checklist.

## Programa E1 (Fundación PostgreSQL en sombra) — especificada 2026-09-13

- E1 del programa E0–E26 está `planificada`: esquema `docs/superpowers/specs/e1/schema.sql` (aplicado y
  probado en PostgreSQL 18.6 descartable: cadena de auditoría verifica y detecta alteración directa),
  contrato `openapi/platform-v2.yaml`, matriz de barridos verificada `specs/e1/matriz-barridos.md` y
  escenarios `specs/e1/test-e1.md`. Decisiones PM-170 (SimpleWebAuthn 14), PM-171 (SMTP existente con
  adjuntos), PM-172 (B2 Object Lock governance 365 d con clave sin borrado). E0 está aceptada; T1 fue
  implementado/revisado en aislamiento y T2 fue aprobado para implementación efímera. (La sección
  "Decisiones E1 incorporadas" de arriba es de otra numeración histórica.)

## E0 aceptada (2026-09-14)

- E0 (PostgreSQL 18.6 + pgBackRest, DR en dos niveles) quedó `aceptada` por decisión de José con la
  evidencia de 24 h de WAL, backups firmados, test:e0 y heartbeat activo. Seguimiento pendiente, no
  bloqueante: restauración desde la copia real de la Mac (`scripts/postgres/restaurar-desde-mac.sh`),
  acordada para el 2026-09-15, y heartbeat opcional de la Mac. E1 ya puede pasar a implementación.
- Causa de la caída de 13 min del 13/09 (15:16–15:29 UTC, 33 × 502 en Better Stack): `better-sqlite3`
  sin binario nativo al reiniciar PM2 (se intentó cargar un build de Node 20; producción usa Node 24).
  Antes de reiniciar tras `npm install`/`npm rebuild`, verificar `node -e "require('better-sqlite3')"`.

## E1 tramo 1 — diseño aprobado (2026-09-15)

- Diseño: `docs/superpowers/specs/2026-09-15-e1-tramo1-fundacion-design.md` (PM-173..176). E1 en 4 tramos;
  tramo 1 = Fundación en `plataforma/` (package propio), Docker (api/worker/scheduler + migrate),
  Node 24 TS nativo + tsc 7, Fastify 5, `pg` SQL explícito, migraciones sólo hacia adelante.
- `schema.sql` corregido: la cadena de auditoría se ordena por `chain_seq` asignado dentro del lock (la
  carrera por `id` estaba reproducida); `core.service_heartbeats` agregada (será `UNLOGGED`).
- Nunca montar `/opt/fusionbikes/backups` en un contenedor (tiene backups SQLite con datos de negocio);
  el estado de E0 se moverá a `/opt/fusionbikes/estado-pg/` en la puesta en marcha del tramo 1. Montar
  carpetas, no archivos sueltos: los scripts reemplazan con `mv` y un bind de archivo queda congelado.
- Siguiente paso: ejecutar el plan aprobado de T2 por cortes; ningún corte se conecta a E0 o canales reales.

## Corrección PM-177 incorporada en E0

- pgBackRest corre sin `archive-push-queue-max`; el vigía controla `.ready`, `pg_wal` y disco. E0 fue
  reaceptada después de recrear, verificar y restaurar desde la copia real de la Mac.
- `shadow_copy_losses` no vive en PostgreSQL; el contador externo pertenece a T3. Observaciones,
  relaciones y orden de versiones pertenecen a T2 y se retienen 400 días sin payload ni PII.

## E1 tramo 3 — diseño asentado (2026-09-16)

- Diseño: `docs/superpowers/specs/2026-09-16-e1-tramo3-sombra-viva-design.md`; implementación:
  `docs/superpowers/plans/2026-09-16-e1-tramo3-sombra-viva.md`. Está documentado, no implementado,
  desplegado ni autorizado para credenciales/tráfico real.
- Corrección central: el webhook crea una señal, no una observación. El worker relee por un gateway
  legacy GET tipado; sólo el resultado remoto entra en observaciones/inbox. La plataforma nunca recibe
  tokens ML ni claves Woo.
- SQLite conserva recibos mínimos sin body/PII por 400 días. Woo orders persiste antes del ACK. La
  copia posterior usa cola acotada 256, concurrencia 2, timeout 250 ms y un intento.
- ML y Woo tienen cuentas/corrientes separadas. `missed_feeds` es suplemento de dos días y no repara
  copias perdidas después de un ACK; los barridos siguen siendo la reparación independiente.
- T3 exige prueba 500/30 min en tres modos y soak de 24 horas. T4 conserva passkeys, firma, email,
  Object Lock y los siete días contractuales. Decisiones PM-179..183.
- **Revisado el 2026-09-16** (sección 13 del diseño tiene la tabla completa de correcciones). Lo
  durable que salió de esa revisión:
  - El recibo de sombra **no es una tabla nueva**: ML y Woo products ya persisten antes del ACK en
    `integration_events` (`lib/workerIntegrationJobs.js:94` y `:137`) con tópico, recurso, fingerprint,
    delivery id, tiempos y dedupe. T3 agrega sólo el ciclo de vida como columnas. **Cerrado en C2:**
    `registrarWebhookWooPedido` le da recibo a Woo orders antes del ACK y es el único cambio de código
    de respuesta del legado (400 con id inválido, 503 si falla SQLite; antes siempre 200).
  - Los recibos sin job nacen `status='completed'`, no `'pending'`: pedidos Woo (el trabajo del legado es
    fail-open en background) y la traza de cuenta ajena. `'pending'` significa "hay trabajo durable
    encolado"; sin job quedaría activo para siempre y la purga de 400 días nunca lo alcanzaría.
  - `crearColaSombra` expone `detener()`: deja de aceptar, abandona lo no intentado como
    `abandoned/process_stopped` y espera lo en vuelo. Además `marcarSombra` no escribe si `db.open` es
    false. Sin las dos cosas, un intento posterior al ACK sobrevive al cierre de la base y rompe con
    `database connection is not open` dentro de una promesa suelta.
  - Nginx tiene **dos** caminos al mismo Express: `location /` y `location /herramientas/`, y el segundo
    proxea con barra final, así que quita el prefijo. Cualquier deny de rutas internas tiene que cubrir
    las dos formas; verificado en `/etc/nginx/sites-available/herramientas`.
  - Multiget de ML verificado con sonda autenticada de sólo lectura el 2026-09-16: `/items?ids=`
    responde 200 con `{code, body}` por elemento y `/items/bulk?ids=` responde 200 con
    `{id, status_code, body}`. Los dos existen; migrar a bulk sólo cambia de `code` a `status_code`. La
    documentación pública de ML devuelve 403 a consultas automatizadas: los límites se afirman con
    sonda, no con la página.
  - Config ML real: `ML_CLIENT_ID`, `ML_CLIENT_SECRET` y `ML_USER_ID` (`server.js:525`). No existe
    `ML_APP_ID` —en ML el app id es el client id— ni `ML_SITE_ID`, que hay que agregar para
    `missed_feeds` de items.
  - El aviso de cuenta ajena persiste traza desde C2: sigue respondiendo 200/`ignored:true`, y deja una
    fila `excluded/foreign_account` sólo si `permitirCuentaAjena` lo admite (20/IP/hora). Se llama con
    `registrarWebhookMl(db, envelope, { sinJob: true })`: **cero jobs**. Encolar trabajo sobre el recurso
    de una cuenta que el emisor elige a voluntad sería trabajar para un tercero — el `sinJob` existe por
    eso, no por prolijidad.
  - **C3 (API interna de señales)**: `POST /internal/v1/reconciliation-signals` vive en la **plataforma**
    (Fastify, puerto 3201, no publicada por Nginx); el gateway GET de C5 vive en el **legado**. Nace
    apagada: sin `SENALES_KEYRING_FILE`+`SENALES_CUENTAS`+`SENALES_ORIGENES` (todo o nada) la ruta es 404.
    La cuenta la resuelve el servidor por canal; un `channel_account_id` en el cuerpo es 400. Nonce
    repetido = 401 (replay) y los nonces viven en `integrations.signal_nonces` para que un reinicio no
    reabra la ventana de 300 s; aviso repetido con nonce nuevo = 202 `duplicate`. `plataforma_app` no
    tiene DELETE por defecto (0002): toda tabla que purgue necesita GRANT explícito, como 0006.
    Firma y origen en `plataforma/src/seguridad/interna.ts`, reutilizable por C5.
  - **C4 (multi-cuenta)**: el worker lee un registro de cuentas (`BARRIDOS_REGISTRO_FILE` +
    `BARRIDOS_KEYRING_FILE`, todo o nada); las variables T2 `BARRIDOS_CUENTA/ML_URL/WOO_URL/ML_SELLER` ya
    no existen y dejarlas puestas frena el arranque. El registro es un JSON de esquema cerrado (sin
    credenciales: un `token` o `consumer_key` lo invalida), y se valida contra `core.channel_accounts`
    (canal + identificador externo) antes de registrar adaptadores. `reclamarCorridas` exige
    `channelAccountId` en cada corriente y los procesadores se indexan `cuenta|topic|cursor_kind`.
    El harness `E1_TRAMO=2` usa dos cuentas (ML 6 + Woo 4 corrientes); con `psql -c` un
    `INSERT … RETURNING` imprime `INSERT 0 1`, por eso el harness captura ids con CTE.
  - **C5 (gateway GET)**: `POST /internal/v1/channel-read` en el legado (`lib/gatewayCanal.js`, catálogo
    cerrado de 14 operaciones; `lib/internoHmac.js`, mismo HMAC v1 que la plataforma). Nace apagado sin
    `GATEWAY_KEYRING_FILE`+`GATEWAY_ORIGENES`. La plataforma traduce rutas de adaptador a operaciones en
    `transporte-gateway.ts`; `test/reconciliacion/gateway.test.ts` importa el JS del legado y prueba la
    ida y vuelta, así que los dos lados no pueden divergir en silencio. `mlFetch` acepta `opts.headers`
    (nunca pisan Authorization). Presupuesto shadow de ML en 0 = 429 sintético sin red.
  - **C8 (observabilidad y SOP)**: legado `lib/metricasSombra.js` (recibos, razones, latencia p95, cola,
    pérdidas sin importar, webhooks Woo caídos) publica alertas como incidentes `integracion='sombra'` y los
    cierra solos; plataforma `observabilidad/sombra.ts` mide señales y barridos, el scheduler guarda
    `integrations.shadow_daily_summaries` (0008, sin firma) y loguea alertas; `GET /api/v2/shadow/status`
    con `operations.read`. Importación de pérdidas: el legado reenvía descartes por plataforma caída con
    bloque `import` y la API deja `audit_events` `shadow.loss_imported` una vez por recibo
    (`aggregate_type='shadow_receipt'`, `aggregate_id`=fingerprint). SOP con un ancla por alerta en
    `docs/superpowers/specs/e1/sop-sombra.md`; un test por lado verifica que cada runbook citado exista.
    El scheduler ahora libera leases vencidos de señales (C6 no lo hacía: quedaban `claimed` para siempre).
  - **Migraciones 104 y 105 del legado YA están aplicadas en producción** (2026-09-16 ~15:10 UTC), por
    accidente: un script de sonda abrió `data/fusion.sqlite` con `openDb`, que migra al abrir. Son aditivas;
    verificado después: `/healthz` 200, webhooks persistiéndose, `quick_check` ok, 0 filas con sombra. Lección:
    **nunca `openDb` sobre la base de producción desde un script**; usar `better-sqlite3` con `readonly: true`.
    El reinicio de C10 ya no aplica esquema, sólo carga código.
  - `missed_feeds` real sin avisos = `{"messages": null}` sin total (sonda 2026-09-16). `ML_SITE_ID=MLA` en
    `.env` de producción (copia previa en `/root/env-backup-e1-*`). Leer el token ML desde un segundo proceso
    con `getAccessToken` puede rotar el refresh token de un solo uso: la sonda leyó `ml_oauth_token` en solo
    lectura y abortaba con < 30 min de vigencia.
  - **Nginx (VPS, fuera del repo) desde 2026-09-16**: `location ~* ^/(herramientas/+)?internal(/|$) { return 404; }`
    en `sites-available/herramientas` y `sites-available/fusionbikes` (el `default_server` del 80 también
    proxea `/herramientas/`). Copia previa en `/root/nginx-backup-e1c5/`. Evidencia: `scripts/qa/deny-interno.sh`.
  - **Medición de llamadas a ML** (techo shadow): `lib/medicionMl.js` + migración 106 `ml_llamadas_minuto`
    (minuto, recurso, reales, 429, sintéticas; 30 días). Enganchada en `mlFetch`, fail-open. Entra en vigor con
    el próximo reinicio del legado; los 7 días de medición cuentan desde ahí. `resumenMedicionMl` da p50/p95/p99.
    **Reinicio hecho 2026-09-16 15:58:30 UTC** (backup `/root/fusion-sqlite-backup-e1-20260916T155355Z.sqlite`):
    106 aplicada, webhooks ML entrando, medición escribiendo desde 15:59Z. La ventana de 7 días cierra el 2026-09-23 16:00 UTC.
  - **C9 (arnés contractual)**: `scripts/qa/c9/correr-c9.sh` corre E1-LAT-01 (A copia apagada, B encendida, C
    encendida + PostgreSQL detenido) y la parte de importación de E1-PGDOWN-01, con webhooks anonimizados de los
    recibos reales de 7 días (`anonimizar.mjs`, base de producción en solo lectura). Legado de prueba aislado:
    `env -i`, cwd en `/root/e1-c9/<ts>` (no carga el `.env` real), `LISTEN_HOST=127.0.0.1`, crons apagados,
    `ML_API_BASE` inalcanzable; aborta si la carga supera 1,6 o producción no responde. Sin `NODE_ENV=production`:
    en ese modo el legado exige push FCM y no arranca.
  - **C10 — plataforma en producción, etapa 1 (2026-09-17 ~04:00 UTC), sin copia de sombra**:
    base `plataforma` y roles en el PostgreSQL de E0 (`alta-base.sql`), migraciones 0001–0008; api/worker/scheduler
    con `docker compose -f plataforma/deploy/compose.yml -p fusion-plataforma --env-file /opt/fusionbikes/plataforma-prod/plataforma.env`
    (red `fusion-pg_default`). Secretos y keyrings (`sobres`, `senales`, `gateway`, `registro.json`) en
    `/opt/fusionbikes/plataforma-prod/` (root 700; keyrings uid 1000, 400). Una sola cuenta: Woo (4 corrientes),
    transporte gateway `host.docker.internal:3001`. Legado con `GATEWAY_*` en `.env` (ML shadow RPM 0), reinicio
    03:58:34 UTC con backup `/root/fusion-sqlite-backup-e1-c10-*` y `.env` en `/root/env-backup-e1-c10-*`.
    `/opt/fusionbikes/estado-pg/` lo refresca `fusion-estado-pg-copia.timer` desde `backups/` (no montar `backups`).
    Canario de copia: `SOMBRA_CANALES=woo`, `SOMBRA_PORCENTAJE` determinístico por recurso; cada ampliación la aprueba José.
    Copia Woo al 1 % desde 2026-09-17 04:08 UTC; en 6 h entraron sólo 3 webhooks Woo (≈1 cada 2 h), así que José
    amplió directo al **50 % el 2026-09-17 10:38 UTC**. ML sigue fuera del canario hasta la cuota medida (23/09).
    **100 % el 2026-09-17 10:48 UTC** y prueba en vivo de **5 h por decisión de José** (no las 24 h de E1-SOAK-01,
    que queda sin cumplir): `scripts/qa/c10/soak.sh` como unidad `fusion-e1-c10-soak`, mide cada 5 min y aplica el
    aborto del SOP (copia a false + reinicio) ante alerta de cola/pérdidas/respuesta cortada, legado caído 15 min o
    plataforma no ok 30 min. Log y evidencia en `/root/e1-c10/<ts>/`. `DB_PATH` del `.env` es relativa: un script
    fuera del repo tiene que resolverla contra la raíz.
  - **C9 en verde (2026-09-17)**: 500 webhooks anonimizados × 3 corridas de 30 min. p95 A 63,5 / B 72,3 / C 50,1 ms;
    p99 148,5 / 143,1 / 107,8 ms; códigos idénticos (423 ML + 77 Woo, todos 200); con PostgreSQL detenido 10 min hubo
    124 pérdidas, 124 importadas y 124 eventos `shadow.loss_imported`. La corrida C se repitió con `C9_REUSAR` +
    `C9_CORRIDAS=C` porque la primera murió con la sesión; correr arneses largos como unidad `systemd-run`, no ligados
    a la sesión. Evidencia: `docs/superpowers/evidence/e1/2026-09-17-E1-LAT-PGDOWN-20260917T030620Z.md`.
  - **Defecto encontrado por C9 y corregido**: `crearPool` (plataforma) no escuchaba `error`; al reiniciar PostgreSQL
    una conexión ociosa muerta tiraba el proceso (API/worker/scheduler) por excepción no capturada, y las pérdidas
    nunca se importaban. Ahora el pool registra el mensaje y descarta la conexión (`test/pool.test.ts`).
  - **Puerto 3001 cerrado hacia afuera desde 2026-09-16** (antes respondía por IP sin Nginx): unidad
    `fusion-firewall-3001.service` → `/usr/local/sbin/fusion-firewall-3001.sh`, cadena `FUSION_3001` en
    iptables e ip6tables, sólo loopback y `172.16.0.0/12` (redes de Docker del VPS: 172.16.0-4.0/24).
    Verificado: Nginx 200, contenedor → `host.docker.internal:3001` 200, webhooks entrando. Sin ufw ni
    netfilter-persistent activos: la persistencia es esa unidad. Copia previa en `/root/firewall-backup-e1-*`.
  - **C6 (relectura por señal)**: `worker/senales.ts` + `reconciliacion/relectura.ts` (relectores por
    tópico) + `senales-cola.ts` (lease, backoff, dead letter). Los normalizadores de recurso se exportan
    desde los adaptadores y los usan barrido y relectura, para que la versión y la proyección coincidan.
    `persistirRecurso` recibe un `ContextoEscritura` con `runId` opcional y usa `coalesce` sobre
    `last_seen_run_id`: una relectura durante una vuelta completa no puede provocar una baja falsa.
    Inbox `source='signal_reread'` (0007). Mensajes adelantan `next_run_at` del barrido en vez de
    resolver el id. El bucle del worker ya no se superpone: barridos y después señales, una vuelta a la vez.
  - **C7 (bulk y missed_feeds)**: ítems por `/items/bulk` (elemento fallido = presente sin contenido, nunca
    baja). `reconciliacion/missed-feeds.ts` crea sólo señales `ml_missed_feed` con fingerprint `mf:<_id>`,
    cada 30 min con lock consultivo por cuenta. **Forma de respuesta de `missed_feeds` sin verificar por
    sonda**: falla cerrado con `FORMA_MISSED_FEEDS`; verificarla requiere autorización antes del canario.
    Gateway: `app_id`=`ML_CLIENT_ID`, `site_id`=`ML_SITE_ID` (nueva, en `.env.example`, aún no en `.env`).
  - **Lazo legado→plataforma conectado** (completa C2, que había dejado la cola sin enganchar):
    `lib/emisorSombra.js` traduce un recibo a señal (tópico E1 + id pelado + fingerprint `ev:<sha256>`) y
    la manda firmada a C3. `server.js` engancha `finish`/`close` antes de responder en los tres webhooks;
    un duplicado no se copia; fuera de E1 queda `excluded/unsupported_topic`. Encendido sólo con
    `SOMBRA_COPIA_ENABLED=true` + `SOMBRA_PLATAFORMA_URL` + `SOMBRA_KEYRING_FILE`; media configuración
    apaga la copia con log. **Con la copia apagada el recibo nace `shadow_status=NULL`**: C2 lo creaba
    `pending` siempre, y esas filas habrían quedado activas para siempre y fuera de la purga.
  - `woo_webhooks_estado` ya registra `topic`, `status`, `delivery_url`, `propio`, `visto_en` y
    `status_desde` de las entregas propias: la alerta de webhook caído lee esa tabla.
  - `integration_events` crece ~1.400 filas/día y **hoy no tiene purga**. La purga de 400 días de T3 es
    la primera retención sobre esa tabla y sólo alcanza filas con sombra terminal y trabajo legacy
    cerrado.
  - El contrato de T3 ya es exigible: doce IDs (`E1-RCP-01..02`, `E1-QUE-01`, `E1-SIG-01..02`,
    `E1-ACC-01`, `E1-GW-01..02`, `E1-RER-01`, `E1-MFD-01`, `E1-BLK-01`, `E1-SOAK-01`) en `test-e1.md`,
    y `gate-e1.mjs` conoce el tramo 3. `E1_TRAMO=3` falla a propósito hasta que existan los cortes.

## E0 re-aceptada (2026-09-15)

- Restauración real desde la copia subida por la Mac (E0-OFF-01): 1068 archivos verificados, verify OK,
  marca `mac-20260914T221129Z` restaurada, RTO 6 s, registro firmado
  `pg-registros/restore-mac-20260915T122312Z.json`. Clave de subida de `fusion-restore` borrada y entrada vacía.
- Cumplidas las cuatro condiciones de PM-177 → E0 `aceptada`. E1 tramo 1 puede ejecutarse según
  `docs/superpowers/plans/2026-09-15-e1-tramo1-fundacion.md`.
- rsync de la Mac con `-rt` omite `backup/fusion/latest` (enlace simbólico): pgBackRest no lo necesita.

- 2026-09-17 vigía de formato (`lib/vigiaPausado.js`, d90a0da): en `catalog_product_id`, producto→vacío o volver a un valor ya visto por ese ítem en 7 días se asienta con `revisado_por='vigia-auto'` y NO pausa ni cuenta para el umbral; producto nuevo sigue pausando. Desplegado 12:58:30 UTC durante la prueba C10 (reinicio planificado).

- 2026-09-17 canario Woo de C10 dado por cerrado por José (evidencia `docs/superpowers/evidence/e1/2026-09-17-E1-C10-canario-woo.md`); copia Woo queda al 100 %. E1-SOAK-01 dispensado por José (aprobó el comportamiento sin las 24 h). Pendiente: canario ML tras 23/09 16:00 UTC.
- 2026-09-17 rollback de la copia ensayado (15:18:30 apagar, 15:38:30 encender, healthz 200 en ambos); evidencia en el mismo archivo del canario Woo. T3 sólo espera el canario ML.
- 2026-09-17 decisiones de José para T4: firma Ed25519 con privada en keyring del VPS (0600) y pública en el repo; reporte diario 07:00 ART a `ALERTAS_EMAIL`; la campaña de 7 días arranca con ML en canario (después del 23/09). Clave B2 propia: pendiente de que José la cree (la de backups no se usa).
- 2026-09-17 16:38:30 UTC canario ML encendido al 100 % por José con tope provisorio `GATEWAY_ML_SHADOW_RPM=60` (medición 24 h: lecturas p99 66, máx 275, 0 429; cupo legado 425). Se recalcula al terminar la medición de 7 días (23/09). Monitor 24 h `fusion-e1-c10-soak-ml`: ante 429 baja el tope de a un escalón (60→45→30→20→10→0) sin apagar la copia (decisión de José).
- 2026-09-17 vigía: `routes/matcher.js` pide `date_created`; vacío→producto en publicación creada hace ≤ 48 h no pausa (`alta_reciente`). Desplegado 17:18:30 UTC.
- 2026-09-17 diseño de E1 T4 en `docs/superpowers/specs/2026-09-17-e1-tramo4-seguridad-reporte-design.md`: módulo `plataforma/src/informes/` (firma Ed25519, manifiesto, reporte, depósito B2, correo) llamado por el scheduler 07:00 ART; rutas de passkeys publicadas pero en 503 con `passkeys.real` apagado; B2 con reintento en disco e incidente a las 24 h; campaña de 7 días que reinicia ante un día con faltantes. Las tablas ya existen del T1: no hay migración de esquema.
- 2026-09-17 el diseño de E1 T4 se corrigió con la revisión externa de Codex (`evidence/e1/2026-09-17-E1-T4-revision-codex.md`): tabla `informes.entregas` con estados y lease, `security.webauthn_challenges`, firma JCS en un solo archivo, Object Lock **compliance** (revisa PM-172), `@simplewebauthn/server` ≥ 14.0.2 (ajusta PM-170), ventana del día calendario ART congelada, doble llave del interruptor de passkeys, segunda clave B2 de sólo lectura, vigilante del legado a las 09:00 ART y ampliación de E1-AUD-04/E1-REC-01/E1-WA-01.
- 2026-09-17 plan de E1 T4 en `docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md`: 16 tareas, una por commit; migraciones 0009 (`informes.entregas`) y 0010 (`security.webauthn_challenges` + `passkeys.real` en false). La tarea 16 (producción: buckets, credenciales B2, migraciones, campaña) requiere autorización explícita de José.
- 2026-09-17 el plan de E1 T4 se corrigió con la revisión externa del plan (`evidence/e1/2026-09-17-E1-T4-revision-plan-codex.md`): 17 tareas (0 a 16), tres migraciones (0009 entregas + CHECK de retención, 0010 desafíos WebAuthn, 0011 intentos de recuperación), dos estados independientes por entrega (depósito y aviso), retención calculada al subir y fuera del contenido firmado, `nodemailer` en la plataforma, incidentes abiertos por el legado, y helper de fixtures en `plataforma/test/soporte/`.
- 2026-09-18 incidente del canario ML: se encendió sin la cuenta en `SENALES_CUENTAS` ni en el registro del worker, así que la plataforma devolvió 409 a todo y el legado descartó 347 recibos; a las 21:40 UTC el monitor apagó la copia por `perdidas_sin_importar`. Corregido (cuenta sembrada + 6 corrientes, config completa, imagen reconstruida, copia reencendida 03:48:30 UTC). Código: razón `cuenta_no_configurada`, reimportación de esos descartes sin bloquear otros canales, la alerta durable la cuenta, y el monitor avisa por descartes en la ventana. Evidencia: `docs/superpowers/evidence/e1/2026-09-18-E1-C10-incidente-canario-ml.md`. **Encender un canal son tres piezas en dos sistemas, no un flag.**
- 2026-09-18 E1 T4 implementado en código en `feature/e1-t4-continuacion` (worktree `/opt/fusionbikes/worktrees/e1-t4-continuacion`), tareas 0–15; ledger en `.superpowers/sdd/2026-09-17-e1-tramo4-seguridad-reporte/progress.md`. Invariantes que no se aflojan: (1) antes de cada PUT a B2 se consulta HEAD + retención de esa versión y sólo se adopta lo que ya está si el `x-amz-meta-sha256` y la retención coinciden; nunca se pisa otro contenido; (2) el reporte congela el estado de señales y barridos al corte de las 06:00 ART del día siguiente, así rearmar un día da el mismo hash; (3) la campaña cuenta sólo días verdes (PM-186); (4) el permiso de entrega usa el reloj real y `ahora` es obligatorio en `entregas.ts` (red de tipos con `@ts-expect-error`); (5) passkeys detrás de doble llave (`passkeys.real` + `PASSKEYS_HABILITADAS=1`), con 503 en todas las rutas del plugin. Decisiones nuevas PM-184 (compliance), PM-185 (simplewebauthn 14.0.2), PM-186 (campaña). El vigilante del legado nace apagado (`VIGILANTE_INFORMES_ENABLED=true` en la tarea 16). La plataforma usa nodemailer 9.1.1; el legado sigue en 9.0.3 con avisos altos (tarea sugerida aparte). Pendiente: tarea 16 con autorización de José, e integrar la rama.
- 2026-09-18 T4 completo y unido en `conteo-confiable` (merge `d6a06e1`): las tareas 7 a 15 venían de `feature/e1-t4-continuacion`. La revisión final de Codex encontró 1 crítico y 5 altos, los seis corregidos (`b761ea6`, `7c71975`, `4944ad5`, `5059f5e`, `c2a41cf`, `2c6ea7c`); detalle en `evidence/e1/2026-09-18-E1-C10-incidente-canario-ml.md`. Invariantes nuevos: la fila canónica se repara si falta, el timeout de B2 no puede sobrevivir al permiso de entrega, todo secreto pasa por `plataforma/src/seguridad/secreto.ts`, el scheduler no arranca si la pública no es pareja de la privada, y el email lleva `Message-ID` estable. Verificado: 261 tests de plataforma y 2.706 del legado en verde.
- 2026-09-18 el gate de escenarios (`scripts/qa/gate-e1.mjs`) exige SUBCASOS nombrados por escenario en el tramo 4, no una cantidad mínima de pruebas: contar dejaba pasar variantes del mismo camino feliz. Al faltar uno, el gate lo nombra. Los tests de B2/email de `vuelta.test.ts` llevan `E1-REC-01` porque el contrato los nombra.
- 2026-09-18 tarea 16 de T4 a mitad de camino (`evidence/e1/2026-09-18-E1-T4-tarea16-avance.md`): buckets B2 con Object Lock y SSE-B2, dos credenciales acotadas sin borrado, clave de firma `e1-2026-09` generada en el VPS con su pública commiteada. La verificación contra B2 REAL encontró dos cosas que el simulador no podía: (1) B2 exige `Content-MD5` en toda subida con Object Lock, sin eso el primer informe fallaba; (2) la credencial de escritura puede OCULTAR un objeto (en B2 escribir incluye ocultar): no lo destruye, pero un GET sin versión da 404. Decisión: hacerlo detectable (migración 0012 `oculto_en`, la vuelta marca, la ruta interna expone). **Falta**: que el vigilante del legado alerte por ocultos, configurar el scheduler y sus montajes, aplicar 0009-0012, email real y campaña de 7 días. La clave maestra de B2 conviene rotarla.
- 2026-09-18 12:29 UTC: **informes de E1 encendidos en producción**. Primera vuelta del 2026-09-17: manifiesto y reporte subidos a `bucket-produccion` (compliance hasta 2027-09-20), email enviado, firma verificada con `npm run verificar-informe` sobre los objetos bajados de B2. Reporte amarillo (sin barrido de `ml.shipments` el día del incidente). **Los secretos que lee node tienen que ser de uid 1000 (0400), no de root**: el entrypoint baja a node con gosu; el diseño decía root y el arranque falló con EACCES. Vigilante del legado encendido (`VIGILANTE_INFORMES_ENABLED=true`).
- 2026-09-18 precios en ML: en el modelo viejo de variaciones, una cuenta sin Mercado Envíos 1 NO puede tener precios distintos entre variaciones (ML: "Found different prices in variations | User has not mode me1"), y cambiarlas de a una también falla. La herramienta de precios agrupa por publicación y aplica el MÁS ALTO de los calculados (decisión de José) con `POST /api/precios/actualizar-precio-item`, un solo PUT con todas las variaciones. Las publicaciones del modelo nuevo (con `user_product_id`) son ítems separados y sí pueden tener precio propio. Pendiente: investigar migrar las viejas al modelo nuevo.
- 2026-09-18 la API de la plataforma contrasta al arrancar `SENALES_CUENTAS` contra el registro del worker (`SENALES_REGISTRO_FILE`, NO `BARRIDOS_REGISTRO_FILE`, que activa la config de barridos y tira la API). Si no coinciden, no arranca y dice qué falta: es el incidente del canario de ML detectado antes de pasar. **Antes de desplegar un cambio de arranque, probarlo en un contenedor aparte** (`docker compose run --rm --no-deps -T api`): el primer intento tiró la API ~1 min.
- 2026-09-18 E2 arrancó por el diseño del tramo 1 (`docs/superpowers/specs/2026-09-18-e2-tramo1-modelos-variantes-design.md`). Decisiones de José: tres tramos por valor; releer Woo/ML desde el origen **proyectando desde el inbox de E1** (una sola lectura); una barrida completa de `ml.items` una vez; variante = lo que se publica en algún canal, con SKU pendiente + caso si no tiene (el SKU es obligatorio para cerrar el caso, no para existir, e inmutable una vez puesto); decisiones del matcher como evidencia auditada; "omitir" entra como omitida con caso de baja prioridad; cada publicación de ML guarda si es del modelo viejo o `user_product`.
- 2026-09-18 diseño de E2 T1 corregido con la revisión externa (`evidence/e2/2026-09-18-E2-T1-revision-codex.md`). **El inbox de E1 NO es un snapshot**: es cola de un solo consumidor, sólo encola cambios, Woo full scan lee sólo ids y el payload vence a 90 días. Por eso: fan-out de E1 a E2 en la misma transacción + bootstrap forzado una vez (Woo completo; ML ~70 páginas de scan + ~350 multigets, por el gateway del legado, con checkpoint por página y multigets en serie). Matcher: copia consistente + eventos firmados del legado + conciliación diaria, con vigencia por decisión. Fusión explícita de variante pendiente cuando el SKU ya existe. SKU observado de Woo vs canónico `FB-{ID_WOO}`.
- 2026-09-18 plan de E2 T1 (`plans/2026-09-18-e2-tramo1-modelos-variantes.md`, 14 tareas) cerrado tras **dos** revisiones externas: 26 hallazgos (`evidence/e2/2026-09-18-E2-T1-revision-plan-codex.md`) y 4 más (`...-revision-plan-v2-codex.md`). Decisiones de José: una cuenta por canal pero **toda clave natural lleva `channel_account_id`**; las escrituras automáticas del matcher entran como decisiones del sistema con motivo; proyector con canario de 100 y revisión; bootstrap de ML a 10 lecturas/min (se sube de madrugada si no termina); los casos de identidad del legado se importan igual que el matcher (copia + eventos); los casos se ven en el reporte diario firmado. Orden de producción, que las dos revisiones corrigieron: gate de E1 → ensayo de la migración → backup → migración apagada → **captura de eventos en outbox con el despachador apagado** → copia consistente con su corte → despachar → proyector con canario → bootstrap → 7 días de conciliación. Capturar antes de copiar es lo que cierra la ventana de pérdida.
- 2026-09-18 E2 T1 tarea 1 (`e1cf72e`): migración `0013_catalogo.sql` con el esquema `catalog` (modelos, variantes vendibles, representaciones, decisiones del matcher, casos de identidad, `bootstrap_runs` como checkpoint durable y `copias`/`copias_lotes` como staging). Lo que la base hace cumplir sola: SKU `FB-{ID_WOO}` único **por empresa** e inmutable por trigger una vez puesto (resolver un pendiente sí se permite); `variacion_normalizada` NOT NULL DEFAULT `''` porque un UNIQUE con NULL deja pasar duplicados; un `contenedor` cuelga de un modelo y nunca de una variante (restricción `..._colgadura_check`, porque PostgreSQL ya usa `..._tipo_check` para el CHECK inline de la columna); una sola decisión vigente por clave; un caso abierto por objeto y tipo; la app sin DELETE (una baja es `archivado_en` con motivo). **`integrations.inbox_messages.source` admite `signal_reread` y tiene 1.230 filas con ese valor en producción**: el CHECK ampliado lo conserva, y la migración valida las filas existentes contra el CHECK nuevo antes de tocarlo, con `lock_timeout` de 5 s. Los tipos de TS se amplían en el mismo commit o no compila. 16 casos verificados por mutación.
- 2026-09-18 reencolado de señales de ML: el UPDATE masivo para revivir muertas **falla entero** por `reconciliation_signals_un_activa` (una sola señal activa por recurso) si hay una fila activa y otra muerta del mismo recurso, o dos muertas del mismo recurso. Hay que filtrar con `NOT EXISTS` (activa del mismo recurso) **y** `DISTINCT ON (channel_account_id, topic, resource_id)` para revivir una sola. Sin eso, psql aborta la transacción y no cambia nada, lo que se confunde fácil con "el reintento no funciona". El backoff sí existe y es exponencial (`senales-cola.ts`: 10 s × 2^intento, tope 900 s, `available_at`); espaciar a mano se hace escribiendo `available_at`.
- 2026-09-19/20 **forma repetible de reencolar señales muertas** (no desplegado ni corrido contra producción): `plataforma/src/reconciliacion/revivir-senales.ts` (`revivirSenalesMuertas`, la lógica testeable) + `scripts/revivir-senales.mjs` (CLI, junto a `catalogo-copia.mjs` en la raíz del legado, no en `plataforma/scripts/`). Aplica el `NOT EXISTS` + `DISTINCT ON` de arriba, resetea `attempts`/`error_detail`/`finished_at`/lease a `pending`, y escalona `available_at` con `--rpm` (default 10, tope defensivo 60 porque cada señal revivida termina en una llamada al canal — no existe ninguna variable de entorno tipo `GATEWAY_ML_SHADOW_RPM` para esto, se verificó contra el esquema zod de `comun/config.ts` y no está; es un parámetro manual a propósito, porque revivir señales es una operación puntual que un operador corre mirando). `--dry-run` por defecto; escribir exige `--ejecutar` explícito. Conexión igual que `cli-migrar.ts`: lee `PG_HOST/PG_PORT/PG_DATABASE/PG_USER/PG_PASSWORD(_FILE)` de `process.env` ya poblado, nunca abre `plataforma.env`. 5 tests en `plataforma/test/reconciliacion/revivir-senales.test.ts` cubren la trampa (dos muertas del mismo recurso → revive una sola; recurso con activa → no la toca; dry-run no escribe; escalonado de `available_at`; filtra por causa) — **verificado que fallan** (2 de 5) si se saca el `DISTINCT ON`/`NOT EXISTS`. Typecheck limpio. Pendiente: correrlo contra producción con José/opt-d2 (candidatas esperadas al momento del diseño: 43 filas, 31 recursos distintos, causa `%PaginaInvalida%` de `ml.orders`, arreglada en `5543f91`).
- 2026-09-20 **`revivir-senales`: agregado `--topic` (opcional), implementado y testeado, no corrido contra producción.** Hallazgo de uso real que lo motivó: tras la corrida de anoche (31 revividas, 27 `succeeded`) quedaron 227 muertas por 429 en 5 tópicos (`ml.items` 194, `ml.shipments` 16, `ml.orders` 14, `ml.questions` 2, `ml.claims` 1) y no había forma de acotar a un solo tópico — el orden es `channel_account_id, topic, resource_id, id`, así que `--limite` se agotaba en tópicos anteriores alfabéticamente antes de llegar al deseado. `RevivirOpciones.topic?: string` arma el predicado `AND s.topic = $2` sólo si viene, y reordena `LIMIT` a `$3` (antes `$2`) para que siga último — sin `--topic` la query y el comportamiento son bit a bit los de antes (los 5 tests viejos siguen pasando sin tocarlos). El `NOT EXISTS` no se tocó a propósito: sigue mirando si el recurso tiene una señal activa en su propio tópico, independiente de qué subconjunto se esté reviviendo — acotar por tópico no lo vuelve redundante. Validación por **lista cerrada** de los 7 tópicos reales (`ml.items`, `ml.orders`, `ml.shipments`, `ml.questions`, `ml.claims`, `woo.products`, `woo.orders`), no aviso ante 0 candidatas: un tópico mal escrito falla alto y explícito en vez de devolver 0 en silencio y parecer "no hay nada que revivir". De paso, corregido el `process.exit(0)` que saltaba el `finally` con `pool.end()` (ahora un `codigoSalida` y un solo `process.exit` después del `finally`). 3 tests nuevos en `plataforma/test/reconciliacion/revivir-senales.test.ts` (con `--topic` revive sólo ese tópico; sin `--topic` sigue reviviendo de todos los que matcheen la causa; el `NOT EXISTS` sigue protegiendo con el filtro puesto) — **verificado que el primero falla** si se saca el filtro de tópico (8/8 con el fix, 7/8 sin él). Typecheck limpio. Sigue sin correrse `--ejecutar` contra producción: lo decide José.
- 2026-09-18 E2 T1 tareas 2 a 5 (`b1f4cf5`, `125afad`, `7b26a2e`). Cola: `reclamar` del inbox devuelve cuenta, recurso, versión remota y el sobre (las cuatro partes o `null`); `completarEnTx(tx, reclamo)` cierra el mensaje dentro de la transacción del consumidor. **Un lease vencido no vuelve a la cola con `reclamar`**: queda `claimed` hasta `liberarVencidos`. Configuración `CATALOGO_*` con keyring propio (`planDeKeyrings` en `src/catalogo/arranque.ts`), todo apagado por omisión. Proyecciones puras en `src/catalogo/{woo,ml,intenciones}.ts`: SKU observado con cuatro estados (`canonico`, `vacio`, `otro`, `no_informado`); en ML la ausencia es `no_informado` porque **el multiget no trae SELLER_SKU de las variaciones**. **`user_product_id` de ML identifica la variante, no la familia** (todas las filas de `ml_publicaciones_cache` lo tienen, cada variación del modelo viejo el suyo, y dos publicaciones pueden compartirlo): decisión de José, es pista de variante y la divergencia abre caso `user_product_divergente`; nunca se fusiona sola. El diseño §5.2 quedó corregido.
- 2026-09-18 **el tope de la sombra de ML estuvo en 0 desde las 20:09 UTC**: el monitor del canario bajaba un escalón por cada 429 real suelto (hubo 5 en todo el día sobre ~1.500 lecturas/h) y el mismo 429 contaba en dos mediciones seguidas (ventana de 6 min medida cada 5). Con el tope en 0 ninguna relectura de ML era posible: murieron las señales y los barridos de ML no convergieron (el reporte del 18 va a salir amarillo). Arreglo (`727284b`, decidido con José): baja sólo con ≥3 429 reales en la ventana, piso de 10 rpm, 30 min entre bajadas. Tope vuelto a **30 rpm** a las 23:24 UTC (backup `/root/env-backup-tope-sombra-20260918T232446Z`, legado reiniciado con OK de José); monitor relanzado como `fusion-e1-c10-soak-ml4` (23 h). 182 señales muertas por 429 reencoladas. **Antes de diagnosticar 429 de la sombra, leer `GATEWAY_ML_SHADOW_RPM` del `.env`**: el valor lo cambia el monitor solo.
- 2026-09-18 E2 T1 tarea 6 (`a1fea7e`): proyector del catálogo (`src/catalogo/{aplicar,proyector}.ts`, ciclo en `src/worker/catalogo.ts`, apagado por omisión). Invariantes: una transacción por mensaje; versión remota vieja no pisa; FB-{ID_WOO} sólo si nadie más lo tiene ni lo muestra; ML se vincula por la decisión vigente del matcher; **una publicación ya vinculada no se re-vincula en el proyector** (fusión y revocación son de la tarea 8); omitida = vendible sin variante (la migración 0013 lo admite); payload vencido → señal `payload_expired`; rechazo → DLQ con causa. Canario y umbral de error detienen y dejan evento `catalogo.proyector_detenido` en la auditoría (la plataforma no tiene tabla de incidentes; el aviso va al reporte en la tarea 13). Suite de plataforma 348/348.
- 2026-09-18 E2 T1 tarea 7 (`1403873`): copias en tandas y API interna del catálogo (`src/catalogo/copias.ts`, `src/api/catalogo-interna.ts`, rutas `/internal/v1/catalogo/{copias,copias/:id/lotes,copias/:id/confirmar,eventos}`, misma firma y nonces que señales, registradas junto a señales). Hash de la copia = SHA-256 de `canonizar` (JCS) de las filas ordenadas por `recurso\0variacion`: el legado tiene que calcularlo igual. **Regla del corte**: una decisión por evento con `vigente_desde` posterior al corte de la copia no la toca la copia. Eventos deduplicados por `evento_id` en `catalog.eventos_recibidos`. **Las rutas que escriben en una transacción envían la respuesta después del COMMIT** (el primer borrador respondía adentro y el legado recibía "confirmada" antes de estar escrita). Suite de plataforma 374/374.
- 2026-09-18 E2 T1 tarea 8 (`823386b`): `src/catalogo/decisiones.ts` reconcilia el vínculo de cada publicación de ML con la decisión vigente (en eventos, copias confirmadas y cuando Woo asigna el SKU esperado); la pendiente que queda sin publicaciones se archiva "fusionada en …", **una variante con SKU nunca se archiva por esto**. **Candado de decisiones por cuenta** (`bloquearDecisiones`, advisory lock de transacción): lo toman eventos, copias, el proyector al vincular ML y la reconciliación por SKU, **siempre antes de bloquear filas** (el orden inverso daba deadlock). Por cuenta y no por clave: una copia de 7.000 filas agotaría la tabla de locks. Suite de plataforma 385/385.
- 2026-09-19 E2 T1 tarea 9 (`57561c4`): outbox del legado (`migrations/108_outbox_plataforma.sql`, `lib/outboxPlataforma.js`, cableado en `server.js`). Dos interruptores apagados: `OUTBOX_PLATAFORMA_CAPTURA=true` (escribe el evento en la transacción del cambio) y `OUTBOX_PLATAFORMA_ENVIO=true` (despachador cada 10 s, lote 50). **Firma con el keyring de la sombra** (`SOMBRA_PLATAFORMA_URL` + `SOMBRA_KEYRING_FILE`): no hay secreto nuevo. Corta la vuelta ante el primer fallo transitorio para preservar el orden; 400 = rechazado sin reintento; alerta por incidente (`outbox_atrasada` >30 min, `outbox_rechazada`). **Toda tabla nueva del legado exige**: agregarla a `test/db.test.js` y clasificar sus columnas JSON/payload en `scripts/qa/snapshot-anonimizado.mjs` (si no, fallan esos dos tests). **Esta migración (108) se aplica en el próximo arranque del legado**: el deploy de E2 T1 trae un reinicio del legado.
- 2026-09-19 **E2 T1: código completo (tareas 1 a 13), sin desplegar.** Gate propio `npm run test:e2` (`scripts/qa/gate-e2.mjs`): 16 IDs y 27 escenarios contractuales con nombre. Suites al cierre: plataforma 408/408, legado 2.747 en verde. Piezas nuevas: tarea 10 por **triggers de SQLite** en `sku_matcher_decisiones` e `identidad_casos` (migración 108) en vez de una función única (había 14 y ~20 escritores); interruptor de captura en la tabla `outbox_config`; eventos de identidad por `/internal/v1/catalogo/eventos-identidad`. Tarea 11: `lib/catalogoCopia.js`, `scripts/catalogo-copia.mjs` (copia inicial) y copia diaria 03:30 ART (`CATALOGO_COPIA_DIARIA=true`) que ES la conciliación (incidentes `divergencia` y `copia_fallida`); el JSON canónico del legado tiene contrato de hash con la plataforma. Tarea 12: bootstrap (`src/catalogo/bootstrap.ts`), una página por vuelta con checkpoint en la misma transacción, ritmo por minuto, cede ante señales de ML o 429. Tarea 13: `GET /api/v2/catalog/{models,variants,reconciliation}` (`catalog.read`) y sección `catalogo` del reporte diario firmado armada **al corte** (no toca el semáforo de E1). **El OpenAPI no era válido y nadie lo validaba** (sólo se dereferenciaba): ahora un test valida el documento entero. **Pendiente: tarea 14 (puesta en producción) con autorización de José**; incluye reiniciar el legado (migración 108) y reconstruir la imagen de la plataforma (migración 0013).
- 2026-09-19 revisión de Codex de la implementación de E2 T1: 1 crítico, 5 altos, 1 medio, los siete corregidos en `6db40eb` (evidencia `evidence/e2/2026-09-19-E2-T1-revision-implementacion-codex.md`). Invariantes nuevos: **candado por recurso** al aplicar una proyección (orden recurso → representación → decisiones → variantes); **la copia no se manda si hay filas intraducibles** (su ausencia cerraría decisiones válidas); `identidad_legado` único **por caso del legado**; el umbral de error del proyector se mide sobre los últimos 50 mensajes con mínimo 10 y cuenta rechazos; el proyector reclama de a un mensaje; el bootstrap renueva su lease en cada llamada al canal. Suites: plataforma 413/413, legado 2.749.
- 2026-09-19 **E2 T1 tarea 14 paso 3: plataforma desplegada en producción, catálogo apagado.** Imagen `fusion-plataforma:local` reconstruida desde `c86e116` (la `:e2t1` de las 01:10 **no** tenía `5543f91` ni `fb90ec0`: nunca desplegar una imagen construida antes de los últimos commits). Migración `0013_catalogo.sql` aplicada en **2,8 s** sin bloqueos; 13 migraciones, 9 tablas en `catalog`, `plataforma_app` con SELECT/INSERT/UPDATE y **sin DELETE**. api, worker y scheduler recreados: health `ok` en los cuatro componentes, `cuentas=2 corrientes=10`, **cero menciones al catálogo y cero errores/warnings** en los logs, `/api/v2/catalog/models` responde **401** sin credencial. **El catálogo apagado es el estado por omisión y es fail-safe**: `leerCatalogo` (`comun/config.ts:126`) devuelve `undefined` si no están `CATALOGO_PROYECTOR=1`/`CATALOGO_BOOTSTRAP=1`, los ciclos quedan en `null` (`worker/main.ts:83,91`) y encender exige además `CATALOGO_KEYRING_FILE` o el arranque falla. No se tocó `plataforma.env`. **La tabla de migraciones es `core.schema_migrations` y su columna es `nombre`** (no `schema_migrations`/`version`); las columnas de estado de las señales son `status` y `error_detail` (no `estado`/`last_error`); los volúmenes viven en `plataforma-prod/secretos/` (no `secrets/`). Señales al cierre: 2.114 exitosas, 5 reintentables, 231 muertas (188 `HTTP_429` + 43 `ErrorPaginaInvalida` de `ml.orders`, **todas anteriores a las 20:24**; ninguna murió después del despliegue de las 22:35). **Dos contenedores `fusion-plataforma-api-run-*` quedaron huérfanos 25 h** de un `compose run` del 18: sin puerto publicado y sin actividad, pero conviene borrarlos (el `docker rm -f` lo bloquea el clasificador). **Pendiente: pasos 4 a 9** (reinicio del legado con la migración 108 y `OUTBOX_PLATAFORMA_CAPTURA=true`, copia inicial, despachador, proyector con canario, bootstrap, 7 días de conciliación).
- 2026-09-19 **E2 T1 tarea 14 paso 4: legado reiniciado con la captura de la outbox encendida** (22:46 UTC, con OK de José para hacerlo "ahora" fuera de la ventana `:x8:30`). Backups previos: `/root/env-backup-antes-outbox-20260919T223940Z` y `/root/fusion-20260919-223955-predeploy.sqlite.gz` (24 MB, `quick_check: ok`, 5.207 decisiones, 1.347 casos). Al `.env` se agregaron **sólo** `OUTBOX_PLATAFORMA_CAPTURA=true` y `OUTBOX_PLATAFORMA_ENVIO=false`. Verificado tras el reinicio: `healthz` `{"ok":true,"integridad":"ok"}`, marcador `outbox_plataforma_108`, 5 triggers, `outbox_config.captura='true'` y el log dice "captura de cambios del matcher y de identidad encendida" **sin una sola línea del despachador**. Ensayo previo de la 108 sobre una copia real: **80 ms**, 2 tablas, 5 triggers, `outbox_config` nace en `'false'` y **la variable de entorno la sincroniza en el arranque** (`sincronizarCaptura(db, env)` — su segundo parámetro es **el entorno, no un booleano**); un UPDATE que no cambia nada **no** encola, y un cambio real de `accion` encoló un `matcher.decision` con clave, acción y origen. **La columna de estado de `sku_matcher_decisiones` es `accion`** (no `estado`), y el CHECK de `outbox_plataforma.tipo` sólo admite `matcher.decision` e `identidad.caso`. **No hay `sqlite3` en el host: la base se consulta con `better-sqlite3` desde Node.** Outbox en 0 eventos al cierre, que es lo correcto sin actividad de matcheo.
- 2026-09-19 **HALLAZGO DE SEGURIDAD, ajeno a E2: las líneas 68-69 del `.env` del legado son `Master-Key-ID` y `Master-Key-Backblaze` en texto plano.** Los guiones las hacen inválidas como variable de shell, así que lo que hace `source .env` intenta ejecutarlas, falla con "command not found" **y vuelca el valor de la clave al log de errores de PM2**. `grep` confirma que **ningún código las usa**: son dos líneas pegadas a mano. Hay que rotar la clave maestra de B2 (ya estaba pendiente), borrar esas dos líneas y purgar los logs de PM2 que las contienen. No se tocaron en este despliegue.
- 2026-09-19 **purga del secreto de B2 filtrado a logs** (pedido de José; la rotación de la clave la hace él cuando quiera). Alcance real medido antes de tocar nada: **14 líneas en `/root/.pm2/logs/herramientas-error.log`** (el `out.log` y journald limpios, sin logs rotados) más **6 archivos en `/root/.vscode-server`**: 4 snapshots del historial de ediciones del `.env` y **2 logs de la extensión de Claude Code**. Todos eran `600 root:root`, así que la exposición nueva era el log de PM2, donde la clave aparecía como texto de un "command not found". Purga **in situ con `sed`** (nunca `truncate` ni borrado: PM2 tiene el descriptor abierto y se pierde el resto del log): las 17.145 líneas del error.log se conservan con 14 marcas `[purgado 2026-09-19]`, y en `.vscode-server` queda el nombre de la variable pero **ningún valor de 12+ caracteres**. Respaldo del log previo a la purga en `/root/pm2-error-antes-purga-20260919T225541Z.log.gz` (600, **contiene el secreto**). **El valor sigue existiendo en 7 lugares que son copias legítimas del `.env`** (`/root/env-backup-*`, `/root/e1-c10/*/env-antes-*` y el transcripto de la sesión): no se borran porque son la red de seguridad de José, y su limpieza depende de la rotación. `docs/memory/active.md` menciona el nombre de la clave, nunca el valor. **Lección: un nombre de variable con guiones en el `.env` no es sólo inválido, se ejecuta y su valor termina en el log de errores.**
- 2026-09-19 contenedores huérfanos `fusion-plataforma-api-run-*` (25 h, de un `compose run` del 18) borrados con `docker rm -f`. Quedan sólo api, worker y scheduler; health de la plataforma `ok` en los cuatro componentes y `healthz` del legado `ok` después de la limpieza. **Un `docker compose run` sin `--rm` deja el contenedor vivo indefinidamente**: usar siempre `--rm` para ensayos.
- 2026-09-19 **E2 T1 tarea 14, pasos 5, 6 y 9 hechos y verificados.** **Paso 5 (copia inicial)**: `node scripts/catalogo-copia.mjs` en **12,7 s**, corte `2026-09-19T23:09:46.492Z`, **0 filas inválidas**, las dos copias `confirmada`. Matcher: 5.207 filas, 5.207 abiertas, y el desglose en la plataforma coincide exacto con el legado (omitir 2.376 / confirmar 1.778 / asignar 1.053). Identidad: **sólo 14 filas de 1.347 y las 14 `sinRepresentacion`**, y las dos cosas son correctas — `ESTADOS_ABIERTOS` descarta los 1.333 `resuelto`/`verificado` (no hay nada que atender), y un caso se cuelga de una representación que todavía no existe porque el proyector y el bootstrap no corrieron: se materializan después. **Paso 6 (despachador)**: `OUTBOX_PLATAFORMA_ENVIO=true`, legado reiniciado, log "despachador encendido: cada 10000 ms, lote 50", `healthz` ok. **Paso 9 (conciliación)**: `CATALOGO_COPIA_DIARIA=true`; `msHastaProximaCopia()` verificada → **03:30 ART exacto**. Las tres variables confirmadas en `/proc/<pid>/environ`. **Camino end-to-end probado con un evento real**: viajó firmado del legado, la plataforma lo aceptó y quedó en `catalog.eventos_recibidos`. Aprendido de la API: **`traducirEvento` recibe el `payload` como objeto ya parseado, no como JSON string**; la plataforma rechaza con `evento_invalido` un payload con clave inventada (la validación es real); y `crearEnvioEventoCatalogo` devuelve `undefined` cuando acepta. Backups: `/root/env-backup-antes-envio-20260919T231149Z`, `/root/env-backup-antes-copiadiaria-20260919T231618Z`, `/root/plataformaenv-backup-antes-proyector-20260919T231447Z`.
- 2026-09-19 **`grep` está roto en este entorno**: devuelve vacío incluso con `grep -c "" archivo` sobre un archivo legible, lo que hace parecer que un patrón no existe cuando sí está. Usar **`sed -n '/patron/p'`** (o `sed -n '/patron/Ip'` para ignorar mayúsculas). Me hizo concluir dos veces que un código no existía.
- 2026-09-19 **el keyring del catálogo es el mismo `sobres.json` de los barridos**, no un secreto nuevo: `CATALOGO_KEYRING_FILE` abre los sobres de los mensajes del inbox, igual que `BARRIDOS_KEYRING_FILE`. Dentro del contenedor la ruta es `/run/fusion-keyring/sobres.json`.
- 2026-09-19 incidente operativo preexistente y **activo**: disco del VPS al **81 %** (19 GB libres), incidente `backup|postgres|capacidad_disco` id 38. Alcanza para el bootstrap, pero conviene liberar: hay 2 dumps de PostgreSQL en `/root` (89 MB + 69 MB) y dos imágenes `fusion-plataforma` viejas (`:e2t1`, `:prueba-e2t3`, 374 MB cada una) recuperables.
- 2026-09-19 **E2 T1 tarea 14 paso 7: proyector encendido con canario de 100, y pasó la revisión.** 5 vueltas de 20 en 8 s: **100 aplicados, 0 rechazados, 0 errores, 0 vencidos**, y se detuvo solo con "canario de 100 completo: revisar antes de seguir". Resultado revisado: **28 modelos, 90 variantes, 100 representaciones** (10 `contenedor` de Woo con `sku_observado` null — el SKU vive en las variaciones — y 90 `vendible`), SKU en formato canónico `FB-{ID_WOO}`, 89 variantes con SKU y 1 pendiente. Invariantes verificados en producción: los 10 contenedores tienen `model_id` y **cero `variant_id`** (`colgadura_check` respetada), los 90 vendibles tienen ambos, **0 mensajes en DLQ y 0 fallidos** (100 `succeeded`, 6.674 `pending`). **Se abrió 1 caso `woo_sku_no_canonico` con `observado: FB-65875`**: es el mismo caso real del ensayo del paso 1 (el producto 65940 tiene cargado el SKU de otro), detectado solo por el sistema en producción.
- 2026-09-19 **HUECO REAL DE LA ENTREGA E2 T1, corregido en `b9851e3`: `compose.yml` nunca declaró las variables `CATALOGO_*`.** El worker arrancaba sano pero no proyectaba nada (6.768 pendientes intactos, ningún log del ciclo) porque **el compose sólo pasa al contenedor las variables que declara explícitamente**: ponerlas en `plataforma.env` no alcanza, y el catálogo era inencendible en producción pese a estar implementado y testeado. **Regla: una variable nueva de un servicio no existe hasta que está en el bloque `environment` de su servicio en `compose.yml`.** Al agregarlas apareció un segundo fallo: **Docker Compose interpola `${VAR}` de una variable inexistente como cadena VACÍA y la pasa igual**, y contra `z.string().min(1).optional()` eso es "inválida", no "ausente" — el worker moría con `configuración inválida o incompleta: CATALOGO_BOOTSTRAP` por un flag apagado. Arreglado en `cargarConfig`, que ahora normaliza el entorno (`sinVacias`): **una variable vacía es una variable ausente**. Protege también a `BARRIDOS_*`, `SENALES_*` e `INFORMES_*`, que comparten la forma del esquema y tenían el mismo riesgo latente. Cubierto por `E2-CFG-07` (4 casos, 17/17 en `test/catalogo/config.test.ts`). **Los dos fallos se atraparon en un contenedor descartable con `run --rm`, no en producción**: la regla de probar el arranque aparte funcionó.
- 2026-09-19 **E2 T1 tarea 14 paso 8: bootstrap encendido y drenando.** Antes hubo que corregir un defecto real (`c9ea2cd`): el bootstrap de Woo pedía `/products?orderby=id` y el gateway lo rechazaba **antes de red** con "ruta sin operación de gateway: valor de dates_are_gmt", porque `woo.products.list` —la única operación que devuelve el producto completo— exige `modified_after`/`modified_before`, `dates_are_gmt=true` y `orderby=modified` (la que barre por id, `woo.presence.list`, trae `_fields=id` y no sirve para proyectar). Ahora el barrido completo se pide como ventana epoch→2100; **las fechas llevan `Z` porque el patrón ISO del legado la exige**. La ruta de variaciones ya era correcta. Test `E2-BOOT-CONTRATO`: cruza las rutas que el bootstrap realmente pide con `rutaAOperacion`, el traductor de verdad — los casos previos usaban transporte falso y por eso el desajuste llegó a producción; **verificado que el test falla con el código viejo**. 13/13. **Estado tras encender**: proyector drenó **todo** el catálogo (0 pendientes de `woo.products`/`ml.items`), bootstrap de Woo en página 4, 588 encolados, y el catálogo en **2.044 modelos, 4.129 variantes, 6.405 representaciones, 2.191 casos**. Los 2.191 casos son trabajo legítimo, no fallas: `omitida_revisar` 1.189 (prioridad baja), `sku_pendiente` 535, `sku_inexistente_en_woo` 291, `user_product_divergente` 116, `woo_sku_no_canonico` 55, `woo_sin_sku` 5. **1 solo mensaje en DLQ** sobre 5.626, y por causa correcta: el producto 69528 está en la papelera de Woo, el proyector lo archivó ("en la papelera de Woo") y rechazó un `sweep` posterior que quería reproyectar un recurso archivado — protege el archivo en vez de revivir un borrado. 30 más archivados por "cerrado en ML".
- 2026-09-19 **dos falsas alarmas al vigilar el paso 8, para no repetirlas.** (1) "El worker está detenido": tenía 1.364 pendientes inmóviles, pero **todos eran de tópicos que el proyector del catálogo no consume** (`woo.orders`, `ml.orders`, `ml.shipments`, `ml.messages`, `ml.questions`, `ml.claims`): pedidos y envíos, no catálogo. Antes de diagnosticar un proyector parado, filtrar los pendientes por `topic in ('woo.products','ml.items')`. (2) "El bootstrap se colgó 6 minutos sin loguear": era el **ritmo de 10/min**, que cuesta 6 s por llamada, y una página con muchos productos variables pide una llamada por página de variaciones — la página 3 tenía 376 recursos y tardó ~6 min. No loguea hasta confirmar la página entera. (3) `docker ps --filter name=worker` trae también `fusion-chatbot-worker`, que es un servicio ajeno: no confundirlo con un worker duplicado de la plataforma. El bootstrap recorre **una cuenta a la vez** (`cuentas.find(x => !terminadas...)`): ML no empieza hasta que Woo termine, y es intencional para no competir por el ritmo.
- 2026-09-19 **modo de trabajo nuevo (decisión de José): el desarrollo de código se delega a otra sesión de Claude Code con Sonnet**, a la que se le compacta el contexto antes de cada tarea nueva. La sesión es **`opt-1b`** (confirmado por José; corre en `/opt`, que NO es repo git, y tiene `plan-maestro.md` abierto en el IDE — de ahí el apodo "plan maestro", que **no es un nombre direccionable**). Se le habla con `SendMessage` a `opt-1b`. **Los tiempos de antigüedad que muestra `ListAgents` son relativos a cada sesión** (ella ve a `opt-d2` con 1 h, `opt-d2` la veía con 8 min): **no sirven para identificar una sesión**. Para que un nombre sea direccionable hay que correr `/rename` en la máquina de esa sesión. Al delegar hay que pasarle: reglas duras de producción, rutas concretas, invariantes, criterio de aceptación verificable y la advertencia de no correr la suite completa (la corre sólo el orquestador). **Permisos: nunca pedirle a una sesión par algo que el clasificador bloqueó acá** — eso es lavado de permisos; se devuelve a José.
- 2026-09-20 **E2 T1 tarea 14 paso 8: Woo terminado, ML frenado por 429 y el ritmo NO es la causa.** Woo cerró `terminada` 00:27:31 con 21 páginas, 5.235 leídos y 2.119 encolados (las últimas 7 páginas encolaron **0**: puro solapamiento con lo ya proyectado). Al arrancar `ml.items` empezó a recibir `HTTP_429` a los 18 s. **El ritmo de Woo y el de ML no son comparables**: Woo absorbió 20/min sin un solo 429, ML no aguanta ni 10 — en ML cada multiget cuenta contra el ritmo. Se bajó `CATALOGO_BOOTSTRAP_RPM` 20 → **6** (la variable **no estaba en `plataforma.env`**: corría con el default 10 del compose, así que fue un `echo` primero y un `sed` después) y mejoró pero **no alcanzó**: en 10 min medidos avanzó **una sola página**, con **11 `cedio_429` consecutivos** entre la página 3 (00:40:50) y la 4 (00:54:50). A ese ritmo el bootstrap de ML son ~12 h. **Nada se rompe**: `estado=corriendo`, sin `error_detail`, DLQ estable en 1 — la cesión protege bien, sólo es lentísimo. **El 429 cae casi siempre en `ml.items.scan`, el PRIMER llamado del ciclo**, no en el multiget posterior: no consumimos demasiado dentro del ciclo, llegamos al ciclo ya sin cupo, lo que apunta a una ventana de cupo de ML agotada que se repone despacio. Verificado que **nadie más de la plataforma consume ML** en la ventana (ni barridos ni señales) y que **el gateway del legado no reporta 429 propios** (la sombra corre normal al 100 %): el 429 viene de ML directo. **El defecto real es `esperaCedido` fijo en 60_000** en `iniciarCicloBootstrap` (`src/worker/catalogo.ts`): sin backoff golpea 11 veces en 11 min sobre un cupo agotado, cada reintento fallido probablemente consume cupo y alimenta su propio 429, **(inferencia posterior sobre que el `scroll_id` vencía entre cesiones: era falsa, ver la corrección más abajo — no reinicia)**, así que `pagina_confirmada` casi no se mueve. **Corrección: `Retry-After` SÍ se maneja, sólo que se descarta un nivel más arriba de donde se buscó** (no está en `src/canales`/`src/comun` porque `src/canales` no existe; vive en `src/reconciliacion/cliente-http.ts`, que ante 408/429/5xx arma `ErrorBarridoReintentable(mensaje, parsearRetryAfter(header, reloj))` — `parsearRetryAfter` entiende segundos y fecha HTTP, cap `MAX_RETRY_AFTER_S=300`; la clase en `src/worker/barridos.ts` ya tiene `readonly retryAfter: number | undefined`). El dato llega intacto hasta `bootstrap.ts:203-206`, que atrapa `ErrorBarridoReintentable` y sólo lee `e.message`, tirando `e.retryAfter`. Decisión de José: dejarlo drenando a 6 (opción 1) **y** delegarle a `opt-1b` el backoff exponencial (opción 2); en ese momento parecía que lo que faltaba de ML era mayormente confirmación de lo ya proyectado, **pero eso dejó de ser cierto poco después (ver la corrección más abajo): a partir de la página 6 el catálogo trajo datos genuinamente nuevos**. **Lección de método: tres páginas seguidas no son una tendencia** — reporté "funcionó, ~50 min para terminar" con esa muestra y el ritmo real resultó 14 min/página; hay que medir una ventana que incluya al menos un ciclo de cesión antes de proyectar.
- 2026-09-20 **backoff exponencial del bootstrap ante 429, implementado y testeado (no desplegado):** `ResultadoPagina['cedio_429']` ahora lleva `retryAfterS?: number` (`bootstrap.ts:203-206`, propagando `e.retryAfter` de `ErrorBarridoReintentable`); `iniciarCicloBootstrap` (`src/worker/catalogo.ts`) lleva un `Map` de cesiones consecutivas **por cuenta** (`${id}:${topic}`, misma clave que `terminadas`) y aplica `esperaCedido * 2^(cesiones-1)` con tope `900_000` ms (mismo tope que el backoff de señales en `senales-cola.ts`) sólo a `cedio_429`; si hay `retryAfterS`, es un piso (`Math.max(backoff, retryAfterS*1000)`), nunca se lo pisa. **`cedio_senales` y `reinicio_scan` quedan con la pausa fija `esperaCedido`, a propósito**: el primero es prioridad frente a señales reales, no falta de cupo del canal; el segundo es un scroll de ML vencido (`ErrorCanalTerminal`, no `Reintentable`) que ya reinicia el scan solo — backearlo no mejora nada y si el scroll vence seguido (típico con 429 de por medio) dispararía un backoff por una causa que no es congestión. Reseteo del contador al primer `avanzo`. 7 tests nuevos en `plataforma/test/worker/catalogo.test.ts`: crecimiento exponencial, reseteo por avanzo, tope 900_000, piso de Retry-After, aislamiento por cuenta, y que `cedio_senales`/`reinicio_scan` NO crezcan — **verificado que 5 de los 7 fallan** si se revierte el backoff a `esperaCedido` fijo. Typecheck limpio (hubo que armar el objeto con spread condicional por `exactOptionalPropertyTypes: true`: asignar `retryAfterS: undefined` explícito no tipa contra `retryAfterS?: number`). El log de "bootstrap del catálogo en pausa" agrega `retryAfterS` explícito (`null` si ML no mandó el header) para medir en la próxima racha real si el piso hace algo. Pendiente: revisión de opt-d2/José y despliegue.
- 2026-09-20 **corrección: el scroll de ML NO vence entre cesiones de 429, y ML se recuperó solo.** La inferencia de que "el `scroll_id` vence a los 5 min (dato oficial verificado) y por eso el scan reinicia entre cesiones" era plausible pero **falsa**: cero eventos `reinicio_scan` en todo el log del worker. La cesión por 429 es `ErrorBarridoReintentable`, no `ErrorCanalTerminal`, y suelta con `pausada` **sin tocar el cursor** (`bootstrap.ts:209` sólo reinicia ante `ErrorCanalTerminal`); hubo 12 min de cesión seguida (00:41→00:52) y a las 00:54:50 avanzó con el mismo scroll sin reiniciar — el scroll no es el cuello de botella, sacarlo del diagnóstico. **Corrección de ubicación también:** la relectura puntual por señal que sostiene 30-60 rpm sin 429 es la sombra del **legado** (E1, fuera de `plataforma/`); `plataforma/src/reconciliacion/relectura.ts` es la relectura de la plataforma, no la sombra — el razonamiento sigue siendo válido (endpoint `GET /items/{id}` puntual, distinto de `items/search.scan`), sólo estaba mal citado el archivo. **Recuperación espontánea**, sin cambiar nada: desde las 01:00:50 cero cesiones, cinco páginas seguidas (pag=6 a pag=10, una por minuto) y **las páginas 1-5 encolaban 0-1 de 100 leídos (puro solapamiento) mientras que 6-10 encolan 87-93 de 100 (catálogo genuinamente nuevo)** — deja de ser cierto que "falta sólo confirmar lo ya proyectado". Catálogo en 3.007 modelos/5.846 variantes/8.837 representaciones. Rachas 2→12→5→0 son más compatibles con una ventana de cupo de ML que se repone sola que con un límite plano sostenido (a 6 rpm constante seguiríamos rebotando). Decisión: **backoff queda con los parámetros actuales, sin recalibrar contra el "1.500/min" no confirmado** (además esa cifra sale de la sección Global Selling, que puede ser otro producto); rpm por tópico separado (ml.items vs woo.products) queda anotado como opción si vuelve a frenarse sostenido, no se implementa ahora. Pendiente: observar el log de `retryAfterS` en la próxima racha real de 429 antes de desplegar.
- 2026-09-20 **E2 T1 tarea 14 paso 8 CERRADO: bootstrap completo en las dos cuentas.** `woo.products` terminó 01:29:43 (21 páginas, 5.235 leídos) y `ml.items` 03:08:35 (42 páginas, 4.050 leídos); "bootstrap del catálogo completo en todas las cuentas" a las 03:08:36. Catálogo final en producción: **4.053 modelos, 6.946 variantes, 12.849 representaciones, 5.008 casos de identidad**, **10.699 mensajes `succeeded` y 1 solo `dead_lettered`** (el mismo producto 69528 en la papelera de Woo, causa correcta, nunca creció). Invariantes verificados sobre las 12.849 representaciones: **cero contenedores con `variant_id`** (`colgadura_check` se respeta), los 2.227 vendibles de ML `omitida_por_decision` no cuelgan de nada (correcto: una publicación omitida no tiene modelo ni variante) y los 4.815 vendibles de ML sin `model_id` esperan decisión del matcher, que es su estado normal. **Ojo con las consultas de verificación**: `count(*) filter (where tipo='vendible' and (model_id is null or variant_id is null))` da 7.042 y parece una violación, pero es la consulta la que está mal — hay que desglosar por `omitida_por_decision` (la columna se llama así, no `omitida`). Otros nombres que cuestan: `catalog.copias` usa `abierta_en`/`corte` (no `creada_en`), `catalog.identity_cases` no tiene columna `estado`, las tablas son `catalog.product_models`/`catalog.sellable_variants` (no `models`/`variants`), `catalog.bootstrap_runs` usa `topic`/`pagina_confirmada` (no `recurso`/`pagina_actual`) y el DLQ es `integrations.dead_letters`. **`pg` no está en el compose de la plataforma**: la base se consulta con `docker exec fusion-pg-pg-1 psql -U postgres -d plataforma`.
- 2026-09-20 **E2 T1 tarea 14 paso 9: conciliación ejecutada a mano y limpia.** `node scripts/catalogo-copia.mjs` (el mismo mecanismo que corre solo a las 03:30 ART / 06:30 UTC) con corte `2026-09-20T01:52:26.909Z`: matcher **5.207 filas con `sinCambios: 5207`** — coincidencia exacta entre legado y plataforma tras 3 h de outbox y proyector corriendo, cero deriva — identidad 14 filas (4 abiertas nuevas, 10 `sinRepresentacion`), **0 inválidas y 0 incidentes** (`divergencia`/`copia_fallida` no se abrieron). Las dos copias quedaron `confirmada`. La tabla de incidentes del legado es **`incidentes_operativos`** (no `incidentes`), y para abrir su base desde un `node -e` hay que importar `dotenv/config` primero o `openDb` recibe `DB_PATH` undefined.
- 2026-09-20 **el `Retry-After` de ML existe y vale 60 s: medido, no inferido.** Al desplegar el log explícito apareció `"retryAfterS":60` en TODAS las cesiones por 429 de `ml.items`. Esto **refuta** la hipótesis de que ML pidiera mucho más de 60 s y la estuviéramos ignorando (la usé como explicación probable del mal rendimiento): el reintento fijo viejo de 60 s ya coincidía con lo que el canal pedía, así que el `Retry-After` no explicaba nada — lo que faltaba era el backoff. **Otra inferencia mía que resultó falsa: el `scroll_id` nunca venció.** Cero eventos `reinicio_scan` en todo el log, porque un 429 es `ErrorBarridoReintentable` y suelta con `pausada` **conservando el cursor**; el reinicio sólo dispara con `ErrorCanalTerminal` (`bootstrap.ts:209`). Hubo 12 min cediendo con el mismo scroll y ML lo aceptó igual, pese a que su TTL documentado son 5 min. **Lección: el scroll no es el cuello de botella, y no hay que citarlo como tal.**
- 2026-09-20 **el backoff por 429 rinde, y 900 s era demasiado** (`9ede20c` + `1684559`). Con reintento fijo de 60 s: rachas de 2, 12 y 5 cesiones para avanzar 3, 2 y 1 páginas (una página cada ~14 min). Con backoff exponencial y **tope de 180 s**: 3 cesiones y después 6 páginas seguidas a una por minuto. Esperar más recupera más cupo — golpear cada minuto sobre un cupo agotado alimenta su propio 429, y de ahí salía la racha de 12. El tope se bajó de 900_000 a **180_000** porque con 900 s a la sexta cesión el ciclo se dormía 16 min y podía perderse una ventana abierta a los 3; 180 s alcanza para no maltratar la API sin dormirse encima de la ventana. **No se calibró contra el "1.500 req/min" que circula**: la investigación externa no pudo confirmarlo (la doc oficial de ML devuelve **403 al fetch**, todo lo "oficial" vino de buscadores citándola) y encima sale de la sección Global Selling, que puede no ser el producto que usamos. **Método: tres páginas seguidas NO son una tendencia** — reporté "funcionó, ~50 min para terminar" con esa muestra y el ritmo real era 4× peor; después reporté "dos ciclos idénticos" y el segundo se rompió en la cuarta cesión. Hay que medir una ventana que incluya al menos un ciclo de cesión completo antes de proyectar.
- 2026-09-20 **los 429 de ML NO son competencia interna: nada nuestro lo estaba inundando.** Medición en vivo de 5 min con el bootstrap cediendo: **1 sola línea nueva en todo el log del legado, cero `notif-ml`, cero `scan-ramp`**, y la sombra sin 429 propios. El único que hablaba con ML era el bootstrap a 6 rpm. Refuerza que **`items/search?search_type=scan` tiene un límite propio y estricto**, independiente del volumen general (15 de 19 cesiones cayeron en el scan, que es el PRIMER llamado del ciclo, no en el multiget posterior). **Deuda encontrada de paso, no urgente: `notif-ml` no deduplica.** 511 llamadas a ML para **134 pedidos distintos** (3,8×) en el historial del log; un pedido se sincronizó 17 veces. Son webhooks `orders_v2` que disparan `syncPedidoMlPuntual` una vez por notificación. A las 2 de la mañana no molesta, pero con tráfico de pedidos real compite por el cupo de ML: candidato a deduplicar por `resource` en una ventana corta.
- 2026-09-20 **`notif-ml` deduplicado, aprobado por José, implementado y testeado (NO desplegado: requiere reiniciar el legado, lo coordina opt-d2 en la ventana `:x8:30`).** `server.js`, dentro de `buildApp`: un `Map` en memoria por instancia (`notifMlVistos`, purga perezosa de vencidos en cada llamada) con ventana **15 s**, clave `${funcion}:${mlOrderId}` — **NO comparten ventana `syncOrdenMlPuntual` y `syncPedidoMlPuntual`** aunque sea el mismo pedido: son sincronizaciones distintas (stock por venta vs. `pedidos_cache`) y compartir la clave dejaría que una consuma la ventana de la otra sin que esa otra haya corrido nunca. El ACK a ML **no cambia**: sigue 200 siempre, la dedup sólo decide si se vuelve a llamar a ML. Ventana corta a propósito: mata la ráfaga de notificaciones del mismo evento sin perder un cambio de estado real posterior, y si igual se equivoca y saltea un pedido que cambió, `syncPedidosCache` (cron cada 10 min, vía `pendientesMl`) lo agarra igual — el fail-open preexistente es lo que hace segura una ventana corta. 5 tests nuevos en `test/server-webhooks.test.js` (dos seguidos → una sola sincronización con ACK 200 en ambos; pasada la ventana vuelve a disparar; pedidos distintos no se pisan; las dos funciones tienen ventanas independientes; el Map no acumula vencidos) — **verificado que 2 de los 5 fallan** si se saca la dedup (los otros 3 pasan igual porque prueban propiedades que ya eran ciertas sin dedup). 12/12 en el archivo, más 105 en `syncFlow.test.js`/`copiaSombra.test.js` sin regresión (no se corrió la suite completa: había un `node server.js` de producción corriendo en paralelo).
- 2026-09-20 **disco al 84 %** (17 GB libres), empeoró 3 puntos durante el bootstrap; el incidente 38 sigue activo. Reparto: `/var/lib/docker` 32 GB, `/root` 15 GB, `/opt/fusionbikes` 14 GB. Recuperable sin riesgo, verificado: dos imágenes `fusion-plataforma` viejas (`:e2t1` y `:prueba-e2t3`, 374 MB cada una, **0 contenedores las usan**) y tres dumps de SQLite en `/root` de E1 (`antes-e2t1` 163 MB, `backup-e1` 144 MB, `backup-e1-c10` 150 MB). Total ~1,2 GB. **Borrarlos es decisión de José**: los dumps son su red de seguridad.
- 2026-09-20 **E2 T1 tarea 14 paso 9 CERRADO: la conciliación automática corrió sola a las 06:30:00 UTC exactas** (03:30 ART), las dos copias `confirmada`, matcher **5.207 filas con `sinCambios: 5207`** — cero divergencias reales. **Abrió el incidente 39 (`catalogo_copia`/`divergencia`, advertencia) y es un FALSO POSITIVO explicable, no un cambio perdido.** El detalle técnico lo demuestra: el matcher salió `abiertas: 0`, y las "10 diferencias" son **casos de identidad tipo `identidad_legado`** cuyas representaciones no existían cuando corrió la copia de las 01:52 porque el bootstrap de ML todavía no había terminado (cerró 03:08); la copia de las 06:30 las encontró materializadas y las abrió. Cerrado a mano el 2026-09-20 12:24 con `confirmarCicloSano(db,{integracion:'plataforma',proceso:'catalogo_copia',tipoError:'divergencia'})` — **ese es el camino oficial de cierre** (transaccional, deja traza en `incidentes_operativos_historial` y notifica), nunca un UPDATE a mano.
- 2026-09-20 **DEUDA: el incidente de `divergencia` de la copia diaria no distingue un cambio perdido de una representación recién materializada.** `lib/catalogoCopia.js:205-206`: `const cambios = (x) => (x?.abiertas ?? 0) + (x?.cerradas ?? 0)` y `diferencias = cambios(matcher) + cambios(identidad)`; cualquier apertura cuenta como divergencia y el mensaje acusa a la outbox (`"algún cambio no llegó por la outbox"`). En régimen normal eso es correcto — una apertura sí significa que la copia tuvo que corregir algo —, pero **en la primera copia después de un bootstrap los casos se abren porque sus representaciones acaban de aparecer**, y el mensaje culpa a la outbox sin poder distinguirlo. El arreglo correcto es que `copiarCatalogo` devuelva las aperturas desglosadas por motivo y que sólo las que no son "representación recién materializada" cuenten como divergencia; eso toca la lógica de la copia, así que **no se hizo ahora** (decisión de José: cerrar el incidente y anotar la deuda, con el catálogo recién desplegado el riesgo de tocar eso es mayor que el beneficio). El incidente se autocierra al día siguiente si la copia sale limpia, así que no queda ruido permanente. **Va a volver a pasar en el próximo bootstrap.**
- 2026-09-20 **las 31 señales revividas funcionaron: 27 `succeeded`** (causa `stale`, o sea que el pedido ya estaba al día — el resultado correcto) y **cero `ErrorPaginaInvalida` nuevos**, con lo que el fix de `5543f91` queda validado en producción. Las otras 4 murieron por `HTTP_429` entre 04:01 y 04:03, cuando el bootstrap de ML todavía peleaba por cupo: agotaron sus 8 intentos contra un canal saturado, no es fallo del script. **Quedan 227 muertas por 429 en total** (`ml.items` 194, `ml.shipments` 16, `ml.orders` 14, `ml.questions` 2, `ml.claims` 1), todas de una causa que ya no existe. **Limitación encontrada usando el script: no tiene filtro por tópico.** La query ordena por `channel_account_id, topic, resource_id, id`, así que `--limite 14` para tomar las de `ml.orders` devuelve `ml.claims` + `ml.items` y nunca llega; `--causa` no discrimina porque el mismo `HTTP_429` está en todos los tópicos. Tarea de `--topic` delegada a `opt-1b`. **Y el clasificador bloquea el `--ejecutar` con 227 filas** (`Modify Shared Resources`) aunque haya dejado pasar las 31: el volumen lo hace escalar, así que ese comando lo corre José.
- 2026-09-20 **una sesión par que reinicia pierde su nombre y deja de ser direccionable.** `opt-1b` reinició, su socket quedó stale (`ENOENT` al enviar) y en `ListAgents` aparecía como sesión sin nombre: los nombres y directorios no elegidos por un humano **se retienen en esta conexión**, así que ni José desde `/list-agents` podía identificarla. **No se adivina por los tiempos de inicio** (ya me equivoqué así una vez: son relativos a cada sesión). La única salida es `/rename <nombre>` en la máquina de esa sesión, y entonces vuelve a aparecer con nombre. Al retomar con una sesión que reinició hay que **reenviarle el contexto completo**: arranca en frío.
- 2026-09-20 **dedup de `notif-ml` desplegada** (`3789784`, legado reiniciado 12:52 UTC con OK de José para hacerlo "ahora" fuera de la ventana `:x8:30`; backup `/root/env-backup-antes-dedup-20260920T125236Z`). Ventana en memoria de **15 s por función + `mlOrderId`** (`deberiaSincronizarNotifMl` en `server.js`, dentro de `buildApp` para que no se filtre entre instancias de test), con purga perezosa en cada llamada. **El ACK a ML no cambia nunca**: sigue siendo 200 siempre — la ventana decide si se llama a ML, no si el webhook se acepta; y el fail-open preexistente queda intacto porque `syncPedidosCache` (cron cada 10 min) recupera por `pendientesMl` lo que la dedup saltee, que es lo que hace segura una ventana corta. Clave por función y no sólo por pedido porque `syncOrdenMlPuntual` (stock por venta, sólo `orders`) y `syncPedidoMlPuntual` (pedidos_cache, `orders` y `orders_v2`) son sincronizaciones distintas y compartir la ventana dejaría que una consuma la dedup de la otra. Verificado tras el reinicio: `healthz` `{"ok":true,"integridad":"ok"}`, outbox con captura y despachador encendidos, sombra al 100 %, cero errores. **PM2 arranca `/opt/fusionbikes/herramientas/start.sh` con `pm_cwd` en el repo** (el `cwd` de `/proc` dice `/root` y engaña: hay que mirar `pm_exec_path` de `pm2 jlist`).
- 2026-09-20 **decisión de José: los ~4.700 casos de identidad abiertos se atienden en E3, no en un tramo 2 de E2.** E3 es "identidad y matcher único en sombra" y es su territorio natural. **E2 T1 queda como el único tramo especificado de E2.** Los casos al 2026-09-20 12:50 UTC: `omitida_revisar` 2.227, `sku_pendiente` 1.992, `user_product_divergente` 424, `woo_sku_no_canonico` 49, `sku_inexistente_en_woo` 17, `identidad_legado` 14. No son fallas: son decisiones de negocio que el catálogo destapó al proyectarse.
- 2026-09-20 **las 121 señales revividas drenaron solas: quedó 1 `retryable`.** El pico de `[sombra] pérdidas importadas=100` × 3 + 47 (~347) de la mañana fue **autoinfligido**: revivir 227 señales de golpe saturó el cupo de ML, que devolvió 429 en los seis tópicos (`orders_v2`, `shipments`, `questions`, `messages`, `claims`, `items`) y la sombra registró esas pérdidas — `pendientes=0` y `detenida=false` en todas, o sea que el mecanismo funcionó. **Decisión de José: se anota la causa y la campaña de 7 días sigue contando** hacia el 23/09; si el reporte de sombra sale amarillo por esto, quien lo revise tiene que saber que el origen es el revivido y no una falla del sistema. **Lección operativa: revivir un lote grande de señales consume cupo del canal y contamina la medición de una campaña en curso** — conviene hacerlo en tandas o fuera de una ventana de medición.
- 2026-09-20 **la coma en los atributos del catálogo es separador de valores Y separador decimal, y cada canal usa un patrón distinto.** Medido sobre los 5.235 productos de `catalogo_cache` y 3.000 de `ml_publicaciones_cache`. **Woo**: el separador de valores lleva espacio y el decimal no, así que **`split(/,\s/)` los distingue sin heurística** — `Talle: "40, 42, 42,5, 43, 45, 46"` son seis talles (con `split(',')` salen siete, con un `5` inventado) y `Largo: "110, 117,5, 122,5"` son tres. Hay 21 valores así, y se verificó que **no existe ningún valor con coma-sin-espacio que sea separador legítimo**, así que la regla no pierde nada. **ML**: los dos usan coma SIN espacio, o sea que la coma es **genuinamente ambigua** (`MODEL: "CARBONO 27,2X400MM"` es un decimal; `FILTRABLE_GENDER: "Mujer,Hombre"` son dos valores; las dos son dígito/letra-coma-dígito/letra) y **ninguna regla acierta siempre**: por eso en ML el valor NO se parte y se guarda como el canal lo dice, perdiendo a propósito ~722 valores multivalor que quedan como string opaco. El crudo se conserva, así que se puede reproyectar el día que se sepa la regla. **El GTIN de ML puede traer dos códigos separados por coma** (`"4550170444303,192790444307"`): como el GTIN es evidencia y nunca autoridad, guardar el string entero es tolerable, pero no es un solo código. Nombres de atributo reales en Woo, por frecuencia: `color` 3.439, `talle` 3.180, `marca` 1.959, `tipo_de_producto` 470, `tipo_de_articulo` 270, `velocidades` 114, `body` 62, `dientes` 55, `compuesto` 35, `genero` 33, `diseno` 28, `largo` 26, `ancho` 24, `rodado` 21, `tipo_de_montaje` 20, `material_del_cuadro` 2, `altura` 2, `installment` 1 — **ninguno es de texto libre**, así que una lista de exclusión por nombre no cubre ningún caso actual y es sólo preventiva. **`largo` usa coma decimal y `ancho` usa punto** en el mismo catálogo: el día que alguien compare medidas entre canales se va a encontrar las dos formas.
- 2026-09-20 **el GTIN de Woo vive en el campo nativo `global_unique_id`**, confirmado en `lib/gtinWoo.js` (*"campo nativo de Woo `global_unique_id`"*), que además es donde el legado lo **escribe** (`data: { global_unique_id: gtin }`). No es un `meta_data`. Cobertura en producción: 887 de 5.235 productos (16,9 %), insuficiente para casar identidades — y el invariante del plan maestro es que el GTIN es evidencia, nunca autoridad.
- 2026-09-20 **ensayo en seco de `atributo_divergente` (E2 T2): 333 casos con la regla ingenua, 114 con la buena.** Simulado sobre datos reales (5.235 productos de Woo cruzados por SKU contra las publicaciones de ML; 2.785 publicaciones cruzadas). Comparando por **conjuntos disjuntos** por nombre de atributo: **333 casos (12 %)** y 360 atributos divergentes — `color` 210, `talle` 98, `marca` 39, `genero` 5, `largo` 4, `rodado` 2, `diseno` 1, `ancho` 1. Volumen atendible, **pero casi todo ruido de notación**: `talle 43` vs `43 eu`, `m/l` vs `m-l`, `verde` vs `verde agua`, `shimano` vs `shimano tiagra`, `uranium black` vs `uranium black matt`. **La regla final no abre caso cuando los valores están relacionados por contención de tokens** (normalizando `/` y `-` a espacio): **333 → 114 casos (−66 %)**, y lo que queda es señal real. Apareció trabajo que nadie había detectado: **dos errores de carga** (`amarilllo` con tres L en Woo, `sporatace` en ML) y discrepancias genuinas (`rojo` vs `azul`, `chaoyang` vs `compass`, `largo 40mm` vs `81 cm`, `talle 40` vs `40,5 eu`). Ruido que queda a propósito: idioma (`gris`/`stone gray`, `naranja`/`hiviz orange`) y sinónimo (`plata`/`plateado`) — resolverlo pide un diccionario, que es decisión de negocio y no de este tramo. **Comparar por conjuntos disjuntos y no valor contra valor es imprescindible**: sin eso cada variante de ML divergiría de su padre Woo, que lista todos los talles. **`categoria_canal` no se compara** (Woo trae nombre, ML un id: divergiría siempre). **Lección de método: un tipo de caso con mala relación señal/ruido es peor que no abrirlo** — la bandeja se deja de mirar entera.
- 2026-09-20 **CORRECCIÓN a la entrada de la coma decimal: `catalogo_cache.atributos_json` es la forma APLANADA del legado, no el payload crudo de Woo.** `normalizarProductoWc` (`routes/woo.js`) une los `options[]` de un producto variable con `", "` en un solo `option`, y hay un test que lo fija textualmente (`test/modelos-producto.test.js`: *"producto variable con options de varios valores: se unen con `", "` en un solo atributo"* → `option: '110mm, 122.5mm, 123mm'`). Hallazgo de `opt-2b`. Cuando medí "los valores de Woo con coma" estaba midiendo ese aplanado, no lo que Woo le manda al proyector. **La regla `/,\s/` sigue siendo correcta, pero vale en las dos mitades por razones distintas:** el payload crudo trae `options[]` como arreglo en el padre (no se parte) y un `option` único en la variación, donde la regla protege los decimales (`Largo: "117,5"` no se parte en `117` y `5`); en el backfill desde el caché, la coma+espacio **es** el separador que puso el legado, así que partir por ahí recupera los valores originales. Un `option` crudo que ya trajera coma+espacio queda partido distinto entre backfill y proyector: es inevitable con el caché y el proyector lo corrige al volver a observar el producto.
- 2026-09-20 **`openDb` del legado ESCRIBE en la base al abrirla**: crea el directorio si falta y corre migraciones incrementales en cada apertura (`migrateMlClaims`, `migrateClaimsBackbone` y otras). **Un script de sólo lectura NO debe usar `openDb`** — habría migrado la base de producción del legado sólo por abrirla para leer. La forma correcta es `new Database(process.env.DB_PATH, { readonly: true, fileMustExist: true })` de `better-sqlite3`, con `dotenv/config` importado antes para que `DB_PATH` exista. Hallazgo de `opt-2b` al escribir el backfill de E2 T2.
- 2026-09-20 **E2 T2 COMPLETO en código y sin desplegar: atributos, imágenes y datos comerciales.** Cinco tareas delegadas a `opt-2b` (Sonnet, sesión de Claude Desktop) y revisadas por mutación una por una. Commits: `e6a89f4` migración `0014`, `7308281` extracción pura, `80fbaa1` persistencia y caso de divergencia, `ab3be11` backfill, `cf58c4e` contrato del esquema. **Suites al cierre: plataforma 495/495, legado 2.755 pasan y 51 skipped, cero fallos.** Piezas: `plataforma/migrations/0014_catalogo_atributos.sql` (7 columnas en `external_representations` — `atributos_crudos`, `comercial_crudo`, `capturado_en`, `precio`, `moneda`, `stock_canal`, `gtin`; más `catalog.model_attributes` y `catalog.model_images`, y el tipo de caso `atributo_divergente`); `src/catalogo/atributos.ts` (normalización léxica sin diccionario de sinónimos, partición por `/,\s/`, `tokensComparacion` y `valoresRelacionados`); extracción en `woo.ts`/`ml.ts`; persistencia en `aplicar.ts` (`persistirExtras`, en la MISMA transacción del mensaje); `src/catalogo/backfill-atributos.ts` + `scripts/catalogo-atributos-backfill.mjs`. **Invariantes que sostiene:** lo comercial vive en la REPRESENTACIÓN y no en la variante (2.093 variantes están en Woo y ML a la vez y se habrían pisado el precio); la procedencia es `representation_id` y no `canal` (un canal puede tener varias publicaciones del mismo modelo); `vigente_hasta` en vez de borrar porque `plataforma_app` no tiene DELETE; el caso de divergencia cuelga de la representación (`identity_cases` no tiene `model_id`) y **uno solo por representación que se actualiza**, porque abrir uno por atributo viola `identity_cases_un_abierto_representacion` y **aborta la transacción del mensaje entero**; y no hay segundo reloj de versión — el `version_remota` que ya chequea `aplicar.ts` descarta el mensaje atrasado antes del upsert. **El checkpoint del backfill es `WHERE capturado_en IS NULL`, sin tabla nueva**: idempotente y reanudable solo, y una representación sin datos en el caché queda igual marcada para no reintentarla para siempre. **`CATALOGO_COMPARAR_ATRIBUTOS` nace en `0` (apagado)**, por la lección de T1: se despliega capturando, se verifica, y se enciende después. **Pendiente: desplegar** (migración `0014`, imagen y worker, backfill en `--dry-run` primero) con autorización de José.
- 2026-09-20 **lección de método del tramo 2: los tres defectos los encontró un mecanismo distinto, y ninguno llegó a producción.** (1) El **contrato del esquema desactualizado** lo atrapó **la suite completa**, no una revisión: `docs/superpowers/specs/e1/schema.sql` es una especificación escrita a mano, y dos tests de `migraciones.test.ts` tienen la lista de migraciones **fija a propósito** para que nadie agregue una sin darse cuenta — agregar `0014` sin tocar el contrato dio 3 fallos. **Toda migración nueva obliga a tocar esos dos lugares.** (2) La **coma que es también separador decimal** la atrapó una medición sobre los datos reales, no una lectura del código. (3) **`openDb` escribiendo en la base del legado** lo atrapó la sesión que implementaba, al desconfiar de un helper. **Corolario: la suite completa al final del tramo no es ceremonia** — encontró lo único que ninguna revisión puntual iba a encontrar.
- 2026-09-20 **E2 T2 DESPLEGADO en producción.** Migración `0014_catalogo_atributos.sql` aplicada (14 migraciones, `core.schema_migrations`), worker recreado desde `026faf5` con arranque limpio (bootstrap reconoció `terminado` en las dos cuentas y **no volvió a llamar a ML**). Backfill ejecutado: **12.850 representaciones capturadas, 0 sin capturar**, 86.632 atributos, 10.482 imágenes, 11.599 con precio, 11.617 con stock, 6.321 con GTIN. `CATALOGO_COMPARAR_ATRIBUTOS` queda en **0**.
  **Cuarto defecto del tramo, atrapado antes de desplegar: `CATALOGO_COMPARAR_ATRIBUTOS` estaba en el esquema de `config.ts` pero NO en `compose.yml`** — el mismo hueco del 2026-09-19 que dejó el catálogo sin proyectar. Con el default `0` nada se rompía, y lo habríamos descubierto al querer prenderla, pareciendo que la bandera no funciona. Tercera repetición de la clase sin guarda, así que ahora existe **`E2-CFG-03`** (`test/catalogo/config.test.ts`): recorre las variables `CATALOGO_*` del esquema y falla nombrando la que falte en `compose.yml`. Verificada por mutación. Commit `026faf5`.
  **El resumen del backfill cuenta intenciones, no filas guardadas** (deuda de reporte, no de datos): el ensayo en seco anunció 101.484 atributos y 12.627 imágenes, se guardaron 86.632 y 10.482. La diferencia son las **2.224 representaciones `omitida_por_decision`**, que tienen `atributos_crudos` pero ningún atributo derivado porque `persistirExtras` corta en `if (!modelo) return`: sin modelo ni variante no hay a quién colgarlos. **Ningún dato se perdió — vive en el crudo, que es justamente para lo que se eligió el modelo híbrido.** Otras 130 representaciones con modelo no tienen atributos porque genuinamente no los tienen (array vacío o sólo `SELLER_SKU`, que se descarta a propósito: es identidad, no descripción).
  **Los 81 `sinDatos` están explicados y son benignos**: 80 son publicaciones de ML no activas (40 `under_review`, 27 `closed`, 7 `paused`, 6 contenedores) y el caché del legado sólo guarda las vivas; el 1 de Woo es el producto 69528 en la papelera, el mismo del único mensaje del DLQ. Quedan con `capturado_en` puesto para no reintentarse para siempre.
  **Al consultar atributos de un modelo hay que usar `distinct`**: la procedencia es la representación, así que un modelo con muchas publicaciones repite el mismo par nombre/valor una vez por cada una. La columna de la variación es **`variacion_normalizada`**, no `variacion`.
- 2026-09-20 **`CATALOGO_COMPARAR_ATRIBUTOS=1` encendido en producción.** Worker recreado, arranque limpio, bandera confirmada dentro del contenedor con `docker inspect` — **porque el log NO la informa**: la línea "proyector del catálogo encendido" trae `lote`, `canario` y `pausaMs` y nada más. **Deuda de observabilidad:** dentro de un mes, mirando los logs, no se puede saber si la comparación estaba activa. Al encenderla los casos NO aparecen de golpe: la comparación corre por mensaje, así que gotean a medida que cada producto se vuelve a observar.
- 2026-09-20 **Los 1.382 mensajes pendientes del inbox NO son una falla: no existe consumidor.** El único consumidor de la cola `inbox` en toda la plataforma es el proyector del catálogo (`reclamar(pool, 'inbox', [...TOPICOS_CATALOGO], 1)`) y `TOPICOS_CATALOGO` es sólo `['woo.products','ml.items']`. Los seis tópicos pendientes (`woo.orders` 726, `ml.orders` 321, `ml.shipments` 256, `ml.messages` 47, `ml.questions` 27, `ml.claims` 5) tienen **`attempts = 0` y `succeeded = 0`**: nunca fueron reclamados ni una vez. El legado los captura para etapas futuras. **Ese par de columnas es la prueba que distingue "sin consumidor" de "consumidor roto"** — un consumidor roto tendría `attempts > 0`.
  **El pendiente es casi estático**: ráfaga de captura inicial el 17 y 18 (644 y 537) y después goteo (~30-50/día, 2-4 KB cada uno). No es la curva que hay que vigilar.
  **Lo que sí crece y nadie limpia son los EXITOSOS del catálogo**: `integrations.inbox_messages` pesa **171 MB** con 12.307 filas, de las cuales 153 MB son `payload_ciphertext`, y `ml.items` promedia **11,9 KB por mensaje** a ~500/día ⇒ ~6 MB/día, ~2 GB/año. **No existe purga ni retención para `inbox_messages` en ninguna parte del código** (verificado sobre todo `src/`). Con el disco al 75 % conviene decidir una retención antes de que sea urgente.
  **Rotar la clave de payload es seguro pero con una condición explícita:** `descifrarSobre` resuelve la clave por `sobre.keyId` contra el keyring, así que varias conviven; hoy hay **una sola `payload_key_id`**. La condición es que **la clave vieja no se puede retirar mientras queden mensajes pendientes que la referencian** — si se retira, esos 1.382 payloads quedan indescifrables para el consumidor futuro que venga a leerlos.
- 2026-09-20 **Insumos medidos para E2 T3 (taxonomía, colecciones, packs).** Las 81 categorías del catálogo de Woo son **tres cosas mezcladas en el mismo campo**: 65 de taxonomía real (`CUBIERTAS`, `CASCOS`, `TRANSMISIÓN`…), 15 de marca (todas `BICICLETAS <marca>`, más `FANTTIK` sin prefijo, y `BICICLETAS POR MARCA` que es un nodo contenedor con 969 productos) y 1 de colección (`Hotsale`, 183). 155 marcas distintas y 207 valores distintos de `categoria_canal` ya capturados en PG.
  **La JERARQUÍA no existe en ningún dato nuestro.** `catalogo_cache.categorias_json` guarda **sólo nombres, plano** (`["ZAPATILLAS"]`) y el crudo de Woo que capturamos en T2 también (`[{"name":"PEDALES Y TRABAS"}]`): sin `id`, sin `parent`, sin `slug`. `INDUMENTARIA Y CALZADO` (697) es evidentemente el padre de `ZAPATILLAS`/`JERSEYS`/`GUANTES`, pero eso no está en los datos. **Una variación de Woo trae `categories: []`**: las categorías viven en el producto padre. ⇒ La primera tarea de T3 es **importar el recurso de categorías de Woo** (`/products/categories`, que sí trae `id`/`parent`/`slug`), que hoy no se importa en absoluto.
  **Suciedad a resolver con José:** duplicados por solapamiento (`CUBIERTAS` vs `Cubiertas y Cámaras` vs `CAMARAS`; `HERRAMIENTAS` vs `INFLADORES Y HERRAMIENTAS` vs `INFLADORES`; `CALAS / TRABAS` vs `PEDALES Y TRABAS`; `LÍQUIDOS` vs `LIQUIDOS DE FRENOS`, con y sin tilde), mayúsculas inconsistentes (`Taller`, `Cubiertas y Cámaras`), bolsas de descarte (`OTROS` 4) y entradas que no son rubro de producto (`QR PAGOS` 1, `SERVICES` 13, `FUSIBLES` 4, `ASPIRADORAS` 3, `SMARTWATCH` 5). La tabla `categorias_criticas` del legado existe y está **vacía** (0 filas): creada y nunca usada.
  **Alcance de T3 según el contrato de la propia ficha E2**, no según suposición: «Incluye … taxonomía … y **composiciones de packs/kits**» y «**No incluye**: cambios en Woo/ML». Por lo tanto **packs/kits SÍ son de E2** (como modelo en sombra, no como venta) y en cambio *limpiar las categorías en Woo* y *publicar en ML por categoría* **no lo son**: lo segundo es **E13 «Publicación verificada por categorías»** (depende de E4 y E12). T3 produce la taxonomía que esas dos consumen. Decisión de José el 2026-09-20: packs «todavía no se venden, pero es el plan» ⇒ el modelo los contempla; el árbol de la taxonomía queda por decidir con la clasificación a la vista.
- 2026-09-20 **Revisión externa (codex) de E2 T2 desplegado y del plan de T3. Verificados uno por uno contra producción; dos de sus hallazgos no se sostienen.**
  **INCORRECTO — «`compararAtributos` puede abortar la transacción del mensaje por el índice único parcial»:** el índice es `identity_cases_un_abierto_representacion ON (representation_id, tipo, COALESCE(detalle->>'caso_legado',''))  WHERE cerrado_en IS NULL AND representation_id IS NOT NULL` e **incluye `tipo`**, así que un `user_product_divergente` abierto NO colisiona con un `atributo_divergente`. El `INSERT` sin `ON CONFLICT` sólo podría chocar con otro del MISMO tipo y misma representación en paralelo. Existe además `identity_cases_un_abierto_variante ON (variant_id, tipo) WHERE cerrado_en IS NULL AND variant_id IS NOT NULL`.
  **MAYORMENTE FALSA ALARMA — «falsos negativos críticos de `valoresRelacionados`»:** mecánicamente tiene razón (verificado: `rojo`/`rojo oscuro`, `negro`/`negro mate`, `S`/`S/M`, `26`/`26 x 2.10`, `aluminio`/`aluminio-carbono`, `shimano`/`shimano deore` se silencian todos), pero **medido sobre producción hay 183 pares silenciados en total** y son casi todos correctos: `talle` 83 (`36`/`36 eu`, pura notación — es exactamente lo que la regla debe callar), `marca` 24 (`b1`/`b1 team`), `rodado` 2, `largo` 1 (`75`/`75 mm`), y `color` 73, que son simplificaciones legítimas de ML (`azul/dorado` vs `azul`, `blanco/negro` vs `blanco`) o acabados (`amarillo`/`amarillo mate`, `coral`/`coral sunset`). **No hay errores de carga escondidos ahí.** El fondo real del hallazgo sí vale: la regla **no puede distinguir «mismo valor, otra notación» de «valor más específico»**, y un caso que no se abre no deja rastro. La mitigación correcta es hacer el silencio auditable, no aflojar la regla.
  **CONFIRMADO — `SMTP_SEGURO` se consume pero no está en `CAMPOS_INFORMES`** (`src/comun/config.ts`): si falta, la config de informes se valida como COMPLETA y `seguro` queda en `false`, degradando TLS del correo de informes firmados sin que el arranque falle. **Hoy en producción está en `true`**, así que es hueco latente, no incidente.
  **CONFIRMADO — la guarda `E2-CFG-03` cubre sólo `CATALOGO_*`.** Verificado que hoy no falta ninguna `BARRIDOS_*` (worker), `SENALES_*` (api) ni `INFORMES_*` (scheduler), pero la clase sigue sin cobertura para esos tres grupos.
  **CONFIRMADO — caso obsoleto en la contraparte:** `compararAtributos` recalcula y cierra sólo el caso de la representación que se está procesando; si la discrepancia desaparece por un cambio del OTRO canal, el caso de la contraparte queda abierto hasta que esa contraparte se vuelva a observar.
  **Sobre `company_id` en `model_attributes`/`model_images`:** coincide en que agregarlo sólo a esas dos no arregla nada mientras no haya RLS en ningún lado; el aislamiento pide una política integral de esquema, roles y RLS, no un parche local. Queda como decisión de programa, no como arreglo de T2.
- 2026-09-20 **Los dos arreglos de la revisión externa, hechos.** (1) **`SMTP_SEGURO` entró en `CAMPOS_INFORMES`** (`src/comun/config.ts`): ahora es obligatorio cuando los informes están configurados, porque faltando degradaba el TLS del correo en silencio. **El test viejo afirmaba `seguro: false`, o sea consagraba el comportamiento que vinimos a arreglar**; se corrigió y se agregó el caso que faltaba (omitir `SMTP_SEGURO` tira `ErrorConfig` nombrándola). (2) **`E2-CFG-03` generalizada a los cuatro grupos**: `CATALOGO_*` y `CAMPOS_BARRIDOS` contra el bloque del worker, `CAMPOS_SENALES` contra el de la api y `CAMPOS_INFORMES` contra el del scheduler, cortando cada bloque por indentación porque declarar la variable en otro servicio no sirve. **Las listas se leen de `config.ts`, no se copian al test**: una copia envejecería en silencio, que es el modo de falla que la guarda vino a cerrar. Verificado por mutación en los cuatro grupos: borrando `CATALOGO_COMPARAR_ATRIBUTOS`, `BARRIDOS_KEYRING_FILE`, `SENALES_CUENTAS` o `SMTP_SEGURO` del compose, falla nombrando exactamente esa variable.
  **Y la guarda nueva me atrapó a mí primero**: puse el umbral de sanidad en `> 2` y `CAMPOS_BARRIDOS` tiene sólo dos entradas, así que el test falló por mi propio umbral y no por el compose. Corregido a `>= 2`.
- 2026-09-20 **La revisión externa del propio arreglo encontró un agujero DE LA MISMA CLASE que el arreglo cerraba.** Poner `SMTP_SEGURO` entre los obligatorios tapó la OMISIÓN pero dejó abierta la del TYPO: `env.SMTP_SEGURO === 'true'` convierte `TRUE`, `1`, `tru` o `' true'` en `false` sin avisar, y un typo en un despliegue es más probable que olvidar la variable entera. Arreglado con `booleanoEstricto(nombre, valor)` en `src/comun/config.ts`, que sólo acepta `'true'`/`'false'` y si no tira `ErrorConfig` nombrando la variable y mostrando el valor recibido. Cubierto con los cinco valores malos y con `'false'`. **Lección: un arreglo que cierra una puerta de una clase de defecto no cierra la clase; hay que preguntarse por las otras puertas.**
  **Y la guarda `E2-CFG-03` tenía tres formas de ser burlada, verificadas por mutación:** (1) `includes` aceptaba una variable **COMENTADA** (`# VAR: ${VAR}`) — o sea aprobaba una variable desactivada, y esto pasaba en verde antes del endurecimiento; ahora exige línea ACTIVA con un regex multilínea; (2) `deLista` sólo leía comillas simples, así que pasar una entrada a comillas dobles la volvía invisible — ahora acepta ambas; (3) el corte del bloque de servicio cortaba ante cualquier línea a dos espacios, incluido un **comentario suelto** entre propiedades, y no toleraba claves entrecomilladas — ahora corta sólo ante una clave (`/^ {2}["'\w]/`). Queda una limitación conocida y aceptada: la comprobación es TEXTUAL sobre `compose.yml` y no evalúa el compose efectivo, así que no dice nada de `compose.test.yml` ni del resultado de `extends`.
- 2026-09-20 **Plan de E2 T3 escrito:** `docs/superpowers/plans/2026-09-20-e2-tramo3-taxonomia-colecciones-packs.md`. Ocho tareas. **Las tareas 1 a 3 entregan valor sin esperar ninguna decisión de José** (importar las categorías de canal como evidencia, marcas canónicas y colecciones con vigencia, informe de candidatos y cobertura); la 4 es la decisión del árbol, y de la 5 a la 8 el árbol versionado, el mapeo con primaria explícita y los packs. Antes el plan quedaba bloqueado en la decisión del árbol: el ajuste vino de la revisión externa.
  **Nueve decisiones que serían caras de cambiar después, tomadas en el plan:** la jerarquía de Woo es EVIDENCIA y no se promueve a árbol propio automáticamente; categoría, marca y colección son tres entidades separadas; identidad propia estable e independiente de nombre y slug; un solo padre por categoría, un producto en varias pero con EXACTAMENTE UNA primaria; mapeo a canal por ID remoto y no por nombre, por canal y cuenta; archivar y no borrar; **los packs se componen de VARIANTES VENDIBLES y no de modelos** (el stock de E5 opera sobre SKU); colecciones con vigencia y fuera del árbol; packs en borrador sin precio, stock, explosión de pedidos ni publicación.
  **Cuatro decisiones abiertas para José (D1–D4)**, ninguna bloquea las tareas 1-3: el árbol en sí; qué hacer con las entradas que no son rubro de producto (`QR PAGOS`, `SERVICES`, `ASPIRADORAS`, `FUSIBLES`, `SMARTWATCH`); si los solapamientos se fusionan (`CUBIERTAS` vs `Cubiertas y Cámaras`); y la profundidad máxima más el destino de `BICICLETAS POR MARCA`.
- 2026-09-20 **E2 T3 tarea 1 implementada: importar las categorías de Woo como evidencia** (`plataforma/src/catalogo/categorias-canal.ts`, `plataforma/test/catalogo/categorias-canal.test.ts`, `scripts/catalogo-categorias-importar.mjs`). Upsert idempotente sobre `catalog.channel_categories` (de la migración `0015_catalogo_taxonomia.sql`, escrita en paralelo por otra tarea de T3): `parent=0` de Woo se normaliza a `NULL`; una categoría con cambios cierra la fila vigente y abre una nueva (preserva historia); una que el canal deja de informar se cierra con `vigente_hasta` y **nunca se borra** (forward-only, `plataforma_app` no tiene DELETE); si vuelve a aparecer es una fila nueva, no un revive. Fuente inyectada (`FuenteCategoriasCanal`, mismo patrón que `FuenteLegado` de `backfill-atributos.ts`) para probar sin llamar a Woo. El script sigue el molde de `catalogo-atributos-backfill.mjs`: `--dry-run` por defecto, `--ejecutar` para escribir, PG_* de `process.env`, nunca abre `plataforma.env`; usa `wooFetch` de `routes/woo.js` (paginando `/products/categories?per_page=100`) y resuelve `company_id` desde `core.channel_accounts` por `--cuenta`, para no depender de ningún .env de negocio. 9/9 tests verdes (`npx vitest run test/catalogo/categorias-canal.test.ts` desde `plataforma/`), cubriendo los cuatro criterios de aceptación de la tarea 1: árbol reconstruible con consulta recursiva (INDUMENTARIA Y CALZADO padre de ZAPATILLAS, fixture real en `docs/superpowers/specs/e2/woo-categorias-2026-09-20.md`), idempotencia, reanudación y cierre sin borrado.
  **Hueco dejado a propósito:** no se corrió contra Woo real ni contra producción (fuera de los límites de esta tarea); no se tocó la migración 0015 (la escribe otra tarea en paralelo); `test/migraciones.test.ts` tiene 1 fallo esperado y documentado, ajeno a este cambio (lo cierra la tarea 8).
- 2026-09-20 **E2 T3 tarea 3 implementada: el informe de candidatos, solapamientos y cobertura** (`plataforma/src/catalogo/informe-taxonomia.ts`, `plataforma/test/catalogo/informe-taxonomia.test.ts`, `scripts/catalogo-informe-taxonomia.mjs`, sólo lectura, sin `--ejecutar`). Reusa `normalizarMarca`/`leerArbol` de `taxonomia.ts` (tarea 2/5/6, ya commiteadas en `c57d24b`) y `catalog.channel_categories` de la tarea 1 (esta sesión), que ahora trae `parent_externo`: es la diferencia con el plan original, que sólo tenía la lista aplanada de `categoria_canal`.
  **La partición 65/15/1 no se hardcodea**: `clasificarCategorias()` cada nombre de categoría del canal se coteja, por `normalizarMarca`, contra `catalog.brands`/`brand_aliases` y contra el atributo `marca`/`brand` que ML ya declaró en `model_attributes`, más el patrón del legado `BICICLETAS <marca>`; y contra `catalog.collections` (con `'hotsale'` como red de contención si T2 todavía no corrió). Todo lo que no case cae en `taxonomia` (default seguro, no se adivina).
  **Solapamientos distinguidos en dos grupos** (`detectarSolapamientos`, sobre `valoresRelacionados`/`tokensComparacion` de `atributos.ts`): "emparentados" son pares padre-hijo en la jerarquía real del canal (leída desde `parent_externo`) — nada que decidir, es justo el caso de `CUBIERTAS`/`Cubiertas y Cámaras` y `LIQUIDOS DE FRENOS`/`LÍQUIDOS` que José creía duplicados; "sin emparentar" son parecidos por nombre pero sin relación de parentesco, y esos sí son candidatos a fusión que José tiene que decidir.
  **Cobertura** (`medirCobertura`) cuenta, no abre casos: modelos sin `categoria_canal` capturado, con más de un valor distinto, cuyas categorías caen TODAS en marca/colección (ninguna en taxonomía), y con `categoria_canal` de Woo y de ML capturados que no están relacionados por tokens (contradicción real entre canales).
  9/9 tests verdes (`npx vitest run test/catalogo/informe-taxonomia.test.ts` desde `plataforma/`), sobre un recorte del fixture real (`docs/superpowers/specs/e2/woo-categorias-2026-09-20.md`): `Cubiertas y Cámaras`⊃{`CUBIERTAS`,`CAMARAS`}, `LÍQUIDOS`⊃`LIQUIDOS DE FRENOS`, `BICICLETAS POR MARCA`⊃`BICICLETAS TREK`, `Hotsale`, `CASCOS`.
  **Hueco dejado a propósito:** no se corrió contra datos reales de producción, sólo contra el fixture; el informe no decide nada de D1-D4 (eso es la tarea 4, con José); no se tocó `taxonomia.ts` ni la migración 0015.

## E2 tramo 3 — taxonomía, marcas, colecciones y packs (2026-09-20)

**Desplegado en producción el 2026-09-20.** Migración `0015_catalogo_taxonomia.sql` y
`plataforma/src/catalogo/{taxonomia,packs,categorias-canal,informe-taxonomia}.ts`, con sus cuatro
archivos de test (17 + 9 + 9 + 10 verdes) y los scripts `catalogo-categorias-importar.mjs` y
`catalogo-informe-taxonomia.mjs`. El contrato `docs/superpowers/specs/e1/schema.sql` está al día y
`test/migraciones.test.ts` vuelve a 8/8.

Decisiones que no hay que volver a discutir (las cerró José el 2026-09-20 con la jerarquía real
a la vista, `docs/superpowers/specs/e2/woo-categorias-2026-09-20.md`):

- El árbol propio **se diseña de cero**; la jerarquía de los canales es evidencia y se mapea
  contra él por ID REMOTO, nunca por nombre. Nunca se promueve sola.
- Los «solapamientos» de Woo **no existían**: eran padre e hijo, aplanados por nuestra propia
  importación (`Cubiertas y Cámaras` ⊃ `CUBIERTAS`, `LÍQUIDOS` ⊃ `LIQUIDOS DE FRENOS`).
- `Hotsale` es colección con vigencia; `SERVICES` y `Taller` son un rubro de servicios; `FANTTIK`
  es marca; `BICICLETAS POR MARCA` se colapsa a un árbol por tipo de bici con la marca como eje
  aparte. No se fija profundidad máxima en el esquema, pero sí se prohíben los ciclos.
- Los componentes de un pack son **variantes vendibles**, no modelos. Los packs nacen en borrador
  y sin precio, reserva de stock, explosión de pedidos ni publicación: las cuatro están diferidas.

La identidad de un nodo (`taxonomy_nodes`) está separada de su nombre y su padre
(`taxonomy_node_versions`): renombrar un rubro no cambia su id ni mueve el mapeo con el canal, y
una versión pasada se reconstruye entera. Es lo que E12/E13 necesitan para publicar lo aprobado.

El árbol propio está implementado pero **vacío**: cargarlo es la primera corrida operativa.

Los once hallazgos de la revisión independiente se arreglaron ANTES de desplegar (`5a71691`). Los dos
que importan para quien siga, porque daban resultados falsos sin un solo error:

- **La importación de categorías cerraba todas las vigentes ante una lectura incompleta.** Un 200 con un
  cuerpo que no es lista (el HTML de un WAF, el objeto de error de WordPress) se volvía «página vacía» y
  de ahí «el canal no tiene categorías». Ahora se niega si no leyó nada o si la baja supera el 20%, salvo
  `permitirBaja`, y el script coteja el total contra `X-WP-Total`. Mismo criterio que `catalog.copias`:
  **una lectura parcial no se distingue de una baja, así que no se trata como una baja.**
- **El informe comparaba el nombre de Woo contra el id `MLA…` de ML.** T2 guarda `categoria_canal` de Woo
  como NOMBRE y de ML como `category_id`, así que todo modelo publicado en los dos canales se contaba como
  contradictorio. Se traduce el id a nombre contra `channel_categories` (`nombresPorIdExterno`). Es la
  misma razón por la que `categoria_canal` quedó fuera de la comparación de `atributo_divergente` en T2.

Tres tipos de caso (`categoria_sin_mapeo`, `marca_ambigua`, `categoria_en_conflicto`) se sacaron del CHECK
de `identity_cases` antes de desplegar: nadie los abría y **dos no se pueden ni representar**, porque
`identity_cases_objeto_check` exige una variante o una representación y una categoría del canal no es
ninguna de las dos. En su lugar `asegurarMarca` falla con `ErrorMarca` ante un alias ambiguo.

`escribirArbol` escribe en tres pasadas y en orden topológico, así que el resultado no depende del orden
del arreglo de entrada y una reorganización (invertir padre e hijo) no falla por un estado intermedio
inválido. Los ciclos y el padre inexistente los rechaza la BASE, con tests que escriben por fuera del
código para probar que la garantía no vive en TypeScript.

## La asimetría de `categoria_canal` volvió a morder, del otro lado (E2 T3, 20/09)

El desglose de granularidad del informe (`medirCobertura`, clases 1a/2/3) sube por la cadena de ancestros
de `channel_categories`, que se indexa por `id_externo`. **Woo guarda `categoria_canal` como NOMBRE y ML
como id**, así que la primera versión buscaba los 81 valores de Woo por nombre contra una tabla indexada
por id: 0 aciertos, y la dirección Woo→ML del criterio era código muerto contra los datos reales. Medido:
los 126 valores de ML existen como `id_externo`, los 81 de Woo **ninguno**.

Y era **silencioso** porque `ancestrosDe` devolvía `incompleta: false` para un id que no estaba en el mapa:
«raíz legítima» y «no la encontré» eran indistinguibles. El test lo tapaba porque su fixture usaba ids de
Woo, que el canal no guarda — **un fixture cuya forma no es la de producción no prueba la función que
corre**. Se arregló el aviso ANTES de la causa, para que el instrumento quede puesto.

Ahora el valor se resuelve a id dentro de su canal (id directo, o nombre único), y un nombre que no
resuelve o resuelve a varios ids vigentes no se adivina: suma a `cadenasIncompletas`. En producción hoy:
0 ids repetidos entre canales, 0 nombres de Woo ambiguos, 0 valores sin resolver, así que
`cadenasIncompletas: 0` es un cero real. `padres` sigue global por id a propósito: el cruce entre canales
es imposible con Woo numérico y ML `MLA…`, y complicar el mapa por un riesgo medido en 0 no se paga.

**Resultado: 942 modelos en ambos canales = 402 por nombre + 231 por granularidad + 309 contradicciones
reales.** Las 309 encabezadas por `TRANSMISIÓN ~ Cadenas` (41), `Piñones` (38), `Plato Palanca` (29): o sea
que siguen siendo granularidad, no error. El criterio es un **puente declarado en el código**; lo exacto
llega cuando las categorías de los dos canales estén en `taxonomy_channel_map` y la pregunta sea «¿caen en
el mismo nodo?». Tamaño de esa decisión: 126 categorías de ML en uso, **9 cubren el 50% de los modelos y
30 el 80%**.

Commits: `5d20734` (desglose), `4b2cb52` (los dos arreglos). Nada publicado: la versión 2 del árbol sigue
en borrador, esperando que José mire los 65 nodos y los 78 mapeos.

## El árbol propio existe, y la comparación entre canales pasó a ser exacta (E2 T3, 20/09)

**Versión 2 publicada** (`estado='vigente'`, 65 nodos, 6 raíces, 0 mapeos colgados). Es la primera acción del
tramo que cambia lo que el sistema hace: `leerArbol` y `clasificarModelo` ya ven el árbol. **No reclasificó
nada**: `model_categories` sigue en 0 y clasificar es un paso aparte. Publicar creó el lugar, no movió producto.

Publicar tiene un solo modo de romper algo, y por eso hay un script (`catalogo-arbol-publicar.mjs`) y no un
UPDATE a mano: `taxonomy_channel_map` apunta al NODO, que vive **fuera** de la versión, así que publicar una
versión que no contenga un nodo mapeado deja el mapeo apuntando a la nada y los modelos de esa categoría sin
clasificar, en silencio. El script lo verifica, exige el id de versión explícito y comprueba alcanzabilidad
desde una raíz. La misma garantía faltaba del otro lado de la puerta — `aplicarMapeoCategorias` verificaba que
el nodo existiera, no que estuviera en la versión vigente — y se cerró en `9a2d624`.

**Las 10 categorías de ML que cubren la mitad del catálogo, mapeadas** (D8/D9). Con eso la pregunta «¿coinciden
los canales?» dejó de ser una heurística de nombres y pasó a ser «¿caen en el mismo nodo?». Medido:

| de 942 modelos en ambos canales | |
|---|---|
| mismo nodo | 359 |
| uno es ancestro del otro | 12 |
| nodos distintos | **15** |
| sin nodo en algún canal | 556 |

Los 12 son bicicletas y **no son un error**: Woo dice la marca y ML la raíz `BICICLETAS POR MARCA`, que es D8
funcionando. Los 15 sí son un conflicto real de criterio: Woo en `GRASAS` (11) y `LIQUIDOS DE FRENOS` (3)
contra ML en `LUBRICANTES`. Son hermanos bajo TALLER, no padre e hijo. **Pendiente de José: ¿una grasa es un
lubricante?** De 942 «contradicciones» a 15 decisiones humanas.

El campo `contradictoriosEntreCanales` **se eliminó** y el criterio de nombres quedó agrupado en
`cobertura.puente`, que cubre exactamente `sinNodoEnAlgunCanal`. Había cambiado de significado dos veces y nada
fuera del informe lo consumía: el único riesgo era humano, alguien leyendo un número creyendo que medía lo de
antes. Un campo cuyo nombre sobrevive a tres significados es una trampa con antigüedad.

Commits: `ea5d534` (publicador), `52eb474` (MAPEO_ML), `9a2d624` (comparación por nodo), `5fcd9a5` (renombre).

## La regla «alguna contra alguna» escondía los desacuerdos reales (E2 T3, 20/09)

Los números de la sección anterior (359 / 12 / 15) eran una aproximación mía por SQL que nunca aplicó la regla
de ancestro. El informe real, con la regla acordada, dio **`nodosDistintos: 0`**: cero desacuerdos, con 14 que
existían. Causa: **Woo etiqueta el padre Y la hija a la vez** (`TALLER` + `GRASAS`), así que con «basta que
alguna categoría de un canal se relacione con alguna del otro», el `TALLER` de Woo resultaba ancestro del
`LUBRICANTES` de ML y el par contaba como acuerdo. El desacuerdo verdadero quedaba tapado por el padre
genérico que el propio canal agregó. Es la misma trampa que opt-2b había advertido para `ACCESORIOS` contra
«Accesorios para Bicicletas», y la dejé pasar sin medirla; el defecto fue de la consigna, no del código.

**Regla nueva: se comparan sólo las HOJAS de cada canal.** Antes de comparar se descarta todo nodo que sea
ancestro propio de otro nodo del mismo canal y modelo. La categoría de un modelo es su nodo más específico; el
padre que el canal agrega de paso no es información nueva y no puede servir de acuerdo. Verificado en
producción, y coincide al dígito con una consulta SQL independiente:

| de 942 modelos en ambos canales | |
|---|---|
| mismo nodo | 277 |
| uno es ancestro del otro | 95 |
| **nodos distintos** | **14** |
| sin nodo en algún canal | 556 |

Los 14 son `GRASAS → LUBRICANTES` (11) y `LIQUIDOS DE FRENOS → LUBRICANTES` (3), y nada más.

Corolario que va a volver al clasificar: **1.296 modelos tienen más de una categoría candidata**, casi un
tercio del catálogo, por este mismo hábito de Woo de etiquetar padre e hija. Clasificar tendrá que elegir la
hoja, igual que acá.

## D12–D14 — lubricantes, baldes de ML y jerseys (20/09)

**D12.** Para José `LUBRICANTES` es específicamente lubricante de cadena, así que **una grasa no es un
lubricante** y Woo tiene el nodo correcto. Su consecuencia esperada («entonces están mal cargados en ML») **no
se puede ejecutar**: ML no tiene categoría de grasas ni de líquido de frenos — verificado contra
`/categories/MLA371402`, público y sin token. Su `Lubricantes` es un balde con tres cosas que nuestro árbol
separa. De los 89 modelos, 66 no están en Woo: por título, 49 son lubricante, **12 dicen «grasa»**, 5 dudosos.
Decisión: mapear a `lubricantes` y **corregir esas 12 a mano al clasificar** (deuda anotada con su criterio de
detección). Descartado mapear al padre `taller`, que no habría dejado nada mal pero habría bajado de nivel a 61.

**D13.** `Otros Repuestos` (39) y `Productos no categorizados` (37) van **sin equivalencia**, con el motivo en
la BASE y no sólo en el código: son baldes que significan «no sé», y mapearlos sería inventar información que
ML no dio. No son «fuera del árbol»: están sin decidir del lado de ML, que es otra cosa.

**D14.** `Camisetas y Remeras` → `jerseys-y-calzas`, decidido leyendo los 27 títulos: 26 son ropa técnica de
ciclismo (`Jersey Ciclismo Funkier`, `Primera Piel Santini`, `BASE LAYER`) y el único que dice «urbana`
también dice «ciclista». Coincide con dónde ya están en Woo.

Con las 21 nuevas categorías el catálogo queda mapeado al **80%** desde el 51%.
