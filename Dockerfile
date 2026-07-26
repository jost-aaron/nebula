FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS base

WORKDIR /app
RUN apk add --no-cache bash ffmpeg

FROM base AS build

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM base AS runtime

ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/server ./server
COPY --from=build /app/dist ./dist
COPY --from=build /app/deploy ./deploy

EXPOSE 5173

CMD ["node", "server/dev.mjs"]
