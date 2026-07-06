# ScyllaDB readiness validator image.
# Build from the repo root:  docker build -f validator/Dockerfile .
FROM alpine:3.20

LABEL org.opencontainers.image.source=https://github.com/arnica-io/scylla-readiness-check

# aws-cli and kubectl are both available in the Alpine community repository.
# If `apk add kubectl` ever becomes unavailable on this Alpine version, swap it
# for a direct binary download, e.g.:
#   ARCH=$(apk --print-arch | sed 's/x86_64/amd64/;s/aarch64/arm64/') && \
#   curl -fsSL -o /usr/local/bin/kubectl \
#     "https://dl.k8s.io/release/$(curl -fsSL https://dl.k8s.io/release/stable.txt)/bin/linux/${ARCH}/kubectl" && \
#   chmod +x /usr/local/bin/kubectl
RUN apk add --no-cache bash curl coreutils ca-certificates aws-cli kubectl

# Build context is the repo root, so the script lives under validator/.
COPY validator/check.sh /usr/local/bin/check.sh
RUN chmod +x /usr/local/bin/check.sh

# Non-root user: kubectl and aws-cli do not need root privileges.
RUN adduser -D -u 10001 validator
USER validator

ENTRYPOINT ["/usr/local/bin/check.sh"]
