# Instrucciones del proyecto

## Catálogo local de SIYS

- Antes de implementar otra consulta tabular de los módulos `orders`, `quotes`, `clients`, `users`, `sites` o `equipment`, reutiliza la infraestructura en `src/cache.ts`; evita crear un segundo almacén local.
- Toda respuesta JSON recibida por un GET de `src/api.ts` debe archivarse mediante `saveApiRead` en el mismo catálogo SQLite, con endpoint, filtros y fecha. La búsqueda de lecturas archivadas es solo referencia y no puede reemplazar lecturas remotas que requieran estado vigente.
- `download` consulta primero un snapshot completo que coincida con el módulo, los filtros, el perfil y la URL de API. Mantén los TTL definidos por módulo en `cacheTtlMs`; `--refresh` fuerza SIYS.
- Guarda los registros personales y comerciales descargados para búsquedas futuras. Pasa los datos por `redact()` antes de exportar o persistir; nunca guardes contraseñas, tokens, cookies, credenciales, claves, firmas ni URLs firmadas.
- Conserva metadatos de alcance, antigüedad, filas, páginas, total y truncamiento. Una consulta parcial debe marcarse como parcial y nunca servirse como snapshot completo vigente.
- `cache search` solo encuentra registros ya observados y debe identificar resultados vencidos; no presentes su cobertura como catálogo completo. `cache resolve` requiere una consulta completa y vigente y falla si la coincidencia es inexistente o ambigua.
- `cache search reads` y `cache read` consultan solo copias JSON archivadas. Nunca uses esas copias para una inspección que exija estado actual o como precondición de escritura.
- La caché es un read model no autoritativo en `%LOCALAPPDATA%\SIYS\cache`; no la guardes en Git, `private/`, OneDrive ni una carpeta compartida. No guardes tokens ni credenciales en SQLite.
- La caché no autoriza escrituras. Antes de modificar una orden, conserva la lectura remota, revisión aprobada, relectura previa y verificación posterior establecidas por los contratos de escritura.
- Actualiza `docs/catalog-cache.md`, `docs/security-and-storage.md` y `CHANGELOG.md` si cambia el esquema, la frescura o la interfaz de estos comandos.
