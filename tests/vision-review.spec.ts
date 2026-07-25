import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { buildVisionReview } from '../src/vision-review.js';

test('creates a traceable proposal only for generic activities with high-confidence visual facts', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'siys-vision-review-'));
  const snapshot = path.join(directory, 'snapshot.json'); const manifest = path.join(directory, 'manifest.json'); const output = path.join(directory, 'draft.json');
  await fs.writeFile(snapshot, JSON.stringify({ code: '007403', maintenances: [{ maintenanceId: 'm1', detail: { tasks: [{ _id: 't1', activitys: [
    { _id: 'a1', name: 'Mantenimiento preventivo', reply: 'Mantenimiento preventivo' },
    { _id: 'a2', name: 'Diagnóstico', reply: 'Se identificó fuga en la tubería.' },
  ] }] } }] }));
  await fs.writeFile(manifest, JSON.stringify({ orderCode: '007403', analyses: [
    { activityId: 'a1', status: 'analyzed', result: { confidence: 'high', proposed_facts: ['Se observa la unidad interior con tapa retirada', 'Se observan filtros retirados'], proposed_description: 'Se registró la unidad interior con tapa y filtros retirados durante la intervención.' } },
    { activityId: 'a2', status: 'analyzed', result: { confidence: 'high', proposed_facts: ['Se observa la unidad exterior'] } },
  ], evidence: [{ activityId: 'a1', imageUrl: 'https://example.test/a.jpg', sha256: 'abc' }] }));
  await expect(buildVisionReview(snapshot, manifest, output)).resolves.toEqual({ orderCode: '007403', proposals: 1, manual: 1 });
  const draft = JSON.parse(await fs.readFile(output, 'utf8'));
  expect(draft.reviews[0].activities).toEqual([expect.objectContaining({ activityId: 'a1', proposed: expect.objectContaining({ reply: 'Se registró la unidad interior con tapa y filtros retirados durante la intervención.' }), evidence: ['https://example.test/a.jpg#sha256=abc'] })]);
  expect(draft.reviews[0].validations[0]).toContain('ya tiene descripción técnica');
  await fs.rm(directory, { recursive: true, force: true });
});

test('rejects a manifest from another order', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'siys-vision-review-'));
  const snapshot = path.join(directory, 'snapshot.json'); const manifest = path.join(directory, 'manifest.json');
  await fs.writeFile(snapshot, JSON.stringify({ code: '007403', maintenances: [] }));
  await fs.writeFile(manifest, JSON.stringify({ orderCode: '007404', analyses: [], evidence: [] }));
  await expect(buildVisionReview(snapshot, manifest, path.join(directory, 'out.json'))).rejects.toThrow(/no pertenecen/);
  await fs.rm(directory, { recursive: true, force: true });
});

test('uses replies[] only as context and keeps the editable reply as the original value', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'siys-vision-review-'));
  const snapshot = path.join(directory, 'snapshot.json'); const manifest = path.join(directory, 'manifest.json'); const output = path.join(directory, 'draft.json');
  await fs.writeFile(snapshot, JSON.stringify({ code: '000461', maintenances: [{ maintenanceId: 'm1', detail: { tasks: [{ _id: 't1', activitys: [{ _id: 'a1', name: 'Emergencia', replies: [{ reply: 'Llamado' }] }] }] } }] }));
  await fs.writeFile(manifest, JSON.stringify({ orderCode: '000461', analyses: [{ activityId: 'a1', status: 'analyzed', result: { confidence: 'high', proposed_facts: ['Se observa una unidad interior'] } }], evidence: [{ activityId: 'a1', imageUrl: 'https://example.test/a.jpg', sha256: 'abc' }] }));
  await expect(buildVisionReview(snapshot, manifest, output)).resolves.toEqual({ orderCode: '000461', proposals: 1, manual: 0 });
  const draft = JSON.parse(await fs.readFile(output, 'utf8'));
  expect(draft.reviews[0].activities[0].original.reply).toBeNull();
  await fs.rm(directory, { recursive: true, force: true });
});

test('marks an activity with an existing corrected reply for manual review', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'siys-vision-review-'));
  const snapshot = path.join(directory, 'snapshot.json'); const manifest = path.join(directory, 'manifest.json'); const output = path.join(directory, 'draft.json');
  await fs.writeFile(snapshot, JSON.stringify({ code: '000461', maintenances: [{ maintenanceId: 'm1', detail: { tasks: [{ _id: 't1', activitys: [{ _id: 'a1', name: 'Emergencia', replyCorrected: { reply: 'Texto ya corregido.' } }] }] } }] }));
  await fs.writeFile(manifest, JSON.stringify({ orderCode: '000461', analyses: [{ activityId: 'a1', status: 'analyzed', result: { confidence: 'high', proposed_facts: ['Se observa una unidad interior'] } }], evidence: [{ activityId: 'a1', imageUrl: 'https://example.test/a.jpg', sha256: 'abc' }] }));
  await expect(buildVisionReview(snapshot, manifest, output)).resolves.toEqual({ orderCode: '000461', proposals: 0, manual: 1 });
  const draft = JSON.parse(await fs.readFile(output, 'utf8'));
  expect(draft.reviews[0].validations[0]).toContain('ya tiene una corrección');
  await fs.rm(directory, { recursive: true, force: true });
});
