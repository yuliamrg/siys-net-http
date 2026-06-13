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

## Contratos principales

### Órdenes

- Método y ruta: `GET /api/order/v2`.
- Respuesta: objeto con `docs`, `total` y `page`.
- Paginación confirmada: `page` y `limit`.
- Filtros observados: `code`, `causa`, `raiz`, `range[]`, `state`, `checkIn`, `subsidiary`, `start`, `end`, `total` y `up`.
- El consumidor usa por defecto el mes actual y permite reemplazar parámetros desde la CLI.
- Campos principales observados: `_id`, `code`, `observations`, `equipments`, `users`, `checkIn`, `requiredQuotation`, `close`, `type`, `customer`, `subsidiary`, `material`, `dates`, `state`, `created_by`, `tasks`, `counters`, `maintenances`, `created_at` y `update_at`.

Endpoints auxiliares observados: `/api/causa-raiz`, `/api/order-type`, `/api/customer`, `/api/user` y `/api/marker`.

### Cotizaciones

- Método y ruta: `GET /api/cotizacion`.
- Respuesta: arreglo JSON.
- Filtros confirmados: `fullCode`, `fecha_busqueda`, `estado`, `cliente`, `sucursal`, `inicio` y `fin`.
- `fecha_busqueda=1` corresponde a fecha de registro y `fecha_busqueda=0` a fecha de venta.
- El consumidor usa por defecto fecha de registro desde el inicio del año hasta el momento de ejecución.
- Campos principales observados: `_id`, `fullCode`, `codigo`, `code`, `titulo`, `unidad_negocio`, `estado`, `estados`, `articulos`, `spendPlan`, `modo`, `cliente`, `sucursal`, `obs`, `iva`, `descuento`, `tipo`, `fecha`, `anio`, `mes` y `creadoPor`.

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

Resultados XLSX del 12 de junio de 2026:

| Módulo | Registros | Archivo |
| --- | ---: | --- |
| Órdenes | 59 | `exports/orders.xlsx` |
| Cotizaciones | 311 | `exports/quotes.xlsx` |
| Clientes | 86 | `exports/clients.xlsx` |
| Equipos | 4.908 | `exports/equipment.xlsx` |

Las cantidades dependen de la fecha, los filtros y los permisos de la cuenta. Órdenes corresponde al rango mensual predeterminado y cotizaciones al rango anual predeterminado.

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
