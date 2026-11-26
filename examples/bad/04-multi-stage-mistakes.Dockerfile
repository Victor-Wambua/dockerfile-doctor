# A multi-stage build that looks right and is not.
# expect: DD002 DD003 DD021 DD022 DD027 DD032 DD038 DD041
ARG APP_VERSION=1.4.0
FROM golang:1.23 AS build
WORKDIR /src
COPY . .
RUN go build -o /out/app ./cmd/app

FROM alpine:3.20 AS build
LABEL version=$APP_VERSION
COPY --from=biuld /out/app /usr/local/bin/app
COPY package.json package-lock.json /app
RUN apk add curl
CMD ['app', '--serve']
