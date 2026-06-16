# SIYS HTTP Downloader

CLI para descargar informacion de SIYS por HTTP directo en formatos de analisis: JSON, CSV, XLSX y Parquet.

El flujo operativo no usa navegador. La UI de SIYS queda solo como respaldo para diagnostico o descubrimiento de endpoints.

## Uso Rapido

```powershell
git clone https://github.com/yuliamrg/siys-net-http.git
cd siys-net-http
npm ci
npm run build
npm link
siys download --module all --format xlsx --out-dir exports
```

## Documentacion

| Documento | Para que sirve |
| --- | --- |
| [Instalacion y configuracion](docs/installation.md) | Preparar el proyecto, variables `.env`, build y enlace del comando `siys`. |
| [Manual de la CLI](docs/cli-manual.md) | Comandos, opciones, ejemplos y filtros para descargar datos. |
| [Integracion con otras aplicaciones](docs/integration.md) | Como ejecutar la CLI desde otros procesos y consumir la salida `--json`. |
| [Seguridad y datos locales](docs/security-and-storage.md) | Manejo de credenciales, token, archivos temporales y carpetas no versionadas. |
| [Comandos de diagnostico](docs/diagnostics.md) | Uso de `capture`, `explore` e `inventory` cuando sea necesario revisar SIYS. |
| [Informe tecnico](docs/technical-findings.md) | Arquitectura observada, endpoints, autenticacion y hallazgos de exploracion. |

## Comandos Principales

```powershell
siys login
siys download
siys download --module orders,quotes --format json,csv --out-dir data
siys download --module clients --format xlsx --output clientes.xlsx
```

## Desarrollo

```powershell
npm run typecheck
npm test
npm run build
```
