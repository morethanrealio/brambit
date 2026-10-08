# ── User sandbox base image ──
# A single image, run as one container per user. Has what a person needs
# to "develop things": python, node, git and common tools.
# Runs as a NON-root user. The strong isolation (network, resources, rootfs) comes
# from the `docker run` flags (see runner.mjs), not here.

FROM debian:12-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    NODE_VERSION=20

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget git unzip jq \
      openssh-client \
      python3 python3-pip python3-venv \
      build-essential \
    && rm -rf /var/lib/apt/lists/*

# Node 20 (NodeSource)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Useful scraping/data libraries pre-installed (avoids pip install every time).
RUN pip3 install --break-system-packages --no-cache-dir \
      requests beautifulsoup4 lxml httpx pandas openpyxl xlrd tabulate

# Non-root user. The user's code runs as them, never as root.
RUN useradd -m -u 10001 -s /bin/bash sandbox
WORKDIR /workspace
RUN chown sandbox:sandbox /workspace
USER sandbox

# Stays alive waiting for commands (the runner does `docker exec`); or runs ephemerally.
CMD ["sleep", "infinity"]
