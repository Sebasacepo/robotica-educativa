# Guía de despliegue en Azure (Container Apps)

Esta guía parte de lo que ya tienes creado:

- Grupo de recursos **robotica-rg**
- Entorno de Container Apps **robotica-env** en **westus2** (la región que permitió tu suscripción Azure for Students)

> **Qué está probado y qué no.** El código se probó aquí con una base de datos real y nginx real (flujo completo de la API y de la tienda en el navegador). Los **Dockerfiles** y **todos los comandos de Azure de esta guía no se pudieron ejecutar** desde el entorno donde se escribió. Si un comando falla, copia el mensaje de error completo: casi siempre es un nombre repetido, una región no permitida o un permiso.

Todos los comandos se pegan en **Azure Cloud Shell (Bash)**, de uno en uno.

---

## 0. Cómo se ve la arquitectura

```
Navegador ──► frontend (nginx, ingress EXTERNO, puerto 80)
                 ├── /api/catalog/* ──► catalog-service (interno, 8080)
                 ├── /api/users/*   ──► users-service   (interno, 8080)
                 └── /api/orders/*  ──► orders-service  (interno, 8080) ──► catalog-service
                                              │
                          MySQL: catalog_db · users_db · orders_db
```

Solo el frontend tiene dirección pública. Los tres microservicios son internos y el frontend (nginx) enruta por ruta, igual que las reglas del balanceador en el laboratorio de AWS.

---

## 1. Variables

Cambia los valores marcados. Los nombres del registro y del servidor MySQL deben ser **únicos en todo Azure** (solo minúsculas y números en el registro).

```bash
RG=robotica-rg
ENV=robotica-env
LOC=westus2
ACR=roboticaacr$RANDOM          # anota el valor: echo $ACR
DBHOST=robotica-mysql-$RANDOM   # anota el valor: echo $DBHOST
DBUSER=robotica
DBPASS='Robotica-Clave-2026'    # cámbiala por una propia (sin comillas simples)
JWT='cambia-este-secreto-largo-123'
ADMINPASS='Admin1234!'          # contraseña del administrador de la tienda
```

> Cloud Shell pierde las variables si se cierra la sesión. Si vuelves más tarde, vuelve a pegar este bloque con **los mismos valores de `ACR` y `DBHOST`** (sin `$RANDOM`).

## 2. Registro de imágenes (Azure Container Registry)

```bash
az provider register --namespace Microsoft.ContainerRegistry --wait
az acr create --resource-group $RG --name $ACR --sku Basic --location $LOC --admin-enabled true
ACR_USER=$(az acr credential show -n $ACR --query username -o tsv)
ACR_PASS=$(az acr credential show -n $ACR --query "passwords[0].value" -o tsv)
```

Si la región no está permitida para el registro, el error lo dirá. Prueba con otra región de la lista que te dé el mensaje.

## 3. Construir y subir las 4 imágenes

Descomprime el zip del proyecto y entra a la carpeta (en Cloud Shell: botón **Administrar archivos → Cargar**, luego `unzip` y `cd`).

**Opción A, construir en Azure (sin Docker en tu computador):**

```bash
az acr build --registry $ACR --image catalog:v1  ./catalog-service
az acr build --registry $ACR --image users:v1    ./users-service
az acr build --registry $ACR --image orders:v1   ./orders-service
az acr build --registry $ACR --image frontend:v1 ./frontend
```

Algunas suscripciones gratuitas o de estudiante bloquean `az acr build` (suele aparecer un error sobre "Tasks" no permitidas). Si te pasa, usa la B o la C.

**Opción B, con Docker en tu computador:**

```bash
az acr login --name $ACR
docker build -t $ACR.azurecr.io/catalog:v1  ./catalog-service  && docker push $ACR.azurecr.io/catalog:v1
docker build -t $ACR.azurecr.io/users:v1    ./users-service    && docker push $ACR.azurecr.io/users:v1
docker build -t $ACR.azurecr.io/orders:v1   ./orders-service   && docker push $ACR.azurecr.io/orders:v1
docker build -t $ACR.azurecr.io/frontend:v1 ./frontend         && docker push $ACR.azurecr.io/frontend:v1
```

**Opción C, con el pipeline** de Azure DevOps (`azure-pipelines.yml`, ver sección 8). Construye y sube las imágenes con la etiqueta del número de ejecución en lugar de `v1`.

Comprueba que están: `az acr repository list -n $ACR -o table` debe mostrar `catalog`, `users`, `orders` y `frontend`.

## 4. Base de datos MySQL

**Opción A, MySQL administrado (la recomendada):**

```bash
az provider register --namespace Microsoft.DBforMySQL --wait
az mysql flexible-server create --resource-group $RG --name $DBHOST --location $LOC \
  --admin-user $DBUSER --admin-password "$DBPASS" \
  --sku-name Standard_B1ms --tier Burstable --storage-size 20 \
  --public-access 0.0.0.0 --yes
```

