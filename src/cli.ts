import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Command, Option } from 'commander';
import { fetchEndpoint } from './api.js';
import { loadToken, tokenExpiration } from './auth.js';
import { captureAssisted } from './capture.js';
import { exploreAutonomously } from './explore.js';
import { exportRows } from './exporters.js';
import { buildInventory } from './inventory.js';
import { endpointConfigPath, exportsDir } from './paths.js';
import { modules, type EndpointDefinition, type ExportFormat, type ModuleName } from './types.js';
import { timestamp } from './utils.js';

function parseParams(values: string[]): Record<string, string> {
  return Object.fromEntries(values.map((value) => {
    const separator = value.indexOf('=');
    if (separator < 1) throw new Error(`Parametro invalido: ${value}. Usa clave=valor.`);
    return [value.slice(0, separator), value.slice(separator + 1)];
  }));
}

function defaultParams(module: ModuleName): Record<string, string> {
  const now = new Date();
  const year = now.getUTCFullYear();
  if (module === 'orders') {
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    return { start: `${year}-${month}-01`, end: now.toISOString().slice(0, 10) };
  }
  if (module === 'quotes') {
    return {
      fecha_busqueda: '1',
      inicio: new Date(Date.UTC(year, 0, 1, 5)).toISOString(),
      fin: now.toISOString(),
    };
  }
  return {};
}

async function fetchAllEquipment(
  equipment: EndpointDefinition,
  clients: EndpointDefinition,
  token: string,
  maxPages: number,
): Promise<Record<string, unknown>[]> {
  const customerRows = await fetchEndpoint(clients, { token, params: {}, maxPages: 1 });
  const output: Record<string, unknown>[] = [];
  const batchSize = 5;
  for (let index = 0; index < customerRows.length; index += batchSize) {
    const batch = customerRows.slice(index, index + batchSize);
    const results = await Promise.all(batch.map(async (customer) => {
      const id = customer._id;
      if (typeof id !== 'string') return [];
      const rows = await fetchEndpoint(equipment, { token, params: { customer: id }, maxPages });
      return rows.map((row) => ({ _customerId: id, ...row }));
    }));
    output.push(...results.flat());
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return output;
}

async function runExport(options: {
  module: ModuleName;
  format: ExportFormat;
  param: string[];
  maxPages: number;
  output?: string;
}): Promise<void> {
  const definitions = JSON.parse(await fs.readFile(endpointConfigPath, 'utf8')) as EndpointDefinition[];
  const selected = definitions.filter((definition) => definition.module === options.module);
  if (selected.length === 0) {
    throw new Error(`No hay endpoints inferidos para ${options.module}. Ejecuta capture, navega el modulo y luego inventory.`);
  }
  const token = await loadToken();
  const expiration = tokenExpiration(token);
  if (expiration && expiration <= new Date()) throw new Error(`El token vencio el ${expiration.toISOString()}. Ejecuta npm run capture.`);

  const params = { ...defaultParams(options.module), ...parseParams(options.param) };
  const rows: Record<string, unknown>[] = [];
  if (options.module === 'equipment' && !params.customer) {
    const clients = definitions.find((definition) => definition.module === 'clients');
    if (!clients) throw new Error('No existe la definicion del endpoint de clientes. Ejecuta npm run inventory.');
    rows.push(...await fetchAllEquipment(selected[0], clients, token, options.maxPages));
  } else {
    for (const endpoint of selected) {
      const endpointRows = await fetchEndpoint(endpoint, { token, params, maxPages: options.maxPages });
      rows.push(...endpointRows.map((row) => ({ _endpoint: endpoint.path, ...row })));
    }
  }
  const output = options.output ?? path.join(exportsDir, `${options.module}-${timestamp()}.${options.format}`);
  await exportRows(rows, options.format, output);
  console.log(`Exportados ${rows.length} registros a ${output}`);
}

const program = new Command();
program.name('siys-explorer').description('Exploracion autorizada y de solo lectura de SIYS.');
program.command('capture').description('Abre Chromium para captura asistida y guarda la sesion local.').action(captureAssisted);
program.command('explore').description('Recorre en modo lectura los cuatro modulos autorizados.').action(exploreAutonomously);
program.command('inventory').description('Genera inventario sanitizado y candidatos de endpoints.').action(async () => {
  await buildInventory();
});
program
  .command('export')
  .description('Consulta directamente endpoints observados y exporta sus datos.')
  .addOption(new Option('-m, --module <module>', 'Modulo').choices([...modules]).makeOptionMandatory())
  .addOption(new Option('-f, --format <format>', 'Formato').choices(['json', 'csv', 'xlsx', 'parquet']).default('json'))
  .option('-p, --param <key=value>', 'Parametro o filtro; se puede repetir.', (value, previous: string[]) => [...previous, value], [])
  .option('--max-pages <number>', 'Limite de paginas.', (value) => Number.parseInt(value, 10), 100)
  .option('-o, --output <file>', 'Ruta de salida.')
  .action(runExport);

await program.parseAsync();
