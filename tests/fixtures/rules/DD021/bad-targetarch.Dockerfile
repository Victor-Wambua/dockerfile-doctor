FROM alpine:3.20
RUN true
COPY bin-${TARGETARCH}/app /app
