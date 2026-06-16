# Comandos de Diagnostico

Estos comandos no son necesarios para la descarga normal. Sirven para revisar cambios en SIYS, capturar trafico autorizado o regenerar inventarios.

## `siys capture`

Abre Chromium para una captura asistida.

```powershell
siys capture
```

Uso esperado:

1. Iniciar sesion manualmente o con credenciales de `.env`.
2. Navegar por los modulos necesarios.
3. Volver a la terminal y presionar Enter.

Genera archivos privados en `private/`.

## `siys explore`

Recorre automaticamente modulos conocidos en modo lectura.

```powershell
siys explore
```

Requiere una sesion previa en `private/storage-state.json`.

## `siys inventory`

Construye un inventario sanitizado desde capturas previas.

```powershell
siys inventory
```

Salidas:

| Ruta | Descripcion |
| --- | --- |
| `artifacts/endpoint-inventory.json` | Inventario sanitizado de endpoints observados. |
| `private/endpoints.json` | Candidatos privados usados como override local. |

## Cuando Usarlos

Usa estos comandos solo cuando:

- SIYS cambia su interfaz o endpoints.
- Una descarga deja de funcionar y se necesita confirmar rutas.
- Se quiere validar un filtro nuevo observado en la UI.
- Se necesita evidencia tecnica para actualizar `docs/technical-findings.md`.

Para descargas normales usa:

```powershell
siys download
```
