# Plan de implementación: finalización de órdenes en SIYS

## Objetivo

Agregar a `siys-cli` un flujo explícito, auditable y reanudable para preparar y pasar una orden a **Finalizada**, incluyendo el mantenimiento faltante de un equipo y su actividad/evidencia cuando el coordinador lo autorice.

El flujo debe conservar separadas estas propiedades:

- `order.state = 3`: orden **Finalizada**.
- `order.close = true` y `order.state = 6`: cierre administrativo **Cerrada**. No se infieren ni se aplican al finalizar.
- `maintenance.equipmentState`: condición del equipo (`1` funcionando, `2` con novedad, `3` fuera de funcionamiento). No es el estado de la orden.
- `activity.complete`: estado de una actividad. Su actualización no tiene todavía una ruta confirmada.

## Evidencia del ensayo en SIYS

Los snapshots completos y las auditorías con datos de producción permanecen en las carpetas locales de exportación y `%TEMP%`; no se incluyen aquí credenciales, IDs internos, datos personales ni fotos.

### Orden 001361

- Lectura remota previa: `state = 2` (En ejecución).
- Escritura observada: `PUT /api/order/{orderId}` con cuerpo `{"state":3}`.
- Resultado: HTTP 200; una lectura remota posterior devolvió `state = 3` (Finalizada) y `close = false`.
- La orden tenía actividad(es) que todavía figuraban incompletas. La coordinadora autorizó expresamente finalizarla para corregir su contenido después. Esta transición se volvió a confirmar en la orden 007418 (ver abajo): `state = 3` no implica `close = true` ni `state = 6`.

### Orden 007644

Precondición: estado 2, `close = false`, dos equipos y un mantenimiento asociado al Chiller 1. El mantenimiento fuente tenía estado de equipo 2 (Con novedad), una tarea General, una actividad con nombre, `complete = false`, respuesta vacía y ocho archivos. La observación indicaba un cambio pendiente de reloj manómetro. La coordinadora confirmó que el Chiller 2 recibió el mismo mantenimiento y que las mismas fotos documentan ambos equipos.

Operaciones y resultados:

1. La aplicación SIYS contiene el formulario de mantenimiento en el chunk `7015.ad377b52.chunk.js`. Envía `POST /maintenance/empty` con `user`, `equipmentState`, `start`, `end`, `observations`, `equipment`, `order` y `preview: false`.
2. Se creó el mantenimiento del Chiller 2 con esos valores. SIYS respondió HTTP 500, pero una lectura remota comprobó que el registro sí quedó creado. No hubo reintento.
3. `POST /maintenance/{maintenanceId}/add-task-general` creó la tarea General. La respuesta fue texto plano `ok`; el parser JSON de la CLI reportó respuesta inválida aunque la lectura confirmó la tarea. No hubo reintento.
4. `PATCH /maintenance/{maintenanceId}/task/{taskId}/add-activity` devolvió una actividad nueva con `complete = true` por defecto.
5. `PUT /maintenance/{maintenanceId}/task/{taskId}/activity/{activityId}?field=nameCorrected`, cuerpo `{"reply":"Mtto preventivo de manejadora"}`, guardó el nombre corregido.
6. Se asociaron, en secuencia, las ocho referencias de archivo ya existentes con `PATCH /maintenance/{maintenanceId}/task/0/activity/0/add-file/{fileId}`. La lectura final confirmó las ocho referencias en ambos equipos; no se volvieron a cargar los binarios.
7. La actividad original del Chiller 1 seguía en `complete = false`. `PATCH /maintenance/{maintenanceId}/task/{taskId}/activity/{activityId}` con `{"complete":true}` respondió 404. Después se probó `PUT` sobre la misma ruta con `?field=complete` y `{"complete":true}`; agotó el tiempo de espera y dos lecturas remotas posteriores confirmaron que seguía `false`. No se reintentó ni se modificó `order.state`.

Estado verificado al terminar el ensayo: 001361 está Finalizada con `close = false`; 007644 sigue En ejecución con `close = false`. Ambos chillers de 007644 conservan `equipmentState = 2`; no se marcó como funcionando un equipo cuya observación refleja una novedad pendiente. El Chiller 2 tiene una actividad `complete = true` y las ocho fotos; la actividad fuente del Chiller 1 continúa `complete = false`.

### Orden 007418

Evidencia posterior que amplía la de 001361:

- Segunda transición real confirmada a `state = 3` mediante `PUT /order/{orderId}` con `{"state":3}` y verificación por relectura.
- `state = 3` no debe inferir `close = true` ni `state = 6`: ambos valores se conservaron tal como estaban antes de la transición.
- Una actividad con `complete = false` no impidió que el backend aceptara y persistiera el paso a Finalizada. `activity.complete` **no está demostrado** como requisito del backend para finalizar.
- Por lo anterior, un `activity.complete` desconocido no se convierte en un bloqueo universal: es una señal de readiness para la coordinadora, no una precondición verificada del backend.

Sigue pendiente el contrato para **modificar** una actividad existente (ruta, método, cuerpo y semántica); hasta contar con esa evidencia no se habilita ninguna operación de cierre de actividad.

