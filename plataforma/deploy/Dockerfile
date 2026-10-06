# Imagen única de E1: los tres servicios sólo cambian el entrypoint. Node se fija por digest
# para que una reconstrucción no cambie el runtime de la plataforma sin revisión.
FROM node@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553
WORKDIR /app
COPY package.json package-lock.json ./
RUN apt-get update && apt-get install -y --no-install-recommends gosu \
 && rm -rf /var/lib/apt/lists/* \
 && npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node src ./src
COPY --chown=node:node migrations ./migrations
COPY deploy/entrypoint.sh /usr/local/bin/plataforma-entrypoint
RUN chmod 755 /usr/local/bin/plataforma-entrypoint
ENTRYPOINT ["plataforma-entrypoint"]
