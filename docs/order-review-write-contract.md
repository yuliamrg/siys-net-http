# Aplicación segura de revisiones de orden

`siys order apply-review` edita los campos existentes autorizados y, con revisión y contrato `1.1`, puede añadir actividades, añadir imágenes, cambiar la visibilidad de una imagen y cambiar la visibilidad de una actividad completa. Con revisión y contrato `1.2` también puede completar la estructura de una orden existente: garantizar el mantenimiento de un equipo aprobado (`ensureEquipmentMaintenance`), crear la tarea General (`addTaskGeneral`) y pasar la orden a **Finalizada** (`finalizeOrder`), encadenando esas operaciones mediante referencias `operationId`. No borra actividades o imágenes, no mueve evidencia, no crea una segunda tarea arbitraria, no cierra actividades y no modifica fechas, usuarios o entrega.

Antes de habilitar una ruta de escritura, capturar una edición equivalente en SIYS y validar manualmente el método, URL y cuerpo. Guardar el resultado en una ruta privada; la CLI no trae un contrato activo ni adivina endpoints.

Para capturar sin modificar producción, ejecutar `siys capture`, abrir una orden de prueba, editar un único campo existente e intentar guardar. El guard de captura aborta la solicitud mutante pero conserva en `private/captures/` la URL, método y cuerpo saneado que la app intentó enviar. Confirmar el contrato contra el equipo de SI&S antes de habilitarlo.

## Contrato local

El archivo pasado con `--contract` debe contener únicamente los endpoints y campos verificados. Ejemplo de forma (las rutas son ilustrativas y no se deben copiar sin captura):

```json
{
  "schemaVersion": "1.0",
  "enabled": true,
  "operations": {
    "maintenance": {
      "method": "PATCH",
      "path": "/maintenance/{maintenanceId}",
      "fields": { "observations": { "path": "observations" } }
    },
    "task": {
      "method": "PATCH",
      "path": "/maintenance/{maintenanceId}/task/{taskId}",
      "fields": { "name": { "path": "name" } }
    },
    "activity": {
      "method": "PATCH",
      "path": "/maintenance/{maintenanceId}/task/{taskId}/activity/{activityId}",
      "fields": { "name": { "path": "name" }, "reply": { "path": "reply" } }
    }
  }
}
```

El contrato `1.0` conserva compatibilidad con las ediciones de texto existentes. Acepta solo `PATCH` o `PUT`, rutas relativas y cuerpos con los campos declarados. `path` sirve cuando el valor leído y el enviado tienen la misma ruta. Cuando SIYS almacene correcciones separadas, declarar `originalPath` (valor que se compara contra el snapshot), `verifyPath` (valor que se verifica tras guardar) y `bodyPath` (valor enviado), todos capturados de la app. Un campo puede declarar además su propio `method` y `path` cuando la interfaz use una URL distinta dentro de la misma actividad. Mantenerlo fuera de Git, por ejemplo en `private/`.

## Contrato 1.1 para actividades, imágenes y visibilidad

El contrato `1.1` añade una lista `actions`. La CLI compara método y plantilla con una lista cerrada; no admite rutas arbitrarias ni habilita borrados.

```json
{
  "schemaVersion": "1.1",
  "enabled": true,
  "operations": {},
  "actions": {
    "addActivity": {
      "create": { "method": "PATCH", "path": "/maintenance/{maintenanceId}/task/{taskId}/add-activity" },
      "name": {
        "method": "PUT",
        "path": "/maintenance/{maintenanceId}/task/{taskId}/activity/{activityId}?field=nameCorrected",
        "bodyPath": "reply",
        "verifyPath": "nameCorrected.reply"
      },
      "reply": {
        "method": "PUT",
        "path": "/maintenance/{maintenanceId}/task/{taskId}/activity/{activityId}?field=replyCorrected",
        "bodyPath": "reply",
        "verifyPath": "replyCorrected.reply"
      }
    },
    "addImage": {
      "upload": { "method": "POST", "path": "/file", "folder": "maintenance-files", "miniatura": "1" },
      "attach": { "method": "PATCH", "path": "/maintenance/{maintenanceId}/task/{taskIndex}/activity/{activityIndex}/add-file/{fileId}" }
    },
    "setImageVisibility": {
      "toggle": { "method": "PATCH", "path": "/maintenance/{maintenanceId}/task/{taskIndex}/activity/{activityIndex}/file/{fileId}/toggle-hidden" }
    },
    "setActivityVisibility": {
      "update": {
        "method": "PUT",
        "path": "/maintenance/{maintenanceId}/task/{taskId}/activity/{activityId}?field=visible",
        "bodyPath": "visible",
        "verifyPath": "visible"
      }
    }
  }
}
```

