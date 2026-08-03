# Estructura del informe de servicio de una orden

Este documento registra la relación entre una orden de SIYS, los datos que carga la aplicación web y el PDF Reporte de Servicio que se genera al imprimir una orden.

El análisis se realizó en modo de solo lectura con la orden 007393 y un PDF de Reporte de Servicio de 66 páginas, correspondiente a 56 equipos/mantenimientos. El PDF fue un insumo temporal de validación y no se conserva en el proyecto.

## Flujo de datos

~~~text
GET /api/order/v2
  -> orden y enlaces de mantenimiento

GET /api/order/{orderId}/detail?full=true
  -> orden enriquecida, cliente, sucursal, tipo,
     fechas, mantenimientos resumidos y deliverOrder

GET /api/maintenance/{maintenanceId}/detail
  -> equipo, estado, observación, tarea,
     actividades y archivos

GET /api/deliver-order/{deliverOrderId}
  -> encuesta, respuestas, calificación y firma
~~~

Las consultas REST usan el encabezado:

~~~http
authentication: Bearer <token>
~~~

## 1. Listado de órdenes

La llamada principal es:

~~~text
GET /api/order/v2?page=1&limit=...&code=...&start=...&end=...
~~~

La respuesta tiene este envoltorio:

~~~json
{
  "docs": [],
  "total": 1,
  "page": 1
}
~~~

Cada orden contiene, entre otros:

~~~text
_id
observations
equipments[]
users[]
checkIn
requiredQuotation
close
type
customer
subsidiary
material
dates[]
state
created_by
tasks[]
counters[]
maintenances[]
created_at
update_at
code
__v
~~~

Cada elemento resumido de maintenances[] contiene status, _id, maintenance y equipment. El campo maintenance identifica el detalle completo.

La CLI actual aplana docs y agrega _endpoint, pero no conserva total ni page en los archivos exportados.

## 2. Detalle enriquecido

La aplicación abre el detalle con:

~~~text
GET /api/order/{orderId}/detail?full=true
~~~

Los datos enriquecidos relevantes son:

~~~text
customer:    _id, name
subsidiary:  _id, name, address, contact, telephone, email, locations, ...
type:        _id, name, cod, gross_margin, color, causa_raiz, fechas y auditoría
~~~

La respuesta resumida solo mostraba _id/name para cliente y sucursal. Dirección y contacto provienen del detalle enriquecido.

## 3. Cabecera del PDF

| Casilla | Fuente o transformación |
| --- | --- |
| Reporte de Servicio | Texto fijo |
| Fecha | start del primer mantenimiento, formato YYYY/MM/DD |
| Servicio | type.name + type.cod + code con ceros a la izquierda |
| Cliente | doc.customer.name |
| Sucursal | doc.subsidiary.name |
| Dirección | doc.subsidiary.address |
| Contacto | doc.subsidiary.contact |
| Logo | Imagen fija del CDN corporativo |

En 007393, Mantenimiento Preventivo 2-007393 se forma con el tipo, el código del tipo y el código de la orden.

## 4. Detalle de cada mantenimiento

Para cada elemento de doc.maintenances[]:

~~~text
GET /api/maintenance/{maintenanceId}/detail
~~~

Estructura observada:

~~~text
status
requiredQuotation
visible
_id
order
equipment
  _id
  name
  supply_zone
start
observations
equipmentState
tasks
  _id
  name
  activitys[]
customer
subsidiary
user
  _id
  name
consecutive
created_at
updated_at
__v
end
userEnd
~~~

En 007393 hubo 56 mantenimientos y 56 equipos. La relación se hace mediante maintenance_detail.equipment._id.

## 5. Bloque del equipo

Cada bloque se compone de:

~~~text
Nombre: maintenance_detail.equipment.name
Estado: maintenance_detail.equipmentState convertido a texto
Texto:  "Zona de suministro: "
        + maintenance_detail.equipment.supply_zone
        + ". "
        + maintenance_detail.observations
~~~

Conversión observada:

