FROM node:22-alpine
COPY . /app
CMD ["node", "/app/server.js"]
