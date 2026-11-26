FROM php:8.3-fpm-alpine
RUN apk add --no-cache --virtual .build-deps $PHPIZE_DEPS \
 && docker-php-ext-install pdo_mysql \
 && apk del .build-deps
