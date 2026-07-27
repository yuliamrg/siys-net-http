# Validación progresiva de escritura HTTP

Esta bitácora conserva las pruebas ejecutadas contra SIYS el 20 de julio de 2026. Los JSON de revisión, snapshots y auditorías quedan en `private/` y no se versionan. Las pruebas conservan el texto técnico existente cuando estaba presente; cuando una descripción u observación estaba vacía se agregó el texto explícito de prueba.

| Orden | Cliente | Tamaño inspeccionado | Lote | Resultado |
| --- | --- | ---: | ---: | --- |
| 007311 | Arturo Calle | 5 mantenimientos, 5 actividades | 3 cambios, 1 equipo | Simulación y aplicación 3/3; reanudación 0 escrituras y 3 `alreadyApplied`. |
| 007309 | Homecenter | 59 mantenimientos, 60 actividades | 3 cambios, 1 equipo | Simulación y aplicación 3/3. Se seleccionó un equipo sin correcciones previas. |
| 007393 | Coopidrogas | 56 mantenimientos, 177 actividades | 10 cambios, 5 equipos | Simulación y aplicación 10/10, serial y verificada por cada escritura. |

## Cobertura confirmada

- Observaciones finales del mantenimiento: `PUT /maintenance/{maintenanceId}/observations` y verificación en `observationsCorrected.reply`.
- Nombre corregido de actividad: `PUT .../activity/{activityId}?field=nameCorrected` y verificación en `nameCorrected.reply`.
- Descripción corregida de actividad: `PUT .../activity/{activityId}?field=replyCorrected` y verificación en `replyCorrected.reply`.
- Campos vacíos equivalentes como `null` y ausentes: se consideran la misma ausencia para el control de conflicto, sin normalizar ni sobrescribir texto real.
- Reanudación: si la corrección propuesta ya está en SIYS, se registra como `alreadyApplied` sin enviar otra escritura.
- Protección de colaboración: si existe una corrección distinta, el lote se detiene antes de escribir ese cambio.
- Error HTTP 429: prueba automatizada confirma que no se reintenta una escritura y la excepción entrega la auditoría parcial con los cambios ya verificados.
- Creación de actividad: `PATCH .../add-activity`, identificación inequívoca del nuevo ID y aplicación de nombre/descripción corregidos.
- Carga de imagen: `POST /file` con base64 aprobado y SHA-256 verificado, seguida de asociación serial a la actividad.
- Visibilidad de imagen: la revisión expresa `visible: true|false`; la CLI verifica pertenencia y usa el endpoint `toggle-hidden` solo cuando el estado actual difiere.
- Visibilidad de actividad: `PUT ...?field=visible` con cuerpo booleano y verificación posterior.
- Índices fotográficos: resolución por ID justo antes de escribir, incluso si la tarea o actividad no ocupa la primera posición.
- Reanudación por auditoría: conserva IDs creados y continúa desde el último paso confirmado solo si coinciden los hashes de revisión y contrato.

## Política operativa resultante

1. Extraer y revisar la orden; no editar una corrección que ya pertenezca a otro usuario.
2. Aprobar el JSON y ejecutar siempre la simulación primero.
3. Aplicar máximo 20 cambios por lote, con una única ejecución sobre una orden y espera de 350 ms o más entre escrituras.
4. Para órdenes grandes, dividir por equipos en lotes de 10 a 20 cambios y revisar la auditoría antes del siguiente.
5. Ante timeout, 401/403, 429, respuesta inesperada o conflicto, detener el lote. No reintentar una escritura ambigua; volver a simular o ejecutar el mismo JSON para detectar `alreadyApplied`.

La prueba de 007393 mostró que 10 cambios en una orden de 56 equipos se procesan sin bloquear el flujo de SIYS porque las escrituras no se hacen en paralelo. No se debe ejecutar más de un proceso de aplicación sobre la misma orden.
