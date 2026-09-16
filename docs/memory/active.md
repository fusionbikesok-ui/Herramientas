# Estado activo

Actualizado: 2026-09-15.

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
  - **Nginx (VPS, fuera del repo) desde 2026-09-16**: `location ~* ^/(herramientas/+)?internal(/|$) { return 404; }`
    en `sites-available/herramientas` y `sites-available/fusionbikes` (el `default_server` del 80 también
    proxea `/herramientas/`). Copia previa en `/root/nginx-backup-e1c5/`. Evidencia: `scripts/qa/deny-interno.sh`.
  - **El legado escucha en `*:3001` sin firewall**: responde desde Internet por IP sin pasar por Nginx
    (verificado 2026-09-16, `/healthz` 200). El gateway se protege validando el origen por socket; cerrar
    3001 hacia afuera queda pendiente de decisión operativa.
  - **C6 (relectura por señal)**: `worker/senales.ts` + `reconciliacion/relectura.ts` (relectores por
    tópico) + `senales-cola.ts` (lease, backoff, dead letter). Los normalizadores de recurso se exportan
    desde los adaptadores y los usan barrido y relectura, para que la versión y la proyección coincidan.
    `persistirRecurso` recibe un `ContextoEscritura` con `runId` opcional y usa `coalesce` sobre
    `last_seen_run_id`: una relectura durante una vuelta completa no puede provocar una baja falsa.
    Inbox `source='signal_reread'` (0007). Mensajes adelantan `next_run_at` del barrido en vez de
    resolver el id. El bucle del worker ya no se superpone: barridos y después señales, una vuelta a la vez.
  - La cola de sombra del legado (`crearColaSombra`) todavía no tiene `enviar` conectado: el cliente
    firmado que la une con la API de C3 no está implementado y la copia sigue apagada por flag.
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
