FROM nginx:1.27-alpine

COPY . /usr/share/nginx/html
COPY docker-entrypoint.d/40-api-base.sh /docker-entrypoint.d/40-api-base.sh

EXPOSE 80
