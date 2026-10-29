import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import matter from 'gray-matter';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppOptions } from '../server/app.js';
import { emptyDraft, type Attachment, type ImportPreview, type Issue, type IssueDraft, type Revision } from '../shared/model.js';

const execFileAsync = promisify(execFile);
const attachmentUrl = /^\/attachments\/[a-f0-9-]{36}\.[a-z0-9]+$/;

interface Ctx { app: FastifyInstance; dir: string }

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function removeDir(dir: string) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      return;
    } catch (error) {
      if (attempt === 4) {
        console.warn(`临时目录清理失败：${dir}`, error);
        return;
      }
      await delay(100);
    }
  }
}

async function withApp(fn: (ctx: Ctx) => Promise<void>, options: Partial<AppOptions> = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'issue-note-test-'));
  let app: FastifyInstance | undefined;
  try {
    app = await buildApp({ ...options, dataDir: dir });
    await fn({ app, dir });
  } finally {
    if (app) await app.close().catch(() => {});
    await removeDir(dir);
  }
}

async function git(dir: string, args: string[]) {
  const result = await execFileAsync('git', ['-C', dir, ...args], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return String(result.stdout);
}

function lines(value: string) {
  return value.split(/\r?\n/).filter(Boolean);
}

async function gitCommitCount(dir: string, file?: string) {
  return lines(await git(dir, ['log', '--format=%H', ...(file ? ['--', file] : [])])).length;
}

async function dataFiles(dir: string) {
  return (await readdir(path.join(dir, 'issues'))).filter(file => file.endsWith('.md')).sort();
}

async function assertNoTempFiles(dir: string) {
  assert.deepEqual((await readdir(path.join(dir, 'issues'))).filter(file => file.endsWith('.tmp')), []);
}

async function createIssue(app: FastifyInstance, payload: object = { title: '测试问题' }, headers: Record<string, string> = {}) {
  const response = await app.inject({ method: 'POST', url: '/api/issues', payload, headers });
  assert.equal(response.statusCode, 201, response.body);
  return response.json() as Issue;
}

async function getIssue(app: FastifyInstance, id: string) {
  const response = await app.inject({ method: 'GET', url: `/api/issues/${id}` });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as Issue;
}

async function exportMarkdown(app: FastifyInstance, id: string) {
  const response = await app.inject({ method: 'GET', url: `/api/issues/${id}/markdown` });
  assert.equal(response.statusCode, 200, response.body);
  assert.match(String(response.headers['content-type']), /^text\/markdown/);
  return response.body;
}

async function getHistory(app: FastifyInstance, id: string) {
  const response = await app.inject({ method: 'GET', url: `/api/issues/${id}/history` });
  assert.equal(response.statusCode, 200, response.body);
  return (response.json() as { revisions: Revision[] }).revisions;
}

async function previewMarkdown(app: FastifyInstance, markdown: string) {
  const response = await app.inject({ method: 'POST', url: '/api/issues/import', payload: { markdown, preview: true } });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as ImportPreview;
}

function draftOf(issue: Issue): IssueDraft {
  const { id: _id, version: _version, createdAt: _createdAt, updatedAt: _updatedAt, ...draft } = issue;
  return draft;
}

function draftFixture(overrides: Partial<IssueDraft> = {}): IssueDraft {
  return {
    title: '登录失败: "500" / 超时',
    type: '缺陷',
    module: '账号/登录',
    status: '处理中',
    priority: '紧急',
    assignees: ['前端', '后端'],
    description: '调用 /api/login 时偶发 500。\n\n```ts\n// 代码块里的标题不应被解析\n## 不是章节\nconst token = "a:b";\n- 是否需要修改：否\n```\n\n末尾说明。',
    process: '1. 打开登录页\n2. 输入错误密码\n3. 点击登录',
    expected: '提示密码错误，HTTP 200。',
    actual: '返回 HTTP 500。',
    rootCause: '空指针。',
    frontendRequired: '需要',
    frontendStatus: '已完成',
    frontendPlan: '前端补充错误提示。',
    backendRequired: '需要',
    backendStatus: '处理中',
    backendPlan: '后端捕获空值。',
    verification: '本地验证通过。',
    notes: '补充：仅测试环境。',
    attachments: [],
    ...overrides,
  };
}

const sectionKeys = ['description', 'process', 'expected', 'actual', 'rootCause', 'frontendPlan', 'backendPlan', 'verification', 'notes'] as const;

/** 清空所有二级标题下的正文，保留 frontmatter、一级标题和二级标题（忽略代码块内的伪标题）。 */
function clearSections(markdown: string) {
  const out: string[] = [];
  let inSection = false;
  let fenced = false;
  let fenceChar = '';
  let fenceLength = 0;
  for (const line of markdown.split('\n')) {
    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (!fenced) { fenced = true; fenceChar = fence[1][0]; fenceLength = fence[1].length; }
      else if (fence[1][0] === fenceChar && fence[1].length >= fenceLength) fenced = false;
    }
    if (!fenced && /^<!-- issue-note:[a-zA-Z]+ -->$/.test(line)) { out.push(line); continue; }
    if (!fenced && /^##\s/.test(line)) {
      inSection = true;
      out.push(line, '');
      continue;
    }
    if (!inSection) out.push(line);
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

function withoutVersion(markdown: string) {
  return markdown.replace(/^version:.*\r?\n/m, '');
}

function missingAttachment(): Attachment {
  return {
    id: randomUUID(),
    name: '缺失的截图.png',
    url: `/attachments/${randomUUID()}.png`,
    mime: 'image/png',
    size: 4,
  };
}

function multipartFile(filename: string, mime: string, content: Buffer) {
  const boundary = `----issue-note-test-${randomUUID()}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return {
    payload: Buffer.concat([head, content, tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

async function uploadFile(app: FastifyInstance, filename: string, mime: string, content: Buffer, headers: Record<string, string> = {}) {
  const form = multipartFile(filename, mime, content);
  return app.inject({
    method: 'POST', url: '/api/attachments', payload: form.payload,
    headers: { ...form.headers, ...headers },
  });
}

test('初始化：临时数据目录结构、Git 提交、安全响应头和健康检查', async () => {
  await withApp(async ({ app, dir }) => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(response.statusCode, 200);
    const health = response.json() as Record<string, unknown>;
    assert.equal(health.ok, true);
    assert.equal(health.storage, 'markdown');
    assert.equal(health.history, 'git');
    assert.match(String(health.head), /^[a-f0-9]{7,}$/);
    assert.equal(health.authRequired, false);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['referrer-policy'], 'same-origin');
    assert.equal(response.headers['cache-control'], 'no-store');

    await stat(path.join(dir, 'issues'));
    await stat(path.join(dir, 'attachments'));
    await stat(path.join(dir, '.git'));
    assert.equal(await readFile(path.join(dir, '.gitignore'), 'utf8'), '*.tmp\n');
    assert.equal(await readFile(path.join(dir, '.gitattributes'), 'utf8'), '*.md text eol=lf\n');
    assert.deepEqual(lines(await git(dir, ['log', '--format=%s'])), ['初始化问题工作台']);

    const session = await app.inject({ method: 'POST', url: '/api/session' });
    assert.equal(session.statusCode, 200);
    assert.equal(session.headers['set-cookie'], undefined);
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/issues' })).json(), { issues: [] });
  });
});

test('创建问题：Markdown 实际落盘、Git 提交记录来源、导出内容包含全部章节', async () => {
  await withApp(async ({ app, dir }) => {
    const draft = draftFixture();
    const created = await createIssue(app, { ...draft }, { 'x-client-source': 'web' });

    assert.equal(created.id, 'ISSUE-0001');
    assert.equal(created.version, 1);
    assert.deepEqual(draftOf(created), draft);
    assert.equal(created.createdAt, created.updatedAt);
    assert.equal(new Date(created.createdAt).toISOString(), created.createdAt);

    const filename = path.join(dir, 'issues', 'ISSUE-0001.md');
    const raw = await readFile(filename, 'utf8');
    const parsed = matter(raw);
    assert.equal(parsed.data.id, 'ISSUE-0001');
    assert.equal(parsed.data.version, 1);
    assert.equal(parsed.data.title, draft.title);
    assert.equal(parsed.data.type, draft.type);
    assert.equal(parsed.data.module, draft.module);
    assert.equal(parsed.data.status, draft.status);
    assert.equal(parsed.data.priority, draft.priority);
    assert.equal(parsed.data.frontend_required, '需要');
    assert.equal(parsed.data.backend_status, '处理中');
    assert.equal(new Date(parsed.data.created_at as string).toISOString(), created.createdAt);
    assert.equal(new Date(parsed.data.updated_at as string).toISOString(), created.updatedAt);
    assert.match(parsed.content, /^# 登录失败: "500" \/ 超时/m);
    for (const heading of ['问题描述', '业务流程与复现步骤', '预期结果', '实际结果', '根因分析', '前端修改方案', '后端修改方案', '验证结果', '补充说明']) {
      assert.ok(parsed.content.includes(`## ${heading}\n`), `缺少章节 ${heading}`);
    }
    assert.ok(parsed.content.includes(draft.description), '描述正文应完整写入文件');

    const subjects = lines(await git(dir, ['log', '--format=%s', '--', 'issues/ISSUE-0001.md']));
    assert.deepEqual(subjects, [`网页 · 创建 ISSUE-0001 · ${draft.title}`]);
    assert.match(await git(dir, ['log', '-1', '--format=%b', '--', 'issues/ISSUE-0001.md']), /Source: web/);
    assert.equal(lines(await git(dir, ['status', '--porcelain'])).length, 0, '保存后工作区应干净');
    await assertNoTempFiles(dir);

    const revisions = await getHistory(app, created.id);
    assert.equal(revisions.length, 1);
    assert.equal(revisions[0].source, 'web');
    assert.equal(revisions[0].summary, `网页 · 创建 ISSUE-0001 · ${draft.title}`);
    assert.ok(Math.abs(new Date(revisions[0].date).getTime() - new Date(created.createdAt).getTime()) < 1000);

    const markdown = await exportMarkdown(app, created.id);
    assert.match(markdown, /^---\nid: ISSUE-0001/m);
    assert.match(markdown, /^version: 1$/m);
    assert.match(markdown, /^type: 缺陷$/m);
    assert.match(markdown, /^attachments: \[\]$/m);

    // 未显式带 x-client-source 时归因为 agent。
    const agentIssue = await createIssue(app, { title: 'Agent 创建的问题' });
    const agentHistory = await getHistory(app, agentIssue.id);
    assert.equal(agentHistory[0].source, 'agent');
    assert.match(agentHistory[0].summary, /^Agent · 创建 ISSUE-0002/);
  });
});

