# Manual de la CLI

La CLI descarga informacion de SIYS por HTTP directo. El comando principal es:

```powershell
siys download
```

Por defecto descarga todos los modulos en formato XLSX dentro de `exports/`.

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
| `--json` | Imprime resumen estructurado para integracion con otras aplicaciones. |
| `--no-auto-login` | No intenta login HTTP automatico si falta o falla la sesion. |

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

Equipos de un cliente especifico:

```powershell
siys download --module equipment --format xlsx --param customer=<customer-id>
```

## Defaults de Fechas

- `orders`: consulta desde el primer dia del mes actual hasta la fecha actual.
- `quotes`: consulta desde el inicio del año actual hasta el momento de ejecucion.
- `clients`: no aplica filtro por defecto.
- `equipment`: si no se pasa `customer`, consulta clientes y consolida los equipos de cada cliente.

## Alias Compatible

`export` funciona como alias de `download`:

```powershell
siys export --module clients --format json
```
