Prueba aislada del puente

bridge-test.php usa WordPress/WooCommerce simulados y dos servicios originales
de Master Control 10.5.0-beta.4: DataService.php y PricingEngine.php.
Para reproducir, preparar una carpeta temporal con estos cinco archivos:
  bridge-test.php (este directorio)
  fusion-herramientas-bridge.php (../fusion-herramientas-bridge/)
  migration-read.php (../fusion-herramientas-bridge/)
  DataService.php (ZIP original, includes/Services/)
  PricingEngine.php (ZIP original, includes/Services/)

Ejecutar php bridge-test.php en un contenedor sin red y con el directorio montado
sólo lectura. No cargar wp-load.php ni conectar una base de datos.
Resultado verificado para 0.2.0: 61 comprobaciones, PHP 8.2.33.
Después de instalar, se verificó por HTTP en WordPress/PHP 8.5.4:
anónimo 401; status autenticado 200; cotización 200; IDs duplicados 400.

Límite de la prueba: las comprobaciones locales de permisos usan stubs de WP;
el smoke posterior confirmó denegación anónima y autenticación real por Woo.
No se crearon credenciales de otros roles ni se probaron cobros.
No hay suite nativa de Herramientas que ejecutar para este plugin independiente.
