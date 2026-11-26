FROM debian:12-slim
RUN --mount=type=cache,target=/var/lib/apt apt-get update && apt-get install -y curl
