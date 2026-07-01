# syntax=docker/dockerfile:1

# --- build stage: install all deps and compile TypeScript ---
FROM node:20-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

# --- runtime stage: only compiled output + production deps ---
FROM node:20-slim AS runtime
ENV NODE_ENV=production
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/dist /app/dist
COPY --from=build /app/package.json /app/package.json

# cody operates on the mounted project directory; provide config/.env at run time
# (e.g. docker run -it -v "$PWD":/workspace --env-file .env cody ...).
WORKDIR /workspace
ENTRYPOINT ["node", "/app/dist/index.js"]
