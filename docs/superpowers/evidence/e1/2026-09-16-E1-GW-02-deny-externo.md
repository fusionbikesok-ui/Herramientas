# E1-GW-02 — exposición pública del plano interno (evidencia externa)

- **Fecha:** 2026-09-16. **Origen:** Mac de José, conexión propia fuera del VPS.
- **Resultado:** verde.

| Petición (POST) | Respuesta | `X-Powered-By` |
|---|---|---|
| `https://herramientas.fusionbikes.com.ar/internal/v1/channel-read` | HTTP/2 404 | ausente |
| `https://…/herramientas/internal/v1/channel-read` | HTTP/2 404 | ausente |
| `https://…/INTERNAL/v1/channel-read` | HTTP/2 404 | ausente |
| `https://…/herramientas//internal/v1/channel-read` | HTTP/2 404 | ausente |
| `https://…/herramientas/%69nternal/v1/channel-read` | HTTP/2 404 | ausente |
| `https://…/Herramientas/Internal/v1/channel-read` | HTTP/2 404 | ausente |
| `http://179.197.74.83/internal/v1/channel-read` | HTTP/1.1 404 | ausente |
| `http://179.197.74.83/herramientas/internal/v1/channel-read` | HTTP/1.1 404 | ausente |
| `http://179.197.74.83/herramientas/InTeRnAl/v1/channel-read` | HTTP/1.1 404 | ausente |
| `http://179.197.74.83:3001/healthz` | no conecta | — |

Las nueve variantes las corta Nginx antes del proxy (sin `X-Powered-By: Express`) y el puerto 3001 del legado
no es alcanzable desde Internet (firewall `fusion-firewall-3001.service`).
