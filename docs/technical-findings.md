# Informe técnico de exploración de SIYS

Fecha de validación: 12 de junio de 2026. Alcance autorizado: órdenes, cotizaciones, clientes y equipos. La exploración se ejecutó en modo de solo lectura.

## Arquitectura observada

- Frontend: SPA React creada con Create React App y servida desde `https://app.siys.net/`.
- Servidor web: nginx 1.18.0 sobre Ubuntu.
- Backend: Express detrás de nginx en `https://api.siys.net`.
- Recursos de negocio: base `https://api.siys.net/api`.
- Librerías visibles: Axios, Redux, Socket.IO, Ant Design y Leaflet.
- Almacenamiento de sesión: `localStorage` del origen del frontend.
- El frontend usa pestañas y vistas internas; las rutas del navegador no siempre cambian al abrir un módulo.
- Se observaron intentos WebSocket de Socket.IO que devolvieron HTTP 400 durante pruebas aisladas. Esto no impidió las consultas REST.

## Autenticación

1. El formulario envía `POST https://api.siys.net/login`.
2. El cuerpo JSON contiene `email` y `password`.
3. Una autenticación correcta devuelve HTTP 200 y un token como respuesta.
4. El frontend guarda ese valor en `localStorage` con la clave `token`.
5. Las consultas posteriores agregan el encabezado no estándar `authentication: Bearer <token>`.
6. El frontend interpreta el token como JWT y elimina `token` al cerrar sesión o ante ciertos errores de políticas.

No se observó un endpoint de renovación durante esta exploración. Tampoco se confirmó una expiración automática; debe validarse con una sesión prolongada. La contraseña no se registra en capturas, HAR ni logs del proyecto.

### Login HTTP directo

El 15 de junio de 2026 se validó que no es necesario usar la UI para obtener una sesión. El endpoint `POST https://api.siys.net/login` acepta directamente las credenciales de `.env` (`SIYS_EMAIL` y `SIYS_PASSWORD`) con cuerpo JSON y devuelve un JWT en la respuesta. Aunque el servidor responde con `content-type: text/html; charset=utf-8`, el cuerpo es el token.

El JWT observado tiene tres partes y contiene `iat`, `_id`, `email` y `name`; no contiene `exp`. Por tanto, el cliente no puede calcular una fecha de vencimiento local. La sesión guardada el 12 de junio de 2026 seguía funcionando durante las pruebas del 15 de junio de 2026, lo que indica persistencia superior a un día, pero no prueba duración indefinida.

La CLI reutilizable automatiza este proceso: `siys download` usa `SIYS_TOKEN`, la sesión guardada o login HTTP directo con `SIYS_EMAIL` y `SIYS_PASSWORD`. Si una consulta devuelve un error de autenticación, intenta renovar sesión una vez y repite la descarga. El uso operativo esta documentado en [`cli-manual.md`](cli-manual.md) y [`installation.md`](installation.md).

## Contratos principales

### Órdenes

- Método y ruta: `GET /api/order/v2`.
- Respuesta: objeto con `docs`, `total` y `page`.
- Paginación confirmada: `page` y `limit`.
- Filtros observados: `code`, `causa`, `raiz`, `range[]`, `state`, `checkIn`, `subsidiary`, `start`, `end`, `total` y `up`.
- El consumidor usa por defecto desde el inicio del año hasta la fecha de ejecución y permite reemplazar parámetros desde la CLI.
- Campos principales observados: `_id`, `code`, `observations`, `equipments`, `users`, `checkIn`, `requiredQuotation`, `close`, `type`, `customer`, `subsidiary`, `material`, `dates`, `state`, `created_by`, `tasks`, `counters`, `maintenances`, `created_at` y `update_at`.

Endpoints auxiliares observados: `/api/causa-raiz`, `/api/order-type`, `/api/customer`, `/api/user` y `/api/marker`.

### Cotizaciones

- Método y ruta: `GET /api/cotizacion`.
- Respuesta: arreglo JSON.
- Detalle observado en la interfaz: `GET /api/cotizacion/{_id}`.
- Filtros confirmados: `fullCode`, `fecha_busqueda`, `estado`, `cliente`, `sucursal`, `inicio` y `fin`.
- `fecha_busqueda=1` corresponde a fecha de registro y `fecha_busqueda=0` a fecha de venta.
- El consumidor usa por defecto fecha de registro desde el inicio del año hasta el momento de ejecución.
- Campos principales observados: `_id`, `fullCode`, `codigo`, `code`, `titulo`, `unidad_negocio`, `estado`, `estados`, `articulos`, `spendPlan`, `modo`, `cliente`, `sucursal`, `obs`, `iva`, `descuento`, `tipo`, `fecha`, `anio`, `mes` y `creadoPor`.
- `articulos[]` contiene agrupadores y líneas cobrables. Las líneas cobrables observadas incluyen `descripcion`, `unidad`, `cantidad`, `factorVenta` y componentes `equipos`, `materiales`, `contratista`, `mano_de_obra`, `transporte` y `viaticos`; cada componente puede incluir `valor` y `desglose[]`.
- La interfaz calcula precio unitario, subtotal, descuento, IVA y total. El listado muestra el subtotal previo a descuento e IVA; la CLI normaliza estos importes con `siys quote inspect <codigo>`.
- El detalle enriquece `estados[]` con el nombre del usuario y del estado. El estado vigente debe tomarse de `estado`, no del primer elemento del historial.
- La respuesta puede incluir campos sensibles dentro de `creadoPor`, como credenciales o tokens. Las exportaciones de cotizaciones deben sanearlos antes de guardarse o compartirse.

