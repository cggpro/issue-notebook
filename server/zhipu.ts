import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Issue } from '../shared/model.js';
import { visualizationDataSchema } from '../shared/visualization.js';
import { VisualizationError, type VisualizationGenerator } from './visualization.js';

const DEFAULT_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';
const PI_CODING_CN_BASE_URL = 'https://open.bigmodel.cn/api/coding/paas/v4';
const DEFAULT_MODEL = 'glm-5.3-flash';
const PI_CODING_CN_MODEL = 'glm-5.3-flash';
const REQUEST_TIMEOUT_MS = 90_000;
// Preserve the existing Zhipu API for callers using the legacy configuration.
export const createZhipuGenerator = createChatGenerator;
const MAX_OUTPUT_TOKENS = 8000;
const PROVIDER_ID = 'zai-coding-cn';

export interface ZhipuConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  reasoningEffort?: 'low' | 'medium' | 'high';
}

export interface ZhipuConfigResult {
  config: ZhipuConfig | null;
  message?: string;
}

type ResolvedValue = { value: string } | { missing: string } | { command: true };

/**
 * Resolve Pi-style `$VAR` / `${VAR}` references without running commands.
 * `$$` and `$!` keep their literal meaning.
 */
function resolveEnvReference(raw: string, env: Record<string, string | undefined>): ResolvedValue {
  const trimmed = raw.trim();
  if (trimmed.startsWith('!')) return { command: true };
  let missing = '';
  const value = trimmed.replace(/\$\$|\$!|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (match, braced: string | undefined, plain: string | undefined) => {
      if (match === '$$') return '$';
      if (match === '$!') return '!';
      const name = braced || plain || '';
      const found = env[name];
      if (found === undefined) { missing = name; return ''; }
      return found;
    });
  if (missing) return { missing };
  return { value };
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function enabledMessage(resolved: ResolvedValue, label: string): string {
  if ('command' in resolved) {
    return `${label} 使用了命令型配置。为避免执行外部命令，服务不会运行它；请把 API Key 直接写入环境变量后重启。`;
  }
  if ('missing' in resolved) {
    return `${label} 引用的环境变量 ${resolved.missing} 未设置，请设置后重启服务。`;
  }
  return `请设置 ${label} 后重启服务。`;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

async function readPiFile(agentDir: string, filename: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(agentDir, filename), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* Missing or malformed Pi configuration is handled as unconfigured. */ }
  return null;
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * Load the Zhipu connection.
 *
 * Priority:
 * 1. Explicit ZHIPU_API_KEY / ZHIPU_BASE_URL / ZHIPU_MODEL.
 * 2. Pi's `zai-coding-cn` provider metadata (models.json) and stored api_key (auth.json).
 *
 * Only those two Pi files are read. Command credentials are never executed and no
 * credential is ever included in the returned message.
 */
export async function loadZhipuConfig(
  env: Record<string, string | undefined> = process.env,
  agentDir?: string,
): Promise<ZhipuConfigResult> {
  const explicitKey = nonEmpty(env.ZHIPU_API_KEY);
  const explicitBase = nonEmpty(env.ZHIPU_BASE_URL);
  const rawModel = nonEmpty(env.ZHIPU_MODEL);
  const envBase = explicitBase
    ? resolveEnvReference(explicitBase, env)
    : { value: DEFAULT_BASE_URL };
  if ('command' in envBase || 'missing' in envBase) {
    return { config: null, message: enabledMessage(envBase, 'ZHIPU_BASE_URL') };
  }
  const explicitModel = rawModel ? resolveEnvReference(rawModel, env) : undefined;
  if (explicitModel && ('command' in explicitModel || 'missing' in explicitModel)) {
    return { config: null, message: enabledMessage(explicitModel, 'ZHIPU_MODEL') };
  }
  const model = explicitModel && 'value' in explicitModel ? explicitModel.value : undefined;

  if (explicitKey) {
    const key = resolveEnvReference(explicitKey, env);
    if ('command' in key || 'missing' in key || !key.value) {
      return { config: null, message: enabledMessage(key, 'ZHIPU_API_KEY') };
    }
    return {
      config: {
        apiKey: key.value,
        baseUrl: normalizeBaseUrl(envBase.value),
        model: model || DEFAULT_MODEL,
      },
    };
  }

  const directory = agentDir || nonEmpty(env.PI_CODING_AGENT_DIR) || path.join(os.homedir(), '.pi', 'agent');
  const models = await readPiFile(directory, 'models.json');
  const auth = await readPiFile(directory, 'auth.json');
  const providers = objectOf(models?.providers);
  const provider = objectOf(providers?.[PROVIDER_ID]);
  const providerModels = Array.isArray(provider?.models) ? provider.models.map(objectOf).filter(Boolean) : [];
  const credential = objectOf(auth?.[PROVIDER_ID]);

  let piBase: string | undefined;
  for (const candidate of [provider?.baseUrl, ...providerModels.map(model => model?.baseUrl)]) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    const resolved = resolveEnvReference(candidate, env);
    if ('value' in resolved && resolved.value) { piBase = resolved.value; break; }
  }

  // Pi stores api-key credentials under `key` (type api_key); never read other secrets.
  let key: ResolvedValue | undefined;
  const storedKey = credential?.type === 'api_key' ? credential.key : undefined;
  for (const candidate of [storedKey, provider?.apiKey]) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    key = resolveEnvReference(candidate, env);
    break;
  }

  const firstModel = providerModels.find(model => typeof model?.id === 'string' && model.id.trim())?.id;
  const result: ZhipuConfigResult = {
    config: null,
    message: '未配置 Zhipu 可视化生成服务。请设置 ZHIPU_API_KEY 环境变量，或在 Pi 中登录 zai-coding-cn 后重启服务。',
  };
  if (!key) return result;
  if ('command' in key) {
    return { config: null, message: 'Pi 中保存的 zai-coding-cn 凭据是命令型配置，服务不会执行外部命令；请设置 ZHIPU_API_KEY 环境变量后重启。' };
  }
  if ('missing' in key) {
    return { config: null, message: `Pi 凭据引用的环境变量 ${key.missing} 未设置，请设置后重启服务。` };
  }
  if (!key.value) return result;

  const baseUrl = normalizeBaseUrl(explicitBase ? envBase.value : (piBase || PI_CODING_CN_BASE_URL));
  const piModel = typeof firstModel === 'string' ? firstModel : undefined;
  return {
    config: {
      apiKey: key.value,
      baseUrl,
      model: model || piModel || (baseUrl.includes('/coding/') ? PI_CODING_CN_MODEL : DEFAULT_MODEL),
    },
  };
}

