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
| `%LOCALAPPDATA%\SIYS\cache\*.sqlite3` | Catálogo local con registros personales y comerciales y respuestas JSON GET saneadas; no guarda contraseñas, tokens ni credenciales. | No |
| `C:\Users\CoordServicio\OneDrive - Siys\ordenes-siys\` | Snapshots, evidencia, revisiones y auditorias de ordenes. | No |

Estas rutas estan cubiertas por `.gitignore`.

## Catálogo SQLite

La caché se guarda por defecto fuera del repositorio y OneDrive, en el perfil local de Windows. Conserva los campos personales y comerciales de los registros descargados para acelerar búsquedas posteriores. No está cifrada por la CLI; hereda los permisos del usuario de Windows. No apuntes `SIYS_CACHE_DIR` a una ubicación compartida sin querer compartir esos datos.

La caché guarda órdenes, cotizaciones, usuarios, clientes, sedes y equipos con filtros, conteos y fecha de consulta. También conserva la última respuesta JSON de cada endpoint GET y combinación de filtros para consulta manual. Las claves con nombres de contraseñas, tokens, autenticación, cookies, credenciales o firmas se redactan antes de almacenar, al igual que valores URL con firmas sensibles. La sesión HTTP continúa en `private/storage-state.json`, separada de SQLite. `SIYS_CACHE_PROFILE` separa bases locales para identidades distintas y `SIYS_CACHE_DIR` permite cambiar la carpeta raíz.

Usa `siys cache status` para ver la ruta y frescura. Para buscar sin red, `siys cache search <modulo> --text <texto>` encuentra candidatos de registros descargados; `siys cache search reads --text <texto>` encuentra respuestas JSON GET archivadas y `siys cache read <snapshot-id>` imprime una copia local saneada. La búsqueda local puede cubrir solo los filtros y periodos consultados previamente. Las respuestas archivadas no sustituyen lecturas remotas cuando se necesita estado vigente. `siys download --refresh` fuerza una lectura nueva de SIYS. Antes de modificar una orden, inspecciona la orden vigente y continúa con el flujo de revisión aprobado.

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

## Validación de configuración

- `SIYS_BASE_URL`, `SIYS_API_URL` y `SIYS_LOGIN_URL` deben ser URL absolutas HTTPS sin credenciales, query ni fragmentos.
- La API y el login deben compartir el mismo origen; la CLI no ofrece una opción permanente para desactivar TLS.
- `private/endpoints.json` solo admite módulos conocidos, método `GET`, rutas relativas seguras, paginación positiva, claves conocidas y combinaciones módulo/ruta no duplicadas.
- Solicitudes, contratos, revisiones, snapshots y manifiestos JSON locales deben estar en UTF-8 sin BOM, caracteres de reemplazo ni mojibake detectable.
