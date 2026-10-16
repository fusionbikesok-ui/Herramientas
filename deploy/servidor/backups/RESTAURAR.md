# Restaurar herramientas desde Backblaze B2

Necesitás: `rclone`, una clave B2 con lectura sobre el bucket y **la passphrase**
(guardada fuera del VPS). Sin la passphrase los respaldos son irrecuperables.

```bash
# 1. Credenciales (en el VPS nuevo no hay .env: ponelas a mano)
export RCLONE_CONFIG_FUSIONB2_TYPE=b2
export RCLONE_CONFIG_FUSIONB2_ACCOUNT='<keyID>'
export RCLONE_CONFIG_FUSIONB2_KEY='<applicationKey>'
export RCLONE_CONFIG_FUSIONCRYPT_TYPE=crypt
export RCLONE_CONFIG_FUSIONCRYPT_REMOTE='fusionb2:Herramientas-Fusion/herramientas/crypt'
export RCLONE_CONFIG_FUSIONCRYPT_FILENAME_ENCRYPTION=standard
export RCLONE_CONFIG_FUSIONCRYPT_DIRECTORY_NAME_ENCRYPTION=true
export RCLONE_CONFIG_FUSIONCRYPT_PASSWORD="$(rclone obscure - < archivo-con-passphrase)"

# 2. Ver qué hay
rclone --config /dev/null lsf fusioncrypt:db/ | sort | tail
rclone --config /dev/null lsf fusioncrypt:env/ | sort | tail

# 3. Bajar
rclone --config /dev/null copyto fusioncrypt:db/fusion-<stamp>.sqlite.gz ./fusion.sqlite.gz && gunzip fusion.sqlite.gz
rclone --config /dev/null copyto fusioncrypt:env/env-<stamp> ./.env
rclone --config /dev/null copy fusioncrypt:uploads ./uploads --transfers 8

# 4. Verificar la base antes de usarla
sqlite3 fusion.sqlite 'PRAGMA integrity_check;'   # debe decir: ok
```

Colocar `fusion.sqlite` en `data/`, `uploads/` y `.env` en la raíz de la app, y arrancar.

Un archivo borrado u ocultado por error sigue en B2 como versión anterior: se recupera desde la
web de Backblaze (Browse Files → mostrar versiones) o con `rclone --b2-versions`.
El estado de la última corrida está en `/opt/fusionbikes/backups/estado-nube.json`.
