import Fastify, { type FastifyReply } from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { ZodError, z } from 'zod';
import { IssueStore } from './store.js';
import { createSchema, patchSchema, importSchema, HttpError } from './schema.js';
import { serializeIssue, markdownTemplate } from './markdown.js';
import { VisualizationService, VisualizationError, type VisualizationGenerator } from './visualization.js';

export interface AppOptions {
  dataDir: string;
  apiKey?: string;
  staticDir?: string;
  logger?: boolean;
  /** Optional test injection; buildApp never loads real credentials on its own. */
  visualization?: VisualizationGenerator;
  visualizationMessage?: string;
}

export async function buildApp(options: AppOptions) {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 2 * 1024 * 1024 });
  const store = new IssueStore(options.dataDir);
  await store.init();
  const visualization = new VisualizationService(store, {
    generator: options.visualization,
    configurationMessage: options.visualizationMessage,
  });
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

  app.addHook('onRequest', async (request) => {
    if (!request.url.startsWith('/api/') && !request.url.startsWith('/attachments/')) return;
    if (request.url === '/api/health') return;
    const origin = request.headers.origin;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && origin) {
      try {
        if (new URL(origin).host !== request.headers.host) throw new Error('origin');
      } catch { throw new HttpError(403, '不允许来自其他网站的写入请求'); }
    }
    if (options.apiKey) {
      let cookieKey = '';
      try { cookieKey = decodeURIComponent((request.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('issue-note-key='))?.slice(15) || ''); } catch { /* Malformed cookies do not authenticate. */ }
      const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, '') || cookieKey;
      const left = Buffer.from(supplied), right = Buffer.from(options.apiKey);
      if (left.length !== right.length || !timingSafeEqual(left, right)) throw new HttpError(401, '请输入工作台访问密钥');
    }
  });

  app.addHook('onSend', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('Cache-Control', 'no-store');
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('；') });
    }
    const status = (error as { statusCode?: number }).statusCode || 500;
    if (status >= 500) app.log.error(error);
    return reply.code(status).send({ error: status >= 500 ? '保存或读取失败，请检查服务日志和数据目录权限。' : (error as Error).message });
  });

  const idOf = (params: unknown) => z.object({ id: z.string().regex(/^ISSUE-\d{4,}$/) }).parse(params).id;
  const sourceOf = (headers: Record<string, unknown>) => headers['x-client-source'] === 'web' ? 'web' : 'agent';

  app.get('/api/health', async () => ({ ok: true, ...await store.health(), authRequired: Boolean(options.apiKey) }));
  app.post('/api/session', async (_req, reply) => {
    if (options.apiKey) reply.header('Set-Cookie', `issue-note-key=${encodeURIComponent(options.apiKey)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`);
    return { ok: true };
  });
  app.get('/api/template', async (_req, reply) => reply.type('text/markdown; charset=utf-8').send(markdownTemplate));
  app.get('/api/issues', async request => {
    const query = z.object({ q: z.string().optional(), type: z.string().optional(), status: z.string().optional(), module: z.string().optional() }).parse(request.query);
    let issues = await store.list();
    if (query.q) {
      const q = query.q.toLocaleLowerCase();
      issues = issues.filter(i => [i.id, i.title, i.description, i.module, i.rootCause].join(' ').toLocaleLowerCase().includes(q));
    }
    for (const field of ['type', 'status', 'module'] as const) if (query[field]) issues = issues.filter(i => i[field] === query[field]);
    return { issues: issues.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) };
  });
  app.post('/api/issues/import', async (request, reply) => {
    const data = importSchema.parse(request.body);
    if (data.preview) return store.preview(data.markdown);
    const result = await store.import(data.markdown, data.expectedVersion, sourceOf(request.headers));
    return reply.code(200).send(result);
  });
  app.post('/api/issues', async (request, reply) => {
    const issue = await store.create(createSchema.parse(request.body), sourceOf(request.headers));
    return reply.code(201).send(issue);
  });
  app.get('/api/issues/:id', async request => store.get(idOf(request.params)));
  app.patch('/api/issues/:id', async request => {
    const { version, ...patch } = patchSchema.parse(request.body);
    return store.update(idOf(request.params), patch, version, sourceOf(request.headers));
  });
  app.get('/api/issues/:id/markdown', async (request, reply) => {
    const issue = await store.get(idOf(request.params));
    return reply.type('text/markdown; charset=utf-8').send(serializeIssue(issue));
  });
  app.get('/api/issues/:id/history', async request => ({ revisions: await store.history(idOf(request.params)) }));
  app.get('/api/issues/:id/history/:hash', async request => {
    const { hash } = z.object({ hash: z.string().regex(/^[a-f0-9]{40}$/) }).parse(request.params);
    return store.revision(idOf(request.params), hash);
  });
  app.post('/api/issues/:id/restore', async request => {
    const data = z.object({ hash: z.string().regex(/^[a-f0-9]{40}$/), version: z.number().int().positive() }).strict().parse(request.body);
    return store.restore(idOf(request.params), data.hash, data.version, sourceOf(request.headers));
  });
  // Visualization failures keep their own friendly messages instead of the global
  // 500 mask, without changing behavior of any other route.
  const runVisualization = async (reply: FastifyReply, action: () => Promise<unknown>) => {
    try { return await action(); }
    catch (error) {
      if (error instanceof VisualizationError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  };
  app.get('/api/issues/:id/visualization', async (request, reply) => {
    const id = idOf(request.params);
    return runVisualization(reply, () => visualization.getState(id));
  });
  app.post('/api/issues/:id/visualization', async (request, reply) => {
    const id = idOf(request.params);
    const body = z.object({ force: z.boolean().optional() }).strict().parse(request.body ?? {});
    return runVisualization(reply, () => visualization.generate(id, body.force ?? false));
  });
  app.post('/api/attachments', async (request, reply) => {
    const file = await request.file();
    if (!file) throw new HttpError(400, '请选择一个附件');
    const buffer = await file.toBuffer();
    if (!buffer.length) throw new HttpError(400, '不能上传空文件');
    return reply.code(201).send(await store.upload(buffer, file.filename, file.mimetype));
  });
  await app.register(fastifyStatic, {
    root: path.join(store.root, 'attachments'), prefix: '/attachments/', decorateReply: false,
    setHeaders(res, filePath) {
      if (!/\.(png|jpg|webp|gif|mp4|webm)$/i.test(filePath)) res.header('Content-Disposition', 'attachment');
      res.header('Content-Security-Policy', "default-src 'none'; sandbox");
    },
  });
  if (options.staticDir && existsSync(options.staticDir)) {
    await app.register(fastifyStatic, { root: path.resolve(options.staticDir), prefix: '/' });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/') || request.url.startsWith('/attachments/')) return reply.code(404).send({ error: '没有找到这个接口或文件' });
      if (request.method !== 'GET' || path.extname(request.url.split('?')[0])) return reply.code(404).send({ error: '没有找到这个页面' });
      return reply.sendFile('index.html');
    });
  }
  return app;
}
