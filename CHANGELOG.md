# Changelog

Todos los cambios relevantes de este proyecto se documentan aquí. Mientras la CLI permanezca en `0.x`, una versión minor puede ajustar contratos visibles; cada ajuste se documentará antes del release.

## [0.5.1] - 2026-10-20

### Cambiado

- `order apply-review` 1.3 exige que `closeOrder` sea la única operación del lote: el cierre administrativo no comparte lote ni aprobación con ediciones de texto, actividades, imágenes u otras acciones. Se conservan las reglas existentes de lote separado frente a `finalizeOrder` y de máximo un `startOrder`.
- Un contrato `1.2`/`1.3` que edite textos debe declarar el bloque `operations`; `"operations": {}` solo autoriza acciones estructurales y cualquier edición de texto se rechaza antes de escribir.

## [0.5.0] - 2026-10-19

### Añadido

- `order apply-review` 1.2 añade la acción `startOrder` (`PUT /order/{orderId}` con `{"state":2}`): relee la orden antes y después, aplica solo desde `state 1`, respeta `state 2` (ya iniciada), `state 3`, `state 6` y `close = true` sin degradarlos ni volver a escribir, bloquea cualquier otra transición con `unsupported_order_state_transition`, reconcilia timeout/5xx por relectura y no reintenta la mutación. Un lote admite como máximo un `startOrder` y `finalizeOrder` sigue siendo la última mutación efectiva.
- `order apply-review` con revisión y contrato `1.3`: nueva acción `closeOrder` para el cierre administrativo de una orden ya finalizada, mediante un único `PUT /order/{orderId}` con `{"state":6}`. **Cerrada es `state=6`**; `close=true` por sí solo no acredita cierre. Solo se permite desde `state=3`; `state=6` se reporta `alreadyApplied` sin escribir; `state=1` o `state=2` se rechazan con `unsupported_order_state_transition`; relee antes y después, exige `state=6` y no reintenta mutaciones ambiguas.
- `closeOrder` y `finalizeOrder` no comparten lote: la finalización y el cierre exigen lotes y aprobaciones separadas. `closeOrder` debe ser la última mutación efectiva del lote. La CLI no valida readiness (actividades, fotos o aceptación); esa precondición queda en el orquestador y la skill.

### Cambiado

- La CLI reporta `0.5.0`. `startOrder` requiere contrato y borrador `schemaVersion` `1.2`; `1.0` y `1.1` no se reinterpretan. Las revisiones con `schemaVersion` `1.3` (incluida `closeOrder`) requieren `0.5.0` o posterior; `1.0`, `1.1` y `1.2` conservan su comportamiento. Un runtime anterior falla cerrado ante la acción desconocida.

## [0.4.0] - 2026-09-26

### Añadido

- Caché local SQLite para los seis módulos de lectura, con retención de registros por ID, scopes de consulta y metadatos de paginación.
- Política cache-first en `download`: 24 horas para catálogos de referencia y 15 minutos para órdenes y cotizaciones; `--refresh` fuerza la consulta remota.
- Comandos `cache refresh`, `cache status`, `cache search` y `cache resolve`, más `--created-by-name` para resolver el generador desde un catálogo de usuarios vigente.
- Archivo SQLite de todas las respuestas JSON GET, con `cache search reads` y `cache read` para localizar consultas de detalle y otras lecturas directas.
- `order apply-review` con revisión y contrato `1.2`: acciones `ensureEquipmentMaintenance` y `addTaskGeneral`, snapshot aprobado `order.approved`, referencias `operationId` hacia atrás y reconciliación por relectura ante respuestas ambiguas. Una cadena `ensureEquipmentMaintenance → addTaskGeneral → addActivity → addImage` se aprueba y ejecuta en una sola revisión.
- `order apply-review` 1.2 admite asociar un `fileId` SIYS existente en `addImage` sin volver a subir el binario.
- `order apply-review` 1.2 añade la acción `finalizeOrder` (`PUT /order/{orderId}` con `{"state":3}`): relee la orden antes y después, respeta `state 3`/`state 6`/`close = true` sin degradarlos, bloquea transiciones sin contrato con `unsupported_order_state_transition`, reconcilia timeout/5xx por relectura, no reintenta la mutación y puede cerrar un lote `ensureEquipmentMaintenance → addTaskGeneral → addActivity → addImage → finalizeOrder` con una sola aprobación.

### Cambiado

- La CLI reporta `0.4.0`. La revisión de órdenes con `schemaVersion` `1.2` (incluida `finalizeOrder`) requiere `0.4.0` o posterior; `0.3.0` no la soporta.

### Corregido

- `order create` admite franjas puntuales con `startLocal == endLocal` y consulta su disponibilidad por GET; sigue rechazando rangos invertidos.
- `order apply-review` 1.1 relee la lista de actividades justo antes del PATCH de `addActivity` y falla por conflicto si cambió desde la baseline aprobada, en lugar de continuar en silencio.
- `order apply-review` normaliza `dates[].user` (objeto o ID) y `dates[].users` al preparar el PUT del formulario, conservando `start`, `end` y los demás campos de la programación viva.

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

[0.5.1]: https://github.com/yuliamrg/siys-net-http/releases/tag/v0.5.1
[0.5.0]: https://github.com/yuliamrg/siys-net-http/releases/tag/v0.5.0
[0.4.0]: https://github.com/yuliamrg/siys-net-http/releases/tag/v0.4.0
[0.2.0]: https://github.com/yuliamrg/siys-net-http/releases/tag/v0.2.0
