FROM alpine:3.20
ADD --checksum=sha256:0123abcd https://example.com/tool-1.2.tar.gz /tmp/
