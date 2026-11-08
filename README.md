# Robótica Educativa: tienda de kits con microservicios

Tienda en línea de kits de robótica para niños y jóvenes de 8 a 16 años, organizados en tres niveles (principiante, intermedio y avanzado). Está construida como **tres microservicios** y una **tienda web**, listos para desplegar en Azure (o en AWS, con el mismo patrón del laboratorio).

## Estructura

```
catalog-service/   Catálogo: niveles, búsqueda, filtros, ficha y gestión de productos (admin)
users-service/     Usuarios: registro, inicio y cierre de sesión, perfil
orders-service/    Pedidos: carrito, pago simulado, historial y estado del pedido
frontend/          Tienda web (HTML/CSS/JS) + nginx que enruta /api/* a cada servicio
docker-compose.yml Levanta todo en tu computador
azure-pipelines.yml  Pipeline de Azure DevOps (construir, subir imágenes, desplegar)
GUIA-AZURE.md      Despliegue paso a paso en Azure Container Apps
```

## Probar en tu computador

Requiere Docker. Desde esta carpeta:

```bash
docker compose up --build
```

Abre http://localhost:8080. Administrador de prueba: `admin@robotica.local` / `Admin1234!`.
Tarjeta de prueba: `4242 4242 4242 4242`, vence `12/29`, CVV `123`. Con `4000 0000 0000 0002` el pago se rechaza.

## API (todas bajo el mismo dominio)

| Servicio | Ruta | Acceso |
|---|---|---|
| Catálogo | `GET /api/catalog/levels`, `/categories`, `/products?level=&category=&q=`, `/products/:id` | Público |
| Catálogo | `POST/PUT/DELETE /api/catalog/admin/products[/:id]` | Administrador |
| Usuarios | `POST /api/users/register`, `/login` | Público |
| Usuarios | `POST /api/users/logout`, `GET/PUT /api/users/me` | Sesión iniciada |
| Pedidos | `GET/POST /api/orders/cart[/items]`, `PUT/DELETE /api/orders/cart/items/:productId` | Sesión iniciada |
| Pedidos | `POST /api/orders/checkout`, `GET /api/orders/orders[/:id]` | Sesión iniciada |
| Pedidos | `GET /api/orders/admin/orders`, `PUT /api/orders/admin/orders/:id/status` | Administrador |
| Todos | `GET /api/<servicio>/health` | Público |

## Historias de usuario cubiertas

| Sprint | Historia | Estado |
|---|---|---|
| 1 Catálogo | Navegar por niveles, ficha clara, búsqueda por nombre, filtro por categoría | Hecho |
| 2 Usuarios | Registro e inicio de sesión, editar perfil, cerrar sesión | Hecho |
| 3 Compras | Carrito, pago (simulado) | Hecho |
| 4 | Historial de compras, estado del pedido | Hecho |
| 4 | Reseñas de productos | **No incluida** |
| 5 | Gestión de productos (administrador) | Hecho |
| 5 | Contactar con soporte | **No incluida** |

Quedan fuera las reseñas y el contacto con soporte. Los productos de ejemplo (9 kits) son datos de demostración: se cambian desde la pantalla de Administración.

## Decisiones de diseño

- **Una base de datos por servicio.** Cada servicio usa su propia base (`catalog_db`, `users_db`, `orders_db`) dentro de un mismo servidor MySQL, y las crea solo al arrancar.
- **Pedidos consulta el precio al catálogo.** El precio nunca viene del navegador, y se guarda una copia del nombre y el precio en cada pedido.
- **Sesión con JWT** de 8 horas, firmado con un secreto compartido (`JWT_SECRET`). Las contraseñas se guardan con bcrypt.
- **Pago simulado:** no se guarda el número de la tarjeta, solo los últimos 4 dígitos.
- **El navegador solo habla con nginx.** Los microservicios no se exponen, y por eso no se necesita CORS.

## Antes de usarlo de verdad

Es un proyecto académico. Para producción habría que cambiar `JWT_SECRET` y las claves, exigir TLS verificado hacia la base de datos, agregar límites de intentos de inicio de sesión, y pruebas automáticas.

## Variables de entorno

| Variable | Servicio | Uso |
|---|---|---|
| `PORT` | todos | Puerto (por defecto 8080) |
| `JWT_SECRET` | catálogo, usuarios, pedidos | Secreto de las sesiones. **Debe ser igual en los tres** |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD` | catálogo, usuarios, pedidos | Conexión a MySQL |
| `DB_SSL` | catálogo, usuarios, pedidos | `true` para conectar con TLS (Azure MySQL) |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | usuarios | Administrador inicial |
| `CATALOG_URL` | pedidos | Dirección del catálogo |
| `CATALOG_URL`, `USERS_URL`, `ORDERS_URL` | frontend | Direcciones a las que nginx reenvía `/api/...` |
