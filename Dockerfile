FROM node:26.0.0-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci && chown -R node:node /app

FROM dependencies AS production-dependencies
RUN npm prune --omit=dev

FROM dependencies AS development
COPY --chown=node:node . .
USER node
CMD ["npm", "run", "dev:relay"]

FROM dependencies AS build
ARG SOURCE_COMMIT
ENV SOURCE_COMMIT=$SOURCE_COMMIT
COPY . .
RUN test -n "$SOURCE_COMMIT" && npm run build

FROM node:26.0.0-alpine AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /app/build ./build
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
USER node
EXPOSE 3000
CMD ["node","build/server/main.js"]

FROM node:26.0.0-bookworm-slim AS browser-node

FROM mcr.microsoft.com/playwright:v1.62.1-noble AS browser-test
COPY --from=browser-node /usr/local /usr/local
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY --chown=pwuser:pwuser . .
RUN chown -R pwuser:pwuser /app
USER pwuser

# Keep the production image as the default target for plain `docker build` commands.
FROM runtime AS production
