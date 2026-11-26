FROM node:22-alpine AS base
USER node
FROM base AS final
CMD ["node"]
