import type { Command } from 'commander';
import { cacheTtlMs, readCacheStatus, readCachedApiResponse, resolveCachedName, searchCacheRecords, searchCachedApiReads } from './cache.js';
import { parseModules, refreshCacheData } from './download.js';
import { modules, type ModuleName } from './types.js';

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function positiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`Numero invalido: ${value}`);
  return parsed;
}

function moduleName(value: string): ModuleName {
  if (!(modules as readonly string[]).includes(value)) throw new Error(`Modulo invalido: ${value}. Usa ${modules.join(', ')}.`);
  return value as ModuleName;
}

function ttlLabel(milliseconds: number): string {
  const minutes = Math.round(milliseconds / 60_000);
  if (minutes >= 1440) return `${Math.round(minutes / 1440)} h`;
  return `${minutes} min`;
}

export function addCacheCommands(program: Command): void {
  const cache = program.command('cache').description('Consulta y actualiza el catálogo local SQLite de datos ya descargados.');

  cache.command('status')
    .description('Muestra la antigüedad, cobertura y ubicación de la caché local.')
    .option('--json', 'Imprime el resultado como JSON.')
    .action((options: { json?: boolean }) => {
      const status = readCacheStatus();
      const result = { cache: status };
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`Caché local: ${status.path} (perfil ${status.profile})`);
      console.log(`Respuestas JSON GET archivadas: ${status.apiReadSnapshots}.`);
      for (const entry of status.modules) {
        const age = entry.latestCompleteFetchedAt ?? 'sin consulta completa';
        const freshness = entry.latestCompleteFetchedAt ? (entry.latestSnapshotFresh ? 'vigente' : 'obsoleta') : 'vacía';
        console.log(`${entry.module}: ${entry.records} registros, ${entry.completeScopes} consultas completas (${entry.freshCompleteScopes} vigentes), ${entry.partialScopes} parciales; última completa ${age}; TTL ${ttlLabel(cacheTtlMs[entry.module])}. Estado: ${freshness}.`);
      }
    });

  cache.command('refresh')
    .description('Descarga y guarda en SQLite uno o todos los módulos, sin crear exportaciones.')
    .option('-m, --module <module>', 'Módulos: all, orders, quotes, clients, users, sites, equipment. Se puede repetir o separar por coma.', collect, [])
    .option('--max-pages <number>', 'Limite de paginas por endpoint.', positiveInteger, 100)
    .option('--allow-partial', 'Guarda el resultado incompleto como parcial; no se reutilizara para descargas cache-first.')
    .option('--no-auto-login', 'No intenta login HTTP si falta o falla la sesion.')
    .option('--json', 'Imprime el resumen en JSON.')
    .action(async (options: { module?: string[]; maxPages?: number; allowPartial?: boolean; autoLogin?: boolean; json?: boolean }) => {
      const selectedModules = parseModules(options.module ?? []);
      const results = await refreshCacheData({
        modules: selectedModules,
        maxPages: options.maxPages ?? 100,
        allowPartial: options.allowPartial ?? false,
        autoLogin: options.autoLogin ?? true,
      });
      if (options.json) {
        console.log(JSON.stringify({ results }, null, 2));
        return;
      }
      for (const result of results) {
        console.log(`${result.module}: ${result.records} registros; ${result.pagesFetched} paginas; ${result.truncated ? 'parcial' : 'completo'}; guardado ${result.fetchedAt}.`);
      }
    });

  cache.command('search <module>')
    .description('Busca sin red en los registros que ya se guardaron localmente.')
    .option('--text <text>', 'Busca texto en los campos de los registros.')
    .option('--id <id>', 'Busca el ID exacto del registro.')
    .option('--limit <number>', 'Máximo de resultados (1-100).', positiveInteger, 20)
    .option('--json', 'Imprime los candidatos como JSON.')
    .action((moduleValue: string, options: { text?: string; id?: string; limit?: number; json?: boolean }) => {
      if (moduleValue === 'reads') {
        if (!options.text || options.id) throw new Error('Para buscar lecturas usa: siys cache search reads --text <texto>.');
        const results = searchCachedApiReads(options.text, options.limit ?? 20);
        if (options.json) {
          console.log(JSON.stringify({ module: 'reads', cacheOnly: true, historical: true, results }, null, 2));
          return;
        }
        if (results.length === 0) {
          console.log('No hay coincidencias en las respuestas JSON GET archivadas. La búsqueda no consultó SIYS.');
          return;
        }
        console.log('Coincidencias en respuestas JSON GET archivadas; son copias de referencia y la búsqueda no consultó SIYS:');
        for (const row of results) {
          const params = Object.keys(row.params).length ? `; filtros ${JSON.stringify(row.params)}` : '';
          console.log(`- snapshot ${row.snapshotId} | GET ${row.endpoint}${params}; descargado ${row.fetchedAt}`);
        }
        return;
      }
      const selectedModule = moduleName(moduleValue);
      const results = searchCacheRecords(selectedModule, { text: options.text, id: options.id }, options.limit ?? 20);
      const result = { module: selectedModule, cacheOnly: true, results };
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      if (results.length === 0) {
        console.log(`No hay coincidencias locales en ${selectedModule}. La búsqueda no consultó SIYS; primero descarga o actualiza ese módulo.`);
        return;
      }
      console.log(`Coincidencias locales en ${selectedModule}; la búsqueda no consultó SIYS:`);
      for (const row of results) {
        const freshness = row.stale ? 'desactualizado' : 'vigente';
        const parent = row.customerId ? `; cliente ${row.customerId}` : '';
        const state = row.state ? `; estado ${row.state}` : '';
        console.log(`- ${row.label} | ID ${row.id}${parent}${state}; ${freshness} desde ${row.fetchedAt}`);
      }
    });

  cache.command('read <snapshot-id>')
    .description('Imprime una respuesta GET JSON archivada por su ID de snapshot; no consulta SIYS.')
    .action((snapshotValue: string) => {
      const snapshot = readCachedApiResponse(positiveInteger(snapshotValue));
      if (!snapshot) throw new Error(`No existe una respuesta GET archivada con ID ${snapshotValue}.`);
      console.log(JSON.stringify(snapshot, null, 2));
    });

  cache.command('resolve <module> <name>')
    .description('Resuelve un nombre a un único ID desde un catálogo completo y vigente.')
    .option('--json', 'Imprime el resultado como JSON.')
    .action((moduleValue: string, name: string, options: { json?: boolean }) => {
      const selectedModule = moduleName(moduleValue);
      const resolved = resolveCachedName(selectedModule, name);
      if (options.json) {
        console.log(JSON.stringify({ module: selectedModule, query: name, ...resolved }, null, 2));
        return;
      }
      console.log(`${resolved.label}: ${resolved.id} (catálogo actualizado ${resolved.fetchedAt}).`);
    });
}
