# SIYS Explorer

Herramienta local para explorar de forma autorizada y de solo lectura los módulos de órdenes, cotizaciones, clientes y equipos de SIYS, documentar su API y exportar datos.

## Seguridad

- Las credenciales pueden mantenerse únicamente en `.env`, que está excluido de Git.
- Nunca escribas credenciales en argumentos de terminal ni en archivos versionados.
- `private/` contiene sesión, JWT, respuestas y capturas; está excluido de Git.
- No se genera HAR durante el login porque ese formato puede conservar la contraseña enviada.
- `exports/` también está excluido porque puede contener información sensible.
- La navegación bloquea todos los métodos salvo `GET`, `HEAD`, `OPTIONS` y `POST https://api.siys.net/login`.

## Flujo

```powershell
npm run capture
```

Puedes iniciar sesión manualmente o completar primero `SIYS_EMAIL` y `SIYS_PASSWORD` en `.env` para que Playwright lo haga. Navega por los cuatro módulos y vuelve a la terminal para presionar Enter. Después ejecuta:

```powershell
npm run explore
npm run inventory
```

El inventario sanitizado queda en `artifacts/endpoint-inventory.json`. Los endpoints inferidos y las evidencias permanecen en `private/`.

## Exportación

El formato se elige en cada ejecución:

```powershell
npm run export -- --module orders --format json
npm run export -- --module quotes --format csv
npm run export -- --module clients --format xlsx
npm run export -- --module equipment --format parquet
```

Los módulos válidos son `orders`, `quotes`, `clients` y `equipment`. Se pueden pasar filtros observados en la aplicación:

```powershell
npm run export -- --module orders --format xlsx --param start=2026-01-01 --param end=2026-06-30
```

No se inventan filtros: usa únicamente nombres confirmados en el inventario o las capturas. `--max-pages` limita la paginación y `--output` permite elegir la ruta de salida.

Por defecto, órdenes consulta el mes actual y cotizaciones consulta desde el inicio del año. Los parámetros explícitos reemplazan esos valores. La exportación de equipos sin `--param customer=<id>` recorre los clientes en lotes pequeños y consolida sus equipos.

La documentación completa de arquitectura, autenticación, endpoints, campos y resultados está en [`docs/technical-findings.md`](docs/technical-findings.md).

## Verificación

```powershell
npm run typecheck
npm test
```
