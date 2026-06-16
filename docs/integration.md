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
      "output": "data\\clients-2026-06-16T03-15-23-225Z.json"
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

- `0`: descarga exitosa.
- Distinto de `0`: error de parametros, autenticacion, red o escritura de archivo.

Cuando se use desde otra aplicacion, captura `stderr` y el codigo de salida para registrar errores.

## Recomendaciones

- Usa `--json` siempre que la CLI sea llamada por otra aplicacion.
- Usa `--out-dir` con una carpeta controlada por la aplicacion llamadora.
- Usa `--output` solo si descargas un modulo y un formato.
- No dependas del texto normal de consola; ese texto es para uso humano.
- No guardes credenciales en argumentos de terminal. Usa `.env` o variables de entorno del proceso.
