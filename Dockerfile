# KubeDeck in a container: the web server plus kubectl and helm.
# See "Docker and Podman" in the README for how to run it.

ARG NODE_VERSION=22

# ---- build: compile the server and the web UI
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
# Electron and Playwright are dev tools for the desktop app and the media script; the image needs neither.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# ---- tools: download kubectl and helm, checked against their published checksums
FROM debian:bookworm-slim AS tools
ARG TARGETARCH
ARG KUBECTL_VERSION=v1.34.1
ARG HELM_VERSION=v3.19.0
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /tools
RUN arch="${TARGETARCH:-amd64}" \
 && curl -fsSLo kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${arch}/kubectl" \
 && echo "$(curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${arch}/kubectl.sha256")  kubectl" | sha256sum -c - \
 && chmod +x kubectl \
 && curl -fsSLo helm.tgz "https://get.helm.sh/helm-${HELM_VERSION}-linux-${arch}.tar.gz" \
 && echo "$(curl -fsSL "https://get.helm.sh/helm-${HELM_VERSION}-linux-${arch}.tar.gz.sha256sum" | cut -d' ' -f1)  helm.tgz" | sha256sum -c - \
 && tar -xzf helm.tgz --strip-components=1 "linux-${arch}/helm" \
 && rm helm.tgz

# ---- runtime
FROM node:${NODE_VERSION}-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data /kube \
 && chown node:node /data
COPY --from=tools /tools/kubectl /tools/helm /usr/local/bin/
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/bin ./bin
COPY --from=build /app/dist ./dist

# Listens on all interfaces inside the container; publish it on the host's 127.0.0.1 only.
# Port-forwards also listen on all interfaces and use 7500-7519, which the compose file publishes.
ENV NODE_ENV=production \
    KUBEDECK_HOST=0.0.0.0 \
    KUBEDECK_PORT=7420 \
    KUBEDECK_HOME=/data \
    KUBEDECK_FORWARD_ADDRESS=0.0.0.0 \
    KUBEDECK_FORWARD_PORTS=7500-7519 \
    KUBECONFIG=/kube/config
USER node
VOLUME ["/data"]
EXPOSE 7420 7500-7519
CMD ["node", "bin/kubedeck.js", "--no-open"]
