import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { buildApp } from '../server/app.js';
import { IssueStore } from '../server/store.js';
import { VisualizationService, VisualizationError, type VisualizationGenerator } from '../server/visualization.js';
import { loadVisualizationConfig } from '../server/visualization-config.js';
import { loadZhipuConfig, createZhipuGenerator } from '../server/zhipu.js';
import type { Issue } from '../shared/model.js';
import type { VisualizationData } from '../shared/visualization.js';

const exec = promisify(execFile);
const emptyData = (): VisualizationData => ({ process: { nodes: [], edges: [] }, comparison: [], causality: { nodes: [], edges: [] }, verification: [] });
const fixture = (title = '入库备注选填'): Partial<Issue> => ({ title, description: '填写数量，备注留空后提交入库。', process: '填写数量，备注留空，提交入库，返回422。', expected: '入库成功。', actual: '422备注必填。', rootCause: '备注被后端设为必填。', backendPlan: '改为选填。', verification: '本地省略备注测试通过，环境待验收。' });
async function temporary(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'issue-visualization-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
}
async function git(dir: string, ...args: string[]) { return (await exec('git', ['-C', dir, ...args], { encoding: 'utf8' })).stdout.trim(); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

test('图表独立落盘：不改 Markdown、不创建提交、复用结果、其他问题提交不使图表过期', async () => temporary(async dir => {
  const store = new IssueStore(dir); await store.init();
  const issue = await store.create(fixture());
  let calls = 0;
  const service = new VisualizationService(store, { generator: { model: 'test', async generate() { calls++; return emptyData(); } } });
  const before = await readFile(path.join(dir, 'issues', `${issue.id}.md`), 'utf8');
  const head = await git(dir, 'rev-parse', 'HEAD');
  const document = await service.generate(issue.id);
  assert.equal(document.sourceCommit, head);
  assert.equal(document.sourceVersion, issue.version);
  assert.equal(await readFile(path.join(dir, 'issues', `${issue.id}.md`), 'utf8'), before);
  assert.equal(await git(dir, 'rev-parse', 'HEAD'), head);
  assert.equal(await git(dir, 'status', '--porcelain'), '');
  assert.equal(await git(dir, 'check-ignore', `visualizations/${issue.id}.json`), `visualizations/${issue.id}.json`);
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'visualizations', `${issue.id}.json`), 'utf8')), document);
  assert.deepEqual(await service.generate(issue.id), document); assert.equal(calls, 1);
  await store.create(fixture('另一个问题'));
  assert.equal((await service.getState(issue.id)).stale, false);
  assert.deepEqual(await service.generate(issue.id), document); assert.equal(calls, 1);
  await store.update(issue.id, { description: '新的问题描述' }, issue.version);
  assert.equal((await service.getState(issue.id)).stale, true);
  const updated = await service.generate(issue.id);
  assert.equal(updated.sourceVersion, 2); assert.notEqual(updated.sourceCommit, head); assert.equal(calls, 2);
  const secondService = new VisualizationService(store);
  assert.deepEqual(await secondService.generate(issue.id), updated, '服务重启后仍可读已生成的结果');
}));

test('多人同时生成或强制更新：共享一次调用；生成时不阻塞问题保存；变化后重新生成最新版本', async () => temporary(async dir => {
  const store = new IssueStore(dir); await store.init(); const issue = await store.create(fixture());
  const started = deferred<void>(), release = deferred<void>(); let calls = 0;
  const versions: number[] = [];
  const service = new VisualizationService(store, { generator: { model: 'test', async generate(source) {
    calls++; versions.push(source.version);
    if (calls === 1) { started.resolve(); await release.promise; }
    return emptyData();
  } } });
  const first = service.generate(issue.id); await started.promise;
  const second = service.generate(issue.id, true);
  assert.equal((await service.getState(issue.id)).generating, true);
  await store.update(issue.id, { expected: '最新预期' }, issue.version);
  release.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b); assert.equal(a.sourceVersion, 2); assert.deepEqual(versions, [1, 2]);
  assert.equal((await service.getState(issue.id)).generating, false);
}));

