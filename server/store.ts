import { mkdir, readdir, readFile, writeFile, rename, unlink, stat } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { diffLines } from 'diff';
import type { Attachment, ImportPreview, Issue, IssueDraft, Revision } from '../shared/model.js';
import { visualizationDocumentSchema, type VisualizationDocument } from '../shared/visualization.js';
import { serializeIssue, parseMarkdown, readFrontmatter } from './markdown.js';
import { HttpError, validateDraft } from './schema.js';

const run = promisify(execFile);
const validId = /^ISSUE-\d{4,}$/;
const validHash = /^[a-f0-9]{40}$/;
const sourceLabel = (source: string) => source === 'agent' ? 'Agent' : '网页';

export class IssueStore {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(public root: string) { this.root = path.resolve(root); }

  async init() {
    await mkdir(path.join(this.root, 'issues'), { recursive: true });
    await mkdir(path.join(this.root, 'attachments'), { recursive: true });
    await mkdir(path.join(this.root, 'visualizations'), { recursive: true });
    try { await stat(path.join(this.root, '.git')); }
    catch {
      await this.git(['init', '--quiet']);
      await writeFile(path.join(this.root, '.gitignore'), '*.tmp\n');
      await writeFile(path.join(this.root, '.gitattributes'), '*.md text eol=lf\n');
      await this.git(['add', '.gitignore', '.gitattributes']);
      await this.commit('初始化问题工作台', 'system');
    }
    // Keep generated visualizations out of history without touching the tracked .gitignore.
    await this.excludeVisualizations();
  }