Cada entrada de `reviews[].operations[]` requiere un `operationId` único. Formas admitidas:

```json
[
  {
    "operationId": "equipo-1-actividad-1",
    "action": "addActivity",
    "taskId": "ID_TAREA",
    "original": { "activityIds": ["ID_ACTIVIDAD_EXISTENTE"] },
    "proposed": { "name": "Nombre aprobado", "reply": "Descripción aprobada" }
  },
  {
    "operationId": "equipo-1-imagen-1",
    "action": "addImage",
    "taskId": "ID_TAREA",
    "activityId": "ID_ACTIVIDAD",
    "original": { "fileIds": ["ID_ARCHIVO_EXISTENTE"] },
    "source": { "path": "C:\\ruta\\absoluta\\evidencia.jpg", "sha256": "HASH_SHA256_64_HEX" }
  },
  {
    "operationId": "equipo-1-visibilidad-imagen-1",
    "action": "setImageVisibility",
    "taskId": "ID_TAREA",
    "activityId": "ID_ACTIVIDAD",
    "fileId": "ID_ARCHIVO",
    "original": { "visible": true },
    "proposed": { "visible": false }
  },
  {
    "operationId": "equipo-1-visibilidad-actividad-1",
    "action": "setActivityVisibility",
    "taskId": "ID_TAREA",
    "activityId": "ID_ACTIVIDAD",
    "original": { "visible": true },
    "proposed": { "visible": false }
  }
]
```

Usar una ruta absoluta para la imagen y calcular su SHA-256 después de descargarla o seleccionarla. Se admiten `.jpg`, `.jpeg`, `.png` y `.gif`. `addActivity` representa tres escrituras; `addImage`, dos; cada cambio de visibilidad, una. El límite `--max-changes` cuenta escrituras HTTP, no entradas de operación.

En una revisión `1.0`/`1.1` no se puede referenciar en el mismo JSON una actividad o un archivo que aún no existe. Aplicar la creación, volver a inspeccionar la orden y preparar una nueva revisión con los IDs confirmados. La revisión `1.2` habilita referencias hacia atrás (ver abajo). Para las rutas fotográficas, la CLI vuelve a resolver `taskIndex` y `activityIndex` inmediatamente antes de asociar o cambiar visibilidad; el JSON siempre expresa el estado deseado y nunca ordena “alternar” directamente.

## Contrato 1.2 para completar estructuras

El contrato `1.2` conserva el contrato `1.1` y añade tres acciones y referencias `operationId`. Un borrador `1.2` exige un contrato `1.2`; un borrador `1.0`/`1.1` nunca se reinterpreta como `1.2`.

```json
{
  "schemaVersion": "1.2",
  "enabled": true,
  "operations": {},
  "actions": {
    "addTaskGeneral": {
      "create": { "method": "POST", "path": "/maintenance/{maintenanceId}/add-task-general", "response": "text" }
    },
    "ensureEquipmentMaintenance": {
      "linkEquipment": { "method": "PUT", "path": "/order/{orderId}" },
      "createMaintenance": { "method": "POST", "path": "/maintenance/empty" }
    },
    "finalizeOrder": {
      "update": { "method": "PUT", "path": "/order/{orderId}" }
    }
  }
}
```

Cada endpoint declara, dentro de una lista cerrada por paso, la modalidad de respuesta permitida: `json`, `text` o `empty`. `add-task-general` está acreditado con texto plano `ok`; no se debe convertir un texto no JSON en fallo final. Ningún endpoint acepta cualquier modalidad: si el contrato no la autoriza para ese paso, la CLI rechaza la operación.

### ensureEquipmentMaintenance

Garantiza que un equipo aprobado pertenece a la orden y tiene exactamente un mantenimiento. No resuelve nombres: el coordinador entrega `equipmentId` y los datos de mantenimiento (`user`, `equipmentState`, `start`, `end`, `observations?`). Consume 0, 1 o 2 escrituras:

