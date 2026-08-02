# Investigación para crear órdenes SIYS por HTTP

> Documento histórico de investigación previa. La funcionalidad resultante ya está implementada y validada; consulta [order-create.md](order-create.md) para el contrato operativo vigente.

Fecha de comprobación: 2 de agosto de 2026. Esta investigación documenta el comportamiento observado de SIYS y el diseño que precedió a la implementación de `siys order create`. No se creó, editó ni eliminó ninguna orden durante la exploración histórica.

## Resultado ejecutivo

La creación manual usa `POST https://api.siys.net/api/order` con JSON. El formulario obtiene antes clientes, sucursales, tipos de orden, equipos activos y técnicos; además valida por HTTP la disponibilidad de cada técnico. El número, el creador, el estado inicial y las estructuras de mantenimiento no aparecen en el cuerpo enviado: son responsabilidad del servidor.

La misma pantalla también se usa para generar órdenes desde planes de mantenimiento. Ese modo no es equivalente a la creación manual: sustituye `type` por `plan` y `period`, añade `tasks`, preasigna equipos y limita el calendario al mes programado.

Durante la exploración histórica la CLI no permitía crear órdenes. El guard de exploración bloqueaba las mutaciones y `sendApiJson` solo se usaba con contratos de revisión aprobados. La implementación resultante conserva esa separación y exige archivo aprobado, simulación, confirmación explícita, auditoría y verificación posterior.

## Evidencia y método

Se contrastaron cuatro fuentes:

1. Interfaz autenticada en `https://app.siys.net/order-list`, automatizada con Playwright.
2. Solicitudes de red producidas por la SPA.
3. Source maps publicados por la aplicación:
   - `main.fd43e346.js.map`;
   - `1881.d7e66995.chunk.js.map`, especialmente `components/Order/List.js` y `components/Order/save.js`;
   - `1784.7bee1b4f.chunk.js.map`, entrada de calendario;
   - `3413.7d0222e2.chunk.js.map`, entrada de planes programados.
4. Implementación y pruebas actuales de esta CLI.

Antes de interactuar con el formulario se instaló un guard de red que permitió `GET`, pero respondió localmente con HTTP 409 a cualquier `POST`, `PUT`, `PATCH` o `DELETE`. Se llenó una solicitud válida de investigación y se pulsó **Guardar**. Playwright observó el intento `POST /api/order`, pero el guard lo interceptó; la consulta posterior no mostró la observación de prueba.

## Permiso y puntos de entrada

La vista completa de órdenes está protegida por la política `order:admin`. La cuenta validada tiene esa política.

La misma clase de formulario `OrderSave` se abre desde:

| Entrada | Datos iniciales | Resultado esperado |
| --- | --- | --- |
| Lista de órdenes | Objeto vacío | Creación manual. |
| Calendario de órdenes | Objeto vacío o datos del elemento seleccionado | Creación manual o edición. |
| Programación de planes | Cliente, sucursal, nombre del plan, ID del plan, periodo, tareas, equipos, fecha y mes mínimo | Orden derivada de un plan. |
| Botón Editar | `_id` de la orden | `GET /api/order/by-filters?_id=...` y luego `PUT /api/order/{id}`; no es creación. |

El botón **Copiar** visible junto al número de una orden pertenece al componente tipográfico de Ant Design y copia únicamente el número al portapapeles. No clona la orden.

## Catálogos y dependencias de lectura