Endpoints auxiliares observados: `/api/cotizacion-estado`, `/api/cotizacion-unidad-negocio`, `/api/unidad-medida`, `/api/customer`, `/api/user` y `/api/marker`.

### Clientes

- Método y ruta: `GET /api/customer`.
- Respuesta: arreglo JSON sin paginación observada.
- La sesión validada devolvió 86 clientes.
- Campos principales observados: `_id`, `name`, `telephone`, `address`, `email`, `subsidiarys`, `equipments`, `allowShowMaintenance`, `allowShowReport`, `created_by`, `created_at` y `update_at`.

La interfaz muestra 20 registros por página, pero el endpoint devuelve la colección completa para la cuenta.

### Equipos

- Método y ruta: `GET /api/equipment?customer=<id>`.
- Respuesta: arreglo JSON por cliente.
- Para consolidar todos los equipos, el consumidor obtiene primero `/api/customer` y consulta cada cliente en lotes de cinco.
- Campos principales observados: `_id`, `name`, `type`, `sub_type`, `state`, `valid`, `subsidiary`, `customer`, `bands`, `capacitors`, `filters`, `materials`, `files`, `photos`, `countFiles`, `dateLastMaintenance`, `obsum`, `created_by`, `created_at` y `update_at`.

Endpoints auxiliares observados: `/api/subsidiary` y `/api/crud/findOne`.

## Permisos observados

- La cuenta puede leer los cuatro módulos solicitados.
- La interfaz indicó ausencia de permisos para editar, borrar y administrar usuarios de clientes.
- El explorador bloquea `POST`, `PUT`, `PATCH` y `DELETE`, salvo el `POST /login` requerido para autenticar.
- No se ejecutaron acciones de creación, edición, aprobación, cambio de estado o eliminación.

## Exportación validada

El consumidor HTTP funciona sin depender de la interfaz después de obtener una sesión válida. Se validaron JSON y XLSX, y existen exportadores probados para CSV y Parquet.

### Extracción directa sin UI

El 15 de junio de 2026 se confirmó que la extracción de datos no requiere navegar la interfaz cuando ya existe una sesión válida en `private/storage-state.json` o cuando se provee `SIYS_TOKEN`. El comando `export` carga el token y consulta directamente `https://api.siys.net/api` con el encabezado `authentication: Bearer <token>`.

Esto cambia el flujo recomendado para análisis: la UI debe tratarse como mecanismo auxiliar para autenticación inicial, renovación de sesión o descubrimiento de filtros/endpoints nuevos. La descarga operativa puede hacerse únicamente por HTTP, lo que reduce dependencia de selectores, tiempos de carga, pestañas internas y cambios visuales del frontend.

Prueba ejecutada por HTTP directo, sin abrir navegador:

| Módulo | Registros | Archivo |
| --- | ---: | --- |
| Clientes | 86 | `exports/http-direct-clients-test.json` |
| Órdenes | 60 | `exports/http-direct-orders-test.json` |
| Cotizaciones | 311 | `exports/http-direct-quotes-test.json` |
| Equipos | 4.908 | `exports/http-direct-equipment-test.json` |

La prueba de órdenes usó `--max-pages 1`; por tanto, el conteo corresponde a la primera página del rango mensual predeterminado en ese momento. Equipos consolidó clientes y luego consultó `/api/equipment?customer=<id>` por cada cliente.

Resultados XLSX del 12 de junio de 2026:

| Módulo | Registros | Archivo |
| --- | ---: | --- |
| Órdenes | 59 | `exports/orders.xlsx` |
| Cotizaciones | 311 | `exports/quotes.xlsx` |
| Clientes | 86 | `exports/clients.xlsx` |
| Equipos | 4.908 | `exports/equipment.xlsx` |

Las cantidades dependen de la fecha, los filtros y los permisos de la cuenta. Órdenes y cotizaciones usan un rango anual predeterminado.

## Seguridad y evidencias

- `.env`, `private/` y `exports/` están excluidos de Git.
- `private/storage-state.json` contiene el estado autenticado y debe tratarse como secreto.
- Las capturas NDJSON redactan claves como contraseña, token, autorización, cookies y secretos.
- No se genera HAR durante el login porque podría incluir la contraseña.
- `artifacts/endpoint-inventory.json` conserva solamente un inventario sanitizado de rutas y estados.

## Limitaciones pendientes

- Confirmar duración real del token y comportamiento cuando expira.
- Confirmar si existe renovación silenciosa o si siempre se requiere un nuevo login.
- Revisar otros filtros de negocio solo cuando sean necesarios para un análisis concreto.
- La clasificación automática depende de la estructura actual del frontend; cambios de etiquetas pueden exigir actualizar selectores.
