# Flujo Git del proyecto

El proyecto ya está versionado. Git conserva el código, las guías y la documentación; no conserva sesiones, secretos ni evidencia descargada de órdenes.

## Antes de modificar

```powershell
git status --short
git switch -c agent/<cambio-corto>
```

No mezclar cambios ajenos que ya aparezcan en `git status`. Cada cambio funcional debe incluir su prueba o una verificación reproducible.

## Ciclo seguro

```powershell
npm run typecheck
npm test
git diff --check
git diff -- src docs guides tests
git add src docs guides tests .gitignore .env.example
git commit -m "Describe el cambio"
```

Usar una rama por tema. No hacer `git add .` cuando hay snapshots, PDFs, artefactos de órdenes o cambios de otras personas.

## Recuperación

- Ver diferencias: `git diff` o `git show <commit>`.
- Volver un cambio ya publicado sin reescribir historia: `git revert <commit>`.
- Recuperar un archivo desde un commit hacia el área de trabajo: `git restore --source <commit> -- ruta/al/archivo`.
- Antes de una entrega estable: crear una etiqueta anotada, por ejemplo `git tag -a v0.2.0 -m "Revisión visual HVAC"`.

No usar `git reset --hard` ni `git checkout --` sobre un árbol compartido: pueden destruir trabajo sin confirmar.

## Qué no se versiona

`.env`, `private/`, `.playwright-cli/` y `.wacli/` pueden contener credenciales o sesiones. Los snapshots, evidencias, revisiones y auditorías de órdenes deben quedar en `C:\Users\CoordServicio\OneDrive - Siys\ordenes-siys`, no en el repositorio ni en commits de código.

## Skills globales

La carpeta global de skills debe manejarse en un repositorio Git separado, privado, excluyendo `.system/`, cachés y credenciales. Cada cambio debe tener un commit con el motivo, archivos modificados y prueba realizada. No se inicializa ni se publica ese repositorio sin autorización explícita, porque es un espacio compartido fuera de este proyecto.