## Hallazgos para el diseño

1. El cambio de estado de la orden funciona con `PUT /order/{orderId}` y `{"state":3}`. Hay dos transiciones reales confirmadas (001361 y 007418). La CLI y el modal Editar orden no ofrecen esta operación hoy.
2. Las escrituras de SIYS no son atómicas con la respuesta HTTP. Un HTTP 500 puede coexistir con un registro guardado. También hay endpoints que devuelven texto plano, incompatible con asumir siempre JSON.
3. En **Orden → Mantenimientos**, la interfaz muestra controles de corrección de nombre/descripción, visibilidad y archivos, pero no un control para `activity.complete`. La vista `/my-maintenance` informa que el usuario coordinador actual no tiene permiso para ver esos mantenimientos. Las rutas públicas comunes de OpenAPI/Swagger consultadas responden 404. El PATCH a la ruta base devolvió 404; el PUT con `field=complete` agotó el tiempo y no cambió el registro. No agregar ninguno al contrato hasta obtener el flujo soportado y su semántica. `activity.complete` desconocido es una señal de readiness, no un bloqueo universal demostrado (ver 007418).
4. La creación de una actividad nueva la inicializa con `complete = true`; esto no demuestra que una actividad anterior pueda cerrarse mediante esa misma operación.
5. La app ya expone una ruta para adjuntar un `fileId` existente. Reutilizar archivos es preferible cuando el coordinador confirma que la misma evidencia documenta ambos equipos; no duplicar binarios por defecto.
6. Un equipo en estado 2 no se debe cambiar automáticamente a 1 para permitir finalizar la orden. La CLI debe mostrar la novedad y dejar que el coordinador decida su tratamiento técnico.

## Experiencia de CLI propuesta

Separar la preparación técnica de la transición del estado:

```powershell
siys order clone-maintenance 007644 `
  --from-equipment "Chiller Nro 1" `
  --to-equipment "Chiller Nro 2" `
  --reuse-existing-files `
  --contract private\order-lifecycle-contract.json `
  --json

siys order finalize 007644 `
  --contract private\order-lifecycle-contract.json `
  --confirm `
  --json
```

`clone-maintenance` debe producir primero una simulación legible con los campos, actividades y archivos que copiará. La aplicación requiere `--confirm`. La selección de equipos debe resolver a una única pareja dentro de la orden. La operación copia valores literales, conserva `equipmentState`, fechas y observaciones, y permite asociar referencias existentes de fotos. No inventa respuestas técnicas ni cambia el estado de la actividad fuente.

`finalize` debe presentar la preparación y los bloqueos antes de escribir. El caso estándar requiere que todos los equipos pertinentes tengan mantenimiento y que las actividades exigidas estén completas con evidencia suficiente. Como el flujo de cierre de actividades no está confirmado, la preparación debe señalar la actividad fuente `complete = false` de 007644 como pendiente de readiness y exigir una decisión explícita de la coordinadora; no es un bloqueo universal del backend (ver 007418).

Para casos como 001361, donde la coordinadora autorizó finalizar antes de completar la revisión, ofrecer un override explícito y auditable, por ejemplo:

```powershell
siys order finalize 001361 `
  --allow-incomplete `
  --reason "Finalizar para corregir la orden después" `
  --contract private\order-lifecycle-contract.json `
  --confirm
```

El override no debe ser implícito ni convertir el bloqueo en una advertencia silenciosa. Requiere motivo, aprobación explícita, simulación visible y registro de los bloqueos aceptados.

## Contrato privado propuesto

Crear un contrato de ciclo de vida separado del contrato de `order apply-review`, para no mezclar cambios de texto/fotos con transiciones de estado y creación de estructuras. Versionar el esquema sin romper contratos 1.0/1.1 existentes.

Operaciones candidatas, limitadas a las observadas:

| Operación | Método y ruta observados | Cuerpo / comportamiento |
| --- | --- | --- |
| Finalizar orden | `PUT /order/{orderId}` | `{ "state": 3 }`; verificar `order.state === 3` y que `close` conserve su valor previo. |
| Crear mantenimiento | `POST /maintenance/empty` | `user`, `equipmentState`, `start`, `end`, `observations`, `equipment`, `order`, `preview: false`. La respuesta puede ser 500 aunque el registro persista; siempre releer. |
| Crear tarea General | `POST /maintenance/{maintenanceId}/add-task-general` | Sin cuerpo. Aceptar respuesta de texto plano; verificar la tarea en el detalle. |
| Crear actividad | `PATCH /maintenance/{maintenanceId}/task/{taskId}/add-activity` | Sin cuerpo; respuesta observada JSON con actividad y `complete: true`. Verificar ID y estado tras releer. |
| Corregir nombre visible | `PUT /maintenance/{maintenanceId}/task/{taskId}/activity/{activityId}?field=nameCorrected` | `{ "reply": "..." }`; verificar `nameCorrected.reply`. |
| Asociar archivo existente | `PATCH /maintenance/{maintenanceId}/task/{taskIndex}/activity/{activityIndex}/add-file/{fileId}` | Sin cuerpo; resolver índices justo antes de escribir y verificar la referencia en la actividad. |
| Completar actividad existente | **Pendiente de contrato** | La ruta probada devolvió 404. No habilitar hasta confirmar endpoint y semántica. |

