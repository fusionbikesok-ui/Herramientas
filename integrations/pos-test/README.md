# POS de prueba (WordPress aislado)

Copia de `/opt/fusionbikes-pos-test`: WordPress + MySQL + wp-cli en Docker, escuchando solo en 127.0.0.1:8099,
con el plugin propio `fusion-bikes-pos` montado desde `wp-content/plugins/fusion-bikes-pos`.

- Credenciales: `cp .env.example .env` y completar. El compose original del VPS traía las claves en texto plano;
  acá se leen de `.env` (las del VPS siguen siendo las que estén en su compose real).
- No se versionan: core de WordPress, uploads, base de datos, el plugin de terceros `woocommerce-mercadopago`
  ni los `.tar.gz` de plugins.
