import type { Issue } from '../shared/model.js';
import {
  visualizationDataSchema,
  visualizationDocumentSchema,
  type VisualizationData,
  type VisualizationDocument,
  type VisualizationState,
} from '../shared/visualization.js';
import type { IssueStore } from './store.js';
import { HttpError } from './schema.js';

/** A generator can be injected by tests or backed by a real model in server/index.ts. */
export interface VisualizationGenerator {
  readonly model: string;
  generate(issue: Issue): Promise<VisualizationData>;
}

export interface VisualizationOptions {
  generator?: VisualizationGenerator;
  configurationMessage?: string;
}

/**
 * Visualization failures are HttpErrors so status semantics stay consistent, but the
 * visualization routes handle them directly before the global >=500 mask can hide
 * the friendly message. Other routes keep their existing behavior.
 */
export class VisualizationError extends HttpError {
  constructor(public override statusCode: number, message: string) {
    super(statusCode, message);
    this.name = 'VisualizationError';
  }
}

const DEFAULT_CONFIGURATION_MESSAGE = '未配置 AI 可视化生成服务。请设置 ZHIPU_API_KEY 环境变量后重启服务。';

export class VisualizationService {
  private readonly inflight = new Map<string, Promise<VisualizationDocument>>();
  private readonly generator?: VisualizationGenerator;
  private readonly configurationMessage?: string;

  constructor(private readonly store: IssueStore, options: VisualizationOptions = {}) {
    this.generator = options.generator && options.generator.model.trim() ? options.generator : undefined;
    this.configurationMessage = options.configurationMessage;
  }

  private get configured() {
    return Boolean(this.generator);
  }

  private get message() {
    return this.configurationMessage || DEFAULT_CONFIGURATION_MESSAGE;
  }

  async getState(id: string): Promise<VisualizationState> {
    // Only the snapshot runs inside store serialization; the cache is a plain read.
    const snapshot = await this.store.withIssueSnapshot(id, current => Promise.resolve(current));
    const document = await this.store.getVisualization(id);
    return {
      document,
      sourceCommit: snapshot.commit,
      stale: document ? document.sourceCommit !== snapshot.commit : false,
      configured: this.configured,
      ...(this.configured ? {} : { configurationMessage: this.message }),
      generating: this.inflight.has(id),
    };
  }

  /**
   * All concurrent requests for one issue share the same promise, including forced
   * refreshes. Only one map exists per app instance, so callers cannot race writes.
   */
  async generate(id: string, force = false): Promise<VisualizationDocument> {
    const running = this.inflight.get(id);
    if (running) return running;
    const task = this.run(id, force);
    this.inflight.set(id, task);
    try {
      return await task;
    } finally {
      if (this.inflight.get(id) === task) this.inflight.delete(id);
    }
  }

  private async run(id: string, force: boolean): Promise<VisualizationDocument> {
    let snapshot = await this.store.withIssueSnapshot(id, current => Promise.resolve(current));
    if (!force) {
      const cached = await this.store.getVisualization(id);
      if (cached && cached.sourceCommit === snapshot.commit) return cached;
    }
    if (!this.generator) throw new VisualizationError(503, this.message);

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (attempt > 1) {
        snapshot = await this.store.withIssueSnapshot(id, current => Promise.resolve(current));
      }
      // Network/model work happens outside store.serialize(); only snapshots and
      // the final compare-and-write critical section are serialized.
      const data = await this.generateData(snapshot.issue);
      const result = await this.store.withIssueSnapshot(id, async current => {
        if (current.commit !== snapshot.commit) return { changed: true as const };
        const document = visualizationDocumentSchema.parse({
          formatVersion: 1,
          issueId: id,
          sourceCommit: current.commit,
          sourceVersion: current.issue.version,
          generatedAt: new Date().toISOString(),
          model: this.generator!.model,
          data,
        });
        await this.store.saveVisualization(document);
        return { changed: false as const, document };
      });
      if (!result.changed) return result.document;
      if (attempt === 2) break;
    }
    throw new VisualizationError(409, '问题内容在生成过程中发生变化，请稍后重试。');
  }

  private async generateData(issue: Issue): Promise<VisualizationData> {
    let raw: unknown;
    try {
      raw = await this.generator!.generate(issue);
    } catch (error) {
      if (error instanceof VisualizationError) throw error;
      throw new VisualizationError(502, 'AI 生成失败，请稍后重试。');
    }
    const parsed = visualizationDataSchema.safeParse(raw);
    if (!parsed.success) {
      throw new VisualizationError(502, 'AI 返回的数据结构不符合要求，请稍后重试。');
    }
    return parsed.data;
  }
}