function buildSystemPrompt(): string {
  return `你是「问题簿」的可视化分析助手。你的唯一任务是把用户提供的问题记录整理成一个可直接渲染的 JSON 对象。

## 事实边界（必须严格遵守）
1. 只能使用用户消息中明确提供的内容。不得引入外部知识，不得猜测代码、接口、日志、测试或环境细节。
2. 不得虚构根因、修复方案、验证过程、测试结果或上线状态。
3. 不得根据问题状态、负责人、优先级推断验证结论；验证结论只能来自「验证结果」原文。
4. 原文没有出现的“已上线、已部署、本地验证通过、线上验证通过、已修复”等结论一律不得生成；节点 label 也不得暗示这些结论。
5. 用户消息不包含附件内容，禁止假设你查看过截图、日志或视频。
6. 字段为空或未提供时，对应内容必须留空或输出空数组。不要使用“暂无”“待补充”“未知”等占位文字，也不要把空内容包装成结论。
7. 所有文本使用简洁、客观的中文纯文本，禁止输出 HTML 标签或 Markdown 标记。
8. 前端状态、后端状态等进度字段不能当作验证结果或修复证据。

## 四个区块的生成规则
- process：优先依据「业务流程与复现步骤」整理流程节点。该字段为空时，只能从「问题描述 / 实际结果 / 预期结果」中明确写出的步骤提炼，不得补写未出现的步骤；完全没有流程信息时输出空图 {"nodes":[],"edges":[]}。
- comparison：只对比原文明确给出的“预期结果”和“实际结果”。没有可对比内容时输出 []；某一侧缺失时该侧留空字符串，不要编造。
- causality：只有原文存在「根因分析」，或「前端修改方案 / 后端修改方案」中有实际文字时才生成。cause 节点只能来自根因原文；frontend/backend 节点只能来自对应方案原文。根因和方案都为空时输出空图 {"nodes":[],"edges":[]}。不得推测未写出的原因或修复。
- verification：只依据「验证结果」原文。没有任何验证信息时输出 []。result 必须是验证原文中的实际结果；status 只有在原文明确表示通过、失败或待验证时才分别使用 passed / failed / pending，含义不明确时使用 unknown，绝不能参考问题状态字段。scope 只填写原文明确的范围，否则为空字符串。

## 输出结构与限制
只输出一个 JSON 对象，字段必须与下面完全一致，不得增加、删除或改名：

{
  "process": { "nodes": GraphNode[], "edges": GraphEdge[] },
  "comparison": { "aspect": string, "expected": string, "actual": string }[],
  "causality": { "nodes": GraphNode[], "edges": GraphEdge[] },
  "verification": {
    "scenario": string,
    "expected": string,
    "result": string,
    "status": "passed" | "failed" | "pending" | "unknown",
    "scope": string
  }[]
}

GraphNode = {
  "id": string,      // 字母开头，只含字母、数字、下划线，1-40 字符，图内唯一
  "label": string,   // 1-100 字符
  "detail": string,  // 0-600 字符
  "kind": "step" | "decision" | "problem" | "impact" | "expected" | "cause" | "frontend" | "backend"
}
GraphEdge = { "from": string, "to": string, "label": string } // from/to 必须是本图已有 id；label 0-80 字符

数量上限：process.nodes ≤ 18，process.edges ≤ 36；causality.nodes ≤ 18，causality.edges ≤ 36；comparison ≤ 12；verification ≤ 24。
字符串上限：label ≤ 100，detail ≤ 600，aspect ≤ 100，scenario ≤ 200，scope ≤ 120。
同一图内节点 id 不能重复，连线两端必须存在。

## 示例（只示范格式，示例内容与实际问题无关）
{
  "process": {
    "nodes": [
      { "id": "step1", "label": "发起操作", "detail": "原文记录的入口操作", "kind": "step" },
      { "id": "check1", "label": "系统校验", "detail": "原文记录的校验行为", "kind": "decision" },
      { "id": "problem1", "label": "出现异常", "detail": "原文记录的实际结果", "kind": "problem" }
    ],
    "edges": [
      { "from": "step1", "to": "check1", "label": "进入校验" },
      { "from": "check1", "to": "problem1", "label": "校验未通过" }
    ]
  },
  "comparison": [
    { "aspect": "操作结果", "expected": "原文的预期", "actual": "原文的实际" }
  ],
  "causality": {
    "nodes": [
      { "id": "cause1", "label": "原文根因", "detail": "根因原文摘要", "kind": "cause" },
      { "id": "backend1", "label": "后端方案", "detail": "后端方案原文摘要", "kind": "backend" }
    ],
    "edges": [
      { "from": "cause1", "to": "backend1", "label": "对应修改" }
    ]
  },
  "verification": [
    { "scenario": "原文验证场景", "expected": "原文预期", "result": "原文实际结果", "status": "unknown", "scope": "" }
  ]
}

输出要求：直接输出 JSON 本身，不要使用代码围栏，不要添加解释、前后缀或注释。`;
}

