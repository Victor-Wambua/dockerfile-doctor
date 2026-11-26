FROM alpine:3.20 AS first
COPY --from=second /x /x
FROM alpine:3.20 AS second
