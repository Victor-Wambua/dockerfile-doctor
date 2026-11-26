FROM alpine:3.20
RUN set -o pipefail && wget -qO- https://example.com/app.tgz | tar xz
