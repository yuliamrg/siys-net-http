# Changelog

Todos los cambios relevantes de este proyecto se documentan aquí. Mientras la CLI permanezca en `0.x`, una versión minor puede ajustar contratos visibles; cada ajuste se documentará antes del release.

## [Unreleased]

### Añadido

- Caché local SQLite para los seis módulos de lectura, con retención de registros por ID, scopes de consulta y metadatos de paginación.
- Política cache-first en `download`: 24 horas para catálogos de referencia y 15 minutos para órdenes y cotizaciones; `--refresh` fuerza la consulta remota.
- Comandos `cache refresh`, `cache status`, `cache search` y `cache resolve`, más `--created-by-name` para resolver el generador desde un catálogo de usuarios vigente.
- Archivo SQLite de todas las respuestas JSON GET, con `cache search reads` y `cache read` para localizar consultas de detalle y otras lecturas directas.
- `order apply-review` con revisión y contrato `1.2`: acciones `ensureEquipmentMaintenance` y `addTaskGeneral`, snapshot aprobado `order.approved`, referencias `operationId` hacia atrás y reconciliación por relectura ante respuestas ambiguas. Una cadena `ensureEquipmentMaintenance → addTaskGeneral → addActivity → addImage` se aprueba y ejecuta en una sola revisión.
- `order apply-review` 1.2 admite asociar un `fileId` SIYS existente en `addImage` sin volver a subir el binario.

### Corregido

- `order create` admite franjas puntuales con `startLocal == endLocal` y consulta su disponibilidad por GET; sigue rechazando rangos invertidos.
- `order apply-review` 1.1 relee la lista de actividades justo antes del PATCH de `addActivity` y falla por conflicto si cambió desde la baseline aprobada, en lugar de continuar en silencio.

### Seguridad

- Los registros descargados se sanean antes de exportarlos o guardarlos en SQLite; la caché mantiene datos personales y comerciales, pero redacta contraseñas y credenciales.

## [0.2.0] - 2026-08-02

### Añadido

- `siys --version` y requisito de Node.js 20.19 o posterior.
- Timeouts explícitos para SIYS, descarga de imágenes y análisis visual.
- Errores tipados, códigos de salida estables, JSON limpio en `stderr`, `--debug` y cancelación controlada.
- Metadatos `pagesFetched`, `totalAvailable` y `truncated` en resúmenes de descarga.
- `--allow-partial` para aceptar explícitamente una exportación limitada por `--max-pages`.
- Validación estricta de URLs, endpoints locales, fechas de calendario y codificación JSON.
- ESLint, comando `npm run check` y CI Windows en Node.js 20 y 24.

### Cambiado

- Una descarga potencialmente truncada ahora falla antes de escribir archivos, salvo que se use `--allow-partial`.
- `order create --confirm` devuelve código 6 cuando SIYS recibe la solicitud pero la verificación posterior falla; la auditoría y el recibo se conservan y no debe repetirse automáticamente.
- Los errores normales ya no muestran stack trace; `--debug` lo habilita de forma explícita.

### Seguridad

- `brace-expansion` se resolvió a 1.1.18 y 2.1.4; `npm audit --omit=dev` no reporta vulnerabilidades.
- Se mantiene TLS obligatorio y no se añadieron reintentos para escrituras.

[0.2.0]: https://github.com/yuliamrg/siys-net-http/releases/tag/v0.2.0
