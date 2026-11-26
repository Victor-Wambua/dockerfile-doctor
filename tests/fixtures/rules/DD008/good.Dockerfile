FROM alpine:3.20
ENV APP_ENV=production
ENV TOKEN_FILE=/run/secrets/token
ENV PASSWORD_MIN_LENGTH=12
