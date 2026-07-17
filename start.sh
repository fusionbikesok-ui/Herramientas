#!/bin/bash
set -a
source /opt/fusionbikes/herramientas/.env
set +a
exec node /opt/fusionbikes/herramientas/server.js