test('失败、持续更新和格式错误都保留原图，不留下临时文件', async () => temporary(async dir => {
  const store = new IssueStore(dir); await store.init(); const issue = await store.create(fixture());
  let behavior: 'success' | 'failure' | 'invalid' | 'changing' = 'success';
  const service = new VisualizationService(store, { generator: { model: 'test', async generate(source) {
    if (behavior === 'failure') throw new Error('SECRET upstream details');
    if (behavior === 'invalid') return { ...emptyData(), process: { nodes: [], edges: [{ from: 'missing', to: 'none', label: '' }] } };
    if (behavior === 'changing') await store.update(source.id, { notes: `updated ${source.version}` }, source.version);
    return emptyData();
  } } });
  const initial = await service.generate(issue.id);
  behavior = 'failure'; await assert.rejects(service.generate(issue.id, true), error => error instanceof VisualizationError && !error.message.includes('SECRET'));
  assert.deepEqual((await service.getState(issue.id)).document, initial);
  behavior = 'invalid'; await assert.rejects(service.generate(issue.id, true), /结构不符合/);
  behavior = 'changing'; await assert.rejects(service.generate(issue.id, true), error => error instanceof VisualizationError && error.statusCode === 409);
  assert.deepEqual((await service.getState(issue.id)).document, initial);
  assert.deepEqual((await readdir(path.join(dir, 'visualizations'))).filter(file => file.endsWith('.tmp')), []);
  assert.equal((await service.getState(issue.id)).generating, false);
}));

test('损坏或旧格式图表文件可重建；不存在的问题、无配置、路由鉴权与输入校验', async () => temporary(async dir => {
  const app = await buildApp({ dataDir: dir, apiKey: 'workspace-key' });
  try {
    const headers = { authorization: 'Bearer workspace-key' };
    const created = await app.inject({ method: 'POST', url: '/api/issues', headers, payload: fixture() });
    const issue = created.json() as Issue; assert.equal(created.statusCode, 201);
    const url = `/api/issues/${issue.id}/visualization`;
    assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url, payload: {} })).statusCode, 401);
    await writeFile(path.join(dir, 'visualizations', `${issue.id}.json`), '{invalid');
    const state = await app.inject({ method: 'GET', url, headers });
    assert.equal(state.statusCode, 200); assert.equal(state.json().document, null); assert.equal(state.json().configured, false);
    const absent = await app.inject({ method: 'POST', url, headers, payload: {} });
    assert.equal(absent.statusCode, 503); assert.match(absent.json().error, /未配置/);
    assert.equal((await app.inject({ method: 'POST', url, headers, payload: { force: 'yes' } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url, headers, payload: { unknown: true } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'GET', url: '/api/issues/ISSUE-9999/visualization', headers })).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url: '/api/issues/ISSUE-9999/visualization', headers, payload: {} })).statusCode, 404);
  } finally { await app.close(); }
}));

test('生成路由可共享持久化结果，force 才重新调用，模型错误不泄露上游信息', async () => temporary(async dir => {
  let calls = 0; let fail = false;
  const generator: VisualizationGenerator = { model: 'test-model', async generate() { calls++; if (fail) throw new Error('key-do-not-leak'); return emptyData(); } };
  const app = await buildApp({ dataDir: dir, visualization: generator });
  try {
    const issue = (await app.inject({ method: 'POST', url: '/api/issues', payload: fixture() })).json() as Issue;
    const url = `/api/issues/${issue.id}/visualization`;
    assert.equal((await app.inject({ method: 'POST', url, payload: {} })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url, payload: {} })).statusCode, 200); assert.equal(calls, 1);
    assert.equal((await app.inject({ method: 'POST', url, payload: { force: true } })).statusCode, 200); assert.equal(calls, 2);
    fail = true;
    const response = await app.inject({ method: 'POST', url, payload: { force: true } });
    assert.equal(response.statusCode, 502); assert.ok(!response.body.includes('key-do-not-leak'));
    const state = (await app.inject({ method: 'GET', url })).json();
    assert.equal(state.document.model, 'test-model'); assert.equal(state.stale, false);
  } finally { await app.close(); }
}));

