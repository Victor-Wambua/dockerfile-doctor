FROM nginx:1.27-alpine
HEALTHCHECK CMD wget -qO- http://127.0.0.1/ || exit 1
