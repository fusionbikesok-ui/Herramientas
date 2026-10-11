FROM wordpress:7.1.2-php8.2-apache
RUN apt-get update \
 && apt-get install -y --no-install-recommends libxml2-dev \
 && docker-php-ext-install -j2 soap \
 && rm -rf /var/lib/apt/lists/*
COPY php-migration.ini /usr/local/etc/php/conf.d/zz-fusion-migration.ini