test('创建问题：默认值、标题清洗、无效字段和非法编号', async () => {
  await withApp(async ({ app, dir }) => {
    const created = await createIssue(app, { title: '  仅标题  ' });
    assert.equal(created.title, '仅标题');
    assert.deepEqual(draftOf(created), { ...emptyDraft(), title: '仅标题' });

    const cases = [
      { title: '   ' },
      { title: 'x', unknown: true },
      { title: 'x', type: '不存在的类型' },
      { title: 'x'.repeat(201) },
      { title: 'x', manualId: 'ISSUE-0042', version: 99 },
    ];
    for (const payload of cases) {
      const response = await app.inject({ method: 'POST', url: '/api/issues', payload });
      assert.equal(response.statusCode, 400, JSON.stringify(payload));
    }

    assert.deepEqual(await dataFiles(dir), ['ISSUE-0001.md']);
    assert.equal(await gitCommitCount(dir, 'issues/ISSUE-0001.md'), 1);
    assert.equal(await gitCommitCount(dir), 2);

    for (const id of ['ISSUE-1', 'no-0001', 'ISSUE-0001x', 'ISSUE-0001.md']) {
      const response = await app.inject({ method: 'GET', url: `/api/issues/${id}` });
      assert.equal(response.statusCode, 400, `${id}: ${response.body}`);
    }
    const absent = await app.inject({ method: 'GET', url: '/api/issues/ISSUE-9999' });
    assert.equal(absent.statusCode, 404);
    assert.match(absent.json().error, /没有找到这个问题/);
  });
});

test('列表：搜索、字段筛选、更新时间排序和查询字段校验', async () => {
  await withApp(async ({ app }) => {
    const first = await createIssue(app, draftFixture({ title: '支付回调失败', type: '缺陷', module: '支付', status: '处理中', rootCause: '回调签名错误' }));
    const second = await createIssue(app, draftFixture({ title: '导出按钮缺失', type: '需求变更', module: '报表', status: '待处理' }));
    const third = await createIssue(app, draftFixture({ title: '账单金额待确认', type: '待确认', module: '支付', status: '待验证' }));
    await delay(5);
    const patched = await app.inject({
      method: 'PATCH', url: `/api/issues/${second.id}`,
      payload: { version: second.version, title: '导出按钮缺失（已更新）' },
    });
    assert.equal(patched.statusCode, 200, patched.body);

    const all = (await app.inject({ method: 'GET', url: '/api/issues' })).json() as { issues: Issue[] };
    assert.equal(all.issues.length, 3);
    assert.equal(all.issues[0].id, second.id);
    assert.deepEqual(all.issues.map(issue => issue.id).slice(1).sort(), [first.id, third.id].sort());

    const byModule = (await app.inject({ method: 'GET', url: '/api/issues?module=支付' })).json() as { issues: Issue[] };
    assert.deepEqual(byModule.issues.map(issue => issue.id).sort(), [first.id, third.id].sort());

    const byType = (await app.inject({ method: 'GET', url: '/api/issues?type=需求变更' })).json() as { issues: Issue[] };
    assert.deepEqual(byType.issues.map(issue => issue.id), [second.id]);

    const byStatus = (await app.inject({ method: 'GET', url: '/api/issues?status=待处理' })).json() as { issues: Issue[] };
    assert.deepEqual(byStatus.issues.map(issue => issue.id), [second.id]);

    const byQuery = (await app.inject({ method: 'GET', url: '/api/issues?q=签名' })).json() as { issues: Issue[] };
    assert.deepEqual(byQuery.issues.map(issue => issue.id), [first.id]);

    const caseInsensitive = (await app.inject({ method: 'GET', url: '/api/issues?q=ISSUE-0003' })).json() as { issues: Issue[] };
    assert.deepEqual(caseInsensitive.issues.map(issue => issue.id), [third.id]);

    const combined = (await app.inject({ method: 'GET', url: '/api/issues?q=支付&type=缺陷&status=处理中&module=支付' })).json() as { issues: Issue[] };
    assert.deepEqual(combined.issues.map(issue => issue.id), [first.id]);

    const none = (await app.inject({ method: 'GET', url: '/api/issues?q=不存在的关键词' })).json() as { issues: Issue[] };
    assert.deepEqual(none.issues, []);
  });
});

