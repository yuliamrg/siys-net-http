# SIYS Explorer

CLI local para descargar informacion de SIYS por HTTP directo y entregarla en formatos utiles para analisis: JSON, CSV, XLSX o Parquet.

La UI de SIYS no hace parte del flujo operativo. Solo queda como respaldo para diagnostico, captura de endpoints o validacion manual.

## Instalacion

```powershell
git clone <repo-url>
cd explorador_app
npm ci
npm run build
npm link
```

Despues de `npm link`, el comando queda disponible como:

```powershell
siys --help
```

Tambien se puede usar sin link durante desarrollo:

```powershell
npm run download -- --module clients --format xlsx
```

## Configuracion

Copia `.env.example` a `.env` y completa las credenciales autorizadas:

```env
SIYS_BASE_URL=https://app.siys.net
SIYS_API_URL=https://api.siys.net/api
SIYS_LOGIN_URL=https://api.siys.net/login
SIYS_EMAIL=
SIYS_PASSWORD=
SIYS_TOKEN=
```

La autenticacion usa este orden:

1. `SIYS_TOKEN`, si esta definido.
2. Token guardado en `private/storage-state.json`.
3. Login HTTP directo con `SIYS_EMAIL` y `SIYS_PASSWORD`.

El login no abre navegador:

```powershell
siys login
```

## Descarga

Comando principal:

```powershell
siys download
```

Por defecto descarga todos los modulos en XLSX dentro de `exports/`.

Ejemplos:

```powershell
siys download --module all --format xlsx --out-dir ./exports
siys download --module orders,quotes --format json,csv --out-dir ./data
siys download --module clients --format xlsx --output ./clientes.xlsx
siys download --module orders --format xlsx --param start=2026-01-01 --param end=2026-06-30
siys download --module equipment --format parquet --out-dir ./warehouse --json
```

Opciones principales:

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

`export` queda como alias compatible:

```powershell
siys export --module clients --format json
```

## Datos Temporales

- `.env`: credenciales locales. No se versiona.
- `private/storage-state.json`: token vigente guardado por `siys login` o por login automatico. No se versiona.
- `private/endpoints.json`: override local de endpoints si se ejecuta `inventory`. No se versiona.
- `exports/`: archivos descargados. No se versiona.

Los endpoints canonicos para instalaciones limpias estan versionados en el codigo, por lo que `download` no depende de `private/endpoints.json`.

## Comandos Avanzados

Estos comandos son para exploracion o diagnostico, no para el flujo normal de descarga:

```powershell
siys capture
siys explore
siys inventory
```

`capture` abre Chromium para iniciar sesion o navegar manualmente. `explore` recorre modulos conocidos en modo lectura. `inventory` genera inventario sanitizado de endpoints observados.

## Desarrollo

```powershell
npm run typecheck
npm test
npm run build
```

La documentacion tecnica de arquitectura, autenticacion, endpoints y hallazgos esta en [`docs/technical-findings.md`](docs/technical-findings.md).
