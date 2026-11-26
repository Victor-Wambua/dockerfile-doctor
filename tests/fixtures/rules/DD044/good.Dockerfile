FROM alpine:3.20
SHELL ["/bin/ash", "-o", "pipefail", "-c"]
RUN wget -qO- https://example.com/app.tgz | tar xz -C /opt