| Propósito | Solicitud observada | Regla de uso |
| --- | --- | --- |
| Clientes | `GET /api/customer` | El valor enviado es `_id`. |
| Sucursales | `GET /api/subsidiary?customer={customerId}` | Se carga al cambiar el cliente. |
| Tipos | `GET /api/order-type` | El valor enviado es `_id`; el catálogo es dinámico. |
| Equipos | `GET /api/equipment?subsidiary={subsidiaryId}&active=1` | Solo muestra equipos activos de la sucursal. |
| Técnicos | `GET /api/user` | La UI conserva únicamente usuarios con `itIsTechnical` verdadero. |
| Disponibilidad | `GET /api/user/{userId}/itAvailable?order={orderId?}&start={iso}&end={iso}` | Se ejecuta durante la validación de cada franja. En una creación la SPA envió `order=undefined`. |
| Orden existente o plan/periodo | `GET /api/order/by-filters?...` | Solo para editar o recuperar una orden generada previamente por un plan. |
| Materiales de tareas | `GET /api/roadmaps/materials?ids={taskIds}` | Solo en órdenes derivadas de tareas; agrega sugerencias al texto de materiales. |

Los nombres y cantidades de los catálogos pueden cambiar. La implementación no debe fijar IDs ni asumir equivalencias por texto.

## Formulario manual

| Campo UI | Campo JSON | Comportamiento observado |
| --- | --- | --- |
| Cliente | `customer` | ID de cliente. La UI lo marca obligatorio, pero no define una regla real de validación. |
| Sucursal | `subsidiary` | ID dependiente del cliente. También está marcado, pero sin regla real de validación. |
| Tipo de orden | `type` | ID de tipo; se omite en modo plan. Está marcado, pero sin regla real de validación. |
| Materiales | `material` | Texto obligatorio. Tab inserta `   » ` y Enter inserta una nueva línea con `» `. |
| Observaciones | `observations` | Texto opcional. |
| Equipos a intervenir | `equipments[]` | IDs de equipos seleccionados en el control de transferencia. La UI permite cero equipos. |
| Día | `dates[].start`, `dates[].end` | Una o más franjas; selector con formato `YYYY-MM-DD HH:mm` y pasos visuales de 30 minutos. |
| Técnico | `dates[].user` | Un técnico por franja, obligatorio y sujeto a disponibilidad. |
| Técnicos únicos | `users[]` | Se deriva de `dates[]`, sin duplicados y conservando el orden de primera aparición. |

La UI permite añadir varias franjas. Una nueva fila copia inicialmente las fechas de la fila anterior y deja vacío el técnico. No se observó una regla cliente que impida traslapos entre franjas de la misma orden.

### Cuerpo confirmado

La solicitud bloqueada produjo esta forma, con identificadores sustituidos por marcadores:

```json
{
  "equipments": ["<equipment-id>"],
  "type": "<order-type-id>",
  "customer": "<customer-id>",
  "subsidiary": "<subsidiary-id>",
  "material": "Herramientas manuales",
  "observations": "INVESTIGACIÓN BLOQUEADA - NO CREAR",
  "users": ["<technician-id>"],
  "dates": [
    {
      "start": "2026-08-03T13:00:00.000Z",
      "end": "2026-08-03T14:00:00.000Z",
      "user": "<technician-id>"
    }
  ]
}
```

La franja ingresada como 08:00–09:00 en Colombia se serializó como 13:00–14:00 UTC. La CLI implementada interpreta explícitamente las horas operativas en `America/Bogota` y no depende de la zona horaria del computador que la ejecute.

## Variante derivada de un plan

La programación construye el documento inicial con:

```json
{
  "customer": "<customer-id>",
  "subsidiary": "<subsidiary-id>",
  "name": "<plan-name>",
  "plan": "<plan-id>",
  "period": "<period>",
  "tasks": [
    { "roadmap": "<roadmap-id>", "task": "<task-id>" }
  ],
  "equipments": ["<equipment-id>"],
  "date": "<selected-month>",
  "minDate": "<start-of-selected-month>"
}
```

Al guardar, el payload incluye `plan`, `period` y, cuando existen, `tasks`; no incluye `type`. Las fechas se restringen al mes programado. Antes de guardar, la UI busca `order/by-filters?plan_id={planId}&period={period}` para reutilizar datos si ya existe una orden del mismo plan y periodo.

La primera versión de la CLI debería implementar solo creación manual. El modo plan debe quedar fuera hasta confirmar tipos de `period`, reglas de unicidad, respuesta de `order/by-filters` y comportamiento del servidor ante un duplicado.

