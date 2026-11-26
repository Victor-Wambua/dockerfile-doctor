FROM php:8.3-cli
RUN composer install --no-dev --no-interaction