function buildUserPrompt(issue: Issue): string {
  const source = {
    标题: issue.title,
    类型: issue.type,
    所属模块: issue.module,
    优先级: issue.priority,
    负责方: issue.assignees,
    问题描述: issue.description,
    业务流程与复现步骤: issue.process,
    预期结果: issue.expected,
    实际结果: issue.actual,
    根因分析: issue.rootCause,
    前端修改方案: issue.frontendPlan,
    后端修改方案: issue.backendPlan,
    验证结果: issue.verification,
    补充说明: issue.notes,
  };
  return `以下是一条问题记录，请按系统要求生成可视化数据。未提供或为空的字段表示原文缺失，必须保持对应内容为空。不要使用问题状态推断验证结果。\n\n${JSON.stringify(source, null, 2)}`;
}

function plainText(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  // Model output must stay plain text; strip any HTML tags or entities it emits.
  return value
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/&(?:lt|gt|amp|quot|#\d+|#x[0-9a-f]+);/gi, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .trim();
}

function plainData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plainData);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, plainData(entry)]));
  }
  return plainText(value);
}

function hasText(value: string) {
  return value.trim().length > 0;
}

function pruneGraph(graph: Record<string, unknown>, allowed: Set<string>) {
  const nodes = (Array.isArray(graph.nodes) ? graph.nodes : [])
    .map(objectOf).filter((node): node is Record<string, unknown> => Boolean(node))
    .filter(node => typeof node.kind === 'string' && allowed.has(node.kind));
  const ids = new Set(nodes.map(node => node.id).filter(id => typeof id === 'string'));
  const edges = (Array.isArray(graph.edges) ? graph.edges : [])
    .map(objectOf).filter((edge): edge is Record<string, unknown> => Boolean(edge))
    .filter(edge => typeof edge.from === 'string' && typeof edge.to === 'string'
      && ids.has(edge.from) && ids.has(edge.to));
  return { nodes, edges };
}

/**
 * Deterministically drop blocks the source cannot support, so a non-compliant
 * model cannot invent verification, root causes or fixes. Runs before validation.
 */
