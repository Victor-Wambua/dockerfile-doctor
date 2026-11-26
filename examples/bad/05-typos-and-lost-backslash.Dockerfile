# Syntax slips that fail late or silently.
# expect: DD002 DD025 DD032 DD035 DD036 DD039 DD042
FROM debian:12-slim
RNU echo "hello"
RUN apt-get update && apt-get install -y --no-install-recommends curl
 && rm -rf /var/lib/apt/lists/*
EXPOSE 80800
USER app
COPY . /srv/app
CMD ["/srv/app/run"]
CMD ["/srv/app/other"]
