FROM alpine:3.20
USER app
COPY --chown=app:app . /app
