import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { analyzeImages } from '../src/image-analysis.js';

const originalFetch = global.fetch;
const originalKey = process.env.OPENAI_API_KEY;

test.afterEach(() => {
  global.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey;
});

test('downloads visible evidence and sends direct SIYS image URLs with strict JSON output', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'siys-image-analysis-'));
  const snapshot = path.join(directory, 'snapshot.json'); const output = path.join(directory, 'manifest.json');
  await fs.writeFile(snapshot, JSON.stringify({ code: '007403', maintenances: [{ maintenanceId: 'm1', equipmentId: 'e1', detail: { equipment: { name: 'Mini Split', type: { name: 'MiniSplit' } }, tasks: [{ _id: 't1', activitys: [{ _id: 'a1', name: 'Mantenimiento preventivo', file: [{ path: 'orders/1', name: 'evidence.jpg' }] }] }] } }] }));
  process.env.OPENAI_API_KEY = 'test-key'; let requestBody: Record<string, unknown> | undefined;
  global.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('digitaloceanspaces.com')) return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    if (url === 'https://api.openai.com/v1/responses') {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ output_text: JSON.stringify({ visible_components: ['filtro'], visible_actions: ['filtro retirado'], visible_conditions: [], unverified_claims: [], confidence: 'high', proposed_facts: ['Se observa filtro retirado'], proposed_description: 'Se registró el filtro retirado durante la intervención.' }) }), { status: 200 });
    }
    throw new Error(`URL inesperada: ${url}`);
  };
  const result = await analyzeImages(snapshot, output, { analyze: true, guidesDir: path.join(directory, 'no-guides') });
  expect(result.evidence).toHaveLength(1);
  expect(result.analyses).toEqual([expect.objectContaining({ status: 'analyzed' })]);
  const body = requestBody!; const content = ((body.input as Array<{ content: Array<Record<string, unknown>> }>)[0].content);
  expect(content.find((item) => item.type === 'input_image')?.image_url).toBe('https://siys.sfo3.cdn.digitaloceanspaces.com/orders/1/evidence.jpg');
  expect(String(content.find((item) => item.type === 'input_image')?.image_url)).not.toContain('base64');
  expect(((body.text as { format: { type: string } }).format.type)).toBe('json_schema');
  await fs.rm(directory, { recursive: true, force: true });
});