- equipo ya en la orden con exactamente un mantenimiento → 0 escrituras, `alreadyApplied`, produce `maintenanceId`;
- equipo ya en la orden sin mantenimiento → solo `POST /maintenance/empty`;
- equipo ausente de la orden → `PUT /order/{orderId}` con el cuerpo completo del formulario manual, normalizado desde la relectura viva, y luego `POST /maintenance/empty`;
- equipo duplicado o con más de un mantenimiento → `AMBIGUOUS`: se bloquea sin escribir.

El cuerpo del `PUT` incluye exactamente `type`, `customer`, `subsidiary`, `material`, `observations`, `users`, `dates` y `equipments`. Se convierte `type`, `customer` y `subsidiary` a IDs; `users` y `equipments` a listas de IDs; se conserva la programación viva de `dates` con los IDs de técnicos; y se conservan los valores vivos de `material` y `observations`. Solo se añade el equipo aprobado a `equipments`. Si falta un campo obligatorio o una referencia no se puede convertir inequívocamente, se detiene antes del `PUT`.

El `PUT` nunca se construye desde un snapshot antiguo: justo antes se relee la orden viva, se comparan los campos protegidos de `order.approved` (`customer`, `subsidiary`, `type`, `material`, `observations`, `users`, `dates`, `equipments`) y ante una divergencia externa se produce `CONFLICT` sin escribir. `order.orderId` es obligatorio; no se selecciona una orden solo por `code`.

Tras `POST /maintenance/empty` la relectura de la orden decide: exactamente un mantenimiento para el equipo → `completed` (aun con HTTP 500); cero con error inequívoco → `failed`; cualquier duda o más de uno → `ambiguous`. Nunca se repite el POST.

### addTaskGeneral

`POST /maintenance/{maintenanceId}/add-task-general` sin cuerpo. Antes del POST se relee el mantenimiento:

- existe una tarea equivalente única → `alreadyApplied`, produce `taskId`;
- `tasks.length == 0` → se crea y, si se pidió un nombre distinto de `General`, se renombra con la edición existente `task.name`;
- existen tareas y ninguna coincide → `BLOCK: generic_task_create_not_supported`; no se renombra una tarea ajena ni se inventa un segundo endpoint.

La comparación de nombres es determinística y normalizada (sin acentos, minúsculas, espacios y separadores colapsados), nunca difusa.

### finalizeOrder

`finalizeOrder` usa `order.orderId` del borrador y no declara `maintenanceId`, refs ni `state`. Su único objetivo es `state = 3` (Finalizada) mediante `PUT /order/{orderId}` con el cuerpo exacto `{"state":3}`; no toca `close` ni intenta `state = 6`. No se usa el PUT completo del formulario para esta acción.

Ejemplo de acción:

```json
{ "operationId": "finalize", "action": "finalizeOrder" }
```

Antes de escribir se relee la orden viva por `orderId` y se confirma el código. La clasificación es cerrada:

- `state == 3` → `alreadyApplied`, 0 escrituras.
- `state == 6` o `close == true` → 0 escrituras; se respeta el estado posterior/cerrado y no se degrada. No es un error operativo.
- `state == 2` → finalización permitida, 1 escritura planificada.
- cualquier otro estado → no hay contrato de transición; se bloquea solo esa transición con `unsupported_order_state_transition`.

Justo antes del `PUT` se vuelve a leer la orden: si sigue en `state == 2` se envía una sola vez; si ya quedó en `state == 3`, `state == 6` o con `close == true`, no se escribe; si cambió a un estado sin contrato, se bloquea. Nunca se usa un baseline viejo. Después del `PUT` se relee la orden: el éxito exige `state == 3` y se registra `close` antes/después para comprobar que no cambió en silencio. Tras un timeout, un 5xx o una respuesta no interpretable se relee: si `state == 3`, la finalización se reconcilia como `completed`; si no, queda `ambiguous` o `failed` según la evidencia. La mutación no se reintenta.

`finalizeOrder` no impone readiness inventado: la CLI no bloquea la finalización porque `activity.complete` sea `false`, un equipo tenga `equipmentState = 2`, un mantenimiento registre novedades o falten fotografías. Esos datos son contexto para la coordinadora, no precondiciones acreditadas del backend, y la CLI tampoco los corrige.

`finalizeOrder` puede ser la última operación de un lote `1.2` (por ejemplo `ensureEquipmentMaintenance → addTaskGeneral → addActivity → addImage → finalizeOrder`) bajo una sola aprobación. Si una operación previa queda `FAILED`, `CONFLICT` o `AMBIGUOUS`, la finalización no se ejecuta.

