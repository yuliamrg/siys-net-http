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

Estas rutas estan cubiertas por `.gitignore`.

## Credenciales

Preferir:

```env
SIYS_EMAIL=
SIYS_PASSWORD=
```

La CLI hace login HTTP directo y guarda el token localmente. `SIYS_TOKEN` existe para casos puntuales donde otra aplicacion ya obtuvo un token.

No usar credenciales en argumentos de terminal.

## Token y Sesion

El token observado no declara `exp`, por lo que la CLI no puede calcular localmente su vencimiento. Si una consulta devuelve error de autenticacion, `siys download` intenta renovar sesion una vez usando login HTTP directo.

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

Los archivos exportados pueden contener informacion de negocio. Guardalos en una carpeta controlada y no los subas al repositorio.

Ejemplo:

```powershell
siys download --module all --format xlsx --out-dir exports
```
