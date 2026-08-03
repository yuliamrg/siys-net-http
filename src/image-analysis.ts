import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { IMAGE_TIMEOUT_MS, OPENAI_TIMEOUT_MS } from './config.js';
import { requestHttp, parseJsonResponse } from './http.js';

type RecordValue = Record<string, unknown>;

export interface ImageEvidence {
  maintenanceId: string;
  equipmentId?: string;
  equipmentName: string;
  equipmentType: string;
  taskId: string;
  activityId: string;
  activityName: string;
  imageUrl: string;
  localFile: string;
  sha256: string;
}

export interface ImageAnalysisReport {
  schemaVersion: '1.0';
  orderCode: string;
  generatedAt: string;
  sourceSnapshot: string;
  evidence: ImageEvidence[];
  analyses: Array<{ activityId: string; status: 'pending' | 'analyzed' | 'failed'; result?: unknown; error?: string }>;
}

async function mapPool<T, R>(values: T[], limit: number, worker: (value: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(values.length); let cursor = 0;
  const count = Math.min(Math.max(1, limit), values.length);
  await Promise.all(Array.from({ length: count }, async () => {
    while (true) { const index = cursor++; if (index >= values.length) return; output[index] = await worker(values[index]); }
  }));
  return output;
}

function record(value: unknown): RecordValue { return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {}; }
function text(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
function entries(value: unknown): RecordValue[] { return Array.isArray(value) ? value.map(record) : value ? [record(value)] : []; }
function safeName(value: string): string { return value.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120); }

function fileUrl(file: RecordValue): string | undefined {
  const pathPart = text(file.path).replace(/^\/+|\/+$/g, '');
  const name = text(file.name).replace(/^\/+/, '');
  return pathPart && name ? `https://siys.sfo3.cdn.digitaloceanspaces.com/${pathPart}/${name}` : undefined;
}

function guideName(type: string, equipmentName: string): string {
  const source = `${type} ${equipmentName}`.toLowerCase();
  if (/chiller/.test(source)) return 'chiller.md';
  if (/fan.?coil|manejadora/.test(source)) return 'fancoil.md';
  return 'minisplit.md';
}

async function download(url: string, target: string): Promise<{ sha256: string }> {
  const response = await requestHttp(url, { method: 'GET', timeoutMs: IMAGE_TIMEOUT_MS, operation: 'descarga de evidencia visual', responseType: 'binary' });
  const body = Buffer.from(response.bytes ?? []);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, body);
  return { sha256: crypto.createHash('sha256').update(body).digest('hex') };
}

function responseText(value: unknown): string {
  const root = record(value);
  if (typeof root.output_text === 'string') return root.output_text;
  for (const item of entries(root.output)) for (const content of entries(item.content)) {
    if (typeof content.text === 'string') return content.text;
  }
  return '';
}

function parseAnalysis(value: string): unknown {
  try { return JSON.parse(value); } catch { /* continue with a fenced JSON response */ }
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? value.match(/(\{[\s\S]*\})/)?.[1];
  if (!fenced) return { raw: value };
  try { return JSON.parse(fenced); } catch { return { raw: value }; }
}

async function analyzeWithOpenAI(evidence: ImageEvidence[], guide: string, model: string): Promise<unknown> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('Falta OPENAI_API_KEY. Ejecuta sin --analyze para solo descargar y preparar la evidencia.');
  const first = evidence[0];
  const content: unknown[] = [{ type: 'input_text', text: [
    'Analiza evidencia fotográfica HVAC de una sola actividad. Devuelve JSON estricto con:',
    'visible_components (string[]), visible_actions (string[]), visible_conditions (string[]),',
    'unverified_claims (string[]), confidence (high|medium|low), proposed_facts (string[]), proposed_description (string).',
    'Solo declara componentes, acciones o condiciones directamente visibles. No inventes mediciones, refrigerante, pruebas, limpieza o cambios de repuesto.',
    'proposed_description debe ser una frase profesional para el cliente, en pasado, que verbalice solo los hechos visibles; si no hay suficiente evidencia, devuelve cadena vacía.',
    `Equipo: ${first.equipmentName}. Tipo: ${first.equipmentType || 'no informado'}. Actividad actual: ${first.activityName}.`,
    'Guía de redacción aplicable:', guide || '(sin guía específica)',
  ].join('\n') }];
  // The CDN links were already fetched and hashed locally. Passing their URLs avoids
  // re-uploading large base64 payloads while retaining immutable local evidence.
  for (const image of evidence) content.push({ type: 'input_image', image_url: image.imageUrl, detail: 'high' });
  const response = await requestHttp('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, store: false, text: { format: { type: 'json_schema', name: 'hvac_visual_evidence', strict: true, schema: {
      type: 'object', additionalProperties: false, required: ['visible_components', 'visible_actions', 'visible_conditions', 'unverified_claims', 'confidence', 'proposed_facts', 'proposed_description'],
      properties: {
        visible_components: { type: 'array', items: { type: 'string' } }, visible_actions: { type: 'array', items: { type: 'string' } }, visible_conditions: { type: 'array', items: { type: 'string' } }, unverified_claims: { type: 'array', items: { type: 'string' } },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] }, proposed_facts: { type: 'array', items: { type: 'string' } }, proposed_description: { type: 'string' },
      },
    } } }, input: [{ role: 'user', content }] }),
    timeoutMs: OPENAI_TIMEOUT_MS,
    operation: 'análisis visual OpenAI',
  });
  const result = parseJsonResponse<unknown>(response, 'análisis visual OpenAI');
  const output = responseText(result);
  return parseAnalysis(output);
}

