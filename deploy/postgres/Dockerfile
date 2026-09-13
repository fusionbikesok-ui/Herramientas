# PostgreSQL 18 + pgBackRest para E0 (docs/superpowers/deliveries/E0-infraestructura-dr.md, PM-166).
# Digest de postgres:18-bookworm (PG 18.6) y versión de pgBackRest fijados: cambiar cualquiera de los
# dos es una decisión revisable, no una actualización automática.
FROM postgres@sha256:1c59e2c3c818eaa0f0628f695b36e7c9e362d6b219b36a54a32df645cbd7e1af

RUN apt-get update \
 && apt-get install -y --no-install-recommends pgbackrest=2.59.1-1.pgdg12+1 \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /var/lib/pgbackrest /var/spool/pgbackrest /var/log/pgbackrest /etc/pgbackrest \
 && chown -R postgres:postgres /var/lib/pgbackrest /var/spool/pgbackrest /var/log/pgbackrest /etc/pgbackrest

COPY pgbackrest.conf /etc/pgbackrest/pgbackrest.conf
