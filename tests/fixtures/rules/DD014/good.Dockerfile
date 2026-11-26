FROM alpine:3.20
COPY .env.example /app/.env.example
COPY ca.pem /usr/local/share/ca-certificates/ca.crt
