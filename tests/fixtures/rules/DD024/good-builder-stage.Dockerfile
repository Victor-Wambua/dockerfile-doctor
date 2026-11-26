FROM debian:12-slim AS build
RUN apt-get install -y gcc
FROM alpine:3.20