test('PATCH：版本递增、旧版本 409 不覆盖、无变化不产生新提交', async () => {
  await withApp(async ({ app, dir }) => {
    const created = await createIssue(app, draftFixture());
    const originalRaw = await readFile(path.join(dir, 'issues', `${created.id}.md`), 'utf8');

    const updatedRes = await app.inject({
      method: 'PATCH', url: `/api/issues/${created.id}`,
      headers: { 'x-client-source': 'web' },
      payload: { version: 1, title: '登录失败（已定位）', status: '已关闭', description: '已修复。' },
    });
    assert.equal(updatedRes.statusCode, 200, updatedRes.body);
    const updated = updatedRes.json() as Issue;
    assert.equal(updated.version, 2);
    assert.equal(updated.createdAt, created.createdAt);
    assert.equal(updated.title, '登录失败（已定位）');
    assert.equal(updated.status, '已关闭');
    assert.equal(updated.description, '已修复。');
    assert.equal(updated.process, created.process);
    assert.equal(updated.rootCause, created.rootCause);
    assert.ok(updated.updatedAt >= created.updatedAt);

    const persisted = matter(await readFile(path.join(dir, 'issues', `${created.id}.md`), 'utf8'));
    assert.equal(persisted.data.version, 2);
    assert.equal(persisted.data.title, '登录失败（已定位）');
    assert.equal(persisted.data.status, '已关闭');
    assert.equal((await getIssue(app, created.id)).version, 2);

    const stale = await app.inject({
      method: 'PATCH', url: `/api/issues/${created.id}`,
      payload: { version: 1, title: '旧页面覆盖' },
    });
    assert.equal(stale.statusCode, 409);
    assert.match(stale.json().error, /已被其他操作更新/);
    const afterStale = await getIssue(app, created.id);
    assert.equal(afterStale.version, 2);
    assert.equal(afterStale.title, '登录失败（已定位）');
    assert.notEqual(await readFile(path.join(dir, 'issues', `${created.id}.md`), 'utf8'), originalRaw);
    assert.equal(await gitCommitCount(dir, `issues/${created.id}.md`), 2);

    const invalidVersion = await app.inject({
      method: 'PATCH', url: `/api/issues/${created.id}`,
      payload: { version: 0, title: '无效版本' },
    });
    assert.equal(invalidVersion.statusCode, 400);

    const immutableField = await app.inject({
      method: 'PATCH', url: `/api/issues/${created.id}`,
      payload: { version: 2, createdAt: new Date().toISOString() },
    });
    assert.equal(immutableField.statusCode, 400);

    const subjects = lines(await git(dir, ['log', '--format=%s', '--', `issues/${created.id}.md`]));
    assert.deepEqual(subjects, [
      `网页 · ${created.id} · 状态 处理中 → 已关闭`,
      `Agent · 创建 ${created.id} · ${created.title}`,
    ]);
    const revisions = await getHistory(app, created.id);
    assert.equal(revisions[0].source, 'web');
    assert.equal(revisions[1].source, 'agent');

    // 内容完全相同的 PATCH 不应制造新版本或新提交。
    const noop = await app.inject({
      method: 'PATCH', url: `/api/issues/${created.id}`,
      payload: { version: 2, title: updated.title },
    });
    assert.equal(noop.statusCode, 200);
    assert.equal((noop.json() as Issue).version, 2);
    assert.equal(await gitCommitCount(dir, `issues/${created.id}.md`), 2);

    // 只变更版本号而没有内容变化，同样视为无操作。
    const versionOnly = await app.inject({
      method: 'PATCH', url: `/api/issues/${created.id}`,
      payload: { version: 2 },
    });
    assert.equal(versionOnly.statusCode, 200);
    assert.equal((versionOnly.json() as Issue).version, 2);
    assert.equal(await gitCommitCount(dir, `issues/${created.id}.md`), 2);
    await assertNoTempFiles(dir);
  });
});

test('并发创建：编号唯一、连续，每个问题都有独立提交', async () => {
  await withApp(async ({ app, dir }) => {
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      app.inject({ method: 'POST', url: '/api/issues', payload: { title: `并发问题 ${index + 1}` } })));

    for (const result of results) assert.equal(result.statusCode, 201, result.body);
    const issues = results.map(result => result.json() as Issue);
    const ids = issues.map(issue => issue.id).sort();
    assert.deepEqual(ids, Array.from({ length: 8 }, (_, index) => `ISSUE-${String(index + 1).padStart(4, '0')}`));
    assert.equal(new Set(ids).size, 8);
    assert.ok(issues.every(issue => issue.version === 1));

    assert.deepEqual(await dataFiles(dir), ids.map(id => `${id}.md`));
    assert.equal(await gitCommitCount(dir), 9); // 初始化 + 8 次创建
    for (const id of ids) assert.equal(await gitCommitCount(dir, `issues/${id}.md`), 1);
    assert.equal(lines(await git(dir, ['status', '--porcelain'])).length, 0);
    await assertNoTempFiles(dir);
  });
});

test('并发更新：同一版本只有一个成功，另一个返回 409', async () => {
  await withApp(async ({ app }) => {
    const created = await createIssue(app, { title: '并发更新', description: '初始' });
    const [left, right] = await Promise.all([
      app.inject({ method: 'PATCH', url: `/api/issues/${created.id}`, payload: { version: 1, title: '并发 A' } }),
      app.inject({ method: 'PATCH', url: `/api/issues/${created.id}`, payload: { version: 1, title: '并发 B' } }),
    ]);

    assert.deepEqual([left.statusCode, right.statusCode].sort((a, b) => a - b), [200, 409]);
    const current = await getIssue(app, created.id);
    assert.equal(current.version, 2);
    assert.ok(['并发 A', '并发 B'].includes(current.title));
  });
});

test('Markdown 往返：导出再预览字段一致，导入新工作台分配新编号', async () => {
  await withApp(async ({ app, dir }) => {
    const draft = draftFixture();
    const created = await createIssue(app, { ...draft });
    const markdown = await exportMarkdown(app, created.id);

    const preview = await previewMarkdown(app, markdown);
    assert.equal(preview.mode, 'update');
    assert.equal(preview.id, created.id);
    assert.equal(preview.expectedVersion, 1);
    assert.deepEqual(preview.issue, draft);
    assert.deepEqual(preview.warnings, []);
    assert.equal(preview.existing?.id, created.id);

    // 预览不应修改文件或增加提交。
    const rawBefore = await readFile(path.join(dir, 'issues', `${created.id}.md`), 'utf8');
    const commitsBefore = await gitCommitCount(dir, `issues/${created.id}.md`);
    await previewMarkdown(app, markdown);
    assert.equal(await readFile(path.join(dir, 'issues', `${created.id}.md`), 'utf8'), rawBefore);
    assert.equal(await gitCommitCount(dir, `issues/${created.id}.md`), commitsBefore);

    // 同一工作台按当前版本导入相同内容：不产生无意义的新版本。
    const sameRes = await app.inject({
      method: 'POST', url: '/api/issues/import',
      payload: { markdown, expectedVersion: 1 },
    });
    assert.equal(sameRes.statusCode, 200, sameRes.body);
    const same = sameRes.json() as Issue;
    assert.equal(same.version, 1);
    assert.deepEqual(draftOf(same), draft);
    assert.equal(await gitCommitCount(dir, `issues/${created.id}.md`), commitsBefore);

    // 导入另一个全新工作台：分配新编号，但所有业务字段保留。
    await withApp(async ({ app: fresh, dir: freshDir }) => {
      const importedRes = await fresh.inject({ method: 'POST', url: '/api/issues/import', payload: { markdown } });
      assert.equal(importedRes.statusCode, 200, importedRes.body);
      const imported = importedRes.json() as Issue;
      assert.equal(imported.id, 'ISSUE-0001');
      assert.equal(imported.version, 1);
      assert.notEqual(imported.createdAt, created.createdAt);
      assert.deepEqual(draftOf(imported), draft);
      const freshFile = matter(await readFile(path.join(freshDir, 'issues', 'ISSUE-0001.md'), 'utf8'));
      assert.equal(freshFile.data.title, draft.title);
      assert.equal(freshFile.data.version, 1);
      assert.equal(await gitCommitCount(freshDir, 'issues/ISSUE-0001.md'), 1);
    });
  });
});

