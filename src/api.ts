import type { ImportPreview, Issue, IssueDraft, Revision } from '../shared/model';
import type { VisualizationDocument, VisualizationState } from '../shared/visualization';

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const token = sessionStorage.getItem('issue-note-key');
  const response = await fetch(url, {
    ...options,
    headers: { ...(!(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      'X-Client-Source': 'web', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers },
  });
  if (!response.ok) {
    let message = `请求失败（${response.status}）`;
    try { message = (await response.json()).error || message; } catch { /* Keep HTTP status. */ }
    if (response.status === 401) window.dispatchEvent(new Event('issue-note-auth'));
    throw new ApiError(response.status, message);
  }
  if (response.headers.get('content-type')?.includes('text/markdown')) return await response.text() as T;
  return response.json();
}
export const api = {
  list: () => request<{ issues: Issue[] }>('/api/issues'),
  get: (id: string) => request<Issue>(`/api/issues/${id}`),
  create: (draft: IssueDraft) => request<Issue>('/api/issues', { method: 'POST', body: JSON.stringify(draft) }),
  update: (id: string, draft: IssueDraft, version: number) => request<Issue>(`/api/issues/${id}`, { method: 'PATCH', body: JSON.stringify({ ...draft, version }) }),
  markdown: (id: string) => request<string>(`/api/issues/${id}/markdown`),
  template: () => request<string>('/api/template'),
  preview: (markdown: string) => request<ImportPreview>('/api/issues/import', { method: 'POST', body: JSON.stringify({ markdown, preview: true }) }),
  import: (markdown: string, expectedVersion?: number) => request<Issue>('/api/issues/import', { method: 'POST', body: JSON.stringify({ markdown, expectedVersion }) }),
  history: (id: string) => request<{ revisions: Revision[] }>(`/api/issues/${id}/history`),
  revision: (id: string, hash: string) => request<{ issue: Issue; markdown: string; diff: { value: string; added?: boolean; removed?: boolean }[] }>(`/api/issues/${id}/history/${hash}`),
  restore: (id: string, hash: string, version: number) => request<Issue>(`/api/issues/${id}/restore`, { method: 'POST', body: JSON.stringify({ hash, version }) }),
  upload: (file: File) => { const body = new FormData(); body.append('file', file); return request<import('../shared/model').Attachment>('/api/attachments', { method: 'POST', body }); },
  visualization: (id: string, signal?: AbortSignal) => request<VisualizationState>(`/api/issues/${id}/visualization`, { signal }),
  generateVisualization: (id: string, force: boolean, signal?: AbortSignal) => request<VisualizationDocument>(`/api/issues/${id}/visualization`, { method: 'POST', body: JSON.stringify({ force }), signal }),
};

export async function copyText(text: string) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  const input = document.createElement('textarea');
  input.value = text; input.style.position = 'fixed'; input.style.opacity = '0';
  document.body.append(input); input.select();
  const success = document.execCommand('copy'); input.remove();
  if (!success) throw new Error('浏览器未允许复制，请使用下载 Markdown。');
}
export function downloadMarkdown(text: string, filename: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
export function asDraft(issue: Issue): IssueDraft {
  const { id: _id, version: _v, createdAt: _c, updatedAt: _u, ...draft } = issue;
  return draft;
}
export const dateTime = (value: string) => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
