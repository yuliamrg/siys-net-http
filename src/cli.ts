#!/usr/bin/env node
import './env.js';
import path from 'node:path';
import { Command } from 'commander';
import { loginDirect, tokenExpiration, tokenIssuedAt } from './auth.js';
import { buildDownloadOptions, downloadData } from './download.js';
import { inspectionOutputPath, inspectOrder, writeInspection } from './order-inspect.js';
import { applyAuditOutputPath, applyReview, writeApplyAudit } from './order-review.js';
import { exportsDir, storageStatePath } from './paths.js';
import { buildOrderFilterParams } from './order-filters.js';
import { analyzeImages } from './image-analysis.js';
import { buildVisionReview } from './vision-review.js';
import { inspectQuote, quoteInspectionOutputPath, writeQuoteInspection } from './quote-inspect.js';
import { executeOrderCreate, orderCreateAuditOutputPath, orderCreateExecutionState, orderCreateSimulationOutputPath, writeOrderCreateAudit, writeOrderCreateSimulation } from './order-create.js';

async function runLogin(): Promise<void> {
  const token = await loginDirect();
  const issuedAt = tokenIssuedAt(token);
  const expiration = tokenExpiration(token);
  console.log('Login HTTP directo completado.');
  console.log(`Sesion guardada en ${path.relative(process.cwd(), storageStatePath)}`);
  console.log(`Emitido: ${issuedAt ? issuedAt.toISOString() : 'no informado por el token'}`);
  console.log(`Vencimiento declarado: ${expiration ? expiration.toISOString() : 'no informado; la CLI reutilizara la sesion guardada'}`);
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
  orderCode?: string;
  orderType?: string;
  cause?: string;
  rootCause?: string;
  start?: string;
  end?: string;
  state?: string;
  invoiced?: string;
  customer?: string;
  subsidiary?: string;
  technician?: string;
  createdBy?: string;
}): Promise<void> {
  const usesOrderFilters = [rawOptions.orderCode, rawOptions.orderType, rawOptions.cause, rawOptions.rootCause, rawOptions.start, rawOptions.end, rawOptions.state, rawOptions.invoiced, rawOptions.customer, rawOptions.subsidiary, rawOptions.technician, rawOptions.createdBy].some((value) => value !== undefined);
  if (usesOrderFilters && (rawOptions.module?.length !== 1 || rawOptions.module[0] !== 'orders')) {
    throw new Error('Los filtros de órdenes requieren --module orders.');
  }
  const today = new Date().toISOString().slice(0, 10);
  const orderParams = usesOrderFilters
    ? buildOrderFilterParams({ code: rawOptions.orderCode, type: rawOptions.orderType, cause: rawOptions.cause, rootCause: rawOptions.rootCause, start: rawOptions.start ?? `${today.slice(0, 4)}-01-01`, end: rawOptions.end ?? today, state: rawOptions.state, invoiced: rawOptions.invoiced, customer: rawOptions.customer, subsidiary: rawOptions.subsidiary, technician: rawOptions.technician, createdBy: rawOptions.createdBy })
    : undefined;
  const options = buildDownloadOptions({
    module: rawOptions.module,
    format: rawOptions.format,
    param: rawOptions.param,
    params: orderParams,
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

async function runOrderInspect(code: string, rawOptions: {
  output?: string;
  outDir?: string;
  json?: boolean;
  noAutoLogin?: boolean;
  orderId?: string;
}): Promise<void> {
  const inspection = await inspectOrder(code, { autoLogin: !rawOptions.noAutoLogin, orderId: rawOptions.orderId });
  const output = rawOptions.output ?? inspectionOutputPath(code, rawOptions.outDir ?? exportsDir);
  await writeInspection(output, inspection);
  const result = { code: inspection.code, maintenances: inspection.maintenances.length, output };
  if (rawOptions.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Inspeccionada la orden ${result.code}: ${result.maintenances} mantenimientos en ${result.output}`);
}

async function runOrderApplyReview(file: string, rawOptions: {
  confirm?: boolean;
  contract?: string;
  outDir?: string;
  auditOutput?: string;
  resumeAudit?: string;
  delayMs?: number;
  timeoutMs?: number;
  maxChanges?: number;
  json?: boolean;
  noAutoLogin?: boolean;
}): Promise<void> {
  if (!rawOptions.contract) throw new Error('Indica --contract <archivo>. El contrato debe provenir de una captura validada de la app SIYS.');
  let result;
  try {
    result = await applyReview(file, {
      confirm: rawOptions.confirm,
      autoLogin: !rawOptions.noAutoLogin,
      contractPath: rawOptions.contract,
      resumeAuditPath: rawOptions.resumeAudit,
      delayMs: rawOptions.delayMs,
      timeoutMs: rawOptions.timeoutMs,
      maxChanges: rawOptions.maxChanges,
      onProgress: async (progress) => {
        const output = rawOptions.auditOutput ?? applyAuditOutputPath(progress.orderCode, rawOptions.outDir ?? exportsDir);
        await writeApplyAudit(output, progress);
      },
    });
  } catch (error) {
    const partial = error && typeof error === 'object' ? (error as { applyResult?: unknown }).applyResult : undefined;
    if (partial) {
      const report = partial as { orderCode: string };
      const output = rawOptions.auditOutput ?? applyAuditOutputPath(report.orderCode, rawOptions.outDir ?? exportsDir);
      await writeApplyAudit(output, partial as Parameters<typeof writeApplyAudit>[1]);
      throw new Error(`${error instanceof Error ? error.message : String(error)} Auditoría parcial: ${output}`);
    }
    throw error;
  }
  const output = rawOptions.auditOutput ?? applyAuditOutputPath(result.orderCode, rawOptions.outDir ?? exportsDir);
  await writeApplyAudit(output, result);
  const summary = { dryRun: result.dryRun, orderCode: result.orderCode, planned: result.planned.length, plannedWrites: result.plannedWrites, applied: result.applied.length, alreadyApplied: result.alreadyApplied.length, audit: output };
  if (rawOptions.json) console.log(JSON.stringify(summary, null, 2));
  else console.log(`${summary.dryRun ? 'Simulación' : 'Aplicación'} de orden ${summary.orderCode}: ${summary.applied}/${summary.planned} cambios; ${summary.alreadyApplied} ya aplicados. Auditoría: ${summary.audit}`);
}

async function runOrderAnalyzeImages(snapshot: string, rawOptions: { output?: string; analyze?: boolean; model?: string; guidesDir?: string; downloadConcurrency?: number; analysisConcurrency?: number }): Promise<void> {
  const output = rawOptions.output ?? path.join('private', 'image-analysis', `analysis-${path.basename(snapshot, path.extname(snapshot))}.json`);
  const report = await analyzeImages(snapshot, output, { analyze: rawOptions.analyze, model: rawOptions.model, guidesDir: rawOptions.guidesDir, downloadConcurrency: rawOptions.downloadConcurrency, analysisConcurrency: rawOptions.analysisConcurrency });
  console.log(JSON.stringify({ orderCode: report.orderCode, evidence: report.evidence.length, analyses: report.analyses.length, output }, null, 2));
}

async function runOrderBuildVisionReview(snapshot: string, manifest: string, rawOptions: { output?: string }): Promise<void> {
  const output = rawOptions.output ?? path.join('private', 'image-analysis', `review-${path.basename(snapshot, path.extname(snapshot))}.json`);
  const result = await buildVisionReview(snapshot, manifest, output);
  console.log(JSON.stringify({ ...result, output }, null, 2));
}

async function runOrderCreate(file: string, rawOptions: {
  confirm?: boolean;
  contract?: string;
  timeoutMs?: number;
  auditOutput?: string;
  output?: string;
  outDir?: string;
  json?: boolean;
  noAutoLogin?: boolean;
}): Promise<void> {
  const auditOutput = rawOptions.auditOutput ?? orderCreateAuditOutputPath(rawOptions.outDir ?? exportsDir);
  let execution;
  try {
    execution = await executeOrderCreate(file, {
      confirm: rawOptions.confirm,
      contractPath: rawOptions.contract,
      timeoutMs: rawOptions.timeoutMs,
      autoLogin: !rawOptions.noAutoLogin,
      onProgress: rawOptions.confirm ? async (audit) => writeOrderCreateAudit(auditOutput, audit) : undefined,
    });
  } catch (error) {
    const partial = error && typeof error === 'object' ? (error as { orderCreateAudit?: Parameters<typeof writeOrderCreateAudit>[1] }).orderCreateAudit : undefined;
    if (partial) {
      try { await writeOrderCreateAudit(auditOutput, partial); } catch { /* The original error remains authoritative. */ }
      throw new Error(`${error instanceof Error ? error.message : String(error)} Auditoría: ${auditOutput}`);
    }
    throw error;
  }
  const simulation = execution.dryRun ? execution : execution.simulation;
  const executionState = orderCreateExecutionState(execution);
  const output = rawOptions.output ?? orderCreateSimulationOutputPath(rawOptions.outDir ?? exportsDir);
  await writeOrderCreateSimulation(output, simulation);
  const summary = {
    dryRun: executionState.dryRun,
    ready: simulation.validation.ready,
    blockers: simulation.validation.blockers,
    customer: simulation.resolved.customer,
    subsidiary: simulation.resolved.subsidiary,
    orderType: simulation.resolved.orderType,
    equipments: simulation.resolved.equipments.length,
    technicians: simulation.resolved.technicians.length,
    schedules: simulation.availability.length,
    siysWritesAttempted: executionState.siysWritesAttempted,
    auditStatus: executionState.auditStatus,
    created: executionState.created,
    audit: execution.dryRun ? undefined : auditOutput,
    verification: execution.dryRun ? undefined : execution.audit.verification,
    output,
  };
  if (rawOptions.json) console.log(JSON.stringify(summary, null, 2));
  else console.log(`${execution.dryRun ? 'Simulacion' : 'Creacion enviada'}: ${summary.ready ? 'lista' : 'bloqueada'}, ${summary.equipments} equipos, ${summary.technicians} tecnicos, ${summary.schedules} horarios, ${summary.siysWritesAttempted} escritura(s) en SIYS. Archivo: ${summary.output}`);
}

async function runOrderReviewImages(snapshot: string, rawOptions: { output?: string; analysisOutput?: string; model?: string; guidesDir?: string; downloadConcurrency?: number; analysisConcurrency?: number }): Promise<void> {
  const stem = path.basename(snapshot, path.extname(snapshot));
  const analysisOutput = rawOptions.analysisOutput ?? path.join('private', 'image-analysis', `analysis-${stem}.json`);
  const output = rawOptions.output ?? path.join('private', 'image-analysis', `review-${stem}.json`);
  const report = await analyzeImages(snapshot, analysisOutput, { analyze: true, model: rawOptions.model, guidesDir: rawOptions.guidesDir, downloadConcurrency: rawOptions.downloadConcurrency, analysisConcurrency: rawOptions.analysisConcurrency });
  const result = await buildVisionReview(snapshot, analysisOutput, output);
  console.log(JSON.stringify({ orderCode: report.orderCode, evidence: report.evidence.length, analyses: report.analyses.length, analysisOutput, proposals: result.proposals, manual: result.manual, output }, null, 2));
}

async function runQuoteInspect(code: string, rawOptions: {
  output?: string;
  outDir?: string;
  json?: boolean;
  noAutoLogin?: boolean;
  quoteId?: string;
}): Promise<void> {
  const inspection = await inspectQuote(code, { autoLogin: !rawOptions.noAutoLogin, quoteId: rawOptions.quoteId });
  const output = rawOptions.output ?? quoteInspectionOutputPath(inspection.code, rawOptions.outDir ?? exportsDir);
  await writeQuoteInspection(output, inspection);
  const summary = {
    code: inspection.code,
    quoteId: inspection.quoteId,
    items: inspection.quote.items.length,
    billableItems: inspection.quote.items.filter((item) => item.kind === 'line').length,
    subtotal: inspection.quote.totals.subtotal,
    total: inspection.quote.totals.total,
    warnings: inspection.quote.totals.warnings.length,
    output,
  };
  if (rawOptions.json) console.log(JSON.stringify(summary, null, 2));
  else console.log(`Inspeccionada la cotizacion ${summary.code}: ${summary.billableItems} lineas cobrables, subtotal ${summary.subtotal ?? 'no calculado'}, total ${summary.total ?? 'no calculado'}. Archivo: ${summary.output}`);
}

function addDownloadOptions(command: Command): Command {
  return command
    .option('-m, --module <module>', 'Modulo(s): all, orders, quotes, clients, equipment. Se puede repetir o separar por coma.', collect, [])
    .option('-f, --format <format>', 'Formato(s): json, csv, xlsx, parquet. Se puede repetir o separar por coma.', collect, [])
    .option('-p, --param <key=value>', 'Parametro o filtro; se puede repetir. Solo para un modulo.', collect, [])
    .option('--order-code <numero>', 'Filtro de órdenes: número/código.')
    .option('--order-type <id>', 'Filtro de órdenes: ID de tipo.')
    .option('--cause <id>', 'Filtro de órdenes: ID de causa.')
    .option('--root-cause <id>', 'Filtro de órdenes: ID de causa raíz.')
    .option('--start <YYYY-MM-DD>', 'Filtro de órdenes: fecha inicial.')
    .option('--end <YYYY-MM-DD>', 'Filtro de órdenes: fecha final.')
    .option('--state <estado>', 'Filtro de órdenes: Abierta, En ejecución, Finalizada, Pendiente por cotizar, Cotizada, Cerrada o Anulada.')
    .option('--invoiced <si|no>', 'Filtro de órdenes: Facturadas.')
    .option('--customer <id>', 'Filtro de órdenes: ID de cliente.')
    .option('--subsidiary <id>', 'Filtro de órdenes: ID de sucursal.')
    .option('--technician <id>', 'Filtro de órdenes: ID de técnico.')
    .option('--created-by <id>', 'Filtro de órdenes: ID del usuario que la generó.')
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

function parseNonNegativeInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`Numero invalido: ${value}`);
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
const order = program.command('order').description('Inspecciona, simula la creacion o aplica una revision aprobada de una orden.');
order.command('create <file>')
  .description('Valida y simula una orden manual; solo escribe con aprobación, contrato y --confirm.')
  .option('--confirm', 'Autoriza un único POST después de repetir toda la prevalidación.')
  .option('--contract <file>', 'Contrato privado que debe autorizar exactamente POST /order.')
  .option('--timeout-ms <number>', 'Tiempo máximo del POST; nunca se reintenta.', parsePositiveInteger, 15000)
  .option('--audit-output <file>', 'Archivo JSON de auditoría para una ejecución confirmada.')
  .option('-o, --output <file>', 'Archivo JSON con el resultado completo de la simulacion.')
  .option('--out-dir <dir>', 'Carpeta destino cuando no se usa --output.', 'exports')
  .option('--json', 'Imprime el resumen de la simulacion en JSON.')
  .option('--no-auto-login', 'No intenta login HTTP si falta o falla la sesion.')
  .action(runOrderCreate);
order.command('inspect <code>')
  .description('Exporta orden, mantenimientos, actividades, archivos y entrega en un JSON sin descargar imagenes.')
  .option('--order-id <id>', 'ID exacto de la orden, obligatorio cuando el código histórico tiene coincidencias.')
  .option('-o, --output <file>', 'Archivo JSON de salida.')
  .option('--out-dir <dir>', 'Carpeta destino cuando no se usa --output.', 'exports')
  .option('--json', 'Imprime resumen en JSON para integraciones.')
  .option('--no-auto-login', 'No intenta login HTTP si falta o falla la sesion.')
  .action(runOrderInspect);
order.command('apply-review <file>')
  .description('Simula o aplica una revisión aprobada, con relectura, detección de conflictos y auditoría local.')
  .requiredOption('--contract <file>', 'Contrato local de endpoints/payloads validado mediante captura de SIYS.')
  .option('--confirm', 'Autoriza escritura; sin esta opción solo simula.')
  .option('--out-dir <dir>', 'Carpeta para la auditoría.', 'exports')
  .option('--audit-output <file>', 'Archivo exacto para la auditoría JSON.')
  .option('--resume-audit <file>', 'Retoma una ejecución parcial usando su auditoría; exige los mismos hashes de revisión y contrato.')
  .option('--delay-ms <number>', 'Espera entre escrituras, para no saturar SIYS.', parseNonNegativeInteger, 350)
  .option('--timeout-ms <number>', 'Tiempo máximo de una escritura; no se reintenta.', parsePositiveInteger, 15000)
  .option('--max-changes <number>', 'Máximo de cambios por ejecución; default: 20.', parsePositiveInteger, 20)
  .option('--json', 'Imprime resumen en JSON para integraciones.')
  .option('--no-auto-login', 'No intenta login HTTP si falta o falla la sesion.')
  .action(runOrderApplyReview);
order.command('analyze-images <snapshot>')
  .description('Descarga fotos visibles de un snapshot y prepara evidencia visual por actividad; con --analyze usa el proveedor multimodal configurado.')
  .option('-o, --output <file>', 'JSON de evidencia y análisis. Por defecto se guarda en private/image-analysis/.')
  .option('--analyze', 'Analiza las fotos con OPENAI_API_KEY; sin esta opción solo descarga y organiza evidencia.')
  .option('--model <id>', 'Modelo multimodal. Por defecto usa SIYS_VISION_MODEL o gpt-5.4-mini.')
  .option('--guides-dir <dir>', 'Carpeta de guías Markdown por tipo de equipo.')
  .option('--download-concurrency <n>', 'Descargas simultáneas de fotos; por defecto 6.', parsePositiveInteger)
  .option('--analysis-concurrency <n>', 'Análisis simultáneos; por defecto 2.', parsePositiveInteger)
  .action(runOrderAnalyzeImages);
order.command('build-vision-review <snapshot> <manifest>')
  .description('Convierte hechos visuales de confianza alta en un borrador trazable; no escribe en SIYS.')
  .option('-o, --output <file>', 'JSON draft de revisión; por defecto en private/image-analysis/.')
  .action(runOrderBuildVisionReview);
order.command('review-images <snapshot>')
  .description('Descarga y analiza las fotos visibles con el proveedor multimodal configurado y genera un borrador visual; no escribe en SIYS.')
  .option('-o, --output <file>', 'JSON draft visual de salida. Por defecto se guarda en private/image-analysis/.')
  .option('--analysis-output <file>', 'JSON de evidencia visual y análisis. Por defecto se guarda en private/image-analysis/.')
  .option('--model <id>', 'Modelo multimodal. Por defecto usa SIYS_VISION_MODEL o gpt-5.4-mini.')
  .option('--guides-dir <dir>', 'Carpeta de guías Markdown por tipo de equipo.')
  .option('--download-concurrency <n>', 'Descargas simultáneas de fotos; por defecto 6.', parsePositiveInteger)
  .option('--analysis-concurrency <n>', 'Análisis simultáneos; por defecto 2.', parsePositiveInteger)
  .action(runOrderReviewImages);

const quote = program.command('quote').description('Consulta cotizaciones y su detalle en modo de solo lectura.');
quote.command('inspect <code>')
  .description('Exporta una cotizacion con articulos, desgloses, historial, calculos y datos saneados.')
  .option('--quote-id <id>', 'ID exacto de la cotizacion cuando el codigo devuelve varias coincidencias.')
  .option('-o, --output <file>', 'Archivo JSON de salida.')
  .option('--out-dir <dir>', 'Carpeta destino cuando no se usa --output.', 'exports')
  .option('--json', 'Imprime resumen JSON para integraciones.')
  .option('--no-auto-login', 'No intenta login HTTP si falta o falla la sesion.')
  .action(runQuoteInspect);

await program.parseAsync();
