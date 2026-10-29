import { loadZhipuConfig, type ZhipuConfig, type ZhipuConfigResult } from './zhipu.js';

/** Generic OpenAI-compatible settings take priority over legacy Zhipu settings. */
export async function loadVisualizationConfig(
  env: Record<string, string | undefined> = process.env,
  agentDir?: string,
): Promise<ZhipuConfigResult> {
  const rawEffort = env.VISUALIZATION_REASONING_EFFORT?.trim();
  if (rawEffort && rawEffort !== 'low' && rawEffort !== 'medium' && rawEffort !== 'high') {
    return { config: null, message: 'VISUALIZATION_REASONING_EFFORT 仅支持 low、medium、high，请修改后重启服务。' };
  }
  const reasoning: Pick<ZhipuConfig, 'reasoningEffort'> =
    rawEffort === 'low' || rawEffort === 'medium' || rawEffort === 'high' ? { reasoningEffort: rawEffort } : {};
  const model = env.VISUALIZATION_MODEL?.trim();
  const baseUrl = env.VISUALIZATION_BASE_URL?.trim();
  const apiKey = env.VISUALIZATION_API_KEY?.trim();
  if (baseUrl || apiKey) {
    const missing = [
      !model && 'VISUALIZATION_MODEL',
      !baseUrl && 'VISUALIZATION_BASE_URL',
      !apiKey && 'VISUALIZATION_API_KEY',
    ].filter(Boolean);
    if (missing.length) {
      return { config: null, message: `可视化配置不完整，请设置 ${missing.join('、')} 后重启服务。` };
    }
    try {
      const url = new URL(baseUrl!);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('invalid URL');
    } catch {
      return { config: null, message: 'VISUALIZATION_BASE_URL 必须是有效的 HTTP 或 HTTPS 接口地址。' };
    }
    return { config: { model: model!, baseUrl: baseUrl!.replace(/\/+$/, ''), apiKey: apiKey!, ...reasoning } };
  }
  const result = await loadZhipuConfig({ ...env, ...(model ? { ZHIPU_MODEL: model } : {}) }, agentDir);
  return result.config ? { ...result, config: { ...result.config, ...reasoning } } : result;
}
