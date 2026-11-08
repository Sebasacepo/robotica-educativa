FROM nginx:1.27-alpine
# Las plantillas de /etc/nginx/templates se procesan con envsubst al arrancar.
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY index.html styles.css app.js /usr/share/nginx/html/
ENV NGINX_ENVSUBST_FILTER="^(CATALOG|USERS|ORDERS)_URL$"
ENV CATALOG_URL=http://catalog:8080 \
    USERS_URL=http://users:8080 \
    ORDERS_URL=http://orders:8080
EXPOSE 80
