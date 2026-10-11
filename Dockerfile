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
# Python is whatever the base image's Debian ships (oven/bun:1.4.2-debian is built on debian:trixie-slim, so
# python3 is 3.13), not the 3.12 pinned for Dockerfile.remote and CI: adding a second Python toolchain here
# would cost more than it buys. Only the markitdown version is pinned identically (0.1.5).
# ffmpeg is what makes the audio extra usable: without it the audio-to-markdown tool
# cannot decode input for transcription. It adds an estimated 200-300 MB (with its codec
# libraries) to the runtime image; the rest of the image is unchanged.
FROM oven/bun:1.4.2-debian AS runner
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv bash git ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# The runtime finds this via resolveMarkitdownPath: MARKITDOWN_PATH, then ./.venv/bin/markitdown, then PATH.
RUN python3 -m venv .venv && .venv/bin/pip install --no-cache-dir "markitdown[all]==0.1.5"

# Production dependencies only; no lifecycle scripts (see builder stage).
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts --production

# Copy the built application
COPY --from=builder /app/dist ./dist

ENTRYPOINT ["bun", "dist/index.js"]