## Validaciones: lo que hace la UI y lo que debe hacer la CLI

La marca visual de obligatorio no equivale siempre a validación. En el código actual solo tienen reglas efectivas:

- `material`: no vacío;
- `dates`: al menos una fila;
- `dates[].date`: rango presente;
- `dates[].user`: técnico presente;
- disponibilidad del técnico: `available` debe ser verdadero.

Cliente, sucursal y tipo usan la propiedad visual `required`, pero no `rules`. Tampoco existe regla para exigir equipos. La CLI no debe reproducir esas omisiones. Su preflight debe comprobar:

1. que cliente, sucursal y tipo existan;
2. que la sucursal pertenezca al cliente;
3. que cada equipo esté activo y pertenezca a la sucursal;
4. que el técnico exista y tenga `itIsTechnical=true`;
5. que `material` tenga contenido útil;
6. que haya al menos una franja, con `start < end`;
7. que las fechas incluyan zona y se normalicen desde `America/Bogota`;
8. que no haya IDs repetidos en equipos ni franjas exactamente duplicadas;
9. que cada técnico esté disponible inmediatamente antes de escribir;
10. que `users[]` sea derivado por la CLI y no aceptado ciegamente del archivo.

Para órdenes sin equipo debe exigirse una excepción explícita, por ejemplo `allowNoEquipment: true`, porque la UI lo permite pero no se confirmó que sea un caso operativo válido.

## Diseño recomendado para `siys order create`

### Interfaz

```powershell
siys order create solicitud.json
siys order create solicitud.json --contract private\order-create-contract.json --confirm
```

El primer comando solo simula. El segundo escribe una única orden cuando el archivo tiene `status: "approved"`, el contrato habilita exactamente `POST /order` y el coordinador ya revisó el resumen.

### Archivo de solicitud propuesto

```json
{
  "schemaVersion": "1.0",
  "status": "draft",
  "mode": "manual",
  "customerId": "<customer-id>",
  "subsidiaryId": "<subsidiary-id>",
  "orderTypeId": "<order-type-id>",
  "material": "Herramientas manuales",
  "observations": "Mantenimiento preventivo agosto",
  "equipmentIds": ["<equipment-id>"],
  "schedule": [
    {
      "startLocal": "2026-08-03T08:00:00",
      "endLocal": "2026-08-03T09:00:00",
      "technicianId": "<technician-id>"
    }
  ],
  "timeZone": "America/Bogota"
}
```

No conviene pedir al usuario `users[]`: es un dato derivado. Tampoco se deben aceptar en la primera versión `created_by`, `code`, `state`, tareas, plan ni periodo.

### Flujo interno

1. Leer JSON UTF-8 sin BOM y rechazar mojibake.
2. Validar esquema y estado `draft` o `approved`.
3. Resolver catálogos por GET y validar relaciones.
4. Normalizar fechas locales a ISO UTC y derivar `users[]`.
5. Consultar disponibilidad de cada franja.
6. Mostrar resumen con nombres, IDs, cantidades, horas Colombia/UTC y hash SHA-256 de la solicitud.
7. Sin `--confirm`, terminar con auditoría `dryRun` y cero mutaciones.
8. Con `--confirm`, exigir `approved` y contrato exacto.
9. Repetir las lecturas críticas y la disponibilidad justo antes del POST.
10. Ejecutar una sola vez `POST /order`. Nunca reintentar automáticamente.
11. Verificar la orden creada y guardar auditoría atómica.

### Contrato local

El contrato debe permanecer fuera de Git, igual que los contratos de revisión. Forma mínima propuesta:

```json
{
  "schemaVersion": "1.0",
  "enabled": true,
  "operation": {
    "method": "POST",
    "path": "/order"
  }
}
```

La implementación debe comparar método y ruta con una constante cerrada; el contrato no puede autorizar URLs arbitrarias.

## Respuesta, verificación e idempotencia

