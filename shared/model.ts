export const issueTypes = ['缺陷', '需求变更', '待确认'] as const;
export const issueStatuses = ['待处理', '处理中', '待验证', '已关闭'] as const;
export const requirements = ['待判断', '需要', '不需要'] as const;
export const progressStates = ['未开始', '处理中', '已完成'] as const;
export const priorities = ['普通', '紧急', '较低'] as const;
export const assigneeOptions = ['前端', '后端'] as const;

export interface Attachment {
  id: string;
  name: string;
  url: string;
  mime: string;
  size: number;
}

export interface IssueDraft {
  title: string;
  type: typeof issueTypes[number];
  module: string;
  status: typeof issueStatuses[number];
  priority: typeof priorities[number];
  assignees: typeof assigneeOptions[number][];
  description: string;
  process: string;
  expected: string;
  actual: string;
  rootCause: string;
  frontendRequired: typeof requirements[number];
  frontendStatus: typeof progressStates[number];
  frontendPlan: string;
  backendRequired: typeof requirements[number];
  backendStatus: typeof progressStates[number];
  backendPlan: string;
  verification: string;
  notes: string;
  attachments: Attachment[];
}

export interface Issue extends IssueDraft {
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface Revision {
  hash: string;
  date: string;
  summary: string;
  source: string;
}

export interface ImportPreview {
  issue: IssueDraft;
  id?: string;
  existing?: Issue;
  expectedVersion?: number;
  mode: 'create' | 'update';
  warnings: string[];
}

export const emptyDraft = (): IssueDraft => ({
  title: '', type: '待确认', module: '', status: '待处理', priority: '普通',
  assignees: ['前端', '后端'],
  description: '', process: '', expected: '', actual: '', rootCause: '',
  frontendRequired: '待判断', frontendStatus: '未开始', frontendPlan: '',
  backendRequired: '待判断', backendStatus: '未开始', backendPlan: '',
  verification: '', notes: '', attachments: [],
});
