# Mensajería de Fusion Bikes



## Entrada y equipo



Una bandeja para Chat web y WhatsApp: Home → Atención al cliente → Mensajería,

`/herramientas/mensajeria/`. Cada persona usa su cuenta de Herramientas.

Matías conserva la administración global y tiene control completo de Mensajería.

José supervisa y atiende; Santi, Miguel y Fabri atienden. El rol específico del

módulo prevalece sobre los permisos generales; no modifica otros módulos.



Las entradas Chat de `/gestion-fusion/?seccion=chat` y WordPress

`admin.php?page=fusion-live-chat` abren esta misma bandeja al activar el modo común.

Las pestañas antiguas no pueden tomar, responder, liberar ni borrar conversaciones.

Contactos, popup y configuración de Fabri IA siguen accesibles en WordPress.



## Atención de ambos canales



- Elegir Todos los canales, Chat web o WhatsApp; buscar nombre, teléfono o texto.

- Tomar la conversación asigna un único responsable y pausa la IA.

- Transferir conserva la pausa y el historial. Liberar deja pendiente sin reactivar IA.

- Notas privadas quedan sólo para el equipo. Cerrar conserva todo el historial.

- Reanudar IA es explícito, respeta el encendido y el horario del canal y cada número.

- Teléfono copiable y producto/página consultada aparecen en el detalle de Web.

- Un mensaje nuevo reabre un chat cerrado sin quitarle el responsable.

- Un resultado de envío incierto exige revisar antes de repetir: no se reenvía solo.

- La disponibilidad del equipo se refleja en el widget mediante un resumen global.



El widget web mantiene su aspecto, captura de WhatsApp y mensajes del visitante.

Recibe texto/enlaces; no ofrece adjuntos hasta disponer de un transporte compatible.

WhatsApp conserva imágenes/audio/video/PDF; texto libre sujeto a su ventana de 24 h.

Las conversaciones se relacionan por teléfono sin fusionar identidades automáticamente.

La edición posterior de un teléfono ya registrado requiere reconciliación: un snapshot

viejo no puede borrar un número capturado por IA ni cambiar el responsable.



## Arquitectura



Historial central, búsquedas, agentes, roles, notas, IA y cola de respuestas viven en el VPS.

WordPress mantiene el widget y una copia de mensajes/estado para mostrarlo al visitante.

El puente envía eventos de cliente y recibe respuestas/estado firmados; no hace una

consulta completa a WordPress por cada actualización de la bandeja de un agente.

POS, facturador, Master Control y plugin oficial de Meta de facturación no se modifican.



Identificadores Web expuestos a los agentes son opacos `webthread:<uuid>`; el token del

widget permanece sólo en el servidor. El BFF usa sesión, Origin, CSRF y firma exclusiva

con nonce. El callback WordPress usa la firma existente y revisión monotónica por chat.

Mensajes idempotentes `inbox:<uuid>`; cambios de responsable y envío se serializan.

Importación histórica sin IA ni mensajes salientes, con fechas originales y mapeo de IDs.

El cron antiguo de borrado de 90 días se detiene mientras esté activo el modo común.



## Operación y recuperación



- Node: `routes/mensajeria.js`, `public/mensajeria/`; bot: `app/inbox*.py` y `outbox_worker.py`.

- WordPress: Fusion Live Chat 1.7.18, rutas firmadas `inbox-export`, `inbox-mode`, `inbound`.

- Corte coordinado por `web_inbox_enabled` en VPS y `fusion_live_chat_unified_enabled` en WP.

- Respaldo privado: `/opt/fusionbikes/backups/mensajeria-unificada-20261007/cutover`.

- Coordinador: `/opt/fusion-unified-release-20261007/remote_release.py` (verify/rollback).

- Rollback conserva historial y esquema aditivo. Nunca restaurar una base antigua sobre

  mensajes nuevos. Un reintento de corte sólo refresca estado inicial sin actividad central.

  Tras una activación completada, `web_inbox_activated_at` bloquea otro corte automático:

  después de un rollback se requiere reconciliar explícitamente la actividad posterior.

