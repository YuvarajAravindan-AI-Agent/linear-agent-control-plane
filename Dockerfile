# Node 22 deliberately, matching what the tests run against locally.
# node:sqlite needs --experimental-sqlite on 22; it is unflagged from Node 24, but
# pinning to the tested runtime beats saving one flag.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
COPY test ./test
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

EXPOSE 3000
CMD ["node", "--experimental-sqlite", "dist/src/main.js"]
