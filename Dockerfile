# Build stage: compile TypeScript. Lifecycle scripts are skipped because the
# package's preinstall hook (setup.sh) would install MarkItDown a second time.
FROM oven/bun:1.4.2-debian AS builder
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN bun run build

# Runtime stage: Bun + Python venv with MarkItDown installed exactly once.
# [all] matches what setup.sh (the preinstall hook) provides for local installs,
# including OCR/audio extras; the version matches the pin used in CI.
FROM oven/bun:1.4.2-debian AS runner
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv bash git \
    && rm -rf /var/lib/apt/lists/*

# The runtime finds this via resolveMarkitdownPath: MARKITDOWN_PATH, then ./.venv/bin/markitdown, then PATH.
RUN python3 -m venv .venv && .venv/bin/pip install --no-cache-dir "markitdown[all]==0.1.5"

# Production dependencies only; no lifecycle scripts (see builder stage).
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts --production

# Copy the built application
COPY --from=builder /app/dist ./dist

ENTRYPOINT ["bun", "dist/index.js"]
