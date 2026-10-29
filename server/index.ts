import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { buildApp } from './app.js';
import { createChatGenerator } from './zhipu.js';
import { loadVisualizationConfig } from './visualization-config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(root, '.env');
if (existsSync(envFile)) loadEnvFile(envFile);
const port = Number(process.env.PORT || 3001);
const host = process.env.HOST || '0.0.0.0';

// Only the real server entry point loads model configuration. Tests that call
// buildApp directly never touch Pi credentials or the network.
const visualization = await loadVisualizationConfig(process.env);
if (!visualization.config) console.warn(`\n  可视化生成未启用：${visualization.message}\n`);

const app = await buildApp({
  dataDir: process.env.DATA_DIR || path.join(root, 'data'),
  staticDir: path.join(root, 'dist'),
  apiKey: process.env.API_KEY,
  logger: true,
  ...(visualization.config ? { visualization: createChatGenerator(visualization.config) } : {}),
  ...(visualization.message ? { visualizationMessage: visualization.message } : {}),
});
try {
  await app.listen({ port, host });
  const addresses = Object.values(networkInterfaces()).flatMap(items => items || [])
    .filter(item => item.family === 'IPv4' && !item.internal).map(item => item.address);
  const links = host === '0.0.0.0' || host === '::'
    ? [`  本机访问 → http://127.0.0.1:${port}`, ...addresses.map(address => `  局域网访问 → http://${address}:${port}`)]
    : [`  访问地址 → http://${host}:${port}`];
  console.log(`\n  问题簿已启动\n${links.join('\n')}\n  数据目录 → ${process.env.DATA_DIR || path.join(root, 'data')}\n`);
  if (visualization.config) console.log(`  可视化模型 → ${visualization.config.model}（${visualization.config.baseUrl}）${visualization.config.reasoningEffort ? `，思考强度 → ${visualization.config.reasoningEffort}` : ''}\n`);
} catch (err) { app.log.error(err); process.exit(1); }
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => { await app.close(); process.exit(0); });
}
