FROM node:22-alpine
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
