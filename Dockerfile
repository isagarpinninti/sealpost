# Self-hosted Sealpost: Studio, REST API, SMTP engine and schedulers in one container.
#
#   docker compose up -d                      (see docker-compose.yml; set SEALPOST_API_KEY first)
#   docker build -t sealpost . && docker run -p 4320:4320 -e SEALPOST_API_KEY=change-me -v "$PWD/data:/project" sealpost
#
# Built from source, so it works before and after the npm release.
FROM node:22-alpine AS build
WORKDIR /src
COPY . .
RUN npm ci && npm run build && mkdir /out && npm pack -w @sealpost/core -w @sealpost/cli --pack-destination /out

FROM node:22-alpine
COPY --from=build /out /tmp/pkgs
RUN npm install -g /tmp/pkgs/*.tgz zod && rm -rf /tmp/pkgs \
 && addgroup -S sealpost && adduser -S sealpost -G sealpost \
 && mkdir /project && chown sealpost:sealpost /project
USER sealpost
WORKDIR /project
VOLUME /project
EXPOSE 4320 2525
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:4320/api/health >/dev/null || exit 1
# First start scaffolds the project. The server refuses to bind 0.0.0.0 without SEALPOST_API_KEY (or keys from `sealpost auth add-key`).
CMD ["sh", "-c", "[ -f /project/sealpost.config.json ] || sealpost init /project; exec sealpost studio /project --host 0.0.0.0 --port 4320"]
