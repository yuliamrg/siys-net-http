# Instalacion y Configuracion

Esta guia deja la CLI `siys` lista para usarse desde la terminal o desde otras aplicaciones.

## Requisitos

- Node.js compatible con el proyecto.
- npm.
- Acceso autorizado a SIYS.
- Credenciales validas de SIYS o un token autorizado.

## Instalacion Desde GitHub

```powershell
git clone https://github.com/yuliamrg/siys-net-http.git
cd siys-net-http
npm ci
npm run build
npm link
```

Verifica que el comando quedo disponible:

```powershell
siys --help
```

Después de `npm link`, `siys` se puede ejecutar desde cualquier carpeta. Al modificar la CLI, volver a ejecutar `npm run build`; el enlace no necesita recrearse mientras el nombre del binario no cambie.

## Uso Sin `npm link`

Durante desarrollo tambien puedes ejecutar la CLI con scripts npm:

```powershell
npm run download -- --module clients --format xlsx
npm run login
```

## Variables de Entorno

Copia `.env.example` a `.env`:

```powershell
Copy-Item .env.example .env
```

Completa los valores necesarios:

```env
SIYS_BASE_URL=https://app.siys.net
SIYS_API_URL=https://api.siys.net/api
SIYS_LOGIN_URL=https://api.siys.net/login
SIYS_EMAIL=
SIYS_PASSWORD=
SIYS_TOKEN=
```

## Autenticacion

La CLI busca sesión o credenciales en este orden:

1. `SIYS_TOKEN`, si esta definido.
2. Token guardado en `private/storage-state.json`.
3. Login HTTP directo con `SIYS_EMAIL` y `SIYS_PASSWORD`.

Puedes iniciar sesion manualmente sin navegador:

```powershell
siys login
```

La sesión guardada se reutiliza en cada ejecución; no se inicia sesión de nuevo mientras SIYS la acepte. Si SIYS rechaza el token y existen `SIYS_EMAIL` y `SIYS_PASSWORD`, la CLI intenta un único login directo y repite la lectura.

## Verificacion

```powershell
npm run typecheck
npm test
npm run build
```
