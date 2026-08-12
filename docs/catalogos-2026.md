# Catálogo SIYS 2026: flujo JSON primero

## Extracción

La extracción de referencia se limita a 2026 para `orders` y `quotes`. `clients`, `users`, `sites` y `equipment` son catálogos vigentes consultados durante la misma ejecución; se conservan con una marca de extracción para saber cuándo refrescarlos.

Ejemplo seguro, guardando únicamente JSON:

```powershell
siys download --module all --format json --out-dir C:\ruta\siys-json-2026 --json
```

No combinar `xlsx,json` en el mismo comando para construir el catálogo. Primero se valida la descarga JSON y después un proceso documental genera el XLSX. Si se necesitan formatos distintos, ejecutarlos en operaciones separadas y explícitas.

## Módulos y relaciones

| Módulo | Endpoint | Regla |
|---|---|---|
| `orders` | `GET /order/v2` | paginado; año por defecto actual, fijar 2026 cuando se requiera histórico |
| `quotes` | `GET /cotizacion` | parámetros de fecha de consulta |
| `clients` | `GET /customer` | catálogo base |
| `users` | `GET /user` | catálogo de técnicos/usuarios |
| `sites` | `GET /subsidiary?customer=<id>` | se consulta para cada `_id` de `clients` |
| `equipment` | `GET /equipment?customer=<id>` | se consulta para cada `_id` de `clients` |

Las filas de `sites` y `equipment` incluyen `_customerId`. No se debe convertir un nombre a ID por parecido; se busca por nombre y se confirma el ID en el JSON o en el XLSX de referencia.

## Ubicación estable

El libro publicado de referencia es:

`C:\Users\CoordServicio\OneDrive - Siys\Referencias\SIYS\Catalogo_SIYS_2026.xlsx`

Se trata como documento nuevo/versionado. No se modifica `Base_operativa_HVAC_SIYS.xlsx` para almacenar este catálogo. Antes de publicar se clasifica la ruta, se hace preflight, se valida el libro y se publica con política `Version`.

## Contratos

`contracts/read/catalog-v1.json` contiene únicamente contratos `GET` de lectura. La creación de órdenes y la revisión de órdenes existentes usan contratos privados separados; no deben copiarse al contrato del catálogo ni guardarse en Git.
