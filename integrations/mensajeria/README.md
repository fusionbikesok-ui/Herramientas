# Mensajería de Fusion Bikes

## Entrada y equipo

Entrar desde Home → Atención al cliente → Mensajería, o `/herramientas/mensajeria/`.
Cada persona usa su sesión existente de Herramientas. José supervisa y atiende;
Santi, Miguel y Fabri atienden; Matías consulta el historial para revisar calidad.
El rol específico de mensajería prevalece sobre el administrador general.
José puede gestionar esos roles desde Equipo; debe quedar al menos un supervisor.

## Atención

- Elegir Sin asignar y Tomar conversación. Un único responsable puede tomarla.
- Responder, adjuntar imagen/audio/video/PDF o guardar una nota privada para el equipo.
- Transferir entrega la atención a otro agente y mantiene pausada la IA.
- Liberar deja la conversación sin responsable y mantiene la IA pausada.
- Cerrar termina la atención; un mensaje nuevo del cliente vuelve a abrirla.
- Reanudar IA es explícito y respeta el apagado general y el control de cada número.
- La disponibilidad Disponible/Ocupado/No disponible se informa al equipo; no asigna chats sola.
- Sin confirmación de envío requiere revisar antes de volver a enviar. El servidor nunca
  reenvía automáticamente una entrega ambigua.
- El texto libre requiere un mensaje entrante reciente (24 horas). Los históricos no abren
  esa ventana. El compositor de plantillas aprobadas no forma parte de esta entrega.

## Chat web y conexión pendiente

El widget web existente conserva su atención, captura de WhatsApp y derivación a humano.
La nueva bandeja consulta conversaciones de WhatsApp del VPS. Cuando el teléfono coincide,
el detalle muestra contexto del chat web (consulta/producto, derivación y últimos mensajes).
No convierte el número dejado en el chat web en un envío automático de WhatsApp.
POS, facturador y plugin oficial de Meta de facturación siguen con su operación web.

Ambos números reales quedan pendientes del onboarding de coexistencia con los teléfonos.
La app Meta no fue publicada por esta entrega. `INBOX_CONNECTED_NUMBER_IDS` permanece vacío,
por lo que no se permiten envíos reales desde la bandeja ni el worker. Cada bot mantiene su
control independiente y el apagado general. Los ensayos usan datos y transporte ficticios.

## Operación y mantenimiento

- Fuentes Node: `routes/mensajeria.js`, `public/mensajeria/`.
- Bot: `/opt/fusion-chatbot/app/inbox*.py` y `outbox_worker.py`.
- Proxy exclusivo firmado mediante `INBOX_PROXY_SECRET`, guardado sólo en los `.env` del VPS.
  Sesión, permisos vigentes, Origin, CSRF, nonce anti-replay y revisión del chat son obligatorios.
- PostgreSQL conserva las conversaciones; migraciones aditivas, cola durable, notas, auditoría
  y adjuntos privados. SQLite de Herramientas guarda únicamente los roles del módulo.
- Docker servicios `api`, `worker`, `outbox`; imagen `fusion-chatbot-mensajeria:20261007`.
- Backups privados: `/opt/fusionbikes/backups/mensajeria-20261007`.
- Verificar: `python3 /opt/fusion-messaging-release-20261007/remote_deploy.py verify`.
- Revertir software: `python3 /opt/fusionbikes/backups/mensajeria-20261007/rollback-deploy.py rollback`.
  Restaura fuentes/configuración/permisos previos y conserva el esquema aditivo y todo historial.
  No se debe restaurar la base completa sobre nuevas conversaciones: el dump es para recuperación.

## Evidencia

Pruebas PostgreSQL/Redis aislados: concurrencia de cinco agentes, duplicados, cambio de
responsable, pausa durante IA, colas, recuperación tras corte, historial tardío, ecos, firmas,
adjuntos y regresión del chat web. Pruebas Node: BFF/sesiones, permisos, CSRF, parser de adjuntos,
roles específicos, UI y recuperación de paginación. Navegador: 390/768/1440 px; toma, nota,
respuesta y archivo ficticios, transferencia y Matías sólo lectura. No hubo mensajes reales.
