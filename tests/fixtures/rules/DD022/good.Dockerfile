FROM golang:1.23 AS build
FROM alpine:3.20
COPY --from=build /out/app /app
COPY --from=nginx:1.27 /etc/nginx/nginx.conf /nginx.conf
