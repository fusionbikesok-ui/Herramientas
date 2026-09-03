# Registro de decisiones del Plan Maestro

Actualizado: 2026-09-01. Este registro resume decisiones aprobadas; el detalle operativo está en el maestro. Cambiar una decisión exige fecha, responsable, impacto y entregas afectadas.

| ID | Decisión vigente | Impacto principal |
| --- | --- | --- |
| PM-001 | Documentación local en `/opt/fusionbikes/herramientas` es canónica; MCP es espejo eventual. | Continuidad E0–E24 |
| PM-002 | Programa renumerado E0–E24; una entrega solo termina en estado `aceptada`. | Gobierno |
| PM-003 | Zona operativa `America/Argentina/Buenos_Aires`, formato 24 h y fecha explícita. | Jornada, SLA, auditoría |
| PM-004 | ML tiene prioridad absoluta. Web tiene máximo normal de preparación 15:00 con calendario de excepciones. El transporte único retira ML, Andreani y Flex; ML/Andreani deben estar listos con 30 min de margen y Flex debe salir como máximo a las 17:00 para permitir el regreso antes del cierre de las 19:00. | E1, E4 |
| PM-005 | La ola inicial conserva sus necesidades normales; pedidos normales posteriores forman mini-olas y ML urgente puede incorporarse a la ola activa. La reasignación automática de la última unidad queda en E12. | E1, E12 |
| PM-029 | UM1 urgente separa Guardia ML, Corrección y Consulta. La cobertura válida es publicación+variación con SKU Woo exacto; decisiones históricas sin SKU no cubren. La primera publicación es solo lectura y no escribe ML. | UM1, E1, E11, E12 |
| PM-030 | Un SKU puede publicar su stock completo en varias claves ML con confirmación de stock compartido. No se promete cero sobreventa: el exceso agregado abre incidente crítico y retiene pedidos según plazo ML, antigüedad y prioridad ML sobre web. | UM1, E11, E12 |
| PM-006 | La misma persona puede preparar, fotografiar y aprobar; despacho es otra responsabilidad. | Permisos y auditoría |
| PM-007 | Una foto cuenta solo tras guardado, validación y procesamiento del servidor. Evidencia se retiene 180 días salvo hold. | E2 |
| PM-008 | Aprobación, auditoría y encolado de etiqueta interna son atómicos; un job idempotente por paquete. | E2, E3 |
| PM-009 | Etiqueta interna 50×25 y etiquetas de transporte son artefactos y momentos distintos. | E3, E4 |
| PM-010 | Woo es autoridad del disponible comercial; Fusion modela físico, comprometido, no disponible, condicionado y entrante sin doble descuento. | E8–E12 |
| PM-011 | Stock físico se deriva de movimientos inmutables; correcciones son inversos o deltas auditados y nunca generan saldo negativo. | E9, E10 |
| PM-012 | Rollout de stock por familia/SKU con familia, ubicación, conteo base y reconciliación; no hay retorno a escrituras legacy. | E9–E12 |
| PM-013 | Recepción es de dos pasos: entrada y putaway; Woo aumenta solo al ubicar disponible. | E14, E15 |
| PM-014 | Conteo inicial ciego con snapshot y reconciliación; tolerancia versionada y alto riesgo con control reforzado. | E16, E17 |
| PM-015 | App es herramienta de piso, iPhone primero; Android queda fuera hasta demanda concreta. | E5, E13–E21 |
| PM-016 | Offline es captura provisional cifrada, ordenada y con lease; jamás usa `last-write-wins`. | E13, E15, E17, E21 |
| PM-017 | Inbox durable distingue reconocer de resolver y enruta por área/turno. | E6, E7 |
| PM-018 | Cancelaciones, devoluciones, daños, proveedor, garantías y taller cambian stock por tareas y movimientos auditados. | E18–E21 |
| PM-019 | Métricas requieren un mes de línea base y no publican rankings personales. | E22 |
| PM-020 | Backend/web pueden publicarse por pipeline verde con rollback automático; Windows y App Store requieren autorización explícita. | E3, E5, E23 |
| PM-021 | Cada entrega dura idealmente 3–5 días, usa flag, piloto acotado y una jornada observada. | Todas |
| PM-022 | App y backend fijan `/api/v1` por commit, con compatibilidad corta y actualización obligatoria cuando corresponda. | E5, E13 |
| PM-023 | E1 usa tablero PC, celular web centrado en una tarea y tablet futura como tablero compartido sin PII; App iPhone futura tendrá el flujo completo de piso. | E1, E5, E13 |
| PM-024 | Un operario mantiene una sola tarea abierta. La ayuda se solicita por zona manual, identifica al ayudante al recibir productos y no permite que el ayudante modifique cantidades, pedidos o estados. | E1 |
| PM-025 | La búsqueda consolidada no escanea unidad por unidad. La confirmación unitaria ocurre en mesa; la herramienta sugiere prioridad y el responsable confirma la asignación. | E1 |
| PM-026 | La ola tiene estados `disponible → en búsqueda → en mesa → cerrada`; el pedido tiene estados independientes y una ola cierra solo con unidades asignadas, devueltas, resguardadas o derivadas explícitamente. | E1 |
| PM-027 | Errores relevantes, reintentos agrupados y correcciones se auditan con actor, hora, antes/después y motivo; los eventos no se borran. | E1, E2 |
| PM-028 | Sustitución transitoria puede autorizarla el operario con constancia del cliente y motivo; Fusion actualiza el pedido comercial, ML bloquea si no puede reflejarlo y un flag de Admin habilita la transición futura a Ventas. | E1 |

## Pendientes que no deben suponerse

| Pendiente | Responsable | Bloquea | Evidencia de cierre |
| --- | --- | --- | --- |
| Modelo, driver, lenguaje y puerto de impresora | Depósito | Publicación E3 | Relevamiento físico y prueba de página real |
| Modelo e iOS exactos del iPhone | Equipo móvil | Matriz final E5 | Dispositivo registrado y build probada |
| Campo SLA real por modalidad ML | Integración y operación | Aceptación E1/E4 | Para MercadoEnvíos no es fijo y puede variar por paquete; usar la hora máxima de entrega en centro de acopio del shipment. Flex: salida máxima 17:00. Payload capturado y regla confirmada |
| Infraestructura y sanitización de staging | Operaciones | Pruebas integrales y publicación automática | Instancia aislada sin credenciales de escritura reales |
| RTO y RPO | Operaciones | Aceptación E23 | Medición real de backup y restauración |
