# Simulación de creación manual de órdenes

Estado: funcionalidad operativa habilitada. Sin `--confirm`, el comando valida y simula sin escribir en SIYS. Toda creación exige la doble autorización documentada y conserva auditoría y verificación posterior.

## Uso

```powershell
npx tsx src/cli.ts order create .\solicitud.json --output .\exports\simulacion.json
```

El esquema de referencia está en [`schemas/order-create-request.schema.json`](../schemas/order-create-request.schema.json). Ejemplo mínimo:

```json
{
  "schemaVersion": "1.0",
  "status": "draft",
  "mode": "manual",
  "customerId": "<customer-id>",
  "subsidiaryId": "<subsidiary-id>",
  "orderTypeId": "<order-type-id>",
  "material": "Herramientas manuales",
  "observations": "Descripción operativa clara de la solicitud.",
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

## Qué comprueba

- La estructura es cerrada: no admite campos desconocidos ni datos derivados de planes.
- Cliente, sede, tipo de orden, equipos activos y técnicos existen en los catálogos consultados.
- La sede se busca dentro del cliente y los equipos activos dentro de la sede.
- Cada usuario está marcado por SIYS como técnico.
- Los IDs de equipos no se repiten; un caso sin equipo exige `allowNoEquipment: true`.
- Los horarios son fechas locales válidas de Bogotá, usan intervalos de 30 minutos, terminan después de iniciar y no se solapan para un mismo técnico.
- SIYS informa disponibilidad para cada franja.

## Resultado

La salida local incluye:

- el SHA-256 del archivo de solicitud;
- los nombres e IDs resueltos;
- la disponibilidad de cada franja;
- la conversión de hora local UTC-05:00 a UTC;
- el payload exacto candidato para una fase posterior;
- `validation.ready` y sus bloqueos;
- la evidencia `siysWritesAttempted: 0` y `orderEndpointCalled: false`.

Que una simulación indique `ready: true` **no autoriza ni ejecuta la creación**. El archivo se guarda de forma atómica en `exports` de forma predeterminada. Puede usarse `--json` para imprimir solamente el resumen.

## Contrato y confirmación

Una ejecución confirmada exige simultáneamente:

1. `status: "approved"` en la solicitud revisada;
2. un contrato privado, fuera de Git, que autorice exactamente `POST /order`;
3. la opción explícita `--confirm`.

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

```powershell
npx tsx src/cli.ts order create .\solicitud-aprobada.json `
  --contract .\private\order-create-contract.json `
  --confirm
```

El contrato rechaza propiedades adicionales, otros métodos y cualquier otra ruta. La prevalidación completa se ejecuta inmediatamente antes del único `POST`. Una indisponibilidad impide el envío.

## Auditoría y resultado ambiguo

Antes del `POST`, una ejecución confirmada guarda una auditoría atómica con estado `in_progress`. Después registra uno de estos estados:

- `submitted`: SIYS respondió satisfactoriamente; todavía falta la verificación posterior.
- `verified`: el detalle releído coincide en cliente, sede, tipo, material, observaciones, equipos, técnicos y fechas.
- `verification_failed`: la relectura difiere, falla o no puede identificarse inequívocamente.
- `failed`: SIYS devolvió un rechazo HTTP inequívoco.
- `ambiguous`: hubo timeout, corte de red u otro error sin confirmación de rechazo.

La auditoría incluye hashes, prevalidación, payload, tiempos, respuesta o error y `retryAllowed: false`; no incluye token ni encabezados de autenticación. Un estado `ambiguous` significa **detenerse, investigar y no repetir el comando**.

Inmediatamente antes del `POST`, la CLI reserva atómicamente un recibo en `private/order-create-receipts/<sha256-de-solicitud>.json`. Si ya existe un recibo para el mismo archivo aprobado, la ejecución se detiene antes de escribir, aunque se use otro nombre de auditoría o se abra otro proceso. El recibo se conserva también ante timeout o fallo local y nunca se elimina automáticamente.

Si la respuesta incluye un ID, el comando consulta `GET /order/{id}/detail?full=true` y compara el detalle campo por campo. Si la respuesta no trae ID, conserva el envío como no verificado: no intenta adivinar cuál orden es y no repite el `POST`.

## Límites actuales

- Solo admite creación manual; planes, periodos y tareas quedan fuera.
- Solo admite `America/Bogota`.
- La disponibilidad es una fotografía del momento de la consulta y puede cambiar.
- La excepción sin equipo es técnicamente validable, pero debe justificarse operativamente.
- La prueba controlada del 2 de agosto de 2026 confirmó que la respuesta exitosa incluye `_id` y `code`, y que `GET /order/{id}/detail?full=true` permite verificar el contenido creado.
- La orden piloto `000013` usó el tipo `prueba`; SIYS conservó el equipo asignado y devolvió cero mantenimientos derivados. Los tipos operativos pueden generar estructuras posteriores diferentes.
- Una creación confirmada imprime solo el ID, código y estado resumidos; la respuesta íntegra permanece en la auditoría local.

## Habilitación operativa

El uso operativo quedó habilitado únicamente después de:

1. validar esquema y simulación sin escrituras;
2. exigir contrato privado, aprobación y `--confirm`;
3. probar auditoría y timeout ambiguo sin reintento;
4. probar verificación posterior;
5. aprobar la suite simulada completa;
6. revisar un payload real;
7. crear una única orden piloto autorizada;
8. inspeccionarla de nuevo por su ID exacto.

El flujo obligatorio sigue siendo: preparar `draft` → simular → mostrar el payload → cambiar a `approved` solo con autorización → ejecutar una vez con contrato y `--confirm` → revisar auditoría → inspeccionar la orden creada. Una auditoría `ambiguous` o `verification_failed` detiene el flujo y prohíbe repetir automáticamente.
