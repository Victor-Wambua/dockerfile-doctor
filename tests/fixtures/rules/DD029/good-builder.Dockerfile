FROM node:22-alpine AS build
RUN npm ci
FROM node:22-alpine
COPY --from=build /app/dist /app
