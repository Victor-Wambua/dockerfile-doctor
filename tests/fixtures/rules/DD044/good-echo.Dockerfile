FROM alpine:3.20
RUN echo hello | sha256sum
