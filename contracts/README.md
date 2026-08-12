# Contratos de SIYS

Los contratos se separan por intención y módulo:

| Grupo | Método | Módulos | Uso |
|---|---|---|---|
| `contracts/read/` | `GET` | `orders`, `quotes`, `clients`, `users`, `sites`, `equipment` | Descargas y catálogos de referencia |
| Contrato privado de creación | `POST` | `orders` | `siys order create`; nunca se guarda en Git |
| Contrato privado de revisión | `PATCH`, `PUT`, `POST` | `orders` y sus mantenimientos | `siys order apply-review`; nunca se mezcla con lectura |

El archivo `read/catalog-v1.json` es el contrato público versionado para la extracción 2026. Los contratos de escritura deben provenir de una captura validada de la aplicación y conservarse en la carpeta privada de la ejecución.

`users` y `sites` son módulos de solo lectura. Las sedes se obtienen con `GET /subsidiary?customer=<id>` para cada cliente; el exportador agrega `_customerId` para conservar la relación.