El paso de auditoría se llama `finalize` y registra `orderId`, el estado previo, el estado verificado posterior y el resultado `completed`/`alreadyApplied`/`ambiguous`/`failed`.

### Referencias backward-only

`maintenanceRef`, `taskRef` y `activityRef` apuntan al `operationId` de una operación que aparece antes en el archivo. Para una misma entidad se declara `id` XOR `ref`, nunca ambos. Cada referencia debe apuntar al tipo que la operación referenciada produce (`ensureEquipmentMaintenance` → `maintenanceId`, `addTaskGeneral` → `taskId`, `addActivity` → `activityId`); las referencias futuras, cruzadas o a tipos incompatibles se rechazan antes de toda lectura remota. Las operaciones de una revisión `1.2` que necesitan un mantenimiento declaran `maintenanceId` o `maintenanceRef` explícito. `reviews[].maintenanceId` puede omitirse únicamente cuando la revisión no contiene ediciones legacy de maintenance, `tasks[]` o `activities[]`; los esquemas `1.0` y `1.1` lo siguen requiriendo.

Ejemplo de una sola revisión aprobada que completa la estructura de un equipo:

```json
{
  "schemaVersion": "1.2",
  "status": "approved",
  "order": { "code": "007644", "orderId": "ID_INTERNO_ORDEN", "approved": { "material": "Mantenimiento preventivo" } },
  "reviews": [{
    "original": {},
    "proposed": {},
    "operations": [
      { "operationId": "equipo-2-mtto", "action": "ensureEquipmentMaintenance", "equipmentId": "ID_EQUIPO_2", "maintenance": { "user": "ID_TECNICO", "equipmentState": 2, "start": "2026-08-03T08:00:00", "end": "2026-08-03T09:00:00" } },
      { "operationId": "equipo-2-tarea", "action": "addTaskGeneral", "maintenanceRef": "equipo-2-mtto" },
      { "operationId": "equipo-2-actividad", "action": "addActivity", "maintenanceRef": "equipo-2-mtto", "taskRef": "equipo-2-tarea", "original": { "activityIds": [] }, "proposed": { "name": "Mantenimiento general", "reply": "Descripción aprobada" } },
      { "operationId": "equipo-2-foto-1", "action": "addImage", "maintenanceRef": "equipo-2-mtto", "taskRef": "equipo-2-tarea", "activityRef": "equipo-2-actividad", "original": { "fileIds": [] }, "source": { "path": "C:\\ruta\\absoluta\\evidencia.jpg", "sha256": "HASH_SHA256_64_HEX" } }
    ]
  }]
}
```

`addImage` admite además asociar un `fileId` SIYS existente sin volver a subir el binario: si la operación declara `fileId` y no `source`, solo se ejecuta el `attach` (una escritura). Una revisión se aprueba una vez; no hay confirmaciones por subpaso.

### Writer count y reconciliación

`ensureEquipmentMaintenance` cuenta 0, 1 o 2; `addTaskGeneral`, 1 más el renombrado opcional; `addActivity`, 3; `addImage` con archivo nuevo, 2; con `fileId` existente, 1; `finalizeOrder`, 1 con `state == 2` y 0 si ya está finalizada o posterior. `--max-changes` sigue siendo el guardia y `plannedWrites` refleja el estado simulado. Para lotes aprobados mayores a 20, la capa autorizada pasa un `--max-changes` explícito acorde; el valor por defecto no se eleva en silencio.

Después de un timeout, un HTTP 5xx, una respuesta no JSON o inesperada, la CLI relee el estado específico y decide `completed`, `alreadyApplied`, `failed` o `ambiguous`. Nunca reintenta una mutación incierta. Una respuesta ambigua detiene la reanudación automática: solo se reutilizan IDs `completed`, `alreadyApplied` o confirmados por lectura viva.

### Carrera de addActivity

Justo antes del `PATCH`, se relee la tarea y se compara la lista actual contra la baseline aprobada más las actividades creadas o reutilizadas por el mismo lote. Si coincide, la operación es `EXPECTED`; si la actividad deseada ya existe inequívocamente, `ALREADY_APPLIED`; si apareció un cambio externo, `CONFLICT` sin enviar el PATCH; si no puede atribuirse, `AMBIGUOUS`. Nunca se continúa en silencio tras una relectura.

Contrato confirmado en la prueba de 006668 para el nombre corregido de una actividad:

