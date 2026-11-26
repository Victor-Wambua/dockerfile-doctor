FROM alpine:3.20
RUN cd /app && npm ci
