FROM alpine:3.20
RUN curl -fsSL https://example.com/app.tgz | tar xz -C /opt
