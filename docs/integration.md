# Integracion con Otras Aplicaciones

La forma recomendada de integrar esta herramienta es ejecutar `siys download` como subproceso y leer su salida.

## Contrato de Ejecucion

Usa `--json` para obtener un resumen estructurado:

```powershell
siys download --module clients --format json --out-dir data --json
```

Salida esperada:

```json
{
  "results": [
    {
      "module": "clients",
      "format": "json",
      "records": 86,
      "output": "data\\clients-2026-06-16T03-15-23-225Z.json",
      "pagesFetched": 1,
      "totalAvailable": 86,
      "truncated": false
    }
  ]
}
```

Cada elemento de `results` indica:

| Campo | Descripcion |
| --- | --- |
| `module` | Modulo descargado. |
| `format` | Formato generado. |
| `records` | Cantidad de registros exportados. |
| `output` | Ruta del archivo generado. |
| `pagesFetched` | Cantidad de páginas consultadas. |
| `totalAvailable` | Total informado por SIYS, cuando el endpoint lo proporciona. |
| `truncated` | `true` únicamente cuando se autorizó una salida parcial. |

## Ejemplo Desde Node.js

```js
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const { stdout } = await execFileAsync('siys', [
  'download',
  '--module',
  'clients',
  '--format',
  'json',
  '--out-dir',
  'data',
  '--json',
]);

const result = JSON.parse(stdout);
console.log(result.results[0].output);
```

## Ejemplo Desde PowerShell

```powershell
$result = siys download --module clients --format json --out-dir data --json | ConvertFrom-Json
$result.results[0].output
```

## Codigos de Salida

| Código | Categoría |
| --- | --- |
| `0` | Éxito. |
| `1` | Error interno inesperado. |
| `2` | Uso, entrada o configuración inválida. |
| `3` | Autenticación o autorización. |
| `4` | Red, timeout, HTTP o respuesta externa. |
| `5` | Lectura, escritura o almacenamiento local. |
| `6` | Conflicto, resultado ambiguo o verificación de seguridad fallida. |
| `130` | Cancelación con `Ctrl+C`. |

Con `--json`, un error produce un único objeto JSON en `stderr` con `code`, `category`, `message`, `operation`, `requestId` y `retryable`; `stdout` queda vacío.

Cuando se use desde otra aplicacion, captura `stderr` y el codigo de salida para registrar errores.

## Recomendaciones

- Usa `--json` siempre que la CLI sea llamada por otra aplicacion.
- Usa `--out-dir` con una carpeta controlada por la aplicacion llamadora.
- Usa `--output` solo si descargas un modulo y un formato.
- No dependas del texto normal de consola; ese texto es para uso humano.
- No guardes credenciales en argumentos de terminal. Usa `.env` o variables de entorno del proceso.

## Inspeccion jerarquica de ordenes

Para integrar una revision de informes HVAC, usa el comando de solo lectura:

```powershell
siys order inspect 007393 --output data\order-007393.json --json
```

Para un código histórico repetido, incluye `--order-id <id>`; la CLI valida que ese ID corresponda al código solicitado antes de continuar.

La salida de consola incluye `code`, `maintenances` y `output`. El archivo indicado por `output` incluye el snapshot completo de orden, mantenimientos, actividades, referencias de archivos y entrega. No incluye binarios de fotografias ni ejecuta operaciones de escritura.