function groundData(data: unknown, issue: Issue): unknown {
  const root = objectOf(data);
  if (!root) return data;
  // Drop only the node kinds the source cannot support. Everything else stays
  // available, so a legitimate graph is not over-pruned.
  const allowed = new Set(['step', 'decision', 'problem', 'impact', 'expected', 'cause', 'frontend', 'backend']);
  if (!hasText(issue.rootCause)) allowed.delete('cause');
  if (!hasText(issue.frontendPlan)) allowed.delete('frontend');
  if (!hasText(issue.backendPlan)) allowed.delete('backend');

  const next: Record<string, unknown> = { ...root };
  const process = objectOf(root.process);
  if (process) next.process = pruneGraph(process, allowed);
  const causality = objectOf(root.causality);
  if (causality) next.causality = pruneGraph(causality, allowed);
  if (!hasText(issue.verification)) next.verification = [];
  if (!hasText(issue.expected) && !hasText(issue.actual)) next.comparison = [];
  else if (Array.isArray(root.comparison)) {
    next.comparison = root.comparison.map(row => {
      const entry = objectOf(row);
      return entry ? { ...entry, ...(!hasText(issue.expected) ? { expected: '' } : {}), ...(!hasText(issue.actual) ? { actual: '' } : {}) } : row;
    });
  }
  if (!hasText(issue.process) && !hasText(issue.description) && !hasText(issue.expected) && !hasText(issue.actual)) {
    next.process = { nodes: [], edges: [] };
  }
  if (!hasText(issue.rootCause) && !hasText(issue.frontendPlan) && !hasText(issue.backendPlan)) {
    next.causality = { nodes: [], edges: [] };
  }
  return next;
}

function extractContent(payload: unknown): string {
  const choices = objectOf(payload)?.choices;
  const first = Array.isArray(choices) ? objectOf(choices[0]) : undefined;
  const content = objectOf(first?.message)?.content;
  if (typeof content === 'string' && content.trim()) return content;
  throw new VisualizationError(502, 'AI 服务没有返回可用内容，请稍后重试。');
}

function parseModelJson(content: string): unknown {
  const trimmed = content.replace(/^\uFEFF/, '').trim();
  const withoutFence = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const candidates = [withoutFence];
  const start = withoutFence.indexOf('{');
  const end = withoutFence.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(withoutFence.slice(start, end + 1));
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch { /* Try the next candidate. */ }
  }
  throw new VisualizationError(502, 'AI 返回的图表数据不是有效 JSON，请稍后重试。');
}

function friendlyStatus(status: number): string {
  if (status === 401 || status === 403) return 'AI 服务鉴权失败，请检查可视化 API Key 配置。';
  if (status === 404) return 'AI 模型或接口不存在，请检查可视化模型和接口地址配置。';
  if (status === 429) return 'AI 服务请求过于频繁或额度不足，请稍后重试。';
  return `AI 服务暂时不可用（HTTP ${status}），请稍后重试。`;
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/** Create a non-streaming OpenAI-compatible chat generator with a 90 second timeout. */
export function createChatGenerator(config: ZhipuConfig): VisualizationGenerator {
  const endpoint = `${normalizeBaseUrl(config.baseUrl)}/chat/completions`;
  const isZhipu = new URL(config.baseUrl).hostname === 'open.bigmodel.cn';
  return {
    model: config.model,
    async generate(issue: Issue) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        let response: Response;
        try {
          response = await fetch(endpoint, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify({
              model: config.model,
              messages: [
                { role: 'system', content: buildSystemPrompt() },
                { role: 'user', content: buildUserPrompt(issue) },
              ],
              temperature: 0.2,
              max_tokens: MAX_OUTPUT_TOKENS,
              stream: false,
              ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}),
              ...(isZhipu ? { thinking: { type: config.reasoningEffort ? 'enabled' : 'disabled' } } : {}),
              response_format: { type: 'json_object' },
            }),
            signal: controller.signal,
          });
        } catch (error) {
          if (isTimeout(error)) throw new VisualizationError(504, 'AI 生成超时（90 秒），请稍后重试。');
          throw new VisualizationError(502, '无法连接 AI 服务，请检查网络和模型配置。');
        }

        if (!response.ok) {
          let code = '';
          try { code = String(objectOf(objectOf(await response.json())?.error)?.code ?? ''); }
          catch { /* Do not expose upstream response bodies. */ }
          if (isZhipu && code === '1311') throw new VisualizationError(502, '当前智谱订阅套餐未开放所选模型权限，请检查 VISUALIZATION_MODEL 或 ZHIPU_MODEL 配置。');
          throw new VisualizationError(502, friendlyStatus(response.status));
        }

        let payload: unknown;
        try { payload = await response.json(); }
        catch (error) {
          if (isTimeout(error)) throw error;
          throw new VisualizationError(502, 'AI 服务返回了无法解析的响应，请稍后重试。');
        }

        const data = groundData(plainData(parseModelJson(extractContent(payload))), issue);
        const parsed = visualizationDataSchema.safeParse(data);
        if (!parsed.success) throw new VisualizationError(502, 'AI 返回的图表数据不符合格式要求，请稍后重试。');
        return parsed.data;
      } catch (error) {
        if (error instanceof VisualizationError) throw error;
        if (isTimeout(error)) throw new VisualizationError(504, 'AI 生成超时（90 秒），请稍后重试。');
        throw new VisualizationError(502, 'AI 生成失败，请稍后重试。');
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