El contrato debe permitir explícitamente los tipos de respuesta esperados (`json`, `text`, `empty`) y separar “respuesta recibida” de “cambio verificado”. No debe interpretar un error de parseo o un 5xx como prueba de que no hubo escritura.

## Controles de escritura y auditoría

- Consultar SIYS en remoto justo antes de cada escritura; nunca usar la caché como precondición.
- Verificar código, ID único, estado previo y `close`; identificar cada equipo por ID además del nombre.
- Aplicar escrituras serialmente. Después de timeout, 5xx o cuerpo no interpretable, releer antes de decidir. Nunca repetir a ciegas.
- Para una creación de mantenimiento ambigua, buscar por orden, equipo, técnico e intervalo. Si aparece exactamente uno, marcarlo como persistido; si aparecen cero o varios, detenerse y pedir revisión.
- Para adjuntos, comparar `fileId` antes y después; si ya está asociado, marcar `alreadyApplied` sin duplicar.
- Para `finalize`, releer el estado inmediatamente antes del `PUT` y comprobar después `state = 3`. No tocar `close` ni cambiar a `state = 6`.
- La auditoría registra snapshot/precondición, cambio aprobado, endpoint, cuerpo saneado, respuesta HTTP/texto, IDs creados, verificación y resultado de cada paso. Nunca guarda token, cookies ni base64 de imágenes.
- La reanudación usa estados `verified`, `alreadyApplied`, `blocked`, `ambiguous` y `failed`; solo vuelve a escribir cuando una lectura reciente demuestra que el paso no ocurrió y el coordinador vuelve a confirmar.

## Plan de trabajo

1. **Resolver el contrato faltante de actividad.** Solicitar al equipo de SIYS el flujo soportado para marcar una actividad existente completa y documentar cuándo `complete` cambia. No convertir la ruta 404 en un contrato.
2. **Definir el esquema 1.2 de ciclo de vida.** Añadir allowlist para las cinco operaciones observadas, formatos de respuesta mixtos, comparación de originales, verificación y no reintento. Mantenerlo separado del contrato de revisión 1.1.
3. **Implementar el cliente de operaciones.** Reutilizar `getAuthenticatedToken`, `fetchApiJson`, `sendApiJson` y el patrón de auditoría de `order-review.ts`; ampliar el cliente HTTP para registrar y manejar respuestas de texto/JSON sin perder el estado HTTP.
4. **Agregar `order clone-maintenance`.** Simular, validar origen/destino y ejecutar un paso por vez. Al crear actividad, releer y usar sus IDs confirmados antes de corregir el nombre y asociar archivos.
5. **Agregar `order finalize`.** Separar revisión de readiness, simulación y confirmación; bloquear por actividades incompletas y permitir el override explícito con razón cuando la coordinadora así lo apruebe.
6. **Documentar estados y recuperación.** Actualizar manual, contrato, ejemplos, errores, auditorías y guía de recuperación de respuestas ambiguas. Explicar diferencia entre Finalizada, Cerrada y `close`.
7. **Validación.** Cubrir con pruebas simuladas: estado ya finalizado, cambio concurrente, código ambiguo, mantenimiento duplicado, 500 con persistencia, respuesta `ok`, timeout ambiguo, imagen ya adjunta, actividad incompleta y override con motivo. Luego hacer una prueba controlada en una orden de ensayo y verificar cada lectura remota.

## Criterios de aceptación

- `order finalize` nunca confunde `state = 3` con `close = true` o `state = 6`.
- Una orden bloqueada muestra equipo, actividad, evidencia y campo exacto que falta; no envía la escritura final.
- Un override autorizado queda visible en simulación y auditoría con su motivo.
- Una respuesta 500, texto plano o timeout jamás provoca un reintento automático.
- La copia de un mantenimiento crea una sola estructura por equipo y reutiliza las imágenes confirmadas sin duplicarlas.
- Cada escritura queda seguida por lectura remota; la CLI comunica el resultado persistido aunque la respuesta HTTP haya sido errónea.
- El endpoint para completar actividades existentes queda fuera del contrato hasta contar con evidencia de método, ruta, cuerpo y semántica.

## Archivos principales a modificar al implementar

- `src/cli.ts`: subcomandos y opciones.
- `src/api.ts` y `src/http.ts`: contratos de escritura y respuestas no JSON/ambiguas.
- Nuevo módulo, por ejemplo `src/order-lifecycle.ts`: preparación, clonación, finalización, readiness y auditoría.
- `docs/order-review-write-contract.md` o un nuevo `docs/order-lifecycle-contract.md`: alcance del contrato y flujos capturados.
- `docs/cli-manual.md`, `CHANGELOG.md` y `docs/security-and-storage.md`: comandos, recuperación y almacenamiento de auditorías.

Este plan no implementa todavía los comandos ni habilita el endpoint de actividad no confirmado.