test('Markdown 导入可清空正文，未清空的字段、附件和版本语义保持不变', async () => {
  await withApp(async ({ app, dir }) => {
    const upload = await uploadFile(app, 'empty-body.png', 'image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    assert.equal(upload.statusCode, 201, upload.body);
    const attachment = upload.json() as Attachment;
    assert.match(attachment.url, attachmentUrl);
    const draft = draftFixture({ attachments: [attachment] });
    const created = await createIssue(app, { ...draft });

    const cleared = clearSections(await exportMarkdown(app, created.id));
    const preview = await previewMarkdown(app, cleared);
    for (const key of sectionKeys) assert.equal(preview.issue[key], '', key);
    assert.equal(preview.issue.title, draft.title);
    assert.equal(preview.issue.type, draft.type);
    assert.equal(preview.issue.module, draft.module);
    assert.equal(preview.issue.status, draft.status);
    assert.equal(preview.issue.priority, draft.priority);
    assert.equal(preview.issue.frontendRequired, draft.frontendRequired);
    assert.equal(preview.issue.frontendStatus, draft.frontendStatus);
    assert.equal(preview.issue.backendRequired, draft.backendRequired);
    assert.equal(preview.issue.backendStatus, draft.backendStatus);
    assert.deepEqual(preview.issue.attachments, [attachment]);
    assert.equal(preview.expectedVersion, 1);
    assert.deepEqual(preview.warnings, []);

    const updateRes = await app.inject({
      method: 'POST', url: '/api/issues/import',
      payload: { markdown: cleared, expectedVersion: 1 },
    });
    assert.equal(updateRes.statusCode, 200, updateRes.body);
    const updated = updateRes.json() as Issue;
    assert.equal(updated.version, 2);
    assert.equal(updated.id, created.id);
    assert.equal(updated.createdAt, created.createdAt);
    assert.deepEqual(draftOf(updated), preview.issue);

    const persisted = await getIssue(app, created.id);
    assert.equal(persisted.description, '');
    assert.equal(persisted.notes, '');
    assert.deepEqual(persisted.attachments, [attachment]);
    await stat(path.join(dir, 'attachments', path.basename(persisted.attachments[0].url)));

    const roundTrip = await previewMarkdown(app, await exportMarkdown(app, created.id));
    assert.equal(roundTrip.issue.description, '');
    assert.equal(roundTrip.issue.notes, '');
    assert.deepEqual(roundTrip.issue.attachments, [attachment]);
    assert.deepEqual(roundTrip.warnings, []);
  });
});

test('附件引用：导入往返、更新保留、缺失文件拒绝且不落盘', async () => {
  await withApp(async ({ app, dir }) => {
    const content = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const upload = await uploadFile(app, '附件截图.png', 'image/png', content);
    assert.equal(upload.statusCode, 201, upload.body);
    const attachment = upload.json() as Attachment;
    const created = await createIssue(app, { ...draftFixture({ attachments: [attachment] }) });
    const markdown = await exportMarkdown(app, created.id);

    const preview = await previewMarkdown(app, markdown);
    assert.deepEqual(preview.issue.attachments, [attachment]);

    const edited = markdown.replace('补充：仅测试环境。', '导入后修改的补充说明。');
    const updateRes = await app.inject({
      method: 'POST', url: '/api/issues/import',
      payload: { markdown: edited, expectedVersion: 1 },
    });
    assert.equal(updateRes.statusCode, 200, updateRes.body);
    const updated = updateRes.json() as Issue;
    assert.equal(updated.version, 2);
    assert.equal(updated.notes, '导入后修改的补充说明。');
    assert.deepEqual(updated.attachments, [attachment]);

    // PATCH 不携带 attachments 时保留已有引用。
    const patchRes = await app.inject({
      method: 'PATCH', url: `/api/issues/${created.id}`,
      payload: { version: 2, verification: '回归通过' },
    });
    assert.equal(patchRes.statusCode, 200);
    assert.equal(patchRes.json().version, 3);
    assert.deepEqual((patchRes.json() as Issue).attachments, [attachment]);

    const download = await app.inject({ method: 'GET', url: attachment.url });
    assert.equal(download.statusCode, 200);
    assert.deepEqual(download.rawPayload, content);

    const commitsBefore = await gitCommitCount(dir);
    const filesBefore = await dataFiles(dir);
    const absentAttachment = missingAttachment();
    const missingMarkdown = `---\ntitle: 缺失附件\nattachments: ${JSON.stringify([absentAttachment])}\n---\n\n# 缺失附件\n`;
    assert.deepEqual((await previewMarkdown(app, missingMarkdown)).issue.attachments, [absentAttachment]);
    const missing = await app.inject({ method: 'POST', url: '/api/issues/import', payload: { markdown: missingMarkdown } });
    assert.equal(missing.statusCode, 400, missing.body);
    assert.match(missing.json().error, /在此工作台不存在/);
    assert.deepEqual(await dataFiles(dir), filesBefore);
    assert.equal(await gitCommitCount(dir), commitsBefore);
  });
});

test('旧 MD 版本导入：拒绝覆盖当前版本，预览给出冲突提示且不写入', async () => {
  await withApp(async ({ app, dir }) => {
    const created = await createIssue(app, draftFixture());
    const oldMarkdown = await exportMarkdown(app, created.id);

    const patchRes = await app.inject({
      method: 'PATCH', url: `/api/issues/${created.id}`,
      payload: { version: 1, title: '更新后的标题', description: '更新后的描述' },
    });
    assert.equal(patchRes.statusCode, 200);
    const current = patchRes.json() as Issue;
    assert.equal(current.version, 2);
    const rawAtV2 = await readFile(path.join(dir, 'issues', `${created.id}.md`), 'utf8');
    assert.equal(await gitCommitCount(dir, `issues/${created.id}.md`), 2);

    const preview = await previewMarkdown(app, oldMarkdown);
    assert.equal(preview.mode, 'update');
    assert.equal(preview.existing?.version, 2);
    assert.equal(preview.expectedVersion, 1);
    assert.ok(preview.warnings.some(warning => warning.includes('v1') && warning.includes('v2')), preview.warnings.join('\n'));

    // 预览不能落盘，也不能新增提交。
    assert.equal(await readFile(path.join(dir, 'issues', `${created.id}.md`), 'utf8'), rawAtV2);
    assert.equal(await gitCommitCount(dir, `issues/${created.id}.md`), 2);

    const staleImport = await app.inject({
      method: 'POST', url: '/api/issues/import', payload: { markdown: oldMarkdown },
    });
    assert.equal(staleImport.statusCode, 409, staleImport.body);
    assert.match(staleImport.json().error, /已被其他操作更新/);
    assert.equal((await getIssue(app, created.id)).version, 2);
    assert.equal((await getIssue(app, created.id)).title, '更新后的标题');
    assert.equal(await readFile(path.join(dir, 'issues', `${created.id}.md`), 'utf8'), rawAtV2);

    const mismatchedConfirm = await app.inject({
      method: 'POST', url: '/api/issues/import',
      payload: { markdown: oldMarkdown, expectedVersion: 2 },
    });
    assert.equal(mismatchedConfirm.statusCode, 409, mismatchedConfirm.body);
    assert.match(mismatchedConfirm.json().error, /导入文件版本与确认的版本不一致/);
    assert.equal((await getIssue(app, created.id)).version, 2);

    // 不带 YAML 版本的历史模板：缺少 expectedVersion 时拒绝更新。
    const noVersionImport = await app.inject({
      method: 'POST', url: '/api/issues/import',
      payload: { markdown: withoutVersion(await exportMarkdown(app, created.id)) },
    });
    assert.equal(noVersionImport.statusCode, 428, noVersionImport.body);
    assert.match(noVersionImport.json().error, /expectedVersion/);
    assert.equal(await gitCommitCount(dir, `issues/${created.id}.md`), 2);

    // 显式确认版本后允许更新。
    const confirmed = await app.inject({
      method: 'POST', url: '/api/issues/import',
      payload: { markdown: withoutVersion(await exportMarkdown(app, created.id)), expectedVersion: 2 },
    });
    assert.equal(confirmed.statusCode, 200, confirmed.body);
    assert.equal((confirmed.json() as Issue).version, 2, '内容无变化不应递增版本');
  });
});

test('导入预览：创建模式不落盘、不产生提交，未知编号不会被直接占用', async () => {
  await withApp(async ({ app, dir }) => {
    const external = `---\nid: ISSUE-0042\nversion: 3\ntitle: 预览问题\ntype: 缺陷\nmodule: 预览\nstatus: 待处理\npriority: 普通\n---\n\n# 预览问题\n\n## 问题描述\n只预览，不保存。\n`;
    const commitsBefore = await gitCommitCount(dir);
    const filesBefore = await dataFiles(dir);

    const preview = await previewMarkdown(app, external);
    assert.equal(preview.mode, 'create');
    assert.equal(preview.id, 'ISSUE-0042');
    assert.equal(preview.expectedVersion, 3);
    assert.equal(preview.issue.title, '预览问题');
    assert.equal(preview.issue.description, '只预览，不保存。');
    assert.ok(preview.warnings.some(warning => warning.includes('没有这个编号')));
    assert.deepEqual(await dataFiles(dir), filesBefore);
    assert.equal(await gitCommitCount(dir), commitsBefore);
    assert.equal((await app.inject({ method: 'GET', url: '/api/issues/ISSUE-0042' })).statusCode, 404);

    const anonymous = await previewMarkdown(app, external.replace(/^id:.*\r?\n/m, ''));
    assert.equal(anonymous.mode, 'create');
    assert.equal(anonymous.id, undefined);
    assert.deepEqual(await dataFiles(dir), filesBefore);
    assert.equal(await gitCommitCount(dir), commitsBefore);

    // 实际导入时忽略外部编号，使用本地下一个编号。
    const importedRes = await app.inject({ method: 'POST', url: '/api/issues/import', payload: { markdown: external } });
    assert.equal(importedRes.statusCode, 200, importedRes.body);
    const imported = importedRes.json() as Issue;
    assert.equal(imported.id, 'ISSUE-0001');
    assert.equal(imported.version, 1);
    assert.equal(imported.description, '只预览，不保存。');
    assert.equal(await gitCommitCount(dir), commitsBefore + 1);
  });
});

test('不带 YAML 的中文模板：列表元数据、中文标题、未知正文和 BOM 处理', async () => {
  await withApp(async ({ app, dir }) => {
    const markdown = `# 支付回调 500

- 类型：缺陷
- 所属模块：支付
- 状态：处理中
- 优先级：紧急

## 问题描述
支付回调偶发 500。

## 业务流程与复现步骤
1. 下单
2. 第三方回调

## 预期结果
回调成功

## 实际结果
返回 500

## 根因分析
空指针

## 其他信息

补充：只在测试环境出现。
`;
    const preview = await previewMarkdown(app, markdown);
    assert.equal(preview.mode, 'create');
    assert.equal(preview.issue.title, '支付回调 500');
    assert.equal(preview.issue.type, '缺陷');
    assert.equal(preview.issue.module, '支付');
    assert.equal(preview.issue.status, '处理中');
    assert.equal(preview.issue.priority, '紧急');
    assert.equal(preview.issue.description, '支付回调偶发 500。');
    assert.equal(preview.issue.process, '1. 下单\n2. 第三方回调');
    assert.equal(preview.issue.expected, '回调成功');
    assert.equal(preview.issue.actual, '返回 500');
    assert.equal(preview.issue.rootCause, '空指针');
    assert.match(preview.issue.notes, /其他信息/);
    assert.match(preview.issue.notes, /补充：只在测试环境出现。/);
    assert.ok(preview.warnings.some(warning => warning.includes('未识别')));

    const importRes = await app.inject({ method: 'POST', url: '/api/issues/import', payload: { markdown } });
    assert.equal(importRes.statusCode, 200, importRes.body);
    const imported = importRes.json() as Issue;
    assert.equal(imported.id, 'ISSUE-0001');
    assert.equal(imported.type, '缺陷');
    assert.equal(imported.priority, '紧急');
    assert.match(imported.notes, /补充：只在测试环境出现。/);
    const raw = matter(await readFile(path.join(dir, 'issues', `${imported.id}.md`), 'utf8'));
    assert.equal(raw.data.type, '缺陷');
    assert.equal(raw.data.module, '支付');
    assert.equal(raw.data.priority, '紧急');

    const bom = await previewMarkdown(app, '\uFEFF# BOM 标题\n\n正文内容');
    assert.equal(bom.issue.title, 'BOM 标题');
    assert.equal(bom.issue.description, '正文内容');
  });
});

test('纯 Markdown 无标题无章节：保留正文并生成标题，不丢失内容', async () => {
  await withApp(async ({ app }) => {
    const withHeading = await previewMarkdown(app, '# 纯文本问题\n\n第一段描述\n第二行\n');
    assert.equal(withHeading.issue.title, '纯文本问题');
    assert.equal(withHeading.issue.description, '第一段描述\n第二行');
    assert.ok(withHeading.warnings.some(warning => warning.includes('未识别')));

    const noHeading = await previewMarkdown(app, '只有一段文字，没有标题。\n第二行。');
    assert.equal(noHeading.issue.title, '只有一段文字，没有标题。');
    assert.equal(noHeading.issue.description, '只有一段文字，没有标题。\n第二行。');
    assert.ok(noHeading.warnings.some(warning => warning.includes('未找到标题')));

    const importedRes = await app.inject({
      method: 'POST', url: '/api/issues/import', payload: { markdown: '只有一段文字，没有标题。\n第二行。' },
    });
    assert.equal(importedRes.statusCode, 200, importedRes.body);
    const issue = importedRes.json() as Issue;
    assert.equal(issue.title, '只有一段文字，没有标题。');
    assert.equal(issue.description, '只有一段文字，没有标题。\n第二行。');
  });
});

test('非法 Markdown 字段：不合法枚举和附件移入补充说明，安全默认值生效', async () => {
  await withApp(async ({ app, dir }) => {
    const markdown = `---
title: 导入字段校验
type: 不存在的类型
module: 支付
status: 待处理
priority: 999
attachments:
  - id: bad
    name: x
    url: /attachments/../../etc/passwd
    mime: text/plain
    size: 1
---

# 导入字段校验

## 问题描述
正文保留。
`;
    const preview = await previewMarkdown(app, markdown);
    assert.equal(preview.issue.title, '导入字段校验');
    assert.equal(preview.issue.type, '待确认');
    assert.equal(preview.issue.priority, '普通');
    assert.equal(preview.issue.module, '支付');
    assert.equal(preview.issue.status, '待处理');
    assert.equal(preview.issue.description, '正文保留。');
    assert.deepEqual(preview.issue.attachments, []);
    for (const field of ['type', 'priority', 'attachments']) {
      assert.ok(preview.warnings.some(warning => warning.includes(field)), `缺少 ${field} 警告`);
      assert.match(preview.issue.notes, new RegExp(`导入字段 ${field}`));
    }
    assert.match(preview.issue.notes, /\.\.\/\.\.\/etc\/passwd/);

    const importRes = await app.inject({ method: 'POST', url: '/api/issues/import', payload: { markdown } });
    assert.equal(importRes.statusCode, 200, importRes.body);
    const imported = importRes.json() as Issue;
    assert.equal(imported.type, '待确认');
    assert.equal(imported.priority, '普通');
    assert.deepEqual(imported.attachments, []);
    assert.match(imported.notes, /etc\/passwd/);
    const raw = matter(await readFile(path.join(dir, 'issues', `${imported.id}.md`), 'utf8'));
    assert.deepEqual(raw.data.attachments, []);
    assert.equal(raw.data.type, '待确认');
  });
});

test('模板与部分章节：官方模板可往返，只导入部分章节时其它字段保留', async () => {
  await withApp(async ({ app }) => {
    const templateRes = await app.inject({ method: 'GET', url: '/api/template' });
    assert.equal(templateRes.statusCode, 200);
    assert.match(String(templateRes.headers['content-type']), /^text\/markdown/);

    const template = await previewMarkdown(app, templateRes.body);
    assert.equal(template.issue.title, '问题标题');
    assert.equal(template.issue.description, '请描述发现的问题。');
    assert.deepEqual(template.warnings, []);

    const createdRes = await app.inject({ method: 'POST', url: '/api/issues/import', payload: { markdown: templateRes.body } });
    assert.equal(createdRes.statusCode, 200, createdRes.body);
    const created = createdRes.json() as Issue;
    const roundTrip = await previewMarkdown(app, await exportMarkdown(app, created.id));
    assert.deepEqual(roundTrip.issue, draftOf(created));
    assert.equal(roundTrip.expectedVersion, 1);
    assert.deepEqual(roundTrip.warnings, []);

    const full = await createIssue(app, draftFixture());
    const partial = `---\nid: ${full.id}\nversion: 1\n---\n\n# ${full.title}\n\n## 问题描述\n新的描述\n`;
    const merged = await previewMarkdown(app, partial);
    assert.equal(merged.mode, 'update');
    assert.equal(merged.issue.description, '新的描述');
    assert.equal(merged.issue.process, full.process);
    assert.equal(merged.issue.expected, full.expected);
    assert.equal(merged.issue.rootCause, full.rootCause);
    assert.equal(merged.issue.notes, full.notes);
    assert.equal(merged.issue.frontendRequired, full.frontendRequired);
    assert.equal(merged.issue.backendPlan, full.backendPlan);

    const analysisOnly = `---\nid: ${full.id}\nversion: 1\n---\n\n## 根因分析\n补充排查结论\n`;
    const analysisPreview = await previewMarkdown(app, analysisOnly);
    assert.equal(analysisPreview.issue.title, full.title, '仅补充分析时应保留原标题');
    assert.equal(analysisPreview.issue.rootCause, '补充排查结论');
    const saved = await app.inject({ method: 'POST', url: '/api/issues/import', payload: { markdown: analysisOnly } });
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.json().title, full.title);
    assert.equal(saved.json().description, full.description);
  });
});

