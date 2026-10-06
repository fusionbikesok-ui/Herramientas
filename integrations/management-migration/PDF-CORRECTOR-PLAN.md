# Corrector de etiquetas PDF — 2026-10-05

Solicitud: integrar al panel actual un corrector para el PDF ya descargado de Andreani, con ver, imprimir y descargar.

1. Reutilizar la regla exacta validada: `Peso: 9000 Gr // Ancho: 20 Cm` y `Alto: 30 Cm // Largo: 40 Cm` en la misma página pasan a 15000/25/70/150. Conservar fuente, códigos, tamaño, orden y páginas ajenas. Rechazar plantillas ambiguas; no inferir valores.
2. Incorporar página `/herramientas/gestion-vps/corregir-etiquetas/` con sesión/admin actuales, Origin y CSRF existentes. Entrada PDF binaria, límite 10 MiB/300 páginas. Mensajes claros para PDF inválido, protegido, sin coincidencias y plantilla distinta.
3. Ejecutar procesamiento en servicio Python aislado de memoria (sin PDF en disco), sólo loopback y autenticación interna derivada de la clave actual. Un trabajo a la vez, timeout, CPU/memoria limitados y sin registro de datos del PDF. Dependencia pypdf empaquetada desde el runtime existente.
4. Mostrar total/páginas corregidas, vista PDF, abrir aparte, imprimir mediante visor del navegador y descarga con nombre derivado del original. Limpiar resultado anterior al elegir otro archivo. Usar componentes/tokens existentes y verificar responsive.
5. Agregar tarjeta en Home y en Gestión, sin cambiar permisos de los módulos existentes. Verificar pruebas Python, Node y suite Home aislada; revisión independiente antes de publicar.
6. Publicar con comprobación de hashes previos, respaldo y rollback. Reiniciar sólo gateway y nuevo worker. Verificar la URL real y registrar contratos en memoria relacionada y fuente reconstruible del repositorio.

Aceptación: muestra dos etiquetas corregidas (páginas 3/8) en la muestra de 16, PDF equivalente al corregido verificado, conserva las otras 14, permite abrir/imprimir/descargar, rechaza sesión ajena y ninguna operación modifica pedidos ni Andreani.
