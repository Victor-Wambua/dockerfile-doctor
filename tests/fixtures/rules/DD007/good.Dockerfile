FROM alpine:3.20
RUN curl -fsSLo /tmp/i.sh https://example.com/i.sh \
 && echo "abc  /tmp/i.sh" | sha256sum -c - \
 && sh /tmp/i.sh
