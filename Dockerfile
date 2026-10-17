# GPU encoder app (encoder/), offered for download by the site: Windows, macOS, Linux.
FROM golang:1.24-alpine AS encoder
WORKDIR /src
COPY encoder/go.mod encoder/go.sum ./
RUN go mod download
COPY encoder/ ./
ARG ENCODER_VERSION=docker
RUN ENCODER_VERSION=$ENCODER_VERSION sh build.sh /out

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server ./server
COPY --from=build /app/client/dist ./client/dist
COPY --from=encoder /out ./encoder/dist
# SQLite lives here (named volume in docker-compose.yml); owned by node so a fresh
# volume inherits writable permissions.
ENV DATA_DIR=/app/data
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3001
CMD ["node", "server/src/index.js"]