test('历史与恢复：恢复旧版产生新提交、保留 id/创建时间并递增版本', async () => {
  await withApp(async ({ app, dir }) => {
    const draft = draftFixture();
    const created = await createIssue(app, { ...draft });
    const v1Raw = await readFile(path.join(dir, 'issues', `${created.id}.md`), 'utf8');

    const patchRes = await app.inject({
      method: 'PATCH', url: `/api/issues/${created.id}`,
      payload: { version: 1, title: '后续标题', description: '后续描述', status: '已关闭' },
    });
    assert.equal(patchRes.statusCode, 200);
    const v2 = patchRes.json() as Issue;
    assert.equal(v2.version, 2);
    assert.equal(v2.title, '后续标题');

    const revisions = await getHistory(app, created.id);
    assert.equal(revisions.length, 2);
    const [v2Hash, v1Hash] = revisions.map(revision => revision.hash);
    assert.match(v1Hash, /^[a-f0-9]{40}$/);
    assert.match(revisions[0].summary, /状态 处理中 → 已关闭/);
    assert.match(revisions[1].summary, /创建 ISSUE-0001/);

    const revisionRes = await app.inject({ method: 'GET', url: `/api/issues/${created.id}/history/${v1Hash}` });
    assert.equal(revisionRes.statusCode, 200, revisionRes.body);
    const revision = revisionRes.json() as { issue: Issue; markdown: string; diff: Array<{ added?: boolean; removed?: boolean; value: string }> };
    assert.equal(revision.issue.version, 1);
    assert.equal(revision.issue.title, draft.title);
    assert.equal(revision.issue.description, draft.description);
    assert.match(revision.markdown, /^version: 1$/m);

    const latestRevisionRes = await app.inject({ method: 'GET', url: `/api/issues/${created.id}/history/${v2Hash}` });
    assert.equal(latestRevisionRes.statusCode, 200, latestRevisionRes.body);
    const latestRevision = latestRevisionRes.json() as { diff: Array<{ added?: boolean; removed?: boolean; value: string }> };
    assert.ok(latestRevision.diff.some(part => part.added && part.value.includes('后续标题')));
    assert.ok(latestRevision.diff.some(part => part.removed && part.value.includes(draft.title)));

    const commitsBefore = await gitCommitCount(dir, `issues/${created.id}.md`);
    const restoreRes = await app.inject({
      method: 'POST', url: `/api/issues/${created.id}/restore`,
      headers: { 'x-client-source': 'web' },
      payload: { hash: v1Hash, version: 2 },
    });
    assert.equal(restoreRes.statusCode, 200, restoreRes.body);
    const restored = restoreRes.json() as Issue;
    assert.equal(restored.id, created.id);
    assert.equal(restored.version, 3);
    assert.equal(restored.createdAt, created.createdAt);
    assert.ok(restored.updatedAt >= v2.updatedAt);
    assert.equal(restored.title, draft.title);
    assert.equal(restored.status, draft.status);
    assert.deepEqual(draftOf(restored), draft);

    assert.equal(await gitCommitCount(dir, `issues/${created.id}.md`), commitsBefore + 1);
    const afterHistory = await getHistory(app, created.id);
    assert.equal(afterHistory.length, 3);
    assert.match(afterHistory[0].summary, new RegExp(`恢复版本 ${v1Hash.slice(0, 7)}`));
    assert.equal(afterHistory[0].source, 'web');
    const restoredFile = matter(await readFile(path.join(dir, 'issues', `${created.id}.md`), 'utf8'));
    assert.equal(restoredFile.data.version, 3);
    assert.equal(new Date(restoredFile.data.created_at as string).toISOString(), created.createdAt);
    assert.notEqual(v1Raw, await readFile(path.join(dir, 'issues', `${created.id}.md`), 'utf8'));

    const staleRestore = await app.inject({
      method: 'POST', url: `/api/issues/${created.id}/restore`,
      payload: { hash: v1Hash, version: 2 },
    });
    assert.equal(staleRestore.statusCode, 409, staleRestore.body);
    assert.equal((await getIssue(app, created.id)).version, 3);

    const missingRevision = await app.inject({
      method: 'POST', url: `/api/issues/${created.id}/restore`,
      payload: { hash: 'a'.repeat(40), version: 3 },
    });
    assert.equal(missingRevision.statusCode, 404);
    assert.match(missingRevision.json().error, /没有找到这个历史版本/);

    const malformedHash = await app.inject({ method: 'GET', url: `/api/issues/${created.id}/history/not-a-hash` });
    assert.equal(malformedHash.statusCode, 400);

    // 其他问题的历史哈希不能用于本问题的恢复。
    const other = await createIssue(app, { title: '另一个问题' });
    const otherRevision = (await getHistory(app, other.id))[0];
    const crossRestore = await app.inject({
      method: 'POST', url: `/api/issues/${created.id}/restore`,
      payload: { hash: otherRevision.hash, version: 3 },
    });
    assert.equal(crossRestore.statusCode, 404);
  });
});

