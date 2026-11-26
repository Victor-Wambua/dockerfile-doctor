FROM alpine:3.20
RUN curl -k https://internal.example.com/pkg.tgz -o pkg.tgz
