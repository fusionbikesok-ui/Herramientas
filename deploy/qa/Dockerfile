# Imagen QA; contrato vigente E0/E1 y evidencia en docs/superpowers/archive/plans-legacy-2026-09-13/2026-09-13-qa-bajo-demanda.md.
# El contexto de build lo arma scripts/qa/qa.sh con `git archive` de la rama: nunca contiene
# .env, data/ ni uploads/ (están en .gitignore).
FROM node@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553

WORKDIR /app
ENV NODE_ENV=qa

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY . .
RUN mkdir -p /app/uploads /data && chown node:node /app/uploads /data

USER node
EXPOSE 3101
CMD ["node", "server.js"]
