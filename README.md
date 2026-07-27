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

La skill global `$siys-cli` documenta el uso operativo de este comando desde cualquier carpeta, incluidos filtros, inspección de órdenes y la integración con `$mejorar-ordenes-siys-net`.

## Documentacion

| Documento | Para que sirve |
| --- | --- |
| [Instalacion y configuracion](docs/installation.md) | Preparar el proyecto, variables `.env`, build y enlace del comando `siys`. |
| [Manual de la CLI](docs/cli-manual.md) | Comandos, opciones, ejemplos y filtros para descargar datos. |
| [Integracion con otras aplicaciones](docs/integration.md) | Como ejecutar la CLI desde otros procesos y consumir la salida `--json`. |
| [Seguridad y datos locales](docs/security-and-storage.md) | Manejo de credenciales, token, archivos temporales y carpetas no versionadas. |
| [Comandos de diagnostico](docs/diagnostics.md) | Uso de `capture`, `explore` e `inventory` cuando sea necesario revisar SIYS. |
| [Informe tecnico](docs/technical-findings.md) | Arquitectura observada, endpoints, autenticacion y hallazgos de exploracion. |
| [Inspeccion interna de cotizaciones](docs/quote-inspection.md) | Articulos, desgloses, calculos, historial y saneamiento de cotizaciones. |
| [Estructura del informe de orden](docs/order-report-structure.md) | Relacion entre la orden, mantenimientos, actividades, fotografias y el PDF de servicio. |
| [Aplicación segura de revisiones](docs/order-review-write-contract.md) | Simulación, confirmación, contratos HTTP y auditoría para mejorar textos de órdenes. |

## Comandos Principales

```powershell
siys login
siys download
siys download --module orders,quotes --format json,csv --out-dir data
siys download --module clients --format xlsx --output clientes.xlsx
siys quote inspect C20260734 --output C20260734-detail.json --json
```

## Desarrollo

```powershell
npm run typecheck
npm test
npm run build
```
