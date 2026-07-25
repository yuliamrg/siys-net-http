import fs from 'node:fs/promises';
import path from 'node:path';

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => v && typeof v === 'object' && !Array.isArray(v) ? v as Rec : {};
const rows = (v: unknown): Rec[] => Array.isArray(v) ? v.map(rec) : v ? [rec(v)] : [];
const str = (v: unknown): string => typeof v === 'string' ? v.trim() : '';
const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map(x => x.trim()) : [];
const latestHistoryReply = (activity: Rec): string => {
  const replies = rows(activity.replies);
  return str(replies.at(-1)?.reply);
};

/** Builds a non-writing review draft from high-confidence, visible image facts. */
export async function buildVisionReview(snapshotPath: string, manifestPath: string, outputPath: string): Promise<{ orderCode: string; proposals: number; manual: number }> {
  const snapshot = rec(JSON.parse(await fs.readFile(snapshotPath, 'utf8')));
  const manifest = rec(JSON.parse(await fs.readFile(manifestPath, 'utf8')));
  const orderCode = str(snapshot.code);
  if (!orderCode || str(manifest.orderCode) !== orderCode) throw new Error('El snapshot y el manifiesto visual no pertenecen a la misma orden.');
  const visual = new Map<string, { facts: string[]; description: string; confidence: string; evidence: string[] }>();
  for (const item of rows(manifest.analyses)) {
    const result = rec(item.result); const activityId = str(item.activityId); const facts = strings(result.proposed_facts);
    if (str(item.status) === 'analyzed' && activityId && facts.length) visual.set(activityId, { facts, description: str(result.proposed_description), confidence: str(result.confidence) || 'low', evidence: [] });
  }
  for (const item of rows(manifest.evidence)) visual.get(str(item.activityId))?.evidence.push(`${str(item.imageUrl)}#sha256=${str(item.sha256)}`);
  let proposals = 0; let manual = 0; const reviews: unknown[] = [];
  for (const maintenance of rows(snapshot.maintenances)) {
    const detail = rec(maintenance.detail); const equipment = rec(detail.equipment); const activities: unknown[] = []; const validations: string[] = [];
    for (const task of rows(detail.tasks)) for (const activity of rows(task.activitys)) {
      const activityId = str(activity._id); const found = visual.get(activityId); if (!found) continue;
      const editableReply = str(activity.reply);
      const correctedReply = str(rec(activity.replyCorrected).reply);
      const historyReply = latestHistoryReply(activity);
      if (correctedReply) { manual++; validations.push(`Actividad ${activityId}: ya tiene una corrección de descripción en SI&S; requiere revisión humana.`); continue; }
      const generic = !editableReply || /^(llamado|emergencia|atendido|realizado|mantenimiento|preventivo|actividad|revision)(\s+(preventivo|realizado|general))*\.?$/i.test(editableReply);
      if (found.confidence !== 'high' || !generic) { manual++; validations.push(`Actividad ${activityId}: ${found.confidence !== 'high' ? `confianza visual ${found.confidence}` : 'ya tiene descripción técnica'}; requiere revisión humana.`); continue; }
      const proposedReply = found.description || `Evidencia fotográfica de la actividad: ${found.facts.join('; ')}.`;
      activities.push({ action: 'edit', taskId: str(task._id), activityId, original: { name: str(activity.name), reply: editableReply || null }, proposed: { name: str(activity.name), reply: proposedReply }, reason: `${historyReply ? 'El historial de respuestas aporta contexto, pero el valor original se toma del campo editable. ' : ''}Descripción vacía o genérica enriquecida solo con hechos visuales de confianza alta.`, evidence: found.evidence, confidence: 'high', manualReview: false }); proposals++;
    }
    if (activities.length || validations.length) reviews.push({ maintenanceId: str(maintenance.maintenanceId), equipmentId: str(maintenance.equipmentId) || str(equipment._id), equipmentName: str(equipment.name), original: { observations: detail.observations ?? null, equipmentState: detail.equipmentState ?? null }, proposed: {}, activities, manualReview: validations.length > 0, validations });
  }
  const order = rec(snapshot.order);
  const draft = { schemaVersion: '1.0', status: 'draft', generatedAt: new Date().toISOString(), order: { id: str(order._id) || str(rec(snapshot.source).orderId), code: orderCode, serviceType: str(rec(order.type).name), sourceSnapshot: path.resolve(snapshotPath) }, source: { visionManifest: path.resolve(manifestPath) }, reviews, summary: { proposals, manual, policy: 'Solo descripciones vacías o genéricas y hechos visibles de confianza alta; nunca escribe SIYS.' } };
  await fs.mkdir(path.dirname(outputPath), { recursive: true }); await fs.writeFile(outputPath, `${JSON.stringify(draft, null, 2)}\n`);
  return { orderCode, proposals, manual };
}