No se dejó completar el POST, por lo que la forma exacta de la respuesta exitosa sigue sin confirmar. Tampoco se observó una clave de idempotencia.

Consecuencias:

- si el servidor responde con éxito y un `_id`, releer `GET /api/order/{id}` y comparar cliente, sucursal, tipo, equipos, material, observaciones, usuarios y fechas;
- si responde éxito sin ID, buscar la orden por una huella estrecha: creador autenticado, cliente, sucursal, tipo, fechas y ventana de creación;
- si el POST expira o se corta la conexión, marcar el resultado `ambiguous`, no reintentar y buscar antes de cualquier decisión;
- si aparecen cero o varias candidatas, detenerse para revisión manual;
- nunca inferir éxito solo porque el servidor aceptó la conexión.

La auditoría debe registrar hashes del archivo y contrato, payload normalizado sin secretos, validaciones, disponibilidad, hora de intento, resultado HTTP, ID/código recuperado y verificación. Debe actualizarse de forma atómica y no contener token ni credenciales.

## Cambios necesarios en este repositorio

| Área | Cambio futuro |
| --- | --- |
| `src/order-create.ts` | Esquema, preflight, normalización, payload, POST único, verificación y auditoría. |
| `src/api.ts` | Reutilizar `sendApiJson`; conservar prohibición de reintento y mensajes de estado ambiguo. |
| `src/cli.ts` | Añadir `order create <file>`, `--contract`, `--confirm`, `--audit-output`, `--timeout-ms`, `--json` y `--no-auto-login`. |
| `src/security.ts` | No abrir el guard general. La creación debe pasar solo por el flujo dedicado y contratado. |
| `src/types.ts` | Tipos de solicitud, contrato, preflight y auditoría. |
| `tests/order-create.spec.ts` | Pruebas unitarias y de integración con `fetch` simulado. |
| Documentación/skill | Manual, contrato, ejemplos y actualización de `$siys-cli` solo después de implementar y validar. |

La creación no debe integrarse en `order apply-review`: una orden nueva tiene semántica, riesgos e idempotencia diferentes a corregir campos de una orden existente.

## Matriz mínima de pruebas

- simulación hace solo GET y no llama POST;
- `--confirm` rechaza archivos `draft`;
- método/ruta del contrato deben ser exactamente `POST /order`;
- cliente, sucursal, tipo, equipo y técnico inexistentes se rechazan;
- sucursal de otro cliente o equipo de otra sucursal se rechazan;
- técnico no técnico u ocupado se rechaza;
- fechas inválidas, sin zona, invertidas o duplicadas se rechazan;
- conversión `America/Bogota` a UTC conserva el instante esperado;
- `users[]` se deriva y elimina duplicados;
- cero equipos exige excepción explícita;
- éxito con ID se relee y verifica;
- HTTP 4xx/5xx queda auditado sin reintento;
- timeout después del POST queda `ambiguous` y no reintenta;
- auditoría no contiene credenciales, token ni encabezado `authentication`;
- el modo manual rechaza `plan`, `period` y `tasks`;
- una prueba real controlada, autorizada y de una sola orden debe ejecutarse únicamente después de aprobar implementación, payload y criterio de verificación.

## Pendientes que requieren una prueba controlada posterior

1. Forma exacta de la respuesta exitosa de `POST /api/order`.
2. Validaciones y mensajes del backend cuando faltan campos o hay relaciones inconsistentes.
3. Valor inicial de `state` y generación de `code` en el servidor.
4. Atomicidad: qué ocurre si falla la creación de mantenimientos internos tras crear la orden.
5. Tratamiento de franjas traslapadas y equipos duplicados por el backend.
6. Regla operativa para órdenes sin equipos.
7. Unicidad de `plan + period` y contrato completo del modo plan.
8. Endpoint de detalle más fiable para verificación inmediata si la respuesta no devuelve `_id`.

Hasta resolver esos puntos no debe habilitarse una escritura real general.
