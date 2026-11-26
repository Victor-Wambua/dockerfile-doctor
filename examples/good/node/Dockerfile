# syntax=docker/dockerfile:1.7
# Node service: build in one stage, ship a distroless image with no shell, no npm, no package manager.
ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-alpine3.22 AS build
WORKDIR /app
# Manifest and lock file first, so the install layer is cached until dependencies change.
COPY package.json package-lock.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM gcr.io/distroless/nodejs22-debian12:nonroot
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY --from=build --chown=65532:65532 /app/dist ./dist
COPY --chown=65532:65532 healthcheck.js ./
USER 65532:65532
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["/nodejs/bin/node", "healthcheck.js"]
# The distroless image's entrypoint is node, so this runs `node dist/server.js` as PID 1.
CMD ["dist/server.js"]
