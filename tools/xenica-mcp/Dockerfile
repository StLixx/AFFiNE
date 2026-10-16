FROM ghcr.nju.edu.cn/toeverything/affine@sha256:b649f5ce2384ffdf13c23bccf81d759e15973d59d0b0058af65d895a84373099
WORKDIR /mcp
COPY package.json package-lock.json ./
RUN NODE_OPTIONS=--dns-result-order=ipv4first npm ci --workspaces=false --ignore-scripts --omit=dev --no-audit --no-fund --fetch-timeout=30000 --fetch-retries=1 --registry=https://registry.npmjs.org
COPY documents.mjs transport.mjs server.mjs ./
ENTRYPOINT ["node","server.mjs"]
