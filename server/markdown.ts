import matter from 'gray-matter';
import { emptyDraft, type Issue, type IssueDraft } from '../shared/model.js';
import { draftSchema, HttpError } from './schema.js';

export function readFrontmatter(markdown: string) {
  const normalized = markdown.replace(/^\uFEFF/, '');
  // gray-matter includes a JavaScript engine; never allow document-selected engines.
  if (normalized.startsWith('---')) {
    const language = normalized.split('\n', 1)[0].slice(3).trim();
    if (language && language !== 'yaml') throw new HttpError(400, 'Markdown 元数据仅支持 YAML，不支持可执行语言。');
  }
  try { return matter(normalized); }
  catch { throw new HttpError(400, 'Markdown 顶部的 YAML 格式不正确，请检查缩进、引号和冒号。'); }
}

const sections: [keyof IssueDraft, string][] = [
  ['description', '问题描述'], ['process', '业务流程与复现步骤'],
  ['expected', '预期结果'], ['actual', '实际结果'], ['rootCause', '根因分析'],
  ['frontendPlan', '前端修改方案'], ['backendPlan', '后端修改方案'],
  ['verification', '验证结果'], ['notes', '补充说明'],
];
const metaFields: Record<string, keyof IssueDraft> = {
  title: 'title', type: 'type', module: 'module', status: 'status', priority: 'priority', assignees: 'assignees',
  frontend_required: 'frontendRequired', frontend_status: 'frontendStatus',
  backend_required: 'backendRequired', backend_status: 'backendStatus', attachments: 'attachments',
};
const aliases: Record<string, keyof IssueDraft> = {
  问题描述: 'description', 问题现象: 'description', description: 'description',
  业务流程与复现步骤: 'process', 业务流程: 'process', 复现步骤: 'process',
  预期结果: 'expected', 实际结果: 'actual', 根因分析: 'rootCause', 根因: 'rootCause',
  前端修改方案: 'frontendPlan', 前端处理: 'frontendPlan',
  后端修改方案: 'backendPlan', 后端处理: 'backendPlan',
  验证结果: 'verification', 回归结果: 'verification', 补充说明: 'notes',
  附件: 'attachments',
};
const listKeys: Record<string, string> = {
  类型: 'type', 所属模块: 'module', 状态: 'status', 优先级: 'priority', 问题编号: 'id',
};

export function serializeIssue(issue: Issue): string {
  const data: Record<string, unknown> = { id: issue.id, format: 'issue-note/v1', title: issue.title, type: issue.type,
    module: issue.module, status: issue.status, priority: issue.priority, assignees: issue.assignees,
    frontend_required: issue.frontendRequired, frontend_status: issue.frontendStatus,
    backend_required: issue.backendRequired, backend_status: issue.backendStatus,
    version: issue.version, created_at: issue.createdAt, updated_at: issue.updatedAt,
    attachments: issue.attachments,
  };
  const body = [`# ${issue.title.replace(/[\r\n]+/g, ' ')}`, ...sections.map(([key, label]) => `<!-- issue-note:${key} -->\n## ${label}\n\n${issue[key] || ''}`)].join('\n\n');
  return matter.stringify(body + '\n', data);
}

export interface ParsedMarkdown {
  patch: Partial<IssueDraft>;
  draft: IssueDraft;
  id?: string;
  version?: number;
  warnings: string[];
}

