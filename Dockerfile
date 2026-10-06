FROM mcr.microsoft.com/playwright:v1.62.0-noble AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM mcr.microsoft.com/playwright:v1.62.0-noble

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ffmpeg renders the motion clips and cuts captioned clips from uploaded recordings.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/dist ./dist
COPY templates ./templates
COPY public ./public

RUN mkdir -p /app/data /app/uploads /app/artifacts && chown -R pwuser:pwuser /app

USER pwuser

EXPOSE 3001

CMD ["node", "dist/src/server.js"]
