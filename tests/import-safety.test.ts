import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../server/app.js';

test('Markdown 导入只允许 YAML，拒绝执行 JavaScript 并保留零写入', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'issue-note-safe-import-'));
  const app = await buildApp({ dataDir: dir });
  try {
    for (const language of ['javascript', 'js', 'json']) {
      const markdown = `---${language}\n(() => { globalThis.__issueNoteImportExecuted = true; return { title: '禁止执行' }; })()\n---\n# 问题\n`;
      const response = await app.inject({ method: 'POST', url: '/api/issues/import', payload: { markdown, preview: true } });
      assert.equal(response.statusCode, 400);
      assert.match(response.json().error, /仅支持 YAML/);
      assert.equal(Reflect.has(globalThis, '__issueNoteImportExecuted'), false);
    }
    const malformed = await app.inject({ method: 'POST', url: '/api/issues/import', payload: { markdown: '---\ntitle: [\n---\n# 错误格式', preview: true } });
    assert.equal(malformed.statusCode, 400);
    assert.match(malformed.json().error, /YAML 格式不正确/);
    const list = await app.inject({ method: 'GET', url: '/api/issues' });
    assert.equal(list.json().issues.length, 0);
  } finally {
    Reflect.deleteProperty(globalThis, '__issueNoteImportExecuted');
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