~~~text
1 -> Operando                 (#28B463, verde)
2 -> Con novedad              (#F1C40F, amarillo)
3 -> Fuera de funcionamiento  (#CB4335, rojo)
~~~

En 007393:

~~~text
Chiller #1 CEDI  -> 1 -> Operando
Chiller #2       -> 1 -> Operando
UMA #2 CEDI      -> 2 -> Con novedad
~~~

## 6. Tareas y actividades

La tarea sale de tasks[].name. En la muestra se llama General.

Cada casilla sale de tasks[].activitys[]. Una actividad puede contener:

~~~text
user { _id, name }
t
complete
file
hiddenFile
visible
_id
name
replies[] { _id, user, reply, createdAt, updatedAt }
control
updated_at
created_at
~~~

Para Chiller #1 CEDI se encontraron nueve actividades:

~~~text
Presión de baja cto#1 - cto #2
Temperatura de entrada y salida del agua
Presión de Alta del cto#1 - cto#2
Intensidad
Ventiladores
Tensión
Mantenimiento general
Ajuste de bornes eléctricos
Revisión de bobinas de compresores
~~~

Estos nombres coinciden con los títulos del PDF.

### Texto de una actividad

La prioridad observada es:

1. activity.replyCorrected.reply, si existe.
2. La última respuesta de activity.replies[].
3. activity.reply.

Los booleanos se muestran como true -> Ok y false -> No ejecutado.

### Visibilidad

El informe filtra las filas con activity.visible === true. maintenance.visible no controla por sí solo la impresión del mantenimiento completo. En 007393 el primer mantenimiento tenía visible=false, pero sus actividades visibles aparecieron.

## 7. Fotografías

Las fotografías salen de activity.file, que puede ser un objeto o un arreglo. Cada archivo contiene:

~~~text
used
_id
createdBy
name
originalName
size
path
createdAt
updatedAt
__v
~~~

La URL se construye como:

~~~text
{CDN}/{file.path}/{file.name}
~~~

Los archivos incluidos en activity.hiddenFile se excluyen.

Para el primer mantenimiento de 007393:

| Actividad | Fotos |
| --- | ---: |
| Presión de baja | 2 |
| Temperatura de entrada y salida | 1 |
| Presión de alta | 2 |
| Intensidad | 12 |
| Ventiladores | 8 |
| Tensión | 3 |
| Mantenimiento general | 4 |
| Ajuste de bornes | 4 |
| Revisión de bobinas | 3 |

La cantidad de páginas depende de las actividades visibles y sus fotografías.

## 8. Relaciones internas

~~~text
doc.equipments[]
       │ _id
       │
       └── maintenance_detail.equipment._id
                              │
                              └── tasks[].activitys[]
                                      ├── name
                                      ├── reply/replies
                                      └── file[]
~~~

En 007393 hubo 56 equipos, 56 mantenimientos, 2 fechas de programación y 2 usuarios asignados. Los 56 maintenances[].equipment coincidieron con los 56 equipments[]._id.

## 9. Encuesta y última página

doc.deliverOrder se resuelve mediante:

~~~text
GET /api/deliver-order/{deliverOrderId}
~~~

La respuesta contiene show, questions[], score, signature, order, user, createdAt, updatedAt y __v.

La última página se imprime cuando show está habilitado. questions[].q se muestra como pregunta y true/false se transforma en Si/No. También se imprimen score y signature. En 007393 hubo tres preguntas, una calificación y una firma.

## 10. Implicaciones para la CLI

Para reproducir o mejorar el PDF hay que implementar:

~~~text
1. Descargar la orden desde /order/v2.
2. Consultar /order/{id}/detail?full=true.
3. Consultar /maintenance/{id}/detail para cada mantenimiento.
4. Resolver archivos desde path/name.
5. Consultar /deliver-order/{id}.
~~~

Para JSON conviene conservar la jerarquía. Para XLSX/CSV conviene separar:

~~~text
orders
order_equipments
equipment_types
equipment_subtypes
order_dates
order_maintenances
maintenance_tasks
maintenance_activities
activity_files
delivery_questions
~~~

También conviene conservar un manifiesto con total, page, order_id, maintenance_ids y fecha_de_consulta.

## 11. Revision textual API-first

La CLI incorpora `siys order inspect <codigo>` para generar un snapshot de solo lectura con IDs estables. La skill `mejorar-ordenes-siys-net` usa ese snapshot para proponer mejoras por equipo en nombres de tareas, descripciones y observaciones finales, usando la evidencia fotográfica visible cuando exista.

La propuesta se guarda en JSON con estado `draft` y se refleja en un Excel con hojas de equipos, actividades y validaciones. Tras validación del coordinador, el JSON se marca `approved` y se puede aplicar con vista previa y confirmación explícita:

```text
siys order apply-review cambios.json --contract private\write-contract.json
siys order apply-review cambios.json --contract private\write-contract.json --confirm
```

La CLI no adivina el endpoint de escritura: el contrato local debe provenir de una captura validada de la app. Consulte [Aplicación segura de revisiones](order-review-write-contract.md).

## Limitaciones

- La validación detallada se hizo con una sola orden (007393).
- Nombres, actividades y fotos cambian por equipo y orden.
- tasks y counters pueden llegar vacíos.
- Algunos campos enriquecidos solo aparecen en endpoints de detalle.
- No se encontró Swagger/OpenAPI; el contrato se reconstruyó observando REST y el JavaScript de la SPA.
