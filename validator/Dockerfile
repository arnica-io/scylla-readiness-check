# ScyllaDB readiness validator image.
# NOTE: the docker build context must be the ./validator directory
# (COPY paths below are relative to validator/, not the repo root):
#   docker build -t scylla-readiness-validator ./validator

# ---- Stage 1: build ----
FROM node:20-alpine AS build
WORKDIR /app

# No package-lock.json is committed, so use `npm install` (not `npm ci`).
COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop dev dependencies (typescript, @types/node) from node_modules.
RUN npm prune --omit=dev

# ---- Stage 2: runtime ----
FROM node:20-alpine
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# Run as a non-root user.
RUN addgroup -g 10001 validator && adduser -D -u 10001 -G validator validator
USER validator

LABEL org.opencontainers.image.source=https://github.com/arnica-io/scylla-readiness-check

ENTRYPOINT ["node", "dist/check.js"]
