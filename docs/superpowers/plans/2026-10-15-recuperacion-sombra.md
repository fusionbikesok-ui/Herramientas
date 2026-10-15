# Recuperación de la sombra existente

Objetivo autorizado por el usuario el 15/10: corregir los bloqueos hallados en la revisión y avanzar hacia la aceptación de E1. Se conserva la captura de las corrientes sin consumidor por decisión explícita del mismo día. El corte de autoridad de stock/pedidos pertenece a entregas posteriores y no se declara terminado aquí.

Diseño: mantener el protocolo existente de cupo, leases, checkpoint transaccional y errores. Guardar un recurso/pack por página; separar el scan de items y sus bulk para que cada llamada útil confirme progreso. Cumplir el encabezado obligatorio del relector de mensajes. No aumentar cuotas para ocultar pérdida de avance.

Archivos: `plataforma/src/reconciliacion/adaptadores/ml.ts`, `plataforma/src/reconciliacion/relectura.ts`, pruebas `progreso-cupo.test.ts` e `items-ml-reintentos.test.ts`; memoria y ficha E1. Sin migración de esquema.

- [x] Reproducir con pruebas que fallen: envío con un permiso, pack con un permiso, scan confirmado antes de bulk, relector con validación real del gateway.
- [x] Corregir y verificar reanudación, 404, 429 real frente a cupo sintético, expiración del scroll sin declarar bajas y conservación del presupuesto de reintento.
- [x] Resolver firma Woo: respaldo privado de `.env`; conservar secreto efectivo aceptado por el servicio, unificar su interpretación por shell/dotenv y firmas de webhooks 17–20. Comprobar con ping sin operaciones de negocio.
- [x] Revisión independiente, typecheck y suites completas seriales en aislamiento. No usar la base productiva en tests.
- [x] Construir imagen con los cambios acotados sobre la imagen del worker en uso; preservar imagen de rollback. Actualizar sólo worker si contratos y migraciones no cambian. Verificar código dentro de imagen, latidos, salud y progreso de barridos antes de cerrar. Incluidos `motor.ts` y `corridas.ts` reanudables que faltaban en la imagen heredada; 134 pruebas sobre el código extraído y checkpoints reales confirmados.
- [ ] Medir volumen/capacidad real por corriente y registrar límites: 24–48 horas de Tarea 0 y después siete días verdes. No bajar crons ni declarar aceptación con reportes rojos.

Riesgos que deben cubrir las pruebas: cupo compartido casi agotado; error entre scan y bulk; 404 sin resultado; scroll expirado; mensajes rechazados antes de red. Las colas de dominios futuros conservan mensajes y estado pendiente; no se marcan artificialmente como procesados.

Rollback: conservar la imagen exacta anterior del worker y configuración previa en respaldo privado. **La imagen anterior no entiende `fase: contenido` de items:** detener el worker, cerrar como fallidas (sin declarar bajas) las corridas activas de `ml.items` que tengan ese formato, limpiar sólo su checkpoint en curso y programar una vuelta nueva desde cero, conservando el cursor final anterior. Recién entonces arrancar la imagen anterior. No basta con cambiar la imagen y reanudar esos checkpoints.

La recuperación de señales se hace únicamente después de corregir la causa y en tandas limitadas, sin borrar historial. Ningún cambio de esta reparación crea pedidos o modifica stock directamente.
