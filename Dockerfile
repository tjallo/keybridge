FROM node:26.0.0-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
FROM dependencies AS development
COPY . .
CMD ["npm","run","dev:relay"]
FROM dependencies AS build
ARG SOURCE_COMMIT=unknown
ENV SOURCE_COMMIT=$SOURCE_COMMIT
COPY . .
RUN npm run build && npm prune --omit=dev
FROM node:26.0.0-alpine AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /app/build ./build
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
USER node
EXPOSE 3000
CMD ["node","build/server/main.js"]
FROM mcr.microsoft.com/playwright:v1.62.1-noble AS browser-test
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