- `--public-access 0.0.0.0` permite que los servicios de Azure se conecten.
- Revisa el costo en **Cost Management** apenas termine. No pude confirmar el precio exacto en tu suscripción.
- Si da error de región o de oferta no disponible (es frecuente en cuentas de estudiante), usa la opción B.
- Los servicios crean solos las bases `catalog_db`, `users_db` y `orders_db` y sus tablas al arrancar. No hay que cargar ningún script.

Las aplicaciones usarán `DB_HOST=$DBHOST.mysql.database.azure.com` y `DB_SSL=true` (Azure MySQL exige conexión cifrada).

**Opción B, MySQL como contenedor (solo para la demostración):**

```bash
az containerapp create --name mysql-db --resource-group $RG --environment $ENV \
  --image mysql:8.0 --ingress internal --transport tcp --target-port 3306 --exposed-port 3306 \
  --min-replicas 1 --max-replicas 1 --cpu 0.5 --memory 1Gi \
  --secrets rootpass="$DBPASS" --env-vars MYSQL_ROOT_PASSWORD=secretref:rootpass
```

Aquí los datos **se pierden si el contenedor se reinicia** (los servicios vuelven a crear tablas y productos de ejemplo, pero no los pedidos). En esta opción usa `DB_HOST=mysql-db`, `DB_USER=root` y **sin** `DB_SSL`. No la probé.

## 5. Crear las aplicaciones

Define, según la opción de base de datos que usaste:

```bash
# Opción A (MySQL administrado):
DB_HOST_VALUE=$DBHOST.mysql.database.azure.com ; DB_USER_VALUE=$DBUSER ; DB_SSL_VALUE=true
# Opción B (contenedor): descomenta estas tres y comenta las de arriba
# DB_HOST_VALUE=mysql-db ; DB_USER_VALUE=root ; DB_SSL_VALUE=false
```

**5.1 Catálogo (interno)**

```bash
az containerapp create --name catalog-service --resource-group $RG --environment $ENV \
  --image $ACR.azurecr.io/catalog:v1 \
  --registry-server $ACR.azurecr.io --registry-username $ACR_USER --registry-password $ACR_PASS \
  --ingress internal --target-port 8080 --cpu 0.25 --memory 0.5Gi --min-replicas 1 --max-replicas 2 \
  --secrets jwt="$JWT" dbpass="$DBPASS" \
  --env-vars JWT_SECRET=secretref:jwt DB_PASSWORD=secretref:dbpass \
             DB_HOST=$DB_HOST_VALUE DB_USER=$DB_USER_VALUE DB_SSL=$DB_SSL_VALUE
```

**5.2 Usuarios (interno)**

```bash
az containerapp create --name users-service --resource-group $RG --environment $ENV \
  --image $ACR.azurecr.io/users:v1 \
  --registry-server $ACR.azurecr.io --registry-username $ACR_USER --registry-password $ACR_PASS \
  --ingress internal --target-port 8080 --cpu 0.25 --memory 0.5Gi --min-replicas 1 --max-replicas 2 \
  --secrets jwt="$JWT" dbpass="$DBPASS" adminpass="$ADMINPASS" \
  --env-vars JWT_SECRET=secretref:jwt DB_PASSWORD=secretref:dbpass ADMIN_PASSWORD=secretref:adminpass \
             ADMIN_EMAIL=admin@robotica.local \
             DB_HOST=$DB_HOST_VALUE DB_USER=$DB_USER_VALUE DB_SSL=$DB_SSL_VALUE
```

**5.3 Direcciones internas de catálogo y usuarios**

```bash
CATALOG_FQDN=$(az containerapp show -n catalog-service -g $RG --query properties.configuration.ingress.fqdn -o tsv)
USERS_FQDN=$(az containerapp show -n users-service -g $RG --query properties.configuration.ingress.fqdn -o tsv)
echo $CATALOG_FQDN $USERS_FQDN
```

Deben verse como `catalog-service.internal.<algo>.westus2.azurecontainerapps.io`.

**5.4 Pedidos (interno, habla con catálogo)**

```bash
az containerapp create --name orders-service --resource-group $RG --environment $ENV \
  --image $ACR.azurecr.io/orders:v1 \
  --registry-server $ACR.azurecr.io --registry-username $ACR_USER --registry-password $ACR_PASS \
  --ingress internal --target-port 8080 --cpu 0.25 --memory 0.5Gi --min-replicas 1 --max-replicas 2 \
  --secrets jwt="$JWT" dbpass="$DBPASS" \
  --env-vars JWT_SECRET=secretref:jwt DB_PASSWORD=secretref:dbpass \
             CATALOG_URL=https://$CATALOG_FQDN \
             DB_HOST=$DB_HOST_VALUE DB_USER=$DB_USER_VALUE DB_SSL=$DB_SSL_VALUE
ORDERS_FQDN=$(az containerapp show -n orders-service -g $RG --query properties.configuration.ingress.fqdn -o tsv)
```

