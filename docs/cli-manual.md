# Manual de la CLI

La CLI descarga informacion de SIYS por HTTP directo. El comando principal es:

```powershell
siys download
```

Por defecto descarga todos los modulos en formato XLSX dentro de `exports/`.

Para mantener el proyecto limpio, usa preferiblemente una carpeta temporal fuera del repositorio:

```powershell
siys download --module all --format xlsx --out-dir "$env:TEMP\siys-net-http-exports"
```

Las exportaciones pueden existir localmente, pero nunca deben versionarse. Las ordenes, snapshots, evidencias, revisiones y auditorias son persistentes y deben guardarse exclusivamente en `C:\Users\CoordServicio\OneDrive - Siys\ordenes-siys`.

## Modulos Disponibles

| Modulo | Valor CLI |
| --- | --- |
| Todos | `all` |
| Ordenes | `orders` |
| Cotizaciones | `quotes` |
| Clientes | `clients` |
| Equipos | `equipment` |

## Formatos Disponibles

| Formato | Valor CLI | Uso tipico |
| --- | --- | --- |
| Excel | `xlsx` | Revision manual y analisis operativo. |
| JSON | `json` | Integracion con scripts o aplicaciones. |
| CSV | `csv` | Carga en hojas de calculo o herramientas BI. |
| Parquet | `parquet` | Procesos analiticos y almacenamiento tabular. |

## Opciones de `download`

| Opcion | Descripcion |
| --- | --- |
| `--module <value>` | `all`, `orders`, `quotes`, `clients`, `equipment`. Se puede repetir o separar por coma. Default: `all`. |
| `--format <value>` | `json`, `csv`, `xlsx`, `parquet`. Se puede repetir o separar por coma. Default: `xlsx`. |
| `--out-dir <dir>` | Carpeta destino cuando se generan uno o varios archivos. Default: `exports`. |
| `--output <file>` | Archivo exacto de salida. Solo valido con un modulo y un formato. |
| `--param <key=value>` | Filtro observado en SIYS. Solo valido con un modulo. Se puede repetir. |
| `--max-pages <number>` | Limite de paginas para endpoints paginados. Default: `100`. |
| `--allow-partial` | Autoriza explícitamente exportar resultados potencialmente truncados por `--max-pages`. Sin esta opción la descarga se detiene antes de escribir el archivo. |
| `--json` | Imprime resumen estructurado para integracion con otras aplicaciones. |
| `--no-auto-login` | No intenta login HTTP automatico si falta o falla la sesion. |

Las lecturas y el login tienen un timeout total de 30 segundos. Puede ajustarse con `SIYS_HTTP_TIMEOUT_MS` entre 1 y 300 segundos. Las escrituras conservan `--timeout-ms` en 15 segundos por defecto y nunca se reintentan automáticamente; las imágenes usan 60 segundos y el análisis visual 120 segundos.

La opción global `--debug` muestra la traza interna en `stderr`. No la uses en registros compartidos porque puede incluir rutas locales. Sin `--debug`, los errores son breves y no muestran stack trace.

## Ejemplos Comunes

Descargar todo en Excel:

```powershell
siys download --module all --format xlsx --out-dir exports
```

Descargar clientes en un archivo especifico:

```powershell
siys download --module clients --format xlsx --output clientes.xlsx
```

Descargar varios modulos y formatos:

```powershell
siys download --module orders,quotes --format json,csv --out-dir data
```

Descargar equipos en Parquet:

```powershell
siys download --module equipment --format parquet --out-dir warehouse
```

Generar salida legible por otra aplicacion:

```powershell
siys download --module clients --format json --out-dir data --json
```

## Filtros

Los filtros se pasan con `--param key=value`. Solo deben usarse filtros ya observados en SIYS.

Ordenes por rango:

```powershell
siys download --module orders --format xlsx --param start=2026-01-01 --param end=2026-06-30
```

Cotizaciones por rango:

```powershell
siys download --module quotes --format xlsx --param inicio=2026-01-01T05:00:00.000Z --param fin=2026-06-30T23:59:59.000Z
```

### Inspeccionar el interior de una cotización

Para consultar una cotización completa, incluidos artículos, agrupadores, desgloses por categoría, precios unitarios, cantidades, subtotal, descuento, IVA, total e historial de estados:

```powershell
siys quote inspect C20260734 --output "$PWD\C20260734-detail.json" --json
```

El comando consulta primero el código en `/api/cotizacion` y luego el detalle en `/api/cotizacion/{_id}`. Si el código devuelve más de una coincidencia, usar el ID exacto:

```powershell
siys quote inspect C20260734 --quote-id <quote-id> --output "$PWD\C20260734-detail.json"
```