  private async excludeVisualizations() {
    // Resolve through Git so linked worktrees and submodule layouts work too.
    const relative = await this.git(['rev-parse', '--git-path', 'info/exclude']);
    const exclude = path.resolve(this.root, relative || path.join('.git', 'info', 'exclude'));
    let current = '';
    try { current = await readFile(exclude, 'utf8'); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
    if (current.split(/\r?\n/).includes('/visualizations/')) return;
    const separator = current && !current.endsWith('\n') ? '\n' : '';
    await mkdir(path.dirname(exclude), { recursive: true });
    await writeFile(exclude, `${current}${separator}/visualizations/\n`, 'utf8');
  }

  private async git(args: string[]) {
    const result = await run('git', ['-c', 'core.quotepath=false', '-C', this.root, ...args], {
      encoding: 'utf8', maxBuffer: 12 * 1024 * 1024, windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return result.stdout.trimEnd();
  }

  private async commit(message: string, source: string) {
    await this.git(['-c', 'user.name=Issue Note', '-c', 'user.email=issue-note@localhost',
      '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', message, '-m', `Source: ${source}`]);
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => {});
    return result;
  }

  private file(id: string) {
    if (!validId.test(id)) throw new HttpError(400, '问题编号格式不正确');
    return path.join(this.root, 'issues', `${id}.md`);
  }

  private decode(raw: string): Issue {
    const parsed = parseMarkdown(raw);
    const data = readFrontmatter(raw).data;
    if (!parsed.id || !parsed.version || !data.created_at || !data.updated_at) throw new Error('问题文件缺少编号、版本或时间信息');
    return { ...parsed.draft, id: parsed.id, version: parsed.version,
      createdAt: new Date(data.created_at).toISOString(), updatedAt: new Date(data.updated_at).toISOString() };
  }

  async get(id: string): Promise<Issue> {
    try { return this.decode(await readFile(this.file(id), 'utf8')); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(404, '没有找到这个问题');
      throw err;
    }
  }

  /**
   * Read the issue together with the hash of the commit that last changed its file.
   * Content is read from that exact commit, so hash and body can never be mixed.
   * The callback runs inside store serialization; keep it short and never await
   * network work here.
   */
  async withIssueSnapshot<T>(id: string, action: (snapshot: { issue: Issue; commit: string }) => Promise<T>): Promise<T> {
    const filename = this.file(id);
    return this.serialize(async () => {
      let commit = '';
      try { commit = await this.git(['log', '-1', '--format=%H', '--', `issues/${id}.md`]); }
      catch (error) {
        // A brand-new repository has no commits, which is a missing issue. Any
        // other git failure (permissions, corruption) is surfaced, not hidden.
        if ((error as { code?: unknown }).code === 128) {
          try { await stat(filename); }
          catch { throw new HttpError(404, '没有找到这个问题'); }
        }
        throw error;
      }
      if (!validHash.test(commit)) throw new HttpError(404, '没有找到这个问题');
      // Content is read from the same commit as the hash, never from the worktree.
      const issue = this.decode(await this.git(['show', `${commit}:issues/${id}.md`]));
      if (issue.id !== id) throw new HttpError(404, '没有找到这个问题');
      return action({ issue, commit });
    });
  }

  private visualizationFile(id: string) {
    if (!validId.test(id)) throw new HttpError(400, '问题编号格式不正确');
    return path.join(this.root, 'visualizations', `${id}.json`);
  }

  /** Invalid or corrupt cache files are treated as missing; other I/O errors surface. */
  async getVisualization(id: string): Promise<VisualizationDocument | null> {
    const filename = this.visualizationFile(id);
    let raw: string;
    try { raw = await readFile(filename, 'utf8'); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    try {
      const parsed = visualizationDocumentSchema.safeParse(JSON.parse(raw));
      if (!parsed.success || parsed.data.issueId !== id) return null;
      return parsed.data;
    } catch { return null; }
  }

  async saveVisualization(document: VisualizationDocument) {
    const parsed = visualizationDocumentSchema.parse(document);
    const filename = this.visualizationFile(parsed.issueId);
    await mkdir(path.dirname(filename), { recursive: true });
    const temp = `${filename}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
      await rename(temp, filename);
    } catch (err) {
      // A failed write or rename must leave the previous cache untouched.
      await unlink(temp).catch(() => {});
      throw err;
    }
  }

  async list() {
    const files = (await readdir(path.join(this.root, 'issues'))).filter(f => /^ISSUE-\d{4,}\.md$/.test(f));
    return Promise.all(files.map(file => this.get(file.slice(0, -3))));
  }

  private async persist(issue: Issue, summary: string, source: string, old?: Issue) {
    const filename = this.file(issue.id);
    const relative = `issues/${issue.id}.md`;
    const temp = `${filename}.${randomUUID()}.tmp`;
    const content = serializeIssue(issue);
    await writeFile(temp, content, 'utf8');
    await rename(temp, filename);
    try {
      await this.git(['add', '--', relative]);
      await this.commit(summary, source);
    } catch (error) {
      // A failed commit must never look like a successful save.
      if (old) {
        await writeFile(temp, serializeIssue(old), 'utf8');
        await rename(temp, filename);
      } else await unlink(filename);
      await this.git(['reset', '--', relative]).catch(() => {});
      throw error;
    }
    return issue;
  }

  async create(draft: Partial<IssueDraft>, source = 'web') {
    return this.serialize(async () => {
      const clean = validateDraft(draft);
      const files = await readdir(path.join(this.root, 'issues'));
      const max = files.reduce((m, f) => Math.max(m, Number(f.match(/^ISSUE-(\d+)\.md$/)?.[1] || 0)), 0);
      const id = `ISSUE-${String(max + 1).padStart(4, '0')}`;
      const now = new Date().toISOString();
      const issue: Issue = { ...clean, id, version: 1, createdAt: now, updatedAt: now };
      await this.checkAttachments(issue.attachments);
      return this.persist(issue, `${sourceLabel(source)} · 创建 ${id} · ${issue.title}`, source);
    });
  }

  async update(id: string, patch: Partial<IssueDraft>, expectedVersion: number, source = 'web') {
    return this.serialize(async () => {
      const current = await this.get(id);
      this.checkVersion(current, expectedVersion);
      const draft = validateDraft({ ...this.draftOf(current), ...patch });
      await this.checkAttachments(draft.attachments);
      if (JSON.stringify(draft) === JSON.stringify(this.draftOf(current))) return current;
      const issue = { ...draft, id, version: current.version + 1, createdAt: current.createdAt, updatedAt: new Date().toISOString() };
      const summary = current.status !== issue.status ? `状态 ${current.status} → ${issue.status}` : '更新内容';
      return this.persist(issue, `${sourceLabel(source)} · ${id} · ${summary}`, source, current);
    });
  }

  draftOf(issue: Issue): IssueDraft {
    const { id: _id, version: _v, createdAt: _c, updatedAt: _u, ...draft } = issue;
    return draft;
  }

  private checkVersion(issue: Issue, version: number) {
    if (version !== issue.version) throw new HttpError(409, '这个问题已被其他操作更新。请保留当前内容，重新加载最新版本后再保存。');
  }

  async preview(markdown: string): Promise<ImportPreview> {
    const parsed = parseMarkdown(markdown);
    let existing: Issue | undefined;
    if (parsed.id) {
      try { existing = await this.get(parsed.id); }
      catch (err) { if (!(err instanceof HttpError && err.statusCode === 404)) throw err; }
      if (!existing) parsed.warnings.push('当前工作台中没有这个编号，将分配新编号创建问题。');
    }
    if (existing && parsed.version && existing.version !== parsed.version) {
      parsed.warnings.push(`导入内容基于 v${parsed.version}，当前已是 v${existing.version}，不能直接覆盖。请先合并最新内容。`);
    }
    return {
      issue: existing ? validateDraft({ ...this.draftOf(existing), ...parsed.patch }) : parsed.draft,
      id: parsed.id, existing, mode: existing ? 'update' : 'create',
      expectedVersion: parsed.version ?? existing?.version, warnings: parsed.warnings,
    };
  }

  async import(markdown: string, expectedVersion?: number, source = 'web') {
    const preview = await this.preview(markdown);
    if (preview.existing) {
      const parsed = parseMarkdown(markdown);
      if (parsed.version && expectedVersion && parsed.version !== expectedVersion) throw new HttpError(409, '导入文件版本与确认的版本不一致，请先合并最新内容。');
      const version = parsed.version ?? expectedVersion;
      if (!version) throw new HttpError(428, '更新已有问题需要 expectedVersion。请先预览并确认当前版本。');
      return this.update(preview.existing.id, parsed.patch, version, source);
    }
    return this.create(preview.issue, source);
  }

  async history(id: string): Promise<Revision[]> {
    await this.get(id);
    const output = await this.git(['log', '-100', '--format=%H%x1f%aI%x1f%s%x1f%b%x1e', '--', `issues/${id}.md`]);
    return output.split('\x1e').map(s => s.trim()).filter(Boolean).map(row => {
      const [hash, date, summary, body] = row.split('\x1f');
      return { hash, date, summary, source: body?.match(/Source: (\w+)/)?.[1] || 'web' };
    });
  }

  async revision(id: string, hash: string) {
    if (!validHash.test(hash)) throw new HttpError(400, '历史版本格式不正确');
    const revisions = await this.history(id);
    const index = revisions.findIndex(r => r.hash === hash);
    if (index < 0) throw new HttpError(404, '没有找到这个历史版本');
    const raw = await this.git(['show', `${hash}:issues/${id}.md`]);
    const before = index + 1 < revisions.length ? await this.git(['show', `${revisions[index + 1].hash}:issues/${id}.md`]) : '';
    return { issue: this.decode(raw), markdown: raw, diff: diffLines(before, raw) };
  }

  async restore(id: string, hash: string, version: number, source = 'web') {
    return this.serialize(async () => {
      const current = await this.get(id);
      this.checkVersion(current, version);
      const revision = await this.revision(id, hash);
      const issue = { ...revision.issue, id, createdAt: current.createdAt,
        version: current.version + 1, updatedAt: new Date().toISOString() };
      return this.persist(issue, `${sourceLabel(source)} · ${id} · 恢复版本 ${hash.slice(0, 7)}`, source, current);
    });
  }

  async checkAttachments(attachments: Attachment[]) {
    for (const attachment of attachments) {
      const filename = attachment.url.slice('/attachments/'.length);
      try { await stat(path.join(this.root, 'attachments', filename)); }
      catch { throw new HttpError(400, `附件“${attachment.name}”在此工作台不存在，请重新上传。`); }
    }
  }

  async upload(buffer: Buffer, name: string, mime: string): Promise<Attachment> {
    const allowed: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg',
      'image/webp': 'webp', 'image/gif': 'gif', 'application/pdf': 'pdf',
      'text/plain': 'txt', 'video/mp4': 'mp4', 'video/webm': 'webm' };
    const extension = allowed[mime];
    if (!extension) throw new HttpError(400, '支持 PNG、JPG、WebP、GIF、PDF、TXT、MP4 和 WebM，单个文件不超过 10 MB。');
    return this.serialize(async () => {
      const id = randomUUID();
      const filename = `${id}.${extension}`;
      const target = path.join(this.root, 'attachments', filename);
      const safeName = path.basename(name.replaceAll('\\', '/')).slice(0, 255) || `附件.${extension}`;
      await writeFile(target, buffer);
      try { await this.git(['add', '--', `attachments/${filename}`]); await this.commit(`上传附件 · ${safeName}`, 'web'); }
      catch (err) { await unlink(target); await this.git(['reset', '--', `attachments/${filename}`]).catch(() => {}); throw err; }
      return { id, name: safeName, url: `/attachments/${filename}`, mime, size: buffer.length };
    });
  }

  async health() {
    const head = await this.git(['rev-parse', '--short', 'HEAD']);
    return { storage: 'markdown', history: 'git', head };
  }
}