- Ambos números tienen coexistencia y atención manual habilitada. La IA de WhatsApp

  permanece apagada para ambos; el control es independiente por número. No repetir onboarding.



## Verificación de publicación



Activado el 2026-10-07 a las 13:33 UTC. Se reconciliaron 526 conversaciones y 1.372

mensajes de WordPress (1.203 ya existentes, 169 nuevos), sin emisiones históricas.

Ambos accesos Chat verificados hacia la bandeja, Matías con control completo y

respuesta positiva del callback firmado de presencia. No se enviaron mensajes reales

a clientes como prueba. Los servicios aislados de QA se detuvieron al terminar.





## Bandeja, audio e inicio de contacto (2026-10-07)



Lista compacta con nombre, hora, vista previa, canal/línea y responsable. Lista e historial

se desplazan por separado; en móvil se abre una conversación y Volver regresa a la lista.

Enter envía texto; Shift+Enter agrega una línea. La composición IME y teclas repetidas no envían.



En WhatsApp: tomar el chat, pulsar Audio, detener, escuchar y Enviar audio. Requiere permiso

del micrófono en el navegador. Se puede descartar antes del envío; no se envía al detener.

Máximo 5 minutos y 16 MB. Cambiar de chat, perder permisos o salir libera el micrófono.

Una grabación pendiente vive en memoria y se pierde al recargar; no afecta el borrador de texto.

El backend convierte WebM/Ogg/MP4 a Ogg Opus mono y valida la salida antes de marcarla como voz.

El widget Web sigue siendo texto/enlaces: no anunciar audio Web sin ampliar su transporte.



Nuevo chat permite elegir la línea e ingresar el número internacional con + y código de país.

Crear/abrir no envía nada, no abre la ventana de 24 h y no cambia el responsable de un hilo existente.

Fuera de esa ventana se usa Plantilla: elegir una aprobada, completar variables si las tiene,

generar vista previa, confirmar permiso para contactar y enviar. Meta puede cobrar ese mensaje.

Sólo se admiten plantillas de texto con parámetros posicionales; encabezados de medios y botones

se muestran no compatibles. No usar plantillas de facturación como saludo.



Meta aprobó fusion_inicio_atencion/es_AR en ambas cuentas el 2026-10-07;

la lista muestra el estado actual, admite Actualizar y sólo permite las aprobadas compatibles.

El texto se identifica como Fusion Bikes y enlaza el sitio oficial. El aviso de servicio seguro

de Meta es generado por WhatsApp, no por esta aplicación; no equivale a una insignia verificada.

Referencia: https://faq.whatsapp.com/643460927283235/?lang=es



API propia: POST /start, GET /templates, POST /template-preview y command/send.template.

Catálogo acotado a la WABA de la línea; revisión de hash/estado antes de encolar y de enviar.

Permisos, propietario, revisión, CSRF, firma, opt-in e idempotencia se conservan. Un resultado

ambiguo no se reenvía automáticamente. Conversión acotada a dos trabajos por proceso, 30 s CPU,

512 MB, 16 MB y 5 min; archivos locales, sin red y sin referencias externas de contenedores MOV.

Migración aditiva: inbox_media.is_voice BOOLEAN NOT NULL DEFAULT FALSE.



Imagen de esta entrega: fusion-chatbot-inbox-tools:20261007 (FFmpeg/ffprobe incluidos).

Fuente del bot replicada en integrations/mensajeria/bot; pruebas backend en bot/tests.

Respaldo: /opt/fusionbikes/backups/mensajeria-usabilidad-20261007.

Coordinador: /opt/fusion-inbox-tools-release-20261007/remote_deploy.py.

Rollback: python3 <coordinador> rollback. Detiene API/worker/outbox, cancela sólo plantillas

todavía en cola incompatibles con el código anterior y restaura el software. Conserva historial,

esquema, configuración de IA y conexión; nunca restaurar la base antigua sobre mensajes nuevos.





## Compartir productos, facturas y seguimiento (2026-10-07)



