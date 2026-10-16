# Integración de PR pendientes de Sombra

Autorización: revisar e integrar los PR38, PR42 y PR45, sin afectar la operación actual. La ejecución corresponde al asistente. Se integra Git; no se despliega, reinicia, migra ni cambia configuración productiva.

1. Fijar las revisiones remotas y registrar contenedores/checkout productivo. Revisar dependencias y automatismos de publicación.
2. Combinar master con PR38 en un worktree aislado; resolver el conflicto documental preservando ambos aportes. Incorporar PR45 (depende de PR38) y PR42. Revisar catálogo, reintentos, cursores, límites, aislamiento por cuenta y conservación de datos.
3. Ejecutar typecheck, suite completa de plataforma con PostgreSQL desechable, suite raíz en copia aislada, validación documental y diff limpio. No compartir bases ni iniciar servidores de QA.
4. Corregir cualquier bloqueo verificado antes de publicar. Integrar PR38, retargetear PR45 a master y fusionarlo; luego PR42. Verificar cabeza esperada antes de cada fusión y reevaluar si master cambia.
5. Comprobar que el árbol final de Git coincide con el candidato probado y que el checkout productivo, imágenes y contenedores no cambiaron. Actualizar memoria/evidencia con las fusiones efectivas.

No se acepta E1 con estas fusiones: siguen pendientes la capacidad sostenida y siete días verdes. Ante un fallo de revisión o pruebas no fusionar el cambio afectado; los servicios actuales permanecen con sus imágenes y datos. La reversión de integración usa un PR de revert, no reset forzado ni restauración de producción.