test('附件上传：落盘、Git 跟踪、静态访问、文件名清理、类型与大小限制', async () => {
  await withApp(async ({ app, dir }) => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const uploadRes = await uploadFile(app, 'screenshot.png', 'image/png', png);
    assert.equal(uploadRes.statusCode, 201, uploadRes.body);
    const attachment = uploadRes.json() as Attachment;
    assert.match(attachment.id, /^[a-f0-9-]{36}$/);
    assert.match(attachment.url, attachmentUrl);
    assert.equal(attachment.name, 'screenshot.png');
    assert.equal(attachment.mime, 'image/png');
    assert.equal(attachment.size, png.length);

    const storedName = path.basename(attachment.url);
    assert.deepEqual(await readFile(path.join(dir, 'attachments', storedName)), png);
    assert.match(await git(dir, ['ls-files', '--', `attachments/${storedName}`]), new RegExp(storedName));
    assert.match(await git(dir, ['log', '--format=%s', '--', `attachments/${storedName}`]), /上传附件 · screenshot\.png/);

    const download = await app.inject({ method: 'GET', url: attachment.url });
    assert.equal(download.statusCode, 200);
    assert.match(String(download.headers['content-type']), /^image\/png/);
    assert.match(String(download.headers['content-security-policy']), /default-src 'none'/);
    assert.equal(download.headers['x-content-type-options'], 'nosniff');
    assert.deepEqual(download.rawPayload, png);

    // 带路径的文件名只保留 basename（正反斜杠都处理）。
    for (const [input, expected] of [['../../evil.png', 'evil.png'], ['..\\..\\win.png', 'win.png']]) {
      const response = await uploadFile(app, input, 'image/png', png);
      assert.equal(response.statusCode, 201, response.body);
      const uploaded = response.json() as Attachment;
      assert.equal(uploaded.name, expected);
      assert.equal(path.basename(uploaded.url), uploaded.url.slice('/attachments/'.length));
    }

    const text = await uploadFile(app, '说明.txt', 'text/plain', Buffer.from('hello'));
    assert.equal(text.statusCode, 201, text.body);
    const textDownload = await app.inject({ method: 'GET', url: (text.json() as Attachment).url });
    assert.equal(textDownload.statusCode, 200);
    assert.match(String(textDownload.headers['content-type']), /^text\/plain/);
    assert.match(String(textDownload.headers['content-disposition']), /attachment/);

    const countOf = async () => (await readdir(path.join(dir, 'attachments'))).length;
    const before = await countOf();
    const disallowed = await uploadFile(app, 'page.html', 'text/html', Buffer.from('<script>'));
    assert.equal(disallowed.statusCode, 400);
    assert.match(disallowed.json().error, /支持 PNG/);
    const empty = await uploadFile(app, 'empty.txt', 'text/plain', Buffer.alloc(0));
    assert.equal(empty.statusCode, 400);
    assert.match(empty.json().error, /不能上传空文件/);
    const noFile = await app.inject({
      method: 'POST', url: '/api/attachments',
      payload: Buffer.from('not multipart'), headers: { 'content-type': 'multipart/form-data; boundary=x' },
    });
    assert.equal(noFile.statusCode, 400);
    const tooLarge = await uploadFile(app, 'big.png', 'image/png', Buffer.alloc(10 * 1024 * 1024 + 1, 1));
    assert.equal(tooLarge.statusCode, 413, tooLarge.body);
    assert.equal(await countOf(), before, '失败的请求不应留下附件文件');

    const unknown = await app.inject({ method: 'GET', url: `/attachments/${randomUUID()}.png` });
    assert.equal(unknown.statusCode, 404);
    const traversal = await app.inject({ method: 'GET', url: '/attachments/..%2F..%2F.git%2Fconfig' });
    assert.ok([403, 404].includes(traversal.statusCode), `路径穿越应被拒绝：${traversal.statusCode}`);
    assert.equal(traversal.body.includes('[core]'), false, '不能泄露 .git/config');

    // 上传结果可作为问题附件引用；缺失文件或穿越路径的引用被拒绝。
    const created = await createIssue(app, draftFixture({ attachments: [attachment] }));
    assert.deepEqual(created.attachments, [attachment]);
    assert.deepEqual((await previewMarkdown(app, await exportMarkdown(app, created.id))).issue.attachments, [attachment]);

    const missing = await app.inject({ method: 'POST', url: '/api/issues', payload: draftFixture({ attachments: [missingAttachment()] }) });
    assert.equal(missing.statusCode, 400);
    assert.match(missing.json().error, /在此工作台不存在/);

    const badPath = await app.inject({ method: 'POST', url: '/api/issues', payload: draftFixture({ attachments: [{ ...attachment, url: '/attachments/../../etc/passwd' }] }) });
    assert.equal(badPath.statusCode, 400);
    assert.equal(await dataFiles(dir).then(files => files.length), 1);

    const thirty = Array.from({ length: 30 }, () => attachment);
    const allowed = await app.inject({ method: 'POST', url: '/api/issues', payload: { title: '30 个附件', attachments: thirty } });
    assert.equal(allowed.statusCode, 201, allowed.body);
    const tooMany = await app.inject({ method: 'POST', url: '/api/issues', payload: { title: '31 个附件', attachments: [...thirty, attachment] } });
    assert.equal(tooMany.statusCode, 400);
    assert.equal((await dataFiles(dir)).length, 2);
  });
});

