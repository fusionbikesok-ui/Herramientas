# Plan — syncs de catálogo resilientes y alertas administrativas

Fecha: 2026-08-27  
Base: `conteo-confiable@19b98797`  
Rama: `fix-alertas-sync-catalogo`

## Objetivo

Evitar que los refrescos de catálogo de WooCommerce y MercadoLibre fallen de manera repetitiva
por errores transitorios y garantizar que todo fallo grave de una integración quede persistido,
agrupado y visible en la pantalla principal para administradores hasta comprobar la recuperación.

## Decisiones operativas confirmadas

- El sistema detecta y registra automáticamente; ninguna persona debe crear el aviso a mano.
- Un error transitorio recuperado dentro de los reintentos no abre un incidente.
- Es grave un fallo de corrida completa después de agotar la política acotada de reintentos,
  un error fatal de autenticación o una excepción no controlada de un job principal de integración.
- Los incidentes repetidos se agrupan por integración + operación: aumentan contador y fecha,
  no crean banners infinitos.
- La Home los muestra solo a administradores, sin credenciales, tokens, cuerpos de respuesta ni
  detalles sensibles.
- El incidente no se puede ocultar permanentemente: se cierra automáticamente únicamente cuando
  una corrida posterior de la misma operación termina con datos válidos.
- Producción no se usa para probar y el despliegue/reinicio de PM2 sigue siendo manual.

## Entrega vertical

1. **Persistencia y contrato**
   - Crear tabla `integracion_incidentes` con clave estable, integración, operación, gravedad,
     resumen seguro, contador, primer/último fallo, estado y fecha de recuperación.
   - Crear helper único para abrir/actualizar y resolver incidentes sin romper el job original si
     falla la escritura del aviso.
   - Exponer endpoint admin-only de incidentes abiertos para la Home.

2. **WooCommerce**
   - Aplicar el retry acotado también a páginas de variaciones.
   - Respetar `Retry-After` para 429 y no reintentar 4xx permanentes.
   - Evitar seguir drenando toda la cola cuando Woo entra en fallo sostenido.
   - Abrir `wc_catalogo` solo si la corrida completa falla tras reintentos.
   - Resolverlo solo después de una corrida que persista datos válidos.

3. **MercadoLibre**
   - Unificar la pausa de multiget del catálogo con la cadencia conservadora ya medida en el
     repositorio (1500 ms).
   - Ante 429, esperar el cooldown acotado y reintentar el mismo chunk sin reconstruir desde cero.
   - Mantener el reemplazo atómico: nunca escribir un catálogo parcial.
   - Abrir `ml_catalogo` al agotar la recuperación; resolverlo al completar el scan.

4. **Home administrativa**
   - Agregar un bloque crítico, visible solo cuando `is_admin`, con integración, operación,
     antigüedad, última ocurrencia y repeticiones.
   - Proveer enlace accionable a la herramienta correspondiente.
   - Usar `role="alert"`, copy concreto y responsive sin ocultar información.

5. **Cobertura y memoria**
   - Tests de retry/recovery de variaciones Woo, 4xx sin retry, 429 con backoff y corte de cola.
   - Tests de pacing/reanudación ML, preservación de caché e incidente abierto/resuelto.
   - Tests de endpoint admin-only y render de Home sin exposición a no-admin.
   - Actualizar memoria de integraciones, arquitectura y UI solo con contratos verificados.

## Criterios de aceptación

- Un 500/503/429 transitorio recuperado no deja incidente.
- Un fallo sostenido deja exactamente un incidente abierto y aumenta `ocurrencias` en repeticiones.
- Un refresco válido posterior lo marca recuperado.
- Un usuario no administrador no recibe la lista ni ve el bloque.
- Woo no descarta un ciclo por el primer fallo transitorio de una variación.
- ML no dispara multiget cada 350 ms ni pierde el cache anterior al abortar.
- Tests dirigidos, suite completa, E2E responsive y auditoría final en verde.