export function parseMarkdown(markdown: string): ParsedMarkdown {
  const parsed = readFrontmatter(markdown);
  const patch: Record<string, unknown> = {};
  const warnings: string[] = [];
  const data = parsed.data;
  const canonical = data.format === 'issue-note/v1' && sections.every(([key]) => parsed.content.includes(`<!-- issue-note:${key} -->`));
  let skipSectionHeading = false;
  let id = typeof data.id === 'string' && /^ISSUE-\d{4,}$/.test(data.id) ? data.id : undefined;
  let version = Number.isInteger(data.version) && data.version > 0 ? data.version as number : undefined;
  if (data.id && !id) warnings.push('问题编号格式未识别，将创建新问题。');
  for (const [key, target] of Object.entries(metaFields)) {
    if (data[key] !== undefined) patch[target] = data[key];
  }
  let active: string | undefined;
  let chunk: string[] = [];
  const unknown: string[] = [];
  const flush = () => {
    if (!chunk.length) return;
    const value = chunk.join('\n').trim();
    if (value && active && active !== 'attachments') {
      patch[active] = patch[active] ? `${patch[active]}\n\n${value}` : value;
    } else if (value && active !== 'attachments') unknown.push(value);
    chunk = [];
  };
  let fenced = false;
  let fenceChar = '';
  let fenceLength = 0;
  for (const line of parsed.content.split('\n')) {
    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (!fenced) { fenced = true; fenceChar = fence[1][0]; fenceLength = fence[1].length; }
      else if (fence[1][0] === fenceChar && fence[1].length >= fenceLength) fenced = false;
      chunk.push(line); continue;
    }
    if (!fenced) {
      const boundary = canonical && line.match(/^<!-- issue-note:([a-zA-Z]+) -->\s*$/);
      if (boundary && sections.some(([key]) => key === boundary[1])) {
        flush(); active = boundary[1]; patch[active] = ''; skipSectionHeading = true; continue;
      }
      if (canonical && skipSectionHeading && /^##\s/.test(line)) { skipSectionHeading = false; continue; }
      if (line.trim()) skipSectionHeading = false;
      const title = line.match(/^#\s+(.+)$/);
      if (title && !active) { if (!patch.title) patch.title = title[1].trim(); continue; }
      const heading = line.match(/^##\s+(.+?)\s*#*$/);
      if (heading && !canonical) {
        const label = heading[1].trim();
        if (!aliases[label] && active && data.format === 'issue-note/v1') {
          chunk.push(line);
          continue;
        }
        flush();
        active = aliases[label];
        // Empty headings are intentional values during a Markdown round trip.
        if (active && active !== 'attachments' && patch[active] === undefined) patch[active] = '';
        if (!active) chunk.push(line);
        continue;
      }
      if (!active) {
        const entry = line.match(/^\s*-\s*(类型|所属模块|状态|优先级|问题编号)[：:]\s*(.*?)\s*$/);
        if (entry) {
          if (entry[1] === '问题编号') { if (/^ISSUE-\d{4,}$/.test(entry[2])) id = entry[2]; }
          else if (entry[2]) patch[listKeys[entry[1]]] = entry[2];
          continue;
        }
      }
      if (!canonical && (active === 'frontendPlan' || active === 'backendPlan')) {
        const side = active === 'frontendPlan' ? 'frontend' : 'backend';
        const entry = line.match(/^\s*-\s*(是否需要修改|进度|修改方案)[：:]\s*(.*?)\s*$/);
        if (entry) {
          if (entry[1] === '是否需要修改' && entry[2]) patch[side + 'Required'] = entry[2];
          else if (entry[1] === '进度' && entry[2]) patch[side + 'Status'] = entry[2];
          else if (entry[1] === '修改方案' && entry[2]) chunk.push(entry[2]);
          continue;
        }
      }
    }
    chunk.push(line);
  }
  flush();
  // Plain Markdown without the template is still a useful issue description.
  if (unknown.length) {
    const target = patch.description === undefined ? 'description' : 'notes';
    patch[target] = [patch[target], ...unknown].filter(Boolean).join('\n\n');
    warnings.push('未识别的正文已保留，请在预览中检查。');
  }
  if (!patch.title) {
    if (id) warnings.push('未提供标题；回填已有问题时保留原标题。');
    else {
      patch.title = parsed.content.split('\n').find(line => line.trim() && !line.startsWith('#'))?.replace(/^[-*]\s*/, '').slice(0, 100) || '未命名问题';
      warnings.push('未找到标题，已根据正文生成标题。');
    }
  }
  // Be tolerant of incomplete or nonstandard AI output, without losing the original values.
  for (const [key, value] of Object.entries(patch)) {
    const field = draftSchema.shape[key as keyof IssueDraft];
    if (!field || !field.safeParse(value).success) {
      delete patch[key];
      patch.notes = [patch.notes, `导入字段 ${key}：${JSON.stringify(value)}`].filter(Boolean).join('\n\n');
      warnings.push(`字段 ${key} 的格式未识别，原始值已保留在补充说明。`);
    }
  }
  return { patch: patch as Partial<IssueDraft>, draft: draftSchema.parse({ ...emptyDraft(), ...patch, title: patch.title || '未命名问题' }), id, version, warnings };
}

export const markdownTemplate = `---
title: 问题标题
type: 待确认
module: ''
status: 待处理
assignees:
  - 前端
  - 后端
frontend_required: 待判断
frontend_status: 未开始
backend_required: 待判断
backend_status: 未开始
---

# 问题标题

## 问题描述
请描述发现的问题。

## 业务流程与复现步骤
1. 

## 预期结果

## 实际结果

## 根因分析

## 前端修改方案

## 后端修改方案

## 验证结果

## 补充说明
`;
