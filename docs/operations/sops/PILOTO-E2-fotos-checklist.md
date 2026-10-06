# Piloto E2 — Fotos, evidencia y aprobación

**Estado:** preparado, no ejecutado
**Entrega:** E2 — Evidencia, perfiles, paquetes y aprobación
**Superficie:** web móvil en navegador; sin publicación móvil ni cambios de producción

## Objetivo

Observar una jornada acotada de preparación y confirmar que las fotos se pueden tomar,
recuperar y aprobar sin duplicados ni pérdida silenciosa ante fallos de red.

## Autorización y alcance

- Responsable que autoriza: ____________________
- Fecha y jornada: ____________________
- Operario: ____________________
- Supervisor de respaldo: ____________________
- Flag o criterio de selección: ____________________
- Máximo de pedidos del piloto: ____________________
- Pedidos excluidos (ML urgente, multipaquete, datos sensibles): ____________________
- Entorno: `staging` / otro aislado: ____________________

No iniciar con pedidos reales hasta completar autorización, entorno, selección y rollback.
No copiar fotos, tokens ni datos personales al registro del piloto.

## Preflight

- [ ] Base y migraciones 045–047 verificadas.
- [ ] Backup del entorno de prueba creado y restaurable.
- [ ] Usuario del piloto tiene solo permisos necesarios.
- [ ] Celular tiene cámara, batería y conexión conocidas.
- [ ] Se confirmó espacio local suficiente para fotos pendientes.
- [ ] Se explicó que una aprobación no se revierte automáticamente.
- [ ] Se confirmó canal de soporte y responsable de escalamiento.
- [ ] Se ejecutó `npm run e2e:e2` y quedó guardado el resultado.

## Recorrido por pedido

Registrar únicamente identificador interno/no sensible y hora:

| Caso | Resultado esperado | Resultado | Hora | Observación |
|---|---|---|---|---|
| Foto normal | Preview inmediata y servidor confirma | | | |
| Doble toque / reenvío | Una sola foto persistida | | | |
| Recarga posterior | Evidencia sigue visible | | | |
| Timeout de red | Foto local marcada para reintento | | | |
| Respuesta tardía | Reconciliación sin duplicado | | | |
| Perfil o requisito ausente | Perfil seguro y tarea de clasificación | | | |
| Falta de evidencia | Aprobación bloqueada con motivo claro | | | |
| Evidencia completa | Aprobación y siguiente estado correctos | | | |

## Criterios de detención

Detener el piloto y avisar al supervisor si ocurre cualquiera:

- una foto desaparece sin estado de reintento;
- aparecen dos registros por una misma intención de subida;
- una respuesta tardía crea duplicado o marca aprobación incorrecta;
- la pantalla muestra aprobado sin evidencia obligatoria;
- no se puede recuperar la operación sin editar la base manualmente;
- se exponen datos de otro pedido u otro usuario.

## Cierre y evidencia

- Pedidos probados: ______
- Fotos confirmadas por servidor: ______
- Reintentos: ______
- Duplicados: ______
- Fallos bloqueantes: ______
- Tiempo activo estimado por pedido: ______
- Incidentes y enlaces internos: ____________________
- ¿Se observó una jornada completa?: sí / no
- Decisión: ampliar / corregir y repetir / detener
- Responsable de decisión: ____________________
- Fecha: ____________________

Este checklist no convierte E2 en `publicada`, `observada` ni `aceptada` por sí solo.
La decisión debe registrarse también en `docs/superpowers/deliveries/E2.md`.
