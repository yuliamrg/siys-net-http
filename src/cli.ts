#!/usr/bin/env node
import 'dotenv/config';
import path from 'node:path';
import { Command } from 'commander';
import { loginDirect, tokenExpiration, tokenIssuedAt } from './auth.js';
import { buildDownloadOptions, downloadData } from './download.js';
import { storageStatePath } from './paths.js';

async function runLogin(): Promise<void> {
  const token = await loginDirect();
  const issuedAt = tokenIssuedAt(token);
  const expiration = tokenExpiration(token);
  console.log('Login HTTP directo completado.');
  console.log(`Sesion guardada en ${path.relative(process.cwd(), storageStatePath)}`);
  console.log(`Emitido: ${issuedAt ? issuedAt.toISOString() : 'no informado por el token'}`);
  console.log(`Vence: ${expiration ? expiration.toISOString() : 'sin exp declarado en el token'}`);
}

async function runDownload(rawOptions: {
  module?: string[];
  format?: string[];
  param?: string[];
  maxPages?: number;
  outDir?: string;
  output?: string;
  json?: boolean;
  noAutoLogin?: boolean;
}): Promise<void> {
  const options = buildDownloadOptions({
    module: rawOptions.module,
    format: rawOptions.format,
    param: rawOptions.param,
    maxPages: rawOptions.maxPages,
    outDir: rawOptions.outDir,
    output: rawOptions.output,
    autoLogin: !rawOptions.noAutoLogin,
  });
  const results = await downloadData(options);
  if (rawOptions.json) {
    console.log(JSON.stringify({ results }, null, 2));
    return;
  }
  for (const result of results) {
    console.log(`Exportados ${result.records} registros de ${result.module} a ${result.output}`);
  }
}

async function runCapture(): Promise<void> {
  const { captureAssisted } = await import('./capture.js');
  await captureAssisted();
}

async function runExplore(): Promise<void> {
  const { exploreAutonomously } = await import('./explore.js');
  await exploreAutonomously();
}

async function runInventory(): Promise<void> {
  const { buildInventory } = await import('./inventory.js');
  await buildInventory();
}

function addDownloadOptions(command: Command): Command {
  return command
    .option('-m, --module <module>', 'Modulo(s): all, orders, quotes, clients, equipment. Se puede repetir o separar por coma.', collect, [])
    .option('-f, --format <format>', 'Formato(s): json, csv, xlsx, parquet. Se puede repetir o separar por coma.', collect, [])
    .option('-p, --param <key=value>', 'Parametro o filtro; se puede repetir. Solo para un modulo.', collect, [])
    .option('--max-pages <number>', 'Limite de paginas.', parsePositiveInteger, 100)
    .option('--out-dir <dir>', 'Carpeta destino.', 'exports')
    .option('-o, --output <file>', 'Archivo de salida. Solo con un modulo y un formato.')
    .option('--json', 'Imprime resumen en JSON para integraciones.')
    .option('--no-auto-login', 'No intenta login HTTP si falta o falla la sesion.');
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`Numero invalido: ${value}`);
  return parsed;
}

const program = new Command();
program.name('siys').description('CLI para descargar datos de SIYS por HTTP directo.');
program.command('login').description('Autentica por HTTP directo y guarda la sesion local sin abrir navegador.').action(runLogin);
addDownloadOptions(program.command('download').description('Descarga uno o varios modulos en uno o varios formatos.')).action(runDownload);
addDownloadOptions(program.command('export').description('Alias compatible de download.')).action(runDownload);
program.command('capture').description('Abre Chromium para captura asistida y guarda la sesion local.').action(runCapture);
program.command('explore').description('Recorre en modo lectura los cuatro modulos autorizados.').action(runExplore);
program.command('inventory').description('Genera inventario sanitizado y candidatos de endpoints.').action(runInventory);

await program.parseAsync();
