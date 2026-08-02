# Seguridad y Datos Locales

La CLI trabaja con informacion sensible. Estas reglas evitan subir credenciales, sesiones o exportaciones a Git.

## Archivos Sensibles

| Ruta | Contenido | Versionado |
| --- | --- | --- |
| `.env` | Credenciales, URLs y token opcional. | No |
| `private/storage-state.json` | Token vigente guardado por login HTTP. | No |
| `private/endpoints.json` | Override local de endpoints observados. | No |
| `private/captures/` | Capturas privadas de exploracion. | No |
| `private/responses/` | Respuestas privadas de API. | No |
| `exports/` | Datos descargados de SIYS. | No |
| `C:\Users\CoordServicio\OneDrive - Siys\ordenes-siys\` | Snapshots, evidencia, revisiones y auditorias de ordenes. | No |

Estas rutas estan cubiertas por `.gitignore`.

## Biblioteca de ordenes

El proyecto no conserva carpetas de ordenes. Las ordenes y sus artefactos deben guardarse exclusivamente en:

```text
C:\Users\CoordServicio\OneDrive - Siys\ordenes-siys
```

No crear nuevas carpetas de ordenes dentro del repositorio. Al inspeccionar o mejorar una orden, usar una subcarpeta identificada por codigo, sede y fecha dentro de la biblioteca de OneDrive.

## Credenciales

Preferir:

```env
SIYS_EMAIL=
SIYS_PASSWORD=
```

La CLI hace login HTTP directo y guarda el token localmente. `SIYS_TOKEN` existe para casos puntuales donde otra aplicacion ya obtuvo un token.

No usar credenciales en argumentos de terminal.

## Token y Sesion

El token se guarda una vez autenticado y la CLI lo reutiliza en todas las ejecuciones; no intenta autenticar de nuevo por fecha local. Si SIYS llegara a rechazarlo, `siys download` intenta un único login directo y repite la lectura cuando existen credenciales configuradas.

Flujo recomendado ante error de sesion:

```powershell
siys login
siys download --module all --format xlsx
```

## UI y Navegador

El flujo normal no usa navegador. Los comandos con navegador solo deben usarse para diagnostico:

```powershell
siys capture
siys explore
```

Durante navegacion de diagnostico, el proyecto bloquea metodos potencialmente mutantes salvo el login requerido.

## Exportaciones

Los archivos exportados pueden contener informacion de negocio. Son salidas generadas y temporales: guardalos preferiblemente fuera del repositorio y no los subas a Git.

Ejemplo recomendado:

```powershell
siys download --module all --format xlsx --out-dir "$env:TEMP\siys-net-http-exports"
```

Si se usa `exports/` dentro del proyecto, esa carpeta esta ignorada y nunca debe versionarse. Las ordenes, snapshots, evidencias, revisiones y auditorias no son exportaciones temporales: deben guardarse exclusivamente en `C:\Users\CoordServicio\OneDrive - Siys\ordenes-siys`.
