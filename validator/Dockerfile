# ScyllaDB readiness validator image.
# NOTE: the docker build context must be the ./validator directory
# (COPY paths below are relative to validator/, not the repo root):
#   docker build -t scylla-readiness-validator ./validator

# ---- Stage 1: build ----
# Pin the build stage to the native builder platform so `npm ci` + `tsc` run
# natively (not under QEMU emulation) during multi-arch builds. The runtime
# deps are pure JavaScript (no native addons), so the resulting node_modules
# is architecture-agnostic and safe to copy into any target-arch runtime.
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop dev dependencies (typescript, @types/node) from node_modules.
RUN npm prune --omit=dev

# ---- Stage 2: runtime ----
FROM node:22-alpine
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# Run as a non-root user.
RUN addgroup -g 10001 validator && adduser -D -u 10001 -G validator validator
USER validator

LABEL org.opencontainers.image.source=https://github.com/arnica-io/scylla-readiness-check

ENTRYPOINT ["node", "dist/check.js"]
