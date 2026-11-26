FROM golang:1.23 AS build
RUN true
FROM alpine:3.20
COPY --from=biuld /out/app /app
