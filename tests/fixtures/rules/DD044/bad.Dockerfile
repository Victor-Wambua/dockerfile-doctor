FROM alpine:3.20
RUN wget -qO- https://example.com/app.tgz | tar xz -C /opt
