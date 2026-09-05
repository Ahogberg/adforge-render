FROM mcr.microsoft.com/playwright:v1.62.0-noble AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM mcr.microsoft.com/playwright:v1.62.0-noble

ENV NODE_ENV=production
# Every persistent directory (data, uploads, artifacts) lives under one mount point
# so a single volume keeps the store, sources, and deliveries across deploys.
ENV ADFORGE_STORAGE_DIR=/app/storage
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY templates ./templates
COPY public ./public

RUN mkdir -p /app/storage && chown -R pwuser:pwuser /app

USER pwuser

EXPOSE 3001

CMD ["node", "dist/src/server.js"]
