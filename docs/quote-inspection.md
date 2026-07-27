# Inspección interna de cotizaciones

La CLI conserva dos niveles de consulta de cotizaciones:

- `siys download --module quotes`: listado/exportación de cotizaciones. Usa `GET /api/cotizacion` y conserva la estructura de artículos, pero no calcula totales comerciales ni enriquece el historial de estados.
- `siys quote inspect <codigo>`: detalle operativo de una cotización. Resuelve el código, consulta `GET /api/cotizacion/{_id}`, normaliza artículos y desgloses, calcula valores y escribe un snapshot JSON saneado.

Todas las operaciones son de solo lectura.

## Uso

```powershell
siys quote inspect C20260734 --output "$PWD\C20260734-detail.json" --json
```

Si el código no es único, seleccionar el ID exacto:

```powershell
siys quote inspect C20260734 --quote-id 6a63cb50b02db19c448181cf --output "$PWD\C20260734-detail.json"
```

El resumen de consola contiene únicamente código, ID, cantidad de líneas cobrables, subtotal, total, advertencias y archivo de salida. El contenido completo queda en el JSON.

## Modelo observado

Una respuesta de cotización contiene:

- identificación: `_id`, `fullCode`, `codigo`, `code`, `titulo`;
- contexto: `unidad_negocio`, `cliente`, `sucursal`, `tipo`, `modo`, `spendPlan`, `fecha`, `anio`, `mes`;
- estado actual: `estado`;
- historial: `estados[]`, que en el detalle trae usuario, estado y fecha enriquecidos;
- condiciones: `obs`, `iva` y `descuento`;
- líneas: `articulos[]`;
- creador: `creadoPor`.

Dentro de `articulos[]` se observan dos clases:

- agrupadores, normalmente con `tipo` nulo o `0`, descripción y sin unidad/cantidad;
- líneas cobrables, normalmente con `tipo: 1`, `descripcion`, `unidad`, `cantidad` y `factorVenta`.

Cada línea puede contener seis componentes de costo: `equipos`, `materiales`, `contratista`, `mano_de_obra`, `transporte` y `viaticos`. Cada componente tiene `valor` y, en algunos casos, `desglose[]` con `item` y `valor`.

## Cálculo normalizado

Para una línea cobrable, la CLI calcula:

```text
costo_base_unitario = suma(componentes.valor)
precio_unitario = costo_base_unitario / (factorVenta / 100)
total_linea = precio_unitario * cantidad
subtotal = suma(total_linea)
descuento = subtotal * descuento / 100
subtotal_con_descuento = subtotal - descuento
iva = subtotal_con_descuento * iva / 100
total = subtotal_con_descuento + iva
```

Los importes se redondean a dos decimales. `descuento` ausente se informa como nulo y se usa como `0 %` solo para completar el cálculo, dejando una advertencia. Si falta `iva`, el total final queda sin calcular.

El valor que muestra la tabla principal de SIYS corresponde al subtotal previo a descuento e IVA. Por eso no debe confundirse con `quote.totals.total`.

## Salida

El snapshot tiene `schemaVersion: "1.0"` y contiene:

- `source.listPath` y `source.detailPath`;
- `quote.items[]` con agrupadores, líneas, componentes, desgloses, costo base, precio unitario y total de línea;
- `quote.totals` con subtotal, descuento, IVA, total y advertencias;
- `quote.statusHistory[]` con usuario, estado y fecha;
- `quote.raw`, copia saneada de la respuesta para conservar campos aún no normalizados.

La respuesta de SIYS puede incluir `password`, `pushToken` u otros campos sensibles dentro de `creadoPor`. La CLI los reemplaza por `[REDACTED]`; además, `quote.createdBy` solo conserva `_id` y `name`. Los exportes de `download --module quotes` aplican el mismo saneamiento.

## Filtros y límites

El listado acepta los filtros observados `fullCode`, `fecha_busqueda`, `estado`, `cliente`, `sucursal`, `inicio` y `fin`. `fecha_busqueda=1` representa fecha de registro y `fecha_busqueda=0` fecha de venta.

`quote inspect` usa el código exacto o un `--quote-id`. No modifica estados, artículos, precios ni observaciones y no descarga fotografías ni archivos externos.
