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
- Ambos números reales siguen pendientes de onboarding/coexistencia con los teléfonos.
  `INBOX_CONNECTED_NUMBER_IDS` vacío: no se habilitan envíos reales de WhatsApp.
- Origin de escritura: `INBOX_PUBLIC_ORIGIN` (por defecto `https://herramientas.fusionbikes.com.ar`).
  En QA o local hay que definirlo con la URL del entorno (QA lo trae en `qa.env`); si no, toda
  escritura responde 403 `csrf`.
- Un rol guardado en `mensajeria_roles` manda sobre `is_admin`: quitarle el rol a un admin lo deja
  sin Mensajería; la guarda `last_supervisor` impide quedarse sin ningún supervisor.

## Verificación de publicación

Activado el 2026-10-07 a las 13:33 UTC. Se reconciliaron 526 conversaciones y 1.372
mensajes de WordPress (1.203 ya existentes, 169 nuevos), sin emisiones históricas.
Ambos accesos Chat verificados hacia la bandeja, Matías con control completo y
respuesta positiva del callback firmado de presencia. No se enviaron mensajes reales
a clientes como prueba. Los servicios aislados de QA se detuvieron al terminar.