export async function analyzeImages(snapshotPath: string, outputPath: string, options: { analyze?: boolean; model?: string; guidesDir?: string; downloadConcurrency?: number; analysisConcurrency?: number }): Promise<ImageAnalysisReport> {
  const snapshot = record(JSON.parse(await fs.readFile(snapshotPath, 'utf8')));
  const orderCode = text(snapshot.code);
  if (!orderCode) throw new Error('El snapshot no tiene código de orden.');
  const root = path.dirname(outputPath);
  const cacheDir = path.join(root, 'images');
  const planned: Array<Omit<ImageEvidence, 'sha256'>> = [];
  for (const maintenance of entries(snapshot.maintenances)) {
    const detail = record(maintenance.detail); const equipment = record(detail.equipment);
    const equipmentName = text(equipment.name) || 'Equipo sin nombre';
    const equipmentType = text(record(equipment.type).name);
    for (const task of entries(detail.tasks)) for (const activity of entries(task.activitys)) {
      const activityId = text(activity._id); const taskId = text(task._id); const maintenanceId = text(maintenance.maintenanceId);
      for (const [index, file] of entries(activity.file).entries()) {
        const url = fileUrl(file); if (!url || !activityId || !taskId || !maintenanceId) continue;
        const ext = path.extname(new URL(url).pathname) || '.jpg';
        const localFile = path.join(cacheDir, safeName(`${activityId}-${index}${ext}`));
        planned.push({ maintenanceId, equipmentId: text(maintenance.equipmentId) || undefined, equipmentName, equipmentType, taskId, activityId, activityName: text(activity.name), imageUrl: url, localFile });
      }
    }
  }
  if (options.analyze && planned.length > 0 && !process.env.OPENAI_API_KEY) {
    throw new Error('Falta OPENAI_API_KEY. Configure la clave antes de solicitar análisis visual; no se generó una revisión textual sin fotos.');
  }
  const evidence = await mapPool(planned, options.downloadConcurrency ?? 6, async (item) => ({ ...item, ...(await download(item.imageUrl, item.localFile)) }));
  const report: ImageAnalysisReport = { schemaVersion: '1.0', orderCode, generatedAt: new Date().toISOString(), sourceSnapshot: snapshotPath, evidence, analyses: [] };
  const byActivity = new Map<string, ImageEvidence[]>();
  for (const item of evidence) byActivity.set(item.activityId, [...(byActivity.get(item.activityId) ?? []), item]);
  const activities = [...byActivity.entries()];
  report.analyses = await mapPool(activities, options.analyze ? options.analysisConcurrency ?? 2 : 1, async ([activityId, images]) => {
    if (!options.analyze) return { activityId, status: 'pending' as const };
    try {
      const guidePath = path.join(options.guidesDir ?? path.join(process.cwd(), 'guides', 'hvac-ejemplos'), guideName(images[0].equipmentType, images[0].equipmentName));
      const guide = await fs.readFile(guidePath, 'utf8').catch(() => '');
      const distinct = [...new Map(images.map((image) => [image.sha256, image])).values()].slice(0, 8);
      return { activityId, status: 'analyzed' as const, result: await analyzeWithOpenAI(distinct, guide, options.model ?? process.env.SIYS_VISION_MODEL ?? 'gpt-5.4-mini') };
    } catch (error) { return { activityId, status: 'failed' as const, error: error instanceof Error ? error.message : String(error) }; }
  });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}