**5.5 Frontend (el único público)**

```bash
az containerapp create --name frontend --resource-group $RG --environment $ENV \
  --image $ACR.azurecr.io/frontend:v1 \
  --registry-server $ACR.azurecr.io --registry-username $ACR_USER --registry-password $ACR_PASS \
  --ingress external --target-port 80 --cpu 0.25 --memory 0.5Gi --min-replicas 1 --max-replicas 2 \
  --env-vars CATALOG_URL=https://$CATALOG_FQDN USERS_URL=https://$USERS_FQDN ORDERS_URL=https://$ORDERS_FQDN
az containerapp show -n frontend -g $RG --query properties.configuration.ingress.fqdn -o tsv
```

El último comando imprime la dirección pública de la tienda. Ábrela con `https://` delante.

## 6. Comprobar que funciona

1. Abre la dirección de la tienda: debe verse el inicio con los 3 niveles.
2. Entra a `https://<tu-direccion>/api/catalog/health`: debe responder `{"status":"ok","service":"catalog"}`. Igual con `/api/users/health` y `/api/orders/health`.
3. Crea una cuenta, agrega un kit, paga con `4242 4242 4242 4242` (vence `12/29`, CVV `123`) y mira el pedido.
4. Inicia sesión como administrador (`admin@robotica.local` y la contraseña de `ADMINPASS`) y abre **Administración**.

Ver registros de un servicio:

```bash
az containerapp logs show -n orders-service -g $RG --tail 50
```

## 7. Si algo falla

| Síntoma | Causa probable | Qué hacer |
|---|---|---|
| La tienda abre pero el catálogo sale con error | El frontend no alcanza al catálogo | Revisa que `CATALOG_URL` empiece con `https://` y que el servicio esté corriendo (`az containerapp show -n catalog-service -g $RG --query properties.runningStatus`) |
| 502/504 al abrir la tienda por primera vez | Un servicio todavía está arrancando | Espera un minuto y recarga |
| Un servicio se reinicia en bucle | No conecta a MySQL | Mira `logs show`. Si dice `ENOTFOUND` revisa `DB_HOST`. Si dice `Access denied` revisa `DB_USER`/`DB_PASSWORD`. Si dice `insecure connection`, falta `DB_SSL=true` |
| `RequestDisallowedByAzure` | Región no permitida | Usa una de las regiones que acepta tu suscripción |
| `az acr build` rechazado | Tareas bloqueadas en tu oferta | Construye con Docker (opción B) o con el pipeline |
| Cambié una imagen y no se actualiza | Falta crear nueva revisión | `az containerapp update -n <app> -g $RG --image $ACR.azurecr.io/<repo>:<etiqueta>` |

## 8. Pipeline en Azure DevOps (la vista de CI/CD)

1. Crea una organización y un proyecto en `dev.azure.com`.
2. Sube este código a **Repos** (rama `main`).
3. En **Project settings → Service connections** crea dos conexiones: `acr-connection` (Docker Registry → Azure Container Registry) y `azure-connection` (Azure Resource Manager).
4. Abre `azure-pipelines.yml` y cambia `acrName` por el nombre real de tu registro (`echo $ACR`).
5. En **Pipelines → New pipeline** elige el repositorio y "Existing Azure Pipelines YAML file".
6. Ejecútalo. Verás las etapas **Construir y subir imágenes** y **Desplegar en Container Apps**.

Las organizaciones nuevas a veces no traen agentes gratuitos de Microsoft para correr pipelines. Si aparece un aviso de paralelismo, hay que solicitarlo con el formulario de Microsoft (tarda días) o usar un agente propio. Esto no lo pude comprobar para tu cuenta: pruébalo pronto.

## 9. Cuidar el crédito

- Cada aplicación con 1 réplica mínima consume crédito todo el tiempo. Para ahorrar entre sesiones: `az containerapp update -n <app> -g $RG --min-replicas 0` (la primera visita tarda unos segundos más). Súbelo a 1 el día de la presentación.
- Revisa **Cost Management → Cost analysis** cada día.
- Al terminar el curso, borra todo de una vez: `az group delete --name $RG --yes --no-wait`.

## 10. Qué mostrar en la presentación

1. El grupo **robotica-rg** en el portal con sus recursos (entorno, aplicaciones, registro, base de datos).
2. Que solo el frontend tiene dirección pública y que los tres microservicios son internos.
3. La tienda funcionando: catálogo por niveles, carrito, pago simulado, pedido.
4. El pipeline en Azure DevOps y una ejecución con etapas en verde.
5. Un cambio en un solo servicio (por ejemplo el texto del inicio o un producto) desplegado sin tocar los demás.
6. Equivalencias con el laboratorio de AWS: ECR ↔ Azure Container Registry, ECS Fargate ↔ Container Apps, reglas del ALB por ruta ↔ nginx en el frontend, CodePipeline/CodeDeploy ↔ Azure Pipelines.