Acciones visibles junto al editor: Archivo, Audio, Producto, Factura y Seguimiento.

Producto abre un buscador por nombre/SKU con miniatura, variante, stock, fecha y precio

contado/transferencia web (precioContado sobre precio vigente, incluidas ofertas; no lista ML).

Consulta el catálogo SQLite local, con máximo 30 resultados. Elegir prepara un borrador;

Enviar sigue siendo explícito. No cambia checkout, Master Control ni stock.



Pedidos: copia sincronizada local, coincidencia exacta de teléfono completo y país;

nunca por últimos dígitos ni fusión automática. Hasta 50 pedidos recientes para elegir.

Factura agrega directamente el PDF único y vuelve a validar el teléfono en la tienda antes de

consultar comprobantes ya autorizados de producción y obtener el PDF. Puente de lectura

0.5.0 conserva autenticación Woo y permiso administrativo. GET acotado por pedido, sin

emitir, enviar, modificar pedidos o crear enlaces públicos. Sólo esta acción consulta

al facturador web. El archivo privado usa el transporte existente y queda en borrador;

su referencia sobrevive a recarga para el mismo operador y conversación. El servidor

verifica pertenencia y vigencia al enviar. Audio pendiente sigue siendo sólo en memoria.



Seguimiento usa números Andreani confirmados en preparaciones web, con enlace oficial

www.andreani.com/envio/<numero>. Exportar etiquetas no prueba que haya seguimiento.

Si no existe número registrado, se informa y no se inventa. El widget Web admite producto

y seguimiento como texto/enlaces; el PDF requiere WhatsApp. Fuera de la ventana de 24 h

desde el último mensaje entrante del cliente se ofrece Plantilla; dentro permanece oculta.



Contrato BFF: GET /products, GET /commerce/orders y POST /commerce/prepare.

Conserva sesión, permisos, responsable, Origin/CSRF, revisión e idempotencia del envío.

Fuentes: lib/mensajeriaCommerce.js, lib/mensajeriaInvoiceSource.js y

integrations/mensajeria/wordpress/fusion-herramientas-bridge. No cambia esquema ni bot.

Rollback de esta ampliación restaura software sin restaurar bases ni cancelar mensajes:

python3 /opt/fusion-inbox-share-release-20261007/remote_deploy.py rollback

Respaldo: /opt/fusionbikes/backups/mensajeria-compartir-20261007.

El puente puede permanecer como lectura o volver al ZIP 0.4.0 respaldado desde WordPress.

IA WhatsApp y emisores POS/ARCA se conservan; la emisión sigue únicamente en la web.





Publicación comercial verificada 2026-10-07: puente WordPress 0.5.0 actualizado y

Herramientas recargado, ambos health correctos. Producto FB-70394 confirma contado

ARS 4.450.000, stock y miniatura; buscador por nombre/SKU y preview comprobados en

conversación propia. PDF autorizado existente leído y validado en memoria, rechazo de

teléfono ajeno confirmado. Sin emisiones ni mensajes de prueba a clientes. IA, bot y

configuración conservados. Envío completo probado sólo con transporte sintético en QA.

Servicios de QA detenidos; rollback y respaldo conservan historial productivo.



Miniaturas de productos: admite AVIF además de JPEG/PNG/WebP/GIF de uploads HTTPS de la tienda; no SVG ni dominios ajenos.



## Ficha comercial y adjuntos directos (2026-10-07)

