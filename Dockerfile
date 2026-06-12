# EMPIRE://36 — single-box deploy: Node server serving the built client.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY server ./server
VOLUME /data
ENV EMPIRE_DB=/data/empire.db
ENV PORT=8136
EXPOSE 8136
CMD ["npx", "tsx", "server/index.ts"]
