# Changelog

Todos los cambios relevantes de este proyecto se documentan aquí. Mientras la CLI permanezca en `0.x`, una versión minor puede ajustar contratos visibles; cada ajuste se documentará antes del release.

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
