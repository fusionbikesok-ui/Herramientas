# Instalar el nivel 2 de DR en la Mac del local (PM-167, PM-169)

La Mac descarga, mientras está encendida, una copia **cifrada** del repositorio pgBackRest del VPS y
guarda una foto diaria durante 14 días. El VPS nunca puede escribir ni borrar en la Mac, y la Mac sólo
puede **leer** el repositorio en el VPS.

## 1. En la Mac (José)

1. Abrir Terminal y crear la clave de la Mac:
   ```bash
   mkdir -p ~/.config/fusion-offsite && chmod 700 ~/.config/fusion-offsite
   ssh-keygen -t ed25519 -N "" -C "mac-local-fusion-offsite" -f ~/.config/fusion-offsite/id_ed25519
   cat ~/.config/fusion-offsite/id_ed25519.pub
   ```
2. Pasarle al asistente **sólo** la línea `ssh-ed25519 …` que imprime el último comando (es pública).
3. Copiar `scripts/postgres/offsite-pull-mac.sh` a la Mac, por ejemplo en
   `~/FusionBackups/offsite-pull-mac.sh`, y darle permiso: `chmod +x ~/FusionBackups/offsite-pull-mac.sh`.
4. Configurar el destino (lo confirma el asistente):
   ```bash
   echo "fusion-offsite@IP_DEL_VPS" > ~/.config/fusion-offsite/destino
   ```
5. Opcional pero recomendado: crear en Better Stack un heartbeat "Copia externa en la Mac" con período
   de **1 día** y gracia de **3 días** (cubre fines de semana), y guardar su URL:
   `echo "URL" > ~/.config/fusion-offsite/heartbeat-url`.
6. Instalar la tarea automática:
   ```bash
   cp deploy/postgres/mac/ar.com.fusionbikes.offsite-pull.plist ~/Library/LaunchAgents/
   sed -i '' "s#RUTA_SCRIPT#$HOME/FusionBackups/offsite-pull-mac.sh#" ~/Library/LaunchAgents/ar.com.fusionbikes.offsite-pull.plist
   launchctl load ~/Library/LaunchAgents/ar.com.fusionbikes.offsite-pull.plist
   ```
7. Ajustes de la Mac: que no entre en reposo mientras está encendida en horario del local
   (Configuración del Sistema → Batería/Energía) y que Terminal tenga acceso completo al disco si
   macOS lo pide.

## 2. En el VPS (asistente)

1. Instalar ACL: `apt-get install -y acl`.
2. Usuario dedicado sin contraseña ni shell interactivo, con **uid fijo 1999**:
   `useradd --system --uid 1999 --user-group --create-home --shell /bin/sh fusion-offsite` y
   `passwd -l fusion-offsite`. **Nunca** dejar que `--system` elija el uid: en este host tomó el 999,
   que es el uid de PostgreSQL dentro del contenedor, y el usuario pasó a ser dueño (con escritura)
   del repositorio y de `pgdata` (2026-09-14, corregido antes de cargar ninguna clave).
3. Permiso de sólo lectura sobre el repositorio (el grupo 999 del contenedor en el host es
   `systemd-journal`, por eso **no** se usa pertenencia a grupo):
   ```bash
   setfacl -m u:fusion-offsite:rx /opt/fusionbikes/postgres
   setfacl -R -m u:fusion-offsite:rX /opt/fusionbikes/postgres/repo
   setfacl -R -d -m u:fusion-offsite:rX /opt/fusionbikes/postgres/repo
   ```
4. `~fusion-offsite/.ssh/authorized_keys` con la clave pública de la Mac, forzada a sólo lectura:
   `restrict,command="/usr/bin/rrsync -ro /opt/fusionbikes/postgres/repo" ssh-ed25519 AAAA… mac-local-fusion-offsite`
5. Verificar desde el VPS que la clave no puede escribir: un `rsync` de subida debe ser rechazado.

## 3. Aceptación del nivel 2

1. La Mac completa un pull con `OK: N archivos verificados` en `~/FusionBackups/pgbackrest/pull.log`.
2. Restauración de prueba desde la copia de la Mac en QA (el asistente la ejecuta con los archivos
   traídos de la Mac) con los mismos controles de `npm run test:e0`.
3. Registrar en la ficha E0: fecha del pull, cantidad de archivos, hash del manifiesto y resultado de
   la restauración.
