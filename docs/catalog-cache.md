# Catálogo local SQLite

La CLI mantiene una base SQLite local con los registros obtenidos en los seis módulos de `download`: `orders`, `quotes`, `clients`, `users`, `sites` y `equipment`. También archiva cada respuesta JSON recibida por los GET de la capa API, incluidas páginas de listados e inspecciones de detalle. Conserva campos personales y comerciales, sanea claves que parezcan contraseñas o credenciales y no almacena tokens de sesión.

## Ubicación y perfil

En Windows se guarda por defecto en `%LOCALAPPDATA%\SIYS\cache\<perfil>-<api>.sqlite3`, fuera del repositorio y de OneDrive. En otros sistemas usa `XDG_CACHE_HOME` o `~/.cache`. `SIYS_CACHE_DIR` permite cambiar la carpeta raíz y `SIYS_CACHE_PROFILE` separa perfiles locales cuando se usan cuentas distintas. La ruta aparece en `siys cache status --json`.

La base no está cifrada por la CLI; en Windows hereda los permisos de la carpeta local del usuario. Debe tratarse como información corporativa privada. No se debe mover a una carpeta compartida o sincronizada salvo que se quiera compartir esos datos.

## Frescura

| Módulos | TTL | Comportamiento |
|---|---:|---|
| `clients`, `users`, `sites`, `equipment` | 24 horas | Se reutiliza una descarga completa con los mismos filtros. |
| `orders`, `quotes` | 15 minutos | Se reutiliza una consulta completa con los mismos filtros. El fin de cotizaciones se agrupa en intervalos de 15 minutos para permitir aciertos entre ejecuciones cercanas. |

`siys download` usa primero una consulta local completa y vigente con el mismo módulo y filtros. Si no existe, está vencida o se solicita `--refresh`, consulta SIYS, sanea los campos de credenciales, guarda el resultado y genera las exportaciones pedidas. No usa una consulta truncada como resultado cache-first. `--allow-partial` puede guardar una copia identificada como parcial, pero no la convierte en una fuente cache-first.

La base conserva el último registro observado por módulo e ID, además de la pertenencia a cada consulta, fecha de descarga, cantidad de filas, páginas, total disponible y truncamiento. Para cada endpoint JSON GET conserva la última respuesta observada con los mismos filtros. `cache search` busca entre los registros que alguna vez se descargaron; ese índice puede incluir subconjuntos filtrados y no implica que se haya consultado todo SIYS.

El TTL invalida el uso cache-first, pero no borra físicamente datos vencidos. `--refresh` reemplaza el snapshot del mismo alcance y actualiza los registros observados; los alcances anteriores siguen disponibles para búsqueda local y se marcan vencidos según la fecha de cada registro. No hay limpieza automática por antigüedad. Para eliminar la base, cierra los procesos `siys` y borra el archivo SQLite junto con sus archivos `-wal` / `-shm`.

Las respuestas JSON GET archivadas se pueden buscar y leer localmente, pero no se reutilizan como respuesta automática a inspecciones ni lecturas que requieran estado vigente. Esos comandos siguen consultando SIYS. La base guarda datos estructurados JSON; las imágenes y otros binarios se gestionan por sus flujos propios.

## Comandos

```powershell
# Actualizar todos los módulos sin crear archivos XLSX/JSON
siys cache refresh --module all

# Actualizar solo usuarios, clientes, sedes o equipos
siys cache refresh --module users

# Ver antigüedad, cobertura y ubicación
siys cache status

# Buscar localmente; no genera tráfico a SIYS
siys cache search users --text "Yuliam Rivera"
siys cache search equipment --text "chiller"
siys cache search orders --id <order-id>

# Buscar y leer una respuesta JSON GET ya archivada
siys cache search reads --text "mantenimiento preventivo"
siys cache read <snapshot-id>

# Resolver un nombre únicamente con un catálogo completo y vigente
siys cache resolve users "Yuliam Rivera"

# Usar el nombre al filtrar órdenes; requiere el catálogo `users` vigente
siys download --module orders --format json --created-by-name "Yuliam Rivera" --start 2026-08-01 --end 2026-09-23 --json

# Ignorar la caché y consultar SIYS explícitamente
siys download --module orders --format json --refresh --state Finalizada --start 2026-08-01 --end 2026-09-23
```

`cache resolve` falla si no existe una descarga completa y vigente del módulo, si no encuentra el nombre o si el nombre coincide con más de un ID. La búsqueda ignora mayúsculas, tildes y orden de las palabras; `--created-by-name` sigue la misma regla y nunca adivina entre homónimos. Actualiza el catálogo con `siys cache refresh --module users` cuando haga falta.

`cache search` es una búsqueda local de candidatos y marca cada resultado vencido. Antes de una decisión que dependa del estado vigente o de una modificación de orden, consultar el registro remoto con `order inspect`; la caché no autoriza escrituras ni sustituye la relectura/verificación de `order apply-review`.

## Límites

- Los snapshots se comparten solo dentro del perfil y la URL de API configurados.
- Las descargas incompletas se etiquetan y no reemplazan el snapshot completo usado por `download`.
- Las credenciales, el token guardado por `siys login`, contraseñas, cookies, claves y campos equivalentes no se incorporan a la caché.
- `cache search reads` devuelve endpoint, filtros y fecha; `cache read` imprime la respuesta saneada completa. Ambas operaciones son locales y no consultan SIYS.
- Los datos cacheados no se suben a Git. Cierra los procesos `siys` antes de mover o borrar manualmente el archivo SQLite y sus archivos `-wal` / `-shm`.
