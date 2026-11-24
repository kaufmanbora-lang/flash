# Flash — один образ для сайта (Next.js) и воркера (FFmpeg-монтаж, планировщик).
# Команда запуска выбирается в docker-compose.yml.

FROM node:24-bookworm-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# ── Зависимости и сборка ─────────────────────────────────────
FROM base AS build
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build

# ── Рабочий образ ────────────────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production

# Настоящий FFmpeg (с ffprobe) для обработки видео и монтажа.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY next.config.mjs tsconfig.json ./
COPY db ./db
COPY src ./src
COPY scripts ./scripts

# Музыкальная библиотека синтезируется при сборке образа (оригинальные композиции, ~1 минута).
RUN mkdir -p assets/music .data \
 && npx tsx scripts/generate-music.ts \
 && chown -R node:node /app/assets /app/.data

USER node
EXPOSE 3000 3101
CMD ["npm", "run", "start"]
