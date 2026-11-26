# Secrets, sudo, and files that should never be in an image.
# expect: DD002 DD004 DD006 DD008 DD009 DD010 DD014 DD015 DD024 DD025 DD032 DD037
FROM php:8.3-apache
MAINTAINER Ops Team <ops@example.com>
ARG DB_PASSWORD=hunter2
ENV AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
COPY .env /var/www/html/.env
COPY id_rsa /root/.ssh/id_rsa
ADD https://example.com/plugin.tar.gz /tmp/plugin.tar.gz
RUN sudo apt-get install -y git \
 && git clone https://deploy:s3cr3tpass@git.example.com/org/app.git /var/www/html/app
RUN curl -k https://internal.example.com/cert.pem -o /etc/ssl/internal.pem
USER root
