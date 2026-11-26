FROM alpine:3.20
COPY --from=3 /x /x