test('智谱配置：环境变量优先、Pi 凭据回退、拒绝命令凭据且消息不含密钥', async () => temporary(async dir => {
  await mkdir(path.join(dir, 'pi'));
  const agentDir = path.join(dir, 'pi');
  await writeFile(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { 'zai-coding-cn': { baseUrl: 'https://example.com/coding/v4', models: [{ id: 'pi-model' }] } } }));
  await writeFile(path.join(agentDir, 'auth.json'), JSON.stringify({ 'zai-coding-cn': { type: 'api_key', key: 'pi-secret' } }));
  const fallback = await loadZhipuConfig({}, agentDir);
  assert.deepEqual(fallback.config, { apiKey: 'pi-secret', baseUrl: 'https://example.com/coding/v4', model: 'pi-model' });
  const explicit = await loadZhipuConfig({ ZHIPU_API_KEY: 'env-secret', ZHIPU_BASE_URL: 'https://explicit.example/v4/', ZHIPU_MODEL: 'env-model' }, agentDir);
  assert.deepEqual(explicit.config, { apiKey: 'env-secret', baseUrl: 'https://explicit.example/v4', model: 'env-model' });
  await writeFile(path.join(agentDir, 'auth.json'), JSON.stringify({ 'zai-coding-cn': { type: 'api_key', key: '!must-not-run-secret' } }));
  const command = await loadZhipuConfig({}, agentDir);
  assert.equal(command.config, null); assert.match(command.message!, /命令型/); assert.ok(!command.message!.includes('must-not-run-secret'));
  const unresolved = await loadZhipuConfig({ ZHIPU_API_KEY: '${MISSING_KEY}' }, agentDir);
  assert.equal(unresolved.config, null); assert.match(unresolved.message!, /MISSING_KEY/);
}));

test('通用可视化配置：中转优先、模型可切换、配置缺失不混用智谱密钥', async () => {
  const env = {
    VISUALIZATION_MODEL: 'gemini-3.8-flash',
    VISUALIZATION_BASE_URL: 'https://relay.example/v1/',
    VISUALIZATION_API_KEY: 'relay-secret',
    ZHIPU_API_KEY: 'zhipu-secret',
    ZHIPU_MODEL: 'glm-5.3-flash',
  };
  assert.deepEqual((await loadVisualizationConfig(env)).config, {
    model: 'gemini-3.8-flash', baseUrl: 'https://relay.example/v1', apiKey: 'relay-secret',
  });
  assert.equal((await loadVisualizationConfig({ ...env, VISUALIZATION_MODEL: 'another-model' })).config?.model, 'another-model');
  const missing = await loadVisualizationConfig({ ...env, VISUALIZATION_API_KEY: '' });
  assert.equal(missing.config, null);
  assert.match(missing.message!, /VISUALIZATION_API_KEY/);
  assert.ok(!missing.message!.includes('secret'));
  assert.equal((await loadVisualizationConfig({ ...env, VISUALIZATION_BASE_URL: 'file:///tmp/relay' })).config, null);
  assert.equal((await loadVisualizationConfig({ ZHIPU_API_KEY: 'legacy', VISUALIZATION_MODEL: 'glm-custom' })).config?.model, 'glm-custom');
  assert.equal((await loadVisualizationConfig({ ZHIPU_API_KEY: 'legacy' })).config?.model, 'glm-5.3-flash');
});

test('智谱 HTTP：使用纯 JSON 协议，缺失信息强制留空，鉴权失败不暴露响应正文', async () => temporary(async dir => {
  const store = new IssueStore(dir); await store.init();
  const issue = await store.create({ title: '只有描述', description: '入库失败', actual: '422' });
  let httpStatus = 200; const captured: Array<{ authorization?: string; body: Record<string, unknown> }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    captured.push({ authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
    assert.equal(req.url, '/v4/chat/completions');
    res.writeHead(httpStatus, { 'content-type': 'application/json' });
    const data: VisualizationData = { ...emptyData(), comparison: [{ aspect: '入库', expected: '虚构预期', actual: '422' }], causality: { nodes: [{ id: 'invented', label: '虚构根因', detail: '', kind: 'cause' }], edges: [] }, verification: [{ scenario: '虚构测试', expected: '', result: '通过', status: 'passed', scope: '' }] };
    res.end(httpStatus === 200 ? JSON.stringify({ choices: [{ message: { content: JSON.stringify(data) } }] }) : '{"error":"sensitive-upstream-key"}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const generator = createZhipuGenerator({ apiKey: 'test-secret', model: 'test-model', baseUrl: `http://127.0.0.1:${address.port}/v4` });
    const data = await generator.generate(issue);
    assert.deepEqual(data.verification, []); assert.deepEqual(data.causality, { nodes: [], edges: [] }); assert.equal(data.comparison[0].expected, '');
    assert.equal(captured[0].authorization, 'Bearer test-secret');
    assert.equal(captured[0].body.model, 'test-model');
    assert.ok(!('thinking' in captured[0].body), 'OpenAI 兼容中转不发送智谱专用参数');
    assert.equal(captured[0].body.stream, false); assert.deepEqual(captured[0].body.response_format, { type: 'json_object' });
    httpStatus = 401;
    await assert.rejects(generator.generate(issue), error => error instanceof VisualizationError && /鉴权失败/.test(error.message) && !error.message.includes('sensitive-upstream-key'));
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}));
