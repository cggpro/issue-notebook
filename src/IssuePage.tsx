import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Copy, Download, Pencil, Check, GitCommitHorizontal, RotateCcw, Clock3, FileText, PanelsTopLeft, Code2, CircleCheck, ChevronDown, ChartNetwork } from 'lucide-react';
import { emptyDraft, issueTypes, issueStatuses, requirements, progressStates, priorities, assigneeOptions, type Issue, type IssueDraft, type Revision } from '../shared/model';
import { api, asDraft, copyText, downloadMarkdown, dateTime, ApiError } from './api';
import { Assignees, Attachments, Field, Markdown, Modal, ModuleTag, Spinner, Status } from './components';
import VisualizationPanel from './VisualizationPanel';

interface Props {
  issue?: Issue;
  onClose: () => void;
  onSaved: (issue: Issue) => void;
  notify: (message: string, error?: boolean) => void;
  registerGuard: (guard: () => boolean) => () => void;
}
export default function IssuePage({ issue, onClose, onSaved, notify, registerGuard }: Props) {
  const [current, setCurrent] = useState(issue);
  const [draft, setDraft] = useState<IssueDraft>(() => issue ? asDraft(issue) : emptyDraft());
  const [baseline, setBaseline] = useState(() => JSON.stringify(issue ? asDraft(issue) : emptyDraft()));
  const [editing, setEditing] = useState(!issue);
  const [tab, setTab] = useState<'details' | 'plans' | 'visualization' | 'history'>('details');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [history, setHistory] = useState<Revision[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [revision, setRevision] = useState<Awaited<ReturnType<typeof api.revision>>>();
  const [revisionHash, setRevisionHash] = useState('');
  const [revisionBusy, setRevisionBusy] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const dirty = JSON.stringify(draft) !== baseline;
  const canLeave = useRef<() => boolean>(() => true);
  canLeave.current = () => {
    if (busy || uploading) { notify('请等待保存或附件上传完成。', true); return false; }
    return !(editing && dirty) || window.confirm('还有未保存的内容，确定离开吗？');
  };
  useEffect(() => registerGuard(() => canLeave.current()), [registerGuard]);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    function beforeUnload(e: BeforeUnloadEvent) { if ((editing && dirty) || uploading) { e.preventDefault(); e.returnValue = ''; } }
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty, editing, uploading]);
  useEffect(() => {
    if (tab !== 'history' || !current) return;
    let active = true;
    setLoadingHistory(true);
    api.history(current.id).then(data => { if (active) setHistory(data.revisions); }).catch(e => { if (active) notify(e.message, true); }).finally(() => { if (active) setLoadingHistory(false); });
    return () => { active = false; };
  }, [tab, current?.version]);

  function set<K extends keyof IssueDraft>(key: K, value: IssueDraft[K]) { setDraft(d => ({ ...d, [key]: value })); }
  function saved(next: Issue) {
    setCurrent(next); setDraft(asDraft(next)); setBaseline(JSON.stringify(asDraft(next))); setEditing(false); setConflict(false); onSaved(next);
  }
  async function save(event?: React.FormEvent) {
    event?.preventDefault();
    if (busy || uploading) return;
    if (!draft.title.trim()) { notify('请先填写问题标题。', true); setTab('details'); return; }
    setBusy(true);
    try { saved(current ? await api.update(current.id, draft, current.version) : await api.create(draft)); notify(current ? '修改已保存' : '问题已记录'); }
    catch (error) { if (error instanceof ApiError && error.status === 409) setConflict(true); notify((error as Error).message, true); }
    finally { setBusy(false); }
  }
  async function copy() {
    if (!current) return;
    try { await copyText(await api.markdown(current.id)); notify('已复制完整 Markdown，可直接粘贴给 AI Agent'); } catch (e) { notify((e as Error).message, true); }
  }
  async function reloadConflict() {
    if (!current) return;
    if (!window.confirm('重新加载会替换当前未保存的内容。你可以先选择“下载当前草稿”保留内容。确定继续吗？')) return;
    try { saved(await api.get(current.id)); notify('已加载最新版本'); } catch (e) { notify((e as Error).message, true); }
  }
  async function showRevision(hash: string) {
    setRevisionBusy(true);
    try { setRevision(await api.revision(current!.id, hash)); setRevisionHash(hash); } catch (e) { notify((e as Error).message, true); }
    finally { setRevisionBusy(false); }
  }
  async function restore() {
    if (!current || !revision) return;
    setRevisionBusy(true);
    try { saved(await api.restore(current.id, revisionHash, current.version)); setRevision(undefined); notify('已恢复历史内容，并保留为一次新修改'); }
    catch (e) { notify((e as Error).message, true); }
    finally { setRevisionBusy(false); }
  }
  function downloadDraft() {
    const text = `# ${draft.title}\n\n当前未保存草稿（基于 ${current?.id || '新问题'} v${current?.version || 0}）\n\n` + Object.entries(draft).filter(([k]) => k !== 'title' && k !== 'attachments').map(([k, v]) => `## ${k}\n\n${v}`).join('\n\n');
    downloadMarkdown(text, `${current?.id || '新问题'}-未保存草稿.md`);
  }
  const changeField = (label: string, field: keyof Pick<IssueDraft, 'description' | 'process' | 'expected' | 'actual' | 'rootCause' | 'verification' | 'notes'>, rows = 4, placeholder?: string) => <Field label={label} key={field} hint="支持 Markdown"><textarea rows={rows} value={draft[field]} onChange={e => set(field, e.target.value)} placeholder={placeholder || '后续补充也可以…'} /></Field>;

  return <>
    <div className="issue-page-navigation"><button className="back-to-list" onClick={onClose} disabled={busy || uploading}><ArrowLeft size={16} />返回问题列表</button><span>{current?.id || '新问题'}{current && <span className="version-label">v{current.version}</span>}</span></div>
    <article className="issue-page" aria-label={current ? '问题详情' : '提交问题'}>
      <header className="panel-header">
        <div className="issue-heading-content"><div className="panel-eyebrow">{current ? '问题记录' : '记录一个新发现'}</div>
        <h1 ref={heading} tabIndex={-1}>{current ? current.title : '提交问题'}</h1>
        {current ? <div className="panel-meta"><Status value={current.type} /><Status value={current.status} /><span>更新于 {dateTime(current.updatedAt)}</span></div> : <p className="panel-intro">先记录发生了什么，分析和方案可以慢慢补充。</p>}</div>
        {current && <div className="panel-actions"><button className="button" onClick={() => void copy()}><Copy size={15} />复制 Markdown</button><button className="button" onClick={() => void api.markdown(current.id).then(text => downloadMarkdown(text, `${current.id}.md`)).catch(e => notify(e.message, true))}><Download size={15} />下载</button><button disabled={busy || uploading} className={`button ${editing ? 'active' : ''}`} onClick={() => { if (editing && dirty && !window.confirm('放弃当前未保存的修改吗？')) return; if (editing) { setDraft(asDraft(current)); setConflict(false); } setEditing(!editing); if (tab === 'history') setTab('details'); }}><Pencil size={15} />{editing ? '取消编辑' : '编辑问题'}</button></div>}
      </header>
      <nav className="panel-tabs" aria-label="问题内容"><button className={tab === 'details' ? 'selected' : ''} onClick={() => setTab('details')}><FileText size={15} />问题详情</button><button className={tab === 'plans' ? 'selected' : ''} onClick={() => setTab('plans')}><PanelsTopLeft size={15} />修改方案</button>{current && <button type="button" className={tab === 'visualization' ? 'selected' : ''} onClick={() => setTab('visualization')}><ChartNetwork size={15} />可视化</button>}{current && <button className={tab === 'history' ? 'selected' : ''} onClick={() => setTab('history')}><Clock3 size={15} />变更记录</button>}</nav>
      <div className="panel-scroll">
        {conflict && <div className="notice warning"><strong>问题已被其他操作更新</strong><p>当前输入仍然保留。先下载草稿，再加载最新内容进行合并。</p><div className="inline-actions"><button className="text-button" onClick={downloadDraft}>下载当前草稿</button><button className="text-button" onClick={() => void reloadConflict()}>加载最新版本</button></div></div>}
        <form id="issue-form" onSubmit={save}>
          {tab === 'details' && (editing ? <div className="form-stack">
            <Field label="问题标题" required><input name="title" maxLength={200} value={draft.title} onChange={e => set('title', e.target.value)} placeholder="用一句话描述问题" /></Field>
            <div className="form-row"><Field label="问题类型"><select name="type" value={draft.type} onChange={e => set('type', e.target.value as IssueDraft['type'])}>{issueTypes.map(v => <option key={v}>{v}</option>)}</select></Field><Field label="所属模块"><input name="module" maxLength={100} value={draft.module} onChange={e => set('module', e.target.value)} placeholder="如：订单、登录" /></Field></div>
            {current && <div className="form-row"><Field label="当前状态"><select name="status" value={draft.status} onChange={e => set('status', e.target.value as IssueDraft['status'])}>{issueStatuses.map(v => <option key={v}>{v}</option>)}</select></Field><Field label="优先级"><select name="priority" value={draft.priority} onChange={e => set('priority', e.target.value as IssueDraft['priority'])}>{priorities.map(v => <option key={v}>{v}</option>)}</select></Field></div>}
            <div className="field assignee-field" role="group" aria-labelledby="assignees-label" aria-describedby="assignees-hint">
              <span className="field-label" id="assignees-label">负责人<small id="assignees-hint">可多选，至少选择一项</small></span>
              <div className="assignee-options">{assigneeOptions.map(value => <label key={value} className={`assignee-option assignee-tone ${value === '前端' ? 'frontend' : 'backend'} ${draft.assignees.includes(value) ? 'selected' : ''}`}>
                <input type="checkbox" name="assignees" value={value} checked={draft.assignees.includes(value)} disabled={draft.assignees.length === 1 && draft.assignees.includes(value)} onChange={e => set('assignees', assigneeOptions.filter(option => option === value ? e.target.checked : draft.assignees.includes(option)))} />{value}
              </label>)}</div>
            </div>
            {changeField('问题描述', 'description', 6, '发生了什么？原本希望怎样？')}
            <Field label="截图与附件" hint="可选"><Attachments files={draft.attachments} onChange={v => set('attachments', v)} onError={m => notify(m, true)} onBusy={setUploading} /></Field>
            <details className="optional-fields" open={current ? true : undefined}><summary>补充业务流程与分析 <ChevronDown size={15} /></summary><div className="form-stack">{changeField('业务流程与复现步骤', 'process')}{changeField('预期结果', 'expected', 3)}{changeField('实际结果', 'actual', 3)}{changeField('根因分析', 'rootCause')}{changeField('验证结果', 'verification', 3)}{changeField('补充说明', 'notes', 3)}</div></details>
          </div> : current && <div className="detail-stack">
            <div className="info-strip"><span>所属模块<strong><ModuleTag value={current.module} /></strong></span><span>负责人<strong><Assignees values={current.assignees} /></strong></span><span>优先级<strong className={current.priority === '紧急' ? 'urgent-text' : ''}>{current.priority}</strong></span><span>创建时间<strong>{dateTime(current.createdAt)}</strong></span></div>
            <section className="detail-section description-section"><h3>问题描述</h3><Markdown text={current.description} /></section>
            {!!current.attachments.length && <section className="detail-section"><h3>截图与附件 <small>{current.attachments.length}</small></h3><Attachments files={current.attachments} onError={m => notify(m, true)} /></section>}
            <section className="detail-section process-section"><h3>业务流程与复现步骤</h3><Markdown text={current.process} placeholder="还没有补充复现步骤" /></section>
            {(current.expected || current.actual) && <div className="results-grid"><section><h3>预期结果</h3><Markdown text={current.expected} /></section><section><h3>实际结果</h3><Markdown text={current.actual} /></section></div>}
            <section className="detail-section analysis-section"><h3><Code2 size={18} />根因分析</h3><Markdown text={current.rootCause} placeholder="等待排查，结论确认后记录在这里。" /></section>
            <section className="detail-section"><h3>验证结果</h3><Markdown text={current.verification} placeholder="完成修改后，记录测试结果。" /></section>
            {current.notes && <section className="detail-section"><h3>补充说明</h3><Markdown text={current.notes} /></section>}
          </div>)}
          {tab === 'plans' && <div className="plans-stack"><p className="section-intro">前后端分别记录，需要修改时再填写方案。</p>{(['frontend', 'backend'] as const).map(side => {
            const label = side === 'frontend' ? '前端' : '后端';
            const requiredKey = `${side}Required` as const, statusKey = `${side}Status` as const, planKey = `${side}Plan` as const;
            return <section className="plan-card" key={side}><h3><span className={`plan-icon ${side}`}>{side === 'frontend' ? <PanelsTopLeft size={18} /> : <Code2 size={18} />}</span>{label}处理{!editing && <span className="plan-state">{draft[requiredKey] === '需要' ? draft[statusKey] : draft[requiredKey]}</span>}</h3>{editing ? <div className="form-stack"><div className="form-row"><Field label="是否需要修改"><select name={`${side}Required`} value={draft[requiredKey]} onChange={e => set(requiredKey, e.target.value as IssueDraft[typeof requiredKey])}>{requirements.map(v => <option key={v}>{v}</option>)}</select></Field><Field label="处理进度"><select name={`${side}Status`} value={draft[statusKey]} disabled={draft[requiredKey] === '不需要'} onChange={e => set(statusKey, e.target.value as IssueDraft[typeof statusKey])}>{progressStates.map(v => <option key={v}>{v}</option>)}</select></Field></div><Field label="修改方案" hint="支持 Markdown"><textarea rows={7} name={`${side}Plan`} value={draft[planKey]} onChange={e => set(planKey, e.target.value)} placeholder="需要调整哪里？准备怎样修改？" /></Field></div> : <Markdown text={draft[planKey]} placeholder={draft[requiredKey] === '不需要' ? `已确认无需${label}修改。` : '方案待补充'} />}</section>;
          })}</div>}
        </form>
        {tab === 'visualization' && current && <VisualizationPanel key={current.id} issueId={current.id} issueVersion={current.version} editing={editing} notify={notify} />}
        {tab === 'history' && <div className="history"><div className="history-intro"><GitCommitHorizontal size={18} /><div><strong>每一次修改，都有记录</strong><p>可以对比变更，也可以恢复到之前的内容。</p></div></div>{loadingHistory ? <div className="center-loading"><Spinner /></div> : <ol className="timeline">{history.map((item, index) => <li key={item.hash}><span className="timeline-dot" /><div className="revision-heading"><span>{item.source === 'agent' ? 'AI Agent' : '网页操作'}{index === 0 && <em>最新</em>}</span><time>{dateTime(item.date)}</time></div><p>{item.summary.replace(/^(网页|Agent) · /, '').replace(`${current!.id} · `, '')}</p><button className="text-button" disabled={revisionBusy} onClick={() => void showRevision(item.hash)}><span className="mono">{item.hash.slice(0, 7)}</span>查看变更</button></li>)}</ol>}</div>}
      </div>
      <footer className="panel-footer"><span className="save-hint">{editing ? (dirty ? <><i className="unsaved-dot" />有未保存的修改</> : '填写后点击保存') : <><Check size={14} />已保存 · 修改历史可追溯</>}</span>{editing ? <button className="button primary" type="submit" form="issue-form" disabled={busy || uploading}>{busy || uploading ? <Spinner /> : <Check size={16} />}{uploading ? '附件上传中…' : current ? '保存修改' : '提交问题'}</button> : current && <button className="button primary" disabled={busy} onClick={async () => {
        setBusy(true);
        const status = ({ 待处理: '处理中', 处理中: '待验证', 待验证: '已关闭', 已关闭: '待处理' } as const)[current.status];
        try { saved(await api.update(current.id, { ...asDraft(current), status }, current.version)); notify(`已更新为${status}`); } catch (e) { notify((e as Error).message, true); } finally { setBusy(false); }
      }}>{busy ? <Spinner /> : current.status === '已关闭' ? <RotateCcw size={16} /> : <CircleCheck size={16} />}{({ 待处理: '开始处理', 处理中: '提交验证', 待验证: '验证通过，关闭', 已关闭: '重新打开' } as const)[current.status]}</button>}</footer>
    </article>
    {revision && <Modal title="查看历史变更" subtitle={`${current?.id} · ${revisionHash.slice(0, 7)}`} wide onClose={() => { if (!revisionBusy) setRevision(undefined); }} footer={<><button className="button" onClick={() => setRevision(undefined)} disabled={revisionBusy}>返回</button><button className="button primary" disabled={revisionBusy || editing} onClick={() => { if (window.confirm('将恢复这个版本的内容，并保留为一次新的修改。确定恢复吗？')) void restore(); }}>{revisionBusy ? <Spinner /> : <RotateCcw size={15} />}恢复此版本</button></>}>
      {editing && <div className="notice">请先保存或取消当前编辑，再恢复历史内容。</div>}
      <div className="diff-legend"><span className="diff-added">新增</span><span className="diff-removed">删除</span><span>与上一次保存对比</span></div><pre className="diff-view">{revision.diff.map((part, i) => <span key={i} className={part.added ? 'added' : part.removed ? 'removed' : ''}>{part.value}</span>)}</pre>
    </Modal>}
  </>;
}