```json
{
  "method": "PUT",
  "path": "/maintenance/{maintenanceId}/task/{taskId}/activity/{activityId}?field=nameCorrected",
  "fields": {
    "name": {
      "originalPath": "name",
      "verifyPath": "nameCorrected.reply",
      "bodyPath": "reply"
    },
    "reply": {
      "method": "PUT",
      "path": "/maintenance/{maintenanceId}/task/{taskId}/activity/{activityId}?field=replyCorrected",
      "originalPath": "reply",
      "verifyPath": "replyCorrected.reply",
      "bodyPath": "reply"
    }
  }
}
```

Para las observaciones finales del mantenimiento, la app confirmó:

```json
{
  "method": "PUT",
  "path": "/maintenance/{maintenanceId}/observations",
  "fields": {
    "observations": {
      "originalPath": "observations",
      "verifyPath": "observationsCorrected.reply",
      "bodyPath": "observationsCorrected.reply"
    }
  }
}
```

### Estado operativo del equipo

Capturado de forma bloqueada en la interfaz de SIYS el 20 de julio de 2026: al seleccionar una opción en **Orden → Equipos → Estado**, la app intenta `PATCH /maintenance/{maintenanceId}` con el campo `equipmentState`. La solicitud se abortó en el navegador antes de salir a SIYS; no se modificó ningún registro.

| Etiqueta SIYS | Valor `equipmentState` |
| --- | ---: |
| Funcionando correctamente / Operando | `1` |
| Con novedad | `2` |
| Fuera de funcionamiento | `3` |

Fragmento que puede agregarse al contrato privado ya validado, junto con las rutas de observaciones y actividades correspondientes:

```json
{
  "maintenance": {
    "method": "PATCH",
    "path": "/maintenance/{maintenanceId}",
    "fields": {
      "equipmentState": {
        "originalPath": "equipmentState",
        "verifyPath": "equipmentState",
        "bodyPath": "equipmentState"
      }
    }
  }
}
```

El estado solo se incluye en un JSON de revisión cuando la observación, actividad y evidencia son coherentes con él. La CLI relee y compara el valor actual antes de escribir.

## Flujo del coordinador

1. Extraer la orden y generar el JSON de revisión.
2. Verificar textos, evidencia y que no haya `manualReview: true`.
3. Cambiar el estado del JSON de `draft` a `approved` únicamente cuando el coordinador lo avale.
4. Simular:

   ```powershell
   siys order apply-review revision-aprobada.json --contract private\write-contract.json --json
   ```

5. Aplicar tras revisar la simulación:

   ```powershell
   siys order apply-review revision-aprobada.json --contract private\write-contract.json --confirm --json
   ```

La aplicación relee todos los mantenimientos, compara cada valor original y se detiene ante un conflicto. Si detecta que la corrección propuesta ya está guardada, la marca `alreadyApplied` y no vuelve a escribirla; esto permite retomar un lote interrumpido. Al aplicar, relee de nuevo inmediatamente antes de cada operación, usa una sola escritura a la vez (350 ms por defecto), no reintenta escrituras ambiguas y verifica el valor guardado. Siempre deja una auditoría JSON local; una falla deja la auditoría parcial para revisión.

Para continuar una operación de varios pasos sin duplicar una actividad o una carga ya confirmada, usar la auditoría parcial:

```powershell
siys order apply-review revision-aprobada.json --contract contract.json --resume-audit auditoria-parcial.json --confirm --json
```

La CLI exige que los hashes SHA-256 de la revisión y del contrato coincidan con la auditoría. La auditoría registra cada paso, IDs creados, índices resueltos y estados `completed`, `alreadyApplied`, `failed` o `ambiguous`, sin guardar base64 ni credenciales.

Para una prueba de no alteración visual, el JSON puede incluir `"forceApply": ["observations"]` en una revisión o `"forceApply": ["name", "reply"]` en una actividad. Esta excepción solo sirve si el contrato verifica una corrección separada del valor original; la CLI la rechaza para campos que escriben directamente sobre el original. Debe conservar el mismo texto, motivo de prueba y aprobación del coordinador.

Para lotes grandes, la CLI limita cada ejecución a 20 cambios por defecto. Mantener `--delay-ms 350` o mayor y aplicar un lote por vez; no ejecutar escrituras en paralelo ni dos procesos sobre la misma orden. Tras revisar la simulación, usar `--max-changes <n>` solo para el tamaño exacto del lote aprobado. La auditoría se actualiza después de cada cambio aplicado.