Acciones + Archivo, + Audio, + Producto, + Factura y + Seguimiento. Solo con stock Sí
filtra cantidad positiva antes del límite de 30; No incluye todos. Consulta local por tecla.
Al elegir, cotización GET comercial autenticada de la tienda, caché 60 s; contado y cuotas
6/9/12/18/24 con el redondeo de la ficha pública y envío gratis según umbral Master Control.
Puente 0.5.1 sólo agrega installment_amount y free_shipping al contrato de lectura.
Master Control no cambia. Foto de uploads del dominio propio, sin redirects/credenciales,
8MB/25Mpx máximo de entrada, JPEG privado de hasta 640px y 2MB, 2 conversiones concurrentes.
La foto acompaña el texto en WhatsApp; web conserva texto/enlace. Enviar siempre explícito.
Factura: elegir pedido con un comprobante lo agrega directamente al borrador. Varios
comprobantes presentan elección; sin casilla de confirmación. Teléfono exacto y autorización
se validan en ambos servidores. No se emite otra factura. PDF y foto preparados persisten
por operador/conversación al recargar. Revalidación de responsable/ventana antes de adjuntar.
Rollback: python3 /opt/fusion-inbox-ficha-release-20261007/remote_deploy.py rollback
Backup: /opt/fusionbikes/backups/mensajeria-ficha-20261007. Sin restauración de bases.
El puente 0.5.1 es aditivo, puede permanecer o volver al ZIP 0.5.0 respaldado.


Ficha comercial publicada y verificada 2026-10-07: puente de lectura 0.5.1 y Herramientas
activos. Comprobados SKU FB-47935, contado3200000, cuotas6/9/12/18/24 y fotoJPEG privada.
Filtro de stock Sí/No y botones + operativos. Factura única directamente al borrador;
varias requieren selección. Sin emisión ni mensajes de prueba a clientes reales.
IA, bot y Master Control conservados. QA aislado cerrado. Si se revierte a la UI anterior,
una foto JPEG todavía en borrador podría requerir adjuntarse nuevamente después de F5;
texto e historial no se restauran ni se reenvían. Backup y rollback en README operativo.


### Mensajería: pendientes y paneles (publicado 2026-10-08)

Pendientes corresponde a chats abiertos con mensajes sin leer; Todas conserva los leídos. Confirmación explícita POST /read al mostrar historial visible al final, con límite de mensaje perteneciente al chat y contador conservador ante nuevas entradas. No cambia responsable, estado, revisión, orden ni IA. Perfil lector no consume pendientes. Separador de escritorio ajustable por arrastre/teclado con preferencia local por operador; móvil conserva panel completo. Publicado y verificado en producción. Importaciones históricas no generan ni retienen pendientes. Todas las reglas de ancho de escritorio incluyen las tres columnas.

La ficha compartida omite el SKU en el texto; el buscador lo conserva. Contado y cuotas llevan presentación comercial y la leyenda de tarjetas bancarizadas y no bancarizadas; importes siguen verificados por Master Control y envío gratis sólo cuando la fuente lo confirma.

Operación de esta actualización: respaldo `/opt/fusionbikes/backups/mensajeria-pendientes-20261007`;
rollback `python3 /opt/fusion-inbox-pending-release-20261007/remote_deploy.py rollback`.
Reversión de software, sin restaurar datos de chats ni tocar colas. Sólo se renueva
la imagen de API (worker y outbox conservan su imagen vigente). Lectura es compartida
por equipo, no un estado individual por operador. El separador guarda su ancho
localmente por operador; flechas ajustan, doble clic o Enter restablecen.

La confirmación de lectura se suspende mientras un diálogo tapa el historial. El encabezado y los filtros se acomodan en varias líneas al reducir la lista a su ancho mínimo.

Publicación 2026-10-08 verificada: API y worker usan fusion-chatbot-inbox-pending:20261007;
salud de bot/Herramientas correcta. Interruptores preservados: 2035 habilitada y 4819
deshabilitada. Matías administrador general y supervisor. IA y operación muestra causas
de inactividad; pausar/tomar un chat mantiene precedencia sobre la habilitación del número.
Credenciales comerciales en .commercial.env privado, fuera del código y de la imagen;
sólo GET a cotizaciones Master Control y gateway BACS. Catálogo y stock siguen locales,
cotizaciones con caché 60 s. Rollback respaldado en
/opt/fusionbikes/backups/mensajeria-pendientes-20261007; ejecutar
python3 /opt/fusion-inbox-pending-release-20261007/remote_deploy.py rollback.
La reversión restaura software, sin restaurar bases vivas ni reenviar mensajes.