`download --module quotes` continúa siendo el mecanismo para listados y exportaciones masivas. `quote inspect` es el mecanismo recomendado cuando se necesita entender el contenido de una cotización individual. Ambos son de solo lectura y sanean campos sensibles embebidos en `creadoPor`.

El esquema y las reglas de cálculo están en [Inspección interna de cotizaciones](quote-inspection.md).

Equipos de un cliente especifico:

```powershell
siys download --module equipment --format xlsx --param customer=<customer-id>
```

### Búsqueda de órdenes en servidor

La CLI incorpora todos los filtros observados en **SIYS > Mantenimiento > Órdenes**. Úsalos con `--module orders`: el servidor reduce el resultado antes de que la CLI pagine o exporte, por lo que evita descargar el histórico completo.

| Campo SIYS | Opción CLI | Parámetro SIYS |
| --- | --- | --- |
| Tipo de orden | `--order-type <id>` | `type` |
| Número | `--order-code <número>` | `code` |
| Causa | `--cause <id>` | `causa` |
| Raíz | `--root-cause <id>` | `raiz` |
| Fechas | `--start YYYY-MM-DD --end YYYY-MM-DD` | `start`, `end`, `range[]` |
| Estado orden | `--state <estado>` | `state` |
| Facturadas | `--invoiced si\|no` | `checkIn` |
| Cliente | `--customer <id>` | `customer` |
| Sucursal | `--subsidiary <id>` | `subsidiary` |
| Técnico | `--technician <id>` | `user` |
| Generada por | `--created-by <id>` | `created_by` |

Los identificadores corresponden a los valores que selecciona la interfaz de SIYS. Los estados se aceptan por nombre (por ejemplo, `Finalizada`) o por código: Abierta `1`, En ejecución `2`, Finalizada `3`, Pendiente por cotizar `4`, Cotizada `5`, Cerrada `6` y Anulada `0`.

Ejemplo equivalente a “órdenes finalizadas generadas por Yuliam”:

```powershell
siys download --module orders --format json `
  --state Finalizada `
  --created-by 6a283f97b02db19c4480ad4d `
  --start 2026-01-01 --end 2026-07-20 `
  --output ordenes-yuliam-finalizadas.json --json
```

La consulta anterior devolvió tres registros en una sola página durante la validación. Los filtros se combinan entre sí. `--param` se conserva para casos avanzados ya verificados, pero se recomienda usar estas opciones para búsquedas de órdenes.

## Defaults de Fechas

- `orders`: consulta desde el inicio del año actual hasta la fecha de ejecución.
- `quotes`: consulta desde el inicio del año actual hasta el momento de ejecucion.
- `clients`: no aplica filtro por defecto.
- `equipment`: si no se pasa `customer`, consulta clientes y consolida los equipos de cada cliente.

## Alias Compatible

`export` funciona como alias de `download`:

```powershell
siys export --module clients --format json
```

## Inspeccion de una orden

`order inspect` exporta el detalle jerarquico de una orden en modo de solo lectura. Incluye detalle enriquecido, mantenimientos, tareas, actividades, referencias de archivos y entrega cuando exista. No descarga imagenes ni modifica SIYS.

### Evidencia visual por actividad

Para descargar y organizar únicamente las fotografías visibles de un snapshot, sin cambiar SIYS ni enviar imágenes a ningún proveedor:

```powershell
siys order analyze-images .\orden-007403.json
```

El manifiesto y las imágenes quedan en `private/image-analysis/`, fuera de Git. Para analizar las imágenes con el proveedor multimodal configurado se requiere `OPENAI_API_KEY` y una autorización explícita de uso:

```powershell
siys order analyze-images .\orden-007403.json --analyze
```

El resultado conserva cada foto, hash, actividad, equipo y hallazgo. Las guías de redacción editables por tipo de equipo están en `guides/hvac-ejemplos/`; sirven para vocabulario y estructura, no para inventar acciones, mediciones o componentes.

Por defecto descarga seis fotos en paralelo y analiza dos actividades en paralelo. Para una red o cuota limitada se pueden reducir los límites, por ejemplo `--download-concurrency 3 --analysis-concurrency 1`; no aumentarlos sin probar primero con una orden pequeña. En modo `--analyze`, se entregan al proveedor las URL públicas verificadas de SIYS —no copias base64— y se conservan localmente los hashes de evidencia. El modo requiere autorización para enviar esas imágenes al proveedor configurado.

La skill `$mejorar-ordenes-siys-net` usa `analyze-images` sin `--analyze` para descargar y organizar las fotos localmente. El análisis visual se hace con hojas de contacto y Codex; no requiere `OPENAI_API_KEY` ni envía imágenes a un proveedor externo.

