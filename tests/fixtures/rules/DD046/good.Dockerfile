FROM alpine:3.20
WORKDIR /app
RUN npm ci
