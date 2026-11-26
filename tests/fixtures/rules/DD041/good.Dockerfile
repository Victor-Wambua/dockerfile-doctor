FROM alpine:3.20
COPY package.json package-lock.json /app/
COPY a b .
