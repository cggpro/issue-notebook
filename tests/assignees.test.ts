import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';
import { buildApp } from '../server/app.js';
import { parseMarkdown, serializeIssue } from '../server/markdown.js';
import { emptyDraft, type Issue } from '../shared/model.js';

test('负责人：新建默认双方，单选/多选可保存，局部更新保留，历史可恢复', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'issue-assignees-'));
  const app = await buildApp({ dataDir: dir });
  try {
    const create = await app.inject({ method: 'POST', url: '/api/issues', payload: { title: '负责人测试' } });
    assert.equal(create.statusCode, 201);
    let issue = create.json() as Issue;
    assert.deepEqual(issue.assignees, ['前端', '后端']);
    const history = await app.inject({ method: 'GET', url: `/api/issues/${issue.id}/history` });
    const initialHash = history.json().revisions[0].hash;

    for (const assignees of [['前端'], ['后端'], ['前端', '后端']] as Issue['assignees'][]) {
      const response = await app.inject({ method: 'PATCH', url: `/api/issues/${issue.id}`, payload: { version: issue.version, assignees } });
      assert.equal(response.statusCode, 200, response.body);
      issue = response.json();
      assert.deepEqual(issue.assignees, assignees);
      const detail = await app.inject({ method: 'GET', url: `/api/issues/${issue.id}` });
      assert.deepEqual(detail.json().assignees, assignees);
      const list = await app.inject({ method: 'GET', url: '/api/issues' });
      assert.deepEqual(list.json().issues[0].assignees, assignees);
      const exported = await app.inject({ method: 'GET', url: `/api/issues/${issue.id}/markdown` });
      assert.deepEqual(matter(exported.body).data.assignees, assignees);
      assert.deepEqual(parseMarkdown(exported.body).draft.assignees, assignees);
    }

    const single = await app.inject({ method: 'PATCH', url: `/api/issues/${issue.id}`, payload: { version: issue.version, assignees: ['后端'] } });
    issue = single.json();
    const partial = await app.inject({ method: 'PATCH', url: `/api/issues/${issue.id}`, payload: { version: issue.version, notes: '不改负责人' } });
    assert.equal(partial.statusCode, 200);
    issue = partial.json();
    assert.deepEqual(issue.assignees, ['后端']);
    const restored = await app.inject({ method: 'POST', url: `/api/issues/${issue.id}/restore`, payload: { version: issue.version, hash: initialHash } });
    assert.equal(restored.statusCode, 200);
    assert.deepEqual(restored.json().assignees, ['前端', '后端']);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('负责人：API 拒绝空选、重复、未知选项及错误类型，不改变已保存内容', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'issue-assignees-'));
  const app = await buildApp({ dataDir: dir });
  try {
    const create = await app.inject({ method: 'POST', url: '/api/issues', payload: { title: '后端负责', assignees: ['后端'] } });
    const issue = create.json() as Issue;
    assert.equal(create.statusCode, 201);
    for (const assignees of [[], ['前端', '前端'], ['测试'], ['前端', '后端', '前端'], '前端', null]) {
      const invalidCreate = await app.inject({ method: 'POST', url: '/api/issues', payload: { title: '非法负责人', assignees } });
      assert.equal(invalidCreate.statusCode, 400, invalidCreate.body);
      const invalidPatch = await app.inject({ method: 'PATCH', url: `/api/issues/${issue.id}`, payload: { version: issue.version, assignees } });
      assert.equal(invalidPatch.statusCode, 400, invalidPatch.body);
    }
    const detail = await app.inject({ method: 'GET', url: `/api/issues/${issue.id}` });
    assert.deepEqual(detail.json(), issue);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('负责人：旧文件默认双方且读取不改文件；Markdown 回填缺省保留、显式字段可更新', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'issue-assignees-'));
  const app = await buildApp({ dataDir: dir });
  try {
    const create = await app.inject({ method: 'POST', url: '/api/issues', payload: { title: '旧问题' } });
    const issue = create.json() as Issue;
    const filename = path.join(dir, 'issues', `${issue.id}.md`);
    const legacy = matter(await readFile(filename, 'utf8'));
    delete legacy.data.assignees;
    const oldRaw = matter.stringify(legacy.content, legacy.data);
    await writeFile(filename, oldRaw);
    const detail = await app.inject({ method: 'GET', url: `/api/issues/${issue.id}` });
    assert.deepEqual(detail.json().assignees, ['前端', '后端']);
    assert.equal(await readFile(filename, 'utf8'), oldRaw);

    const single = await app.inject({ method: 'PATCH', url: `/api/issues/${issue.id}`, payload: { version: issue.version, assignees: ['前端'] } });
    let current = single.json() as Issue;
    let markdown = `---\nid: ${issue.id}\nversion: ${current.version}\n---\n\n## 补充说明\n仅回填分析。\n`;
    const preview = await app.inject({ method: 'POST', url: '/api/issues/import', payload: { markdown, preview: true } });
    assert.deepEqual(preview.json().issue.assignees, ['前端']);
    const imported = await app.inject({ method: 'POST', url: '/api/issues/import', payload: { markdown } });
    assert.equal(imported.statusCode, 200, imported.body);
    current = imported.json();
    assert.deepEqual(current.assignees, ['前端']);

    markdown = serializeIssue({ ...current, assignees: ['后端'] });
    const changed = await app.inject({ method: 'POST', url: '/api/issues/import', payload: { markdown } });
    assert.equal(changed.statusCode, 200, changed.body);
    assert.deepEqual(changed.json().assignees, ['后端']);
    const template = await app.inject({ method: 'GET', url: '/api/template' });
    assert.deepEqual(parseMarkdown(template.body).draft.assignees, ['前端', '后端']);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('负责人：Markdown 非法值保留到备注，默认数组不跨草稿共享', () => {
  const parsed = parseMarkdown('---\ntitle: 测试\nassignees: []\n---\n');
  assert.deepEqual(parsed.draft.assignees, ['前端', '后端']);
  assert.ok(parsed.warnings.some(warning => warning.includes('assignees')));
  assert.match(parsed.draft.notes, /assignees/);
  const first = emptyDraft();
  first.assignees.pop();
  assert.deepEqual(emptyDraft().assignees, ['前端', '后端']);
});