Los comandos `review-images` y `build-vision-review` permanecen disponibles para flujos que cuenten con un proveedor multimodal configurado.

```powershell
siys order inspect 007393 --output orden-007393.json --json
```

El codigo puede escribirse con o sin ceros iniciales. La salida JSON conserva IDs estables para que una herramienta de revision pueda proponer cambios trazables.

Si un código histórico tiene más de una coincidencia, identifica primero el ID exacto y úsalo junto con el código esperado. Esto evita inspeccionar una orden distinta:

```powershell
siys order inspect 000462 --order-id 6a3ef87eb02db19c4480f820 --output orden-000462.json --json
```

## Crear una orden manual

`order create` prepara y, solo tras autorización explícita, crea una orden manual nueva. No acepta planes, periodos ni tareas derivadas. Primero consultar la Base Operativa y los catálogos de cliente/sede para resolver IDs; después simular y mostrar el payload.

```powershell
siys order create solicitud.json --output exports\order-create-simulation.json --json
siys order create solicitud-approved.json --contract private\order-create-contract.json --confirm --audit-output exports\order-create-audit.json --json
```

La ejecución confirmada exige `status: "approved"`, contrato privado exacto `POST /order`, `--confirm`, recibo anti-replay, auditoría y verificación posterior por el ID devuelto. Ante `ambiguous` o `verification_failed`, conservar la auditoría, inspeccionar la orden y no repetir automáticamente. El procedimiento completo está en [Creación manual de órdenes](order-create.md).

## Aplicar una revisión aprobada

`order apply-review` permite aplicar textos ya revisados sin usar Excel. Se limita a editar observaciones/estado del mantenimiento, nombre de tarea y nombre o respuesta de actividades existentes. No crea ni elimina elementos y exige un contrato local de endpoints validado contra la app.

```powershell
siys order apply-review cambios-aprobados.json --contract private\write-contract.json
siys order apply-review cambios-aprobados.json --contract private\write-contract.json --confirm
```

Sin `--confirm` solo simula; con `--confirm` exige `status: "approved"` en el JSON. Antes de cada cambio relee SIYS, valida el valor original, escribe de forma secuencial y verifica el resultado. Consulte [Aplicación segura de revisiones](order-review-write-contract.md) antes de crear el contrato.

Para evitar saturar SIYS, la aplicación es serial y limita el lote a 20 cambios por defecto. Usar `--max-changes` únicamente tras revisar la simulación; no ejecutar dos procesos sobre la misma orden.

Las pruebas reales y la política de lote se registran en [Validación progresiva de escritura HTTP](order-review-validation.md).

## Flujo visual SIYS: estado y PDF

Validado en la interfaz el 20 de julio de 2026, sin efectuar cambios: abrir **Mantenimiento → Órdenes → Ver (ojo) → Equipos**. En un equipo que ya tiene mantenimiento, pulsar su celda de estado para ver **Funcionando correctamente**, **Con novedad** y **Fuera de funcionamiento**. La selección aplica inmediatamente `PATCH /maintenance/{maintenanceId}` con `equipmentState`: `1`, `2` y `3`, respectivamente. Revisar la observación antes de escogerla.

Los estados de orden observados y definidos por la app son Abierta (`1`), En ejecución (`2`), Finalizada (`3`), Pendiente por cotizar (`4`), Cotizada (`5`), Cerrada (`6`) y Anulada (`0`). El modal de **Editar orden** no mostró un selector de estado; por tanto, no se debe inferir una transición HTTP ni intentar llevar una orden de Finalizada a Cerrada hasta capturar el flujo autorizado que lo haga.

Para generar el reporte de una orden: **Mantenimiento → Órdenes → Ver (ojo) → Mantenimientos → Imprimir**. SIYS prepara el reporte para la impresión del navegador; elegir “Guardar como PDF” en el cuadro de impresión. Antes de imprimir, comprobar que los mantenimientos que deben aparecer tengan activado “Mostrar en el reporte”.
## Operaciones aprobadas sobre actividades e imágenes

`siys order apply-review` acepta revisiones `1.1` para `addActivity`, `addImage`, `setImageVisibility` y `setActivityVisibility`, además de las ediciones de texto `1.0`. Todas requieren contrato privado, simulación, estado `approved`, `--confirm` y verificación posterior. Consultar [order-review-write-contract.md](order-review-write-contract.md) para el esquema completo.

La reanudación de una ejecución parcial usa `--resume-audit <archivo>`. Las actividades o archivos creados no pueden ser referenciados por otra operación del mismo JSON: inspeccionar de nuevo y preparar la siguiente revisión.
