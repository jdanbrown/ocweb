FROM debian:bookworm-slim

WORKDIR /opt/dancodes

# Install system deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    git \
    xz-utils \
    python3 \
    python3-pip \
    python3-venv \
    procps \
    jq \
  && rm -rf /var/lib/apt/lists/*

# Install node
# - This is apparently the typical way to do it 🤷
# - Set ARCH dynamically (arm64 for docker on macos/apple, amd64 for linux/intel)
ARG NODE_VERSION=24.14.0
RUN ARCH=$(dpkg --print-architecture | sed 's/amd64/x64/') \
  && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${ARCH}.tar.xz" \
  | tar -xJ --strip-components=1 -C /usr/local

# Install caddy
# - Set ARCH dynamically (arm64 for docker on macos/apple, amd64 for linux/intel)
RUN ARCH=$(dpkg --print-architecture) \
  && curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=${ARCH}" -o /usr/local/bin/caddy \
  && chmod a+x /usr/local/bin/caddy

# Install opencode
# - Pin version for reproducible builds. Bump manually when upgrading.
ARG OPENCODE_VERSION=1.14.18
RUN npm install -g opencode-ai@${OPENCODE_VERSION}

# Install python deps
# - Restrict COPY to just requirements.txt, because `COPY . .` busts cache on _any_ file change -- annoying in dev
# - Precompile .pyc at build time so the slow shared CPU doesn't have to at startup
COPY requirements.txt .
RUN python3 -m venv .venv \
  && .venv/bin/pip install --no-cache-dir -r requirements.txt \
  && python3 -m compileall -q .venv

# Install node deps
# - Restrict COPY to just package.json, because `COPY . .` busts cache on _any_ file change -- annoying in dev
# - After python deps, since node deps will change more often
COPY package.json .
RUN npm install

# Copy project dir
COPY . .
RUN chmod a+x bin/*

# Build frontend (Vite outputs to frontend/dist/)
RUN npx vite build frontend/

# Create frontend/dist/version.json from git sha/time
RUN printf '{"sha":"%s","time":"%s"}\n' \
  "$(git rev-parse --short HEAD)" \
  "$(git log -1 --format=%cI)" \
  > frontend/dist/version.json

# git config
# - HACK fsync all git writes to avoid data loss when fly vms do weird vm things
#   - Without this, we observed (3 times) that loose objects would occasionally get written as empty files, corrupting git
#   - See MEMORY.md for details (2026-03-13, 2026-03-04, 2026-03-03)
RUN git config --global core.fsync all \
 && git config --global core.fsyncMethod fsync

EXPOSE 8080

ENTRYPOINT ["/opt/dancodes/bin/run"]
