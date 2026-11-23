# Docker Hub rakomi/rakomi: the published `rakomi` CLI (npm) on Node.js 22, run as the unprivileged `node` user.
# Built by .github/workflows/registries.yml on a cli/v<version> release tag, after npm serves that version.
FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914

ARG RAKOMI_VERSION
RUN test -n "${RAKOMI_VERSION}" \
 && npm install --global --ignore-scripts --no-fund --no-audit "rakomi@${RAKOMI_VERSION}" \
 && npm cache clean --force \
 && rakomi --version

LABEL org.opencontainers.image.title="rakomi" \
      org.opencontainers.image.description="The Rakomi CLI" \
      org.opencontainers.image.url="https://rakomi.com" \
      org.opencontainers.image.source="https://github.com/rakomidev/rakomi-js" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${RAKOMI_VERSION}"

USER node
WORKDIR /home/node
ENTRYPOINT ["rakomi"]
CMD ["--help"]
