# Stage 1: Build
FROM node:20-slim AS builder
RUN corepack enable && corepack prepare pnpm@10 --activate
WORKDIR /app

# Install dependencies first (layer cache)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

# Build UI apps
COPY ui/ ui/
COPY scripts/ scripts/
RUN pnpm build:ui && pnpm build:ui-imports

# Build server
COPY src/ src/
COPY tsconfig.json ./
RUN pnpm build:server

# Stage 2: Production
FROM node:20-slim AS production
RUN corepack enable && corepack prepare pnpm@10 --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/dist ./dist
COPY public/ ./public/

ENV PORT=8080
ENV NODE_ENV=production
EXPOSE 8080

USER node
CMD ["node", "dist/server.js"]
