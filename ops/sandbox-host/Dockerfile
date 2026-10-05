# ── Imagem base do sandbox de usuário ──
# Uma imagem só, rodada como container por usuário. Tem o que a pessoa precisa
# pra "desenvolver coisas": python, node, git e ferramentas comuns.
# Roda como usuário NÃO-root. O isolamento forte (rede, recurso, rootfs) vem nas
# flags do `docker run` (ver runner.mjs), não aqui.

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

# Bibliotecas úteis de scraping/dados já prontas (evita pip install a cada vez).
RUN pip3 install --break-system-packages --no-cache-dir \
      requests beautifulsoup4 lxml httpx pandas openpyxl xlrd tabulate

# Usuário não-root. O código do usuário roda como ele, nunca como root.
RUN useradd -m -u 10001 -s /bin/bash sandbox
WORKDIR /workspace
RUN chown sandbox:sandbox /workspace
USER sandbox

# Fica vivo esperando comandos (o runner faz `docker exec`); ou roda efêmero.
CMD ["sleep", "infinity"]
