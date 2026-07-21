# Aplicación segura de revisiones de orden

`siys order apply-review` solo edita campos ya existentes: observaciones y estado del mantenimiento, nombre de tarea y nombre/respuesta de actividad. No crea, borra, mueve ni modifica fotos, archivos, visibilidad, fechas, usuarios o entrega.

Antes de habilitar una ruta de escritura, capturar una edición equivalente en SIYS y validar manualmente el método, URL y cuerpo. Guardar el resultado en una ruta privada; la CLI no trae un contrato activo ni adivina endpoints.

Para capturar sin modificar producción, ejecutar `siys capture`, abrir una orden de prueba, editar un único campo existente e intentar guardar. El guard de captura aborta la solicitud mutante pero conserva en `private/captures/` la URL, método y cuerpo saneado que la app intentó enviar. Confirmar el contrato contra el equipo de SI&S antes de habilitarlo.

## Contrato local

El archivo pasado con `--contract` debe contener únicamente los endpoints y campos verificados. Ejemplo de forma (las rutas son ilustrativas y no se deben copiar sin captura):

```json
{
  "schemaVersion": "1.0",
  "enabled": true,
  "operations": {
    "maintenance": {
      "method": "PATCH",
      "path": "/maintenance/{maintenanceId}",
      "fields": { "observations": { "path": "observations" } }
    },
    "task": {
      "method": "PATCH",
      "path": "/maintenance/{maintenanceId}/task/{taskId}",
      "fields": { "name": { "path": "name" } }
    },
    "activity": {
      "method": "PATCH",
      "path": "/maintenance/{maintenanceId}/task/{taskId}/activity/{activityId}",
      "fields": { "name": { "path": "name" }, "reply": { "path": "reply" } }
    }
  }
}
```

El contrato acepta solo `PATCH` o `PUT`, rutas relativas y cuerpos con los campos declarados. `path` sirve cuando el valor leído y el enviado tienen la misma ruta. Cuando SIYS almacene correcciones separadas, declarar `originalPath` (valor que se compara contra el snapshot), `verifyPath` (valor que se verifica tras guardar) y `bodyPath` (valor enviado), todos capturados de la app. Un campo puede declarar además su propio `method` y `path` cuando la interfaz use una URL distinta dentro de la misma actividad. Mantenerlo fuera de Git, por ejemplo en `private/`.

Contrato confirmado en la prueba de 006668 para el nombre corregido de una actividad:

```json
{
  "method": "PUT",
  "path": "/maintenance/{maintenanceId}/task/{taskId}/activity/{activityId}?field=nameCorrected",
  "fields": {
    "name": {
      "originalPath": "name",
      "verifyPath": "nameCorrected.reply",
      "bodyPath": "reply"
    },
    "reply": {
      "method": "PUT",
      "path": "/maintenance/{maintenanceId}/task/{taskId}/activity/{activityId}?field=replyCorrected",
      "originalPath": "reply",
      "verifyPath": "replyCorrected.reply",
      "bodyPath": "reply"
    }
  }
}
```

Para las observaciones finales del mantenimiento, la app confirmó:

```json
{
  "method": "PUT",
  "path": "/maintenance/{maintenanceId}/observations",
  "fields": {
    "observations": {
      "originalPath": "observations",
      "verifyPath": "observationsCorrected.reply",
      "bodyPath": "observationsCorrected.reply"
    }
  }
}
```

### Estado operativo del equipo

Capturado de forma bloqueada en la interfaz de SIYS el 20 de julio de 2026: al seleccionar una opción en **Orden → Equipos → Estado**, la app intenta `PATCH /maintenance/{maintenanceId}` con el campo `equipmentState`. La solicitud se abortó en el navegador antes de salir a SIYS; no se modificó ningún registro.

| Etiqueta SIYS | Valor `equipmentState` |
| --- | ---: |
| Funcionando correctamente / Operando | `1` |
| Con novedad | `2` |
| Fuera de funcionamiento | `3` |

Fragmento que puede agregarse al contrato privado ya validado, junto con las rutas de observaciones y actividades correspondientes:

```json
{
  "maintenance": {
    "method": "PATCH",
    "path": "/maintenance/{maintenanceId}",
    "fields": {
      "equipmentState": {
        "originalPath": "equipmentState",
        "verifyPath": "equipmentState",
        "bodyPath": "equipmentState"
      }
    }
  }
}
```

El estado solo se incluye en un JSON de revisión cuando la observación, actividad y evidencia son coherentes con él. La CLI relee y compara el valor actual antes de escribir.

## Flujo del coordinador

1. Extraer la orden y generar el JSON de revisión.
2. Verificar textos, evidencia y que no haya `manualReview: true`.
3. Cambiar el estado del JSON de `draft` a `approved` únicamente cuando el coordinador lo avale.
4. Simular:

   ```powershell
   siys order apply-review revision-aprobada.json --contract private\write-contract.json --json
   ```

5. Aplicar tras revisar la simulación:

   ```powershell
   siys order apply-review revision-aprobada.json --contract private\write-contract.json --confirm --json
   ```

La aplicación relee todos los mantenimientos, compara cada valor original y se detiene ante un conflicto. Si detecta que la corrección propuesta ya está guardada, la marca `alreadyApplied` y no vuelve a escribirla; esto permite retomar un lote interrumpido. Al aplicar, relee de nuevo inmediatamente antes de cada operación, usa una sola escritura a la vez (350 ms por defecto), no reintenta escrituras ambiguas y verifica el valor guardado. Siempre deja una auditoría JSON local; una falla deja la auditoría parcial para revisión.

Para una prueba de no alteración visual, el JSON puede incluir `"forceApply": ["observations"]` en una revisión o `"forceApply": ["name", "reply"]` en una actividad. Esta excepción solo sirve si el contrato verifica una corrección separada del valor original; la CLI la rechaza para campos que escriben directamente sobre el original. Debe conservar el mismo texto, motivo de prueba y aprobación del coordinador.

Para lotes grandes, la CLI limita cada ejecución a 20 cambios por defecto. Mantener `--delay-ms 350` o mayor y aplicar un lote por vez; no ejecutar escrituras en paralelo ni dos procesos sobre la misma orden. Tras revisar la simulación, usar `--max-changes <n>` solo para el tamaño exacto del lote aprobado. La auditoría se actualiza después de cada cambio aplicado.
