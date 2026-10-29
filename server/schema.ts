import { z } from 'zod';
import { issueTypes, issueStatuses, requirements, progressStates, priorities, assigneeOptions, emptyDraft } from '../shared/model.js';

const text = z.string().max(100_000);
export const attachmentSchema = z.object({
  id: z.string().regex(/^[a-f0-9-]{36}$/),
  name: z.string().min(1).max(255),
  url: z.string().regex(/^\/attachments\/[a-f0-9-]{36}\.[a-z0-9]+$/),
  mime: z.string().max(100),
  size: z.number().int().nonnegative().max(10 * 1024 * 1024),
});
export const draftSchema = z.object({
  title: z.string().trim().min(1, '请填写问题标题').max(200),
  type: z.enum(issueTypes), module: z.string().trim().max(100),
  status: z.enum(issueStatuses), priority: z.enum(priorities),
  assignees: z.array(z.enum(assigneeOptions)).min(1, '请至少选择一位负责人').max(2)
    .refine(values => new Set(values).size === values.length, '负责人不能重复'),
  description: text, process: text, expected: text, actual: text, rootCause: text,
  frontendRequired: z.enum(requirements), frontendStatus: z.enum(progressStates), frontendPlan: text,
  backendRequired: z.enum(requirements), backendStatus: z.enum(progressStates), backendPlan: text,
  verification: text, notes: text,
  attachments: z.array(attachmentSchema).max(30),
}).strict();
export const createSchema = draftSchema.partial().extend({ title: draftSchema.shape.title });
export const patchSchema = draftSchema.partial().extend({ version: z.number().int().positive() }).strict();
export const importSchema = z.object({
  markdown: z.string().min(1).max(1_000_000),
  preview: z.boolean().optional(),
  expectedVersion: z.number().int().positive().optional(),
}).strict();
export function validateDraft(value: unknown) {
  return draftSchema.parse({ ...emptyDraft(), ...(value as object) });
}
export class HttpError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}
