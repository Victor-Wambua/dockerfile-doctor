# syntax=docker/dockerfile:1.7
# Laravel-shaped PHP app, two deployable images from one file:
#   docker build --target app -t sample-php-app .   (php-fpm, port 9000)
#   docker build --target web -t sample-php-web .   (nginx, port 8080, proxies PHP to the app image)
# The default (last) target is "web".
ARG PHP_VERSION=8.3
ARG COMPOSER_VERSION=2.8

# --- Stage 1: PHP dependencies. Composer and the dev tooling never reach a runtime image.
FROM composer:${COMPOSER_VERSION} AS vendor
WORKDIR /app
COPY composer.json composer.lock ./
RUN composer install --no-dev --no-scripts --no-autoloader --prefer-dist --no-interaction
COPY . .
RUN composer dump-autoload --no-dev --classmap-authoritative --no-interaction

# --- Stage 2: php-fpm runtime. The master process starts as root only to bind its socket and
# drop privileges; every worker runs as www-data (see pool setting `user` in www.conf).
FROM php:${PHP_VERSION}-fpm-alpine3.21 AS app
RUN apk add --no-cache --virtual .build-deps $PHPIZE_DEPS \
 && docker-php-ext-install pdo_mysql opcache \
 && apk del .build-deps
COPY docker/php.ini /usr/local/etc/php/conf.d/zz-app.ini
WORKDIR /var/www/html
COPY --from=vendor --chown=www-data:www-data /app ./
EXPOSE 9000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["php", "-r", "exit(@fsockopen('127.0.0.1', 9000) ? 0 : 1);"]
CMD ["php-fpm"]

# --- Stage 3: nginx in front. The unprivileged image runs as uid 101 and listens on 8080.
FROM nginxinc/nginx-unprivileged:1.27-alpine AS web
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=app /var/www/html/public /var/www/html/public
USER 101
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/ping || exit 1
