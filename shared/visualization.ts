import { z } from 'zod';

const text = z.string().max(600);
export const graphSchema = z.object({
  nodes: z.array(z.object({
    id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/),
    label: z.string().min(1).max(100),
    detail: text,
    kind: z.enum(['step', 'decision', 'problem', 'impact', 'expected', 'cause', 'frontend', 'backend']),
  }).strict()).max(18),
  edges: z.array(z.object({ from: z.string(), to: z.string(), label: z.string().max(80) }).strict()).max(36),
}).strict().superRefine((graph, ctx) => {
  const ids = new Set(graph.nodes.map(node => node.id));
  if (ids.size !== graph.nodes.length) ctx.addIssue({ code: 'custom', message: '图表节点编号重复' });
  if (graph.edges.some(edge => !ids.has(edge.from) || !ids.has(edge.to))) ctx.addIssue({ code: 'custom', message: '图表连线引用了不存在的节点' });
});
export const visualizationDataSchema = z.object({
  process: graphSchema,
  comparison: z.array(z.object({ aspect: z.string().min(1).max(100), expected: text, actual: text }).strict()).max(12),
  causality: graphSchema,
  verification: z.array(z.object({
    scenario: z.string().min(1).max(200), expected: text, result: text,
    status: z.enum(['passed', 'failed', 'pending', 'unknown']), scope: z.string().max(120),
  }).strict()).max(24),
}).strict();
export type VisualizationGraph = z.infer<typeof graphSchema>;
export type VisualizationData = z.infer<typeof visualizationDataSchema>;
export const visualizationDocumentSchema = z.object({
  formatVersion: z.literal(1), issueId: z.string().regex(/^ISSUE-\d{4,}$/),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/), sourceVersion: z.number().int().positive(),
  generatedAt: z.string().datetime(), model: z.string().min(1), data: visualizationDataSchema,
}).strict();
export type VisualizationDocument = z.infer<typeof visualizationDocumentSchema>;
export interface VisualizationState {
  document: VisualizationDocument | null;
  sourceCommit: string;
  stale: boolean;
  configured: boolean;
  configurationMessage?: string;
  generating: boolean;
}