test('可选 API 密钥：Bearer、Cookie、会话、同源写入和附件鉴权', async () => {
  const apiKey = 'top-secret';
  await withApp(async ({ app, dir }) => {
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(health.statusCode, 200);
    assert.equal((health.json() as { authRequired: boolean }).authRequired, true);

    const unauthenticated = await app.inject({ method: 'GET', url: '/api/issues' });
    assert.equal(unauthenticated.statusCode, 401);
    assert.match(unauthenticated.json().error, /访问密钥/);

    const wrong = await app.inject({ method: 'GET', url: '/api/issues', headers: { authorization: 'Bearer nope' } });
    assert.equal(wrong.statusCode, 401);

    const bearer = await app.inject({ method: 'GET', url: '/api/issues', headers: { authorization: `Bearer ${apiKey}` } });
    assert.equal(bearer.statusCode, 200);
    assert.deepEqual((bearer.json() as { issues: Issue[] }).issues, []);

    const cookie = await app.inject({ method: 'GET', url: '/api/issues', headers: { cookie: `issue-note-key=${apiKey}` } });
    assert.equal(cookie.statusCode, 200);

    const session = await app.inject({ method: 'POST', url: '/api/session', headers: { authorization: `Bearer ${apiKey}` } });
    assert.equal(session.statusCode, 200);
    const setCookie = String(session.headers['set-cookie']);
    assert.match(setCookie, /issue-note-key=top-secret/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    const sessionCookie = setCookie.split(';')[0];
    assert.equal((await app.inject({ method: 'GET', url: '/api/issues', headers: { cookie: sessionCookie } })).statusCode, 200);

    const crossOrigin = await app.inject({
      method: 'POST', url: '/api/issues',
      headers: { authorization: `Bearer ${apiKey}`, host: '127.0.0.1:3001', origin: 'https://evil.example' },
      payload: { title: '跨站写入' },
    });
    assert.equal(crossOrigin.statusCode, 403);
    assert.match(crossOrigin.json().error, /不允许来自其他网站的写入请求/);
    assert.equal((await readdir(path.join(dir, 'issues'))).length, 0);

    const sameOrigin = await app.inject({
      method: 'POST', url: '/api/issues',
      headers: { authorization: `Bearer ${apiKey}`, host: '127.0.0.1:3001', origin: 'http://127.0.0.1:3001' },
      payload: { title: '同源写入' },
    });
    assert.equal(sameOrigin.statusCode, 201, sameOrigin.body);

    const upload = await uploadFile(app, 'auth.png', 'image/png', Buffer.from([1, 2, 3]), { authorization: `Bearer ${apiKey}` });
    assert.equal(upload.statusCode, 201, upload.body);
    const attachment = upload.json() as Attachment;
    assert.equal((await app.inject({ method: 'GET', url: attachment.url })).statusCode, 401);
    const authorizedDownload = await app.inject({
      method: 'GET', url: attachment.url, headers: { authorization: `Bearer ${apiKey}` },
    });
    assert.equal(authorizedDownload.statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/issues', headers: { authorization: 'Bearer wrong-but-same-length' } })).statusCode, 401);
  }, { apiKey });
});

test('无效请求：拒绝非法字段、非法问题编号和非法附件路径，且不产生文件或提交', async () => {
  await withApp(async ({ app, dir }) => {
    const created = await createIssue(app, { title: '合法问题' });
    const filesBefore = await dataFiles(dir);
    const commitsBefore = await gitCommitCount(dir);

    const cases = [
      { method: 'POST' as const, url: '/api/issues', payload: { title: 'x', extra: 1 } },
      { method: 'POST' as const, url: '/api/issues', payload: { title: '', type: '缺陷' } },
      { method: 'POST' as const, url: '/api/issues', payload: { title: 'x', priority: '终极' } },
      { method: 'POST' as const, url: '/api/issues', payload: [] },
      { method: 'PATCH' as const, url: `/api/issues/${created.id}`, payload: { version: -1, title: 'x' } },
      { method: 'PATCH' as const, url: `/api/issues/${created.id}`, payload: { version: 1, id: 'ISSUE-9999' } },
      { method: 'PATCH' as const, url: `/api/issues/${created.id}`, payload: { version: 1, attachments: [{ ...missingAttachment(), url: '/attachments/../../etc/passwd' }] } },
      { method: 'POST' as const, url: '/api/issues/import', payload: { markdown: '# x', preview: 'yes' } },
      { method: 'POST' as const, url: '/api/issues/import', payload: { markdown: '# x', surprise: true } },
      { method: 'POST' as const, url: '/api/issues/import', payload: {} },
      { method: 'GET' as const, url: '/api/issues/ISSUE-1' },
      { method: 'GET' as const, url: '/api/issues/not-an-id' },
      { method: 'GET' as const, url: '/api/issues/%2e%2e%2f%2e%2e%2fpackage.json' },
      { method: 'GET' as const, url: `/api/issues/${created.id}/history/not-a-hash` },
      { method: 'POST' as const, url: `/api/issues/${created.id}/restore`, payload: { hash: 'xyz', version: 1 } },
      { method: 'POST' as const, url: `/api/issues/${created.id}/restore`, payload: { hash: 'a'.repeat(40), version: 1, extra: true } },
    ];
    for (const testCase of cases) {
      const response = await app.inject(testCase);
      assert.equal(response.statusCode, 400, `${testCase.method} ${testCase.url}: ${response.body}`);
    }

    const missing = await app.inject({ method: 'GET', url: '/api/issues/ISSUE-9999' });
    assert.equal(missing.statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: '/api/issues/ISSUE-0001/history' })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/unknown-route' })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: '/api/issues?q=x&bogus=1' })).statusCode, 200);

    assert.deepEqual(await dataFiles(dir), filesBefore);
    assert.equal(await gitCommitCount(dir), commitsBefore);
  });
});

test('特殊字符的 API 密钥可使用 session Cookie 鉴权', async () => {
  const apiKey = 'p@ss word/中文';
  await withApp(async ({ app }) => {
    const session = await app.inject({ method: 'POST', url: '/api/session', headers: { authorization: `Bearer ${apiKey}` } });
    assert.equal(session.statusCode, 200);
    const cookie = String(session.headers['set-cookie']).split(';')[0];
    const response = await app.inject({ method: 'GET', url: '/api/issues', headers: { cookie } });
    assert.equal(response.statusCode, 200, `session 下发的 Cookie 应能通过鉴权，实际：${response.body}`);
  }, { apiKey });
});

test('正文二级标题在 Markdown 往返中保持完整', async () => {
  await withApp(async ({ app }) => {
    const description = '第一段\n\n## 详细日志\n\n堆栈内容\n\n## 复现频率\n偶发\n\n## 根因分析\n这是正文中的标题，不是问题字段。';
    const created = await createIssue(app, { title: '含子标题', description, notes: '备注' });
    const preview = await previewMarkdown(app, await exportMarkdown(app, created.id));
    assert.equal(preview.issue.description, description);
    assert.equal(preview.issue.notes, '备注');
  });
});

test('多行标题在 Markdown 往返中保持完整', async () => {
  await withApp(async ({ app }) => {
    const created = await createIssue(app, { title: '第一行\n第二行', description: 'D', notes: 'N' });
    const preview = await previewMarkdown(app, await exportMarkdown(app, created.id));
    assert.equal(preview.issue.title, '第一行\n第二行');
    assert.equal(preview.issue.notes, 'N');
    assert.deepEqual(preview.warnings, []);
  });
});
