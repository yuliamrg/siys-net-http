# Esquemas de exportaciones

Los esquemas describen el JSON descargado por módulo. Son deliberadamente tolerantes (`additionalProperties: true`) porque SIYS puede agregar campos; los campos mínimos permiten validar que la relación básica no se perdió.

La fuente de verdad es el JSON. El XLSX de referencia se genera después, como una vista consultable y no como sustituto de la respuesta API. Para `sites` y `equipment`, `_customerId` identifica el cliente usado en la consulta.
