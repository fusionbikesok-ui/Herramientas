# Chat nativo en VPS — primera prueba aislada, 2026-10-04

Objetivo confirmado: mover almacenamiento, consulta frecuente y atención del chat al VPS e integrarlo después en Herramientas. Tienda, checkout y Master Control permanecen como están. Los originales siguen operando hasta verificar equivalencia y efectuar un corte por canal con un solo escritor.

Esta etapa implementa una conversación web completa con cliente, historial, respuesta automática simulada y operador en una pantalla de prueba privada. No constituye todavía la migración del chat en producción. No se cambia la URL del widget ni se copian conversaciones reales al entorno de prueba.

1. Respaldar código/configuración y PostgreSQL del bot actual en el VPS; verificar integridad del archivo y del índice del dump. No restaurar sobre producción.
2. Usar una copia del código actual del bot, su misma imagen por ID inmutable y una red Docker interna con PostgreSQL/Redis propios. Sin puertos publicados en el VPS; acceso por túnel SSH ligado a 127.0.0.1:8191 en la computadora local, sin salida a Internet, con límites de recursos. Ningún secreto del bot productivo se reutiliza.
3. Añadir app/native_store.py: sesiones, comandos idempotentes, cola durable, toma/liberación con revisión, bloqueo por conversación y validación de respuesta pendiente del bot. Reutilizar las tablas conversations/messages del bot actual dentro de la base aislada.
4. Añadir app/native_main.py: API de visitante con token, API de operador firmada y autenticación separada, límites, validación, paginación e historial. API interna destinada a un futuro proxy de sesión Herramientas; no entregar claves al navegador.
5. Añadir app/native_worker.py: procesar trabajos con leases y respuestas simuladas, guardar respuesta y estado en una transacción. No ejecutar WhatsApp ni callbacks de WordPress.
6. Añadir vista privada /qa/ con cliente y operador para comprobar el recorrido real. Usar tokens visuales de Herramientas, estados explícitos, controles accesibles y vistas 390/768/1440. Vista de ensayo únicamente, nunca habilitada en producción.
7. Ejecutar pruebas sobre PostgreSQL y Redis reales: mensajes y reintentos, aislamiento de sesiones, firma/replay, toma concurrente, bot en vuelo al tomar/liberar, recuperación de lease, paginación, límites y reinicio del servicio. Recorrido de navegador con datos ficticios. Verificar salud de los servicios originales.

Aceptación de esta etapa: copia privada funcionando y pruebas anteriores verificadas; evidencia sin secretos ni contenido real. Desactivación: docker compose stop sólo sobre el proyecto fusion-chat-migration-qa. Los servicios productivos no necesitan rollback porque no se modifican.

Pendiente antes del corte: adaptar el widget completo (contactos, leads y carrito abandonado incluidos), acceso y permisos reales de Herramientas, disponibilidad/horarios, consola de aprendizaje/configuración, importación incremental de historial con conciliación, integración de respuestas del bot real y WhatsApp, notificaciones y retención, ensayo de reversión. Medir ahorro después de mover el tráfico; no prometer porcentajes con este entorno de ensayo.
