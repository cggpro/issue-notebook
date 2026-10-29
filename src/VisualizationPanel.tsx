import { useEffect, useRef, useState } from 'react';
import { AlertCircle, ChartNetwork, Cpu, GitCommitHorizontal, Pencil, RefreshCw, ScanEye, Sparkles, TriangleAlert } from 'lucide-react';
import type { VisualizationDocument } from '../shared/visualization';
import { api, dateTime } from './api';
import { Spinner } from './components';
import { VisualizationGraphView } from './VisualizationGraph';
import './visualization.css';

interface Props {
  issueId: string;
  issueVersion: number;
  editing: boolean;
  notify?: (message: string, error?: boolean) => void;
}

type Failure = { message: string; retry: 'load' | 'auto' | 'manual' };

const verificationLabels = { passed: '通过', failed: '失败', pending: '待验证', unknown: '未记录' } as const;

function EmptySection({ text = '暂无内容' }: { text?: string }) {
  return <div className="viz-empty"><span>{text}</span></div>;
}

export default function VisualizationPanel({ issueId, issueVersion, editing, notify }: Props) {
  const [document, setDocument] = useState<VisualizationDocument | null>(null);
  const [configured, setConfigured] = useState(true);
  const [configurationMessage, setConfigurationMessage] = useState('');
  const [stale, setStale] = useState(false);
  const [stage, setStage] = useState<'loading' | 'idle' | 'generating'>('loading');
  const [failure, setFailure] = useState<Failure | null>(null);
  const [reload, setReload] = useState(0);
  const operation = useRef<{ run: number; controller: AbortController } | null>(null);

  function beginOperation() {
    operation.current?.controller.abort();
    const controller = new AbortController();
    const run = (operation.current?.run ?? 0) + 1;
    operation.current = { run, controller };
    return { run, controller };
  }
  const isCurrent = (run: number, controller: AbortController) => operation.current?.run === run && !controller.signal.aborted;

  async function generate(force: boolean, run: number, controller: AbortController) {
    setStage('generating');
    setFailure(null);
    try {
      const next = await api.generateVisualization(issueId, force, controller.signal);
      if (!isCurrent(run, controller)) return;
      setDocument(next);
      setStale(false);
      setStage('idle');
      if (force) notify?.('可视化已重新生成');
    } catch (error) {
      if (!isCurrent(run, controller)) return;
      setStage('idle');
      setFailure({ message: (error as Error).message, retry: force ? 'manual' : 'auto' });
    }
  }

  useEffect(() => {
    const { run, controller } = beginOperation();
    setStage('loading');
    setFailure(null);
    setStale(false);
    void (async () => {
      let next;
      try {
        next = await api.visualization(issueId, controller.signal);
      } catch (error) {
        if (!isCurrent(run, controller)) return;
        setStage('idle');
        setFailure({ message: (error as Error).message, retry: 'load' });
        return;
      }
      if (!isCurrent(run, controller)) return;
      setConfigured(next.configured);
      setConfigurationMessage(next.configurationMessage ?? '');
      setDocument(next.document && next.document.issueId === issueId ? next.document : null);
      setStale(next.stale);
      if (!next.configured) { setStage('idle'); return; }
      // A POST joins the server's existing task when another reader is generating.
      if (!next.document || next.stale || next.generating) await generate(false, run, controller);
      else setStage('idle');
    })();
    return () => controller.abort();
    // A saved issue changes issueVersion, which rechecks the visualization.
  }, [issueId, issueVersion, reload]);

  useEffect(() => () => operation.current?.controller.abort(), []);

  function regenerate(force: boolean) {
    if (!configured) return;
    const { run, controller } = beginOperation();
    void generate(force, run, controller);
  }
  function retry() {
    if (!failure) return;
    if (failure.retry === 'load') { setReload(value => value + 1); return; }
    regenerate(failure.retry === 'manual');
  }

  const visibleDocument = document && document.issueId === issueId ? document : null;
  const data = visibleDocument?.data;
  const busy = stage === 'generating';
  const loading = stage === 'loading';
  const outdated = Boolean(visibleDocument && stale);
  const retryLabel = failure?.retry === 'load' ? '重新加载' : failure?.retry === 'manual' ? '再次重试' : '重试生成';

  return <section className="viz-panel" aria-label="问题可视化">
    <header className="viz-panel-head">
      <div className="viz-panel-title">
        <div className="viz-kicker"><ScanEye size={13} />VISUAL SUMMARY</div>
        <h2>问题可视化</h2>
        <p>把业务流程、预期与实际、根因与修改、验证结果放在同一视图里。</p>
      </div>
      <div className="viz-panel-actions">
        {busy && <span className="viz-status-chip" role="status"><Spinner />正在生成</span>}
        <button type="button" className="button viz-regenerate" disabled={!configured || busy || loading} onClick={() => regenerate(true)}>
          {busy && !failure ? <Spinner /> : <RefreshCw size={15} />}重新生成
        </button>
      </div>
    </header>

    {visibleDocument && <div className="viz-meta">
      <span title={visibleDocument.generatedAt}>生成于 {dateTime(visibleDocument.generatedAt)}</span>
      <span><Cpu size={12} />{visibleDocument.model}</span>
      <span><ChartNetwork size={12} />基于问题 v{visibleDocument.sourceVersion}</span>
      <span className="viz-meta-commit" title={visibleDocument.sourceCommit}><GitCommitHorizontal size={12} />{visibleDocument.sourceCommit.slice(0, 7)}</span>
      {outdated && <span className="viz-meta-stale">待更新</span>}
    </div>}

    {editing && <div className="viz-notice editing"><Pencil size={15} /><div><strong>编辑中，只展示已保存版本</strong><p>当前可视化基于已保存的 v{issueVersion}；保存修改后会自动检查并更新。</p></div></div>}

    {failure && <div className="viz-notice error" role="alert"><AlertCircle size={15} /><div><strong>{failure.retry === 'load' ? '暂时无法读取可视化' : '生成可视化失败'}</strong><p>{failure.message}</p>{visibleDocument && failure.retry !== 'load' && <p>失败时保留了上一版内容，可以直接重试或稍后再试。</p>}</div><button type="button" className="text-button viz-notice-action" onClick={retry}>{retryLabel}</button></div>}

    {!configured && <div className="viz-notice warning"><TriangleAlert size={15} /><div><strong>尚未配置可视化生成</strong><p>{configurationMessage || '服务端还没有返回配置说明。配置完成后再进入此页即可尝试生成。'}</p></div></div>}

    {outdated && !busy && <div className="viz-notice warning"><TriangleAlert size={15} /><div><strong>问题内容已更新</strong><p>当前展示基于 v{visibleDocument?.sourceVersion}，问题已保存为 v{issueVersion}。重新生成后会同步最新内容。</p></div><button type="button" className="text-button viz-notice-action" onClick={() => regenerate(true)}>重新生成</button></div>}

    {loading && visibleDocument && <div className="viz-notice"><Spinner /><div><strong>正在检查最新版本</strong><p>已展示上一版内容，检查完成后会自动更新。</p></div></div>}


    {loading && !visibleDocument ? <div className="viz-loading" role="status"><Spinner /><span>正在读取可视化…</span></div> : visibleDocument ? <>
      {busy && <div className="viz-progress" role="status"><span className="viz-progress-track"><i /></span><span>正在生成新的可视化，旧版暂时保留。</span></div>}

      <section className="viz-section" aria-labelledby="viz-process-title">
        <header className="viz-section-head">
          <span className="viz-section-index">01</span>
          <div className="viz-section-title"><h3 id="viz-process-title">业务流程</h3><p>从触发到结果的真实路径，箭头表示方向，分支表示不同选择。</p></div>
          {!!data?.process.nodes.length && <span className="viz-section-count">{data.process.nodes.length} 节点 · {data.process.edges.length} 连线</span>}
        </header>
        <div className="viz-section-body">
          {data?.process.nodes.length ? <VisualizationGraphView graph={data.process} title="业务流程" /> : <EmptySection />}
        </div>
      </section>

      <section className="viz-section" aria-labelledby="viz-comparison-title">
        <header className="viz-section-head">
          <span className="viz-section-index">02</span>
          <div className="viz-section-title"><h3 id="viz-comparison-title">预期与实际</h3><p>逐项对照，避免把预期结果当成已经发生的事实。</p></div>
          {!!data?.comparison.length && <span className="viz-section-count">{data.comparison.length} 组对照</span>}
        </header>
        <div className="viz-section-body">
          {data?.comparison.length ? <div className="viz-compare">
            {data.comparison.map((row, index) => <article className="viz-compare-row" key={`${row.aspect}-${index}`}>
              <h4>{row.aspect}</h4>
              <div className="viz-compare-pair">
                <div className="viz-compare-side expected"><span>预期</span><p>{row.expected || '未记录'}</p></div>
                <div className="viz-compare-side actual"><span>实际</span><p>{row.actual || '未记录'}</p></div>
              </div>
            </article>)}
          </div> : <EmptySection />}
        </div>
      </section>

      <section className="viz-section" aria-labelledby="viz-causality-title">
        <header className="viz-section-head">
          <span className="viz-section-index">03</span>
          <div className="viz-section-title"><h3 id="viz-causality-title">根因与修改</h3><p>从问题回溯原因，再落到前端或后端的改动。</p></div>
          {!!data?.causality.nodes.length && <span className="viz-section-count">{data.causality.nodes.length} 节点 · {data.causality.edges.length} 连线</span>}
        </header>
        <div className="viz-section-body">
          {data?.causality.nodes.length ? <VisualizationGraphView graph={data.causality} title="根因与修改" /> : <EmptySection />}
        </div>
      </section>

      <section className="viz-section" aria-labelledby="viz-verification-title">
        <header className="viz-section-head">
          <span className="viz-section-index">04</span>
          <div className="viz-section-title"><h3 id="viz-verification-title">验证矩阵</h3><p>每个场景的预期、实际结果和覆盖范围，状态保持独立记录。</p></div>
          {!!data?.verification.length && <span className="viz-section-count">{data.verification.length} 条</span>}
        </header>
        <div className="viz-section-body">
          {data?.verification.length ? <div className="viz-matrix-scroll">
            <table className="viz-matrix">
              <thead><tr><th scope="col">场景</th><th scope="col">预期</th><th scope="col">实际结果</th><th scope="col">范围</th><th scope="col">状态</th></tr></thead>
              <tbody>{data.verification.map((row, index) => <tr key={`${row.scenario}-${index}`}>
                <th scope="row">{row.scenario}</th>
                <td>{row.expected || '未记录'}</td>
                <td>{row.result || '未记录'}</td>
                <td className="viz-matrix-scope">{row.scope || '—'}</td>
                <td><span className={`viz-status viz-status-${row.status}`}><i aria-hidden="true" />{verificationLabels[row.status]}</span></td>
              </tr>)}</tbody>
            </table>
          </div> : <EmptySection />}
        </div>
      </section>
    </> : busy ? <div className="viz-loading" role="status"><Spinner /><span>正在整理流程、对照与验证信息…</span><small>通常需要几十秒，生成后会自动保存。</small></div> : <div className="viz-empty viz-empty-panel">
      <Sparkles size={20} />
      <span>暂无内容</span>
      {configured && !failure && <button type="button" className="text-button" onClick={() => regenerate(true)}>生成可视化</button>}
    </div>}
  </section>;
}
