# Alertas internas de reposición

Ejecutor privado: `/opt/fusion-management-migration/alerts/run_alerts.py`.
Programación nativa del VPS: `fusion-stock-whatsapp.timer` comprueba cada minuto el horario guardado.
Fuera del minuto programado, con pausa general o sin destinatarios activos, termina sin consultar
catálogo, Docker ni Meta. No recupera horarios perdidos. Hora inicial: 09:00 Argentina.

El archivo privado `alert_config.json` conserva emisor, plantilla y configuración técnica.
Los destinatarios, etiquetas, hora y pausas se editan como administrador en Stock y reposición →
Alertas por WhatsApp → Configurar → Guardar cambios. Fuente vigente de esos campos:
`/var/lib/fusion-management-validation/stock-alert-settings.json` (0600, dueño DynamicUser
del gateway). No copiar datos personales al repositorio. Guardar no envía; afecta el próximo
envío programado. No cancela una petición a Meta ya en curso. Emisor 2035 fijo.
Para pausar la programación completa:

    systemctl disable --now fusion-stock-whatsapp.timer

El cálculo importa el mismo `stock-report.mjs` del informe comercial: ventas de
90 días, cobertura menor a 15 días, variantes independientes y servicios excluidos.
Las fuentes son las SQLite/JSON locales; no consulta WooCommerce. Rechaza fuentes
vencidas, cantidades no verificadas y productos ambiguos. El historial parcial
de Mercado Libre se aclara en el texto. No decide cantidades de compra ni escribe
stock, pedidos o precios.

Un resumen por destinatario cuando aparecen productos críticos o baja más su stock.
Sin mensajes por stock idéntico o mejorado; una recuperación permite avisar si
vuelve a entrar en crítico. Primer envío: resumen de todos los críticos actuales,
con hasta tres ejemplos priorizados y enlace al informe privado. Un intento máximo
por fecha/destinatario. Fallo definitivo: se evalúa otra vez al día siguiente.
Resultado incierto: se bloquean nuevos intentos de ese destinatario hasta conciliar
el webhook de Meta o revisión operativa; nunca reintentar a ciegas.

La plantilla `fusion_resumen_reposicion_v1`, idioma `es_AR`, debe estar aprobada
en la WABA del 2035. Se comprueba en cada ejecución y antes de cada envío. No usa
texto libre fuera de la ventana de atención ni reutiliza una plantilla comercial.
Si Meta continúa revisando o rechaza la plantilla, la tarea no envía y falla con
`template_pending_or_unavailable`; revisar el estado en Meta.

Registro en PostgreSQL del bot: tablas aditivas `stock_alert_runs` y
`stock_alert_state`, vinculadas a `inbox_outbox`/`messages`. Usa `CloudTransport`
y recuperación/webhooks existentes. Mensajes de sistema para excluirlos del
aprendizaje de agentes. El envío no reclama chats, no cambia la IA ni responsables,
ni crea una ventana ficticia de 24 horas. No depende de que el bot esté encendido.
No se reinicia ningún contenedor ni se cambia su imagen.

Diagnóstico sin enviar:

    python3 /opt/fusion-management-migration/alerts/run_alerts.py --dry-run
    systemctl list-timers fusion-stock-whatsapp.timer
    journalctl -u fusion-stock-whatsapp.service --since today

`status.json` guarda resultado, fecha, cantidades, nombres y últimos cuatro dígitos
del último procesamiento; no incluye credenciales. Una previsualización no modifica
los registros de entrega ni la base de comparación.

Rollback: deshabilitar el timer; conservar tablas, historial y archivos privados.
No restaurar bases ni retirar registros de mensajes enviados. Los archivos de esta
funcionalidad se enumeran en `deployment-manifest.json`; ninguna función anterior
debe revertirse. Para probar cambios usar PostgreSQL desechable, red Docker interna
sin salida externa, credenciales ficticias y `test_stock_alerts.py` con transporte falso.


API administrativa GET/POST `/ventas/stock/alertas`, sesión vigente, Origin exacto y CSRF.
Revisión optimista evita pisar otra pestaña. JSON atómico; números argentinos normalizados
y únicos, dos destinatarios, nombre hasta 70 caracteres, pausa individual y general.
El ejecutor vuelve a validar los datos compartidos y no admite modificar emisor/plantilla
desde ese archivo. Estado de entrega sin secretos en `stock-alert-status.json`.
Rollback de esta edición: manifiesto en /opt/fusion-management-migration/backups/stock-alert-settings-20261014T231001Z/manifest.json;
restaurar archivos/unidades previos, daemon-reload y reiniciar sólo el gateway y timer.
Conservar el estado editable y los registros de entrega; las versiones antiguas lo ignoran.
