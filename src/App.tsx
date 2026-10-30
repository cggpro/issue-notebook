import { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, LayoutList, CircleDashed, CircleDot, CircleCheck, FlaskConical, Plus, Search, SlidersHorizontal, ArrowUpRight, FileUp, Copy, Bot, GitBranch, ChevronRight, X, Check, AlertCircle, RefreshCw, ArrowRight, ArrowLeft, FileText, KeyRound, Terminal } from 'lucide-react';
import { issueStatuses, issueTypes, type Issue } from '../shared/model';
import { api, copyText, dateTime, request } from './api';
import { Assignees, Field, Modal, ModuleTag, Spinner, Status } from './components';
import IssuePage from './IssuePage';
import { useIssueRoute } from './useIssueRoute';
import ImportModal from './ImportModal';
import ThemeToggle from './ThemeToggle';

const statusIcons = { 待处理: CircleDashed, 处理中: CircleDot, 待验证: FlaskConical, 已关闭: CircleCheck };
function relativeDate(date: string) {
  const elapsed = Math.max(0, Date.now() - new Date(date).getTime());
  if (elapsed < 60_000) return '刚刚';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`;
  return new Date(date).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}
function Progress({ issue, side }: { issue: Issue; side: 'frontend' | 'backend' }) {
  const required = issue[`${side}Required`], status = issue[`${side}Status`];
  const label = side === 'frontend' ? '前端' : '后端';
  const progress = required === '不需要' ? '无需修改' : required === '待判断' ? '待判断' : status;
  return <span className={`mini-progress ${required === '不需要' ? 'unneeded' : required === '待判断' ? 'undecided' : status === '已完成' ? 'done' : status === '处理中' ? 'in-progress' : 'not-started'}`} title={`${label}：${progress}`}>
    {required === '需要' && status === '已完成' ? <Check size={13} /> : <i aria-hidden="true" />}<span>{label}</span><span>{progress}</span>
  </span>;
}

export default function App() {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [status, setStatus] = useState('全部问题');
  const [query, setQuery] = useState('');
  const [type, setType] = useState('全部类型');
  const [module, setModule] = useState('全部模块');
  const [showClosed, setShowClosed] = useState(false);
  const [filters, setFilters] = useState(false);
  const { issueId, navigate, registerGuard } = useIssueRoute();
  const [pageIssue, setPageIssue] = useState<Issue>();
  const [issueLoading, setIssueLoading] = useState(Boolean(issueId && issueId !== 'new'));
  const [issueError, setIssueError] = useState('');
  const [issueRetry, setIssueRetry] = useState(0);
  const [importing, setImporting] = useState(false);
  const [agent, setAgent] = useState(false);
  const [auth, setAuth] = useState(false);
  const [key, setKey] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [health, setHealth] = useState<{ ok: boolean; head: string; authRequired: boolean }>();
  const [toast, setToast] = useState<{ text: string; error: boolean }>();
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const requestCounter = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);

  function notify(text: string, error = false) {
    clearTimeout(toastTimer.current); setToast({ text, error });
    toastTimer.current = setTimeout(() => setToast(undefined), error ? 6500 : 3500);
  }
  async function refresh(initial = false) {
    const counter = ++requestCounter.current;
    if (initial) setLoading(true);
    try {
      const data = await api.list();
      if (counter === requestCounter.current) { setIssues(data.issues); setLoadError(''); }
    } catch (error) { if (counter === requestCounter.current) setLoadError((error as Error).message); }
    finally { if (counter === requestCounter.current) setLoading(false); }
    fetch('/api/health').then(r => r.json()).then(setHealth).catch(() => setHealth(undefined));
  }
  useEffect(() => {
    const needAuth = () => setAuth(true);
    window.addEventListener('issue-note-auth', needAuth);
    void refresh(true);
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 20_000);
    const onFocus = () => void refresh(); window.addEventListener('focus', onFocus);
    const shortcuts = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || document.querySelector('[role="dialog"]')) return;
      if (event.key === '/') { event.preventDefault(); searchRef.current?.focus(); }
    };
    window.addEventListener('keydown', shortcuts);
    return () => { clearInterval(timer); clearTimeout(toastTimer.current); window.removeEventListener('focus', onFocus); window.removeEventListener('keydown', shortcuts); window.removeEventListener('issue-note-auth', needAuth); };
  }, []);

  useEffect(() => {
    if (!issueId || issueId === 'new') {
      setPageIssue(undefined); setIssueError(''); setIssueLoading(false); return;
    }
    if (pageIssue?.id === issueId && issueRetry === 0) return;
    let active = true;
    setIssueLoading(true); setIssueError('');
    api.get(issueId).then(issue => { if (active) setPageIssue(issue); })
      .catch(error => { if (active) { setPageIssue(undefined); setIssueError(error.message); } })
      .finally(() => { if (active) setIssueLoading(false); });
    return () => { active = false; };
  }, [issueId, issueRetry]);
  useEffect(() => {
    document.title = issueId ? `${issueId === 'new' ? '提交问题' : pageIssue?.id === issueId ? pageIssue.title : issueId} · 问题簿` : '问题簿 · 把问题理清楚';
  }, [issueId, pageIssue?.title]);

  const counts = useMemo(() => Object.fromEntries(issueStatuses.map(s => [s, issues.filter(i => i.status === s).length])), [issues]);
  const modules = useMemo(() => [...new Set(issues.map(i => i.module).filter(Boolean))].sort(), [issues]);
  const filtered = useMemo(() => issues.filter(issue => {
    if (status !== '全部问题' && issue.status !== status) return false;
    if (status === '全部问题' && !showClosed && issue.status === '已关闭') return false;
    if (type !== '全部类型' && issue.type !== type) return false;
    if (module !== '全部模块' && (module === '未分类' ? Boolean(issue.module) : issue.module !== module)) return false;
    const q = query.trim().toLocaleLowerCase();
    return !q || [issue.id, issue.title, issue.description, issue.module, issue.rootCause].join(' ').toLocaleLowerCase().includes(q);
  }), [issues, status, showClosed, type, module, query]);
  const activeFilters = type !== '全部类型' || module !== '全部模块';
  function onSaved(issue: Issue) {
    setPageIssue(issue);
    navigate(issue.id, { replace: issueId === 'new', saved: true });
    void refresh();
  }
  function openIssue(issue: Issue) { navigate(issue.id); }
  function showList(nextStatus: string) {
    if (navigate(null)) setStatus(nextStatus);
  }
  const agentGuide = `你可以通过 HTTP API 操作“问题簿”。\n\n服务地址：${window.location.origin}\n${health?.authRequired ? '鉴权：在 Authorization 请求头中使用 Bearer <工作台访问密钥>。请向使用者索取密钥。\n' : ''}\n1. 查询：GET /api/issues?q=关键词&status=待处理\n2. 详情：GET /api/issues/{id}\n3. 创建：POST /api/issues，JSON 至少包含 title\n4. 更新：PATCH /api/issues/{id}，JSON 必须包含最近读取的 version 和要修改的字段\n5. Markdown：GET /api/issues/{id}/markdown\n6. 导入预览：POST /api/issues/import，JSON 为 {"markdown":"...","preview":true}\n7. 导入保存：POST /api/issues/import，JSON 为 {"markdown":"...","expectedVersion":当前版本}\n8. 附件：POST /api/attachments，multipart/form-data，字段 file。返回附件对象后，加入问题的 attachments 数组并保存。\n\n问题类型 type：缺陷 / 需求变更 / 待确认\n状态 status：待处理 / 处理中 / 待验证 / 已关闭\n优先级 priority：普通 / 紧急 / 较低\n文本字段：description、process、expected、actual、rootCause、frontendPlan、backendPlan、verification、notes\n模块：module\n负责人 assignees：["前端"] / ["后端"] / ["前端","后端"]，默认双方负责，至少选择一项。此字段独立于是否需要修改。\n是否修改：frontendRequired、backendRequired（待判断 / 需要 / 不需要）\n处理进度：frontendStatus、backendStatus（未开始 / 处理中 / 已完成）\n\n收到 409 表示版本冲突：先重新读取，合并内容后再更新。收到 428 表示缺少确认版本。创建和更新会自动保留 Git 历史。不要把推测写成已验证根因，不要未经确认关闭问题。

## 创建内容规范

目标：每条问题都应能脱离聊天记录独立阅读，让没参与讨论的人知道为什么提出、如何触发、实际怎样、希望怎样。以下规范同时适用于 API 创建和 Markdown 导入创建；接口只要求 title，不代表内容只需标题。

### 1. 背景与字段写法
- title：用“对象＋触发条件＋现象或目标”概括问题。例如“问题列表：修改状态并保存后，列表仍显示旧状态”，避免只写“状态更新异常”或“优化用户体验”。
- module：填写已知的所属功能模块，不确定时不要猜测。
- description：交代相关功能、使用角色、业务场景和操作目的；补充理解这条问题必需的业务规则、对象状态及已知影响。不必介绍整个项目，也不要把“这个页面”“刚才那个问题”等聊天指代直接写进去。
- process：缺陷写复现步骤，包括操作入口、前提条件、关键数据或状态、操作顺序及触发动作；需求写当前业务流程和遇到困难的具体环节。步骤应足以让读者按顺序理解或复现。
- actual：写当前可观察的行为、报错、结果或现有做法的具体限制。用户反馈与自己实际验证的结果要区分，未复现不能写成已复现。
- expected：写希望发生的具体行为和可检查的结果。需求要说明它帮助谁完成什么任务，不能只写“增加一个按钮”。
- rootCause：区分现象、推测和已验证结论。尚未排查时写“待排查”；有假设时明确标注“推测，待验证”并说明依据，不得当成已验证根因。
- notes：记录不影响登记、但仍需补充或确认的信息；待确认的问题也可在此注明确认人或角色（如已知）。
只填写与本条问题有关的内容，不为凑齐字段重复描述，也不编造方案、验证结果或影响范围。

### 2. 按问题类型组织内容
- 缺陷：讲清什么条件下，执行哪些操作，实际结果与预期哪里不同。
- 需求变更：讲清谁在什么场景遇到什么困难、目前怎么做、希望改成什么，以及要解决的实际问题。
- 待确认：讲清已知情况、具体需要确认的业务规则或行为，以及由谁确认（如已知）。尚未明确的规则要标注“待确认”。

### 3. 缺少信息时怎么处理
- 先从已有聊天、用户提供的材料及已读取的项目信息中提取事实，主动补入正文，不让用户重复提供已知信息。
- 如果缺失的信息会影响理解、复现或实现，例如操作入口、触发条件、需求目的或预期规则，创建前集中追问这些关键问题，得到答复后再整理提交。
- 如果缺失的信息不影响登记，可以先创建，在相应字段或 notes 中明确标注“待补充”或“待确认”，写明具体缺什么。
- 完整不等于编造。不要自行补出用户没提供、也没有证据支持的项目背景、操作步骤、业务规则或根因。

### 4. 表达方式
使用自然、直接的语言，以具体动作和结果说明问题。保留必要背景，避免空泛评价、口号和重复扩写：
- “优化状态同步机制，提升用户体验”应写成“保存成功后，列表中的状态应立即更新”。
- “当前交互逻辑存在不足”应写成“点击保存后弹窗关闭，但列表仍显示修改前的状态”。
- “完善异常处理能力”应写成“保存失败时保留已填写内容，并显示失败原因”。
以上是表达示例，不是待创建问题的事实；只有符合当前问题的已知情况时才使用。

假设示例（仅示范写法，不得当作当前项目的实际问题提交）：
标题：问题列表：修改状态并保存后，列表仍显示旧状态
背景（description）：处理人员在问题列表中修改问题状态，用于记录处理进度。
操作过程（process）：打开一条待处理问题，将状态改为“处理中”，点击保存。
实际结果（actual）：提示保存成功，但列表仍显示“待处理”；手动刷新页面后显示“处理中”。
预期结果（expected）：保存成功后，列表立即显示“处理中”，无需手动刷新。
根因（rootCause）：待排查。

## 创建前自检规则

提交创建请求或导入保存前，先自行检查并修正文稿：
1. 没看过聊天记录的人，能否知道这是哪个功能、谁在什么场景下想完成什么？
2. 缺陷是否写清入口、必要前提、触发步骤、实际结果和预期差异？需求是否写清当前做法、实际困难和期望改变？待确认项是否提出了明确的问题？
3. 标题、背景、操作过程和结果是否一致？是否还残留“这个”“上面说的”等需要依赖聊天才能理解的指代？
4. 是否区分了已知事实、用户反馈、推测和待确认事项？是否把未验证的根因、影响或验证结果写成了事实？
5. 是否用具体动作和结果替换了空泛措辞，并删掉重复内容？
6. 缺失信息若影响理解或实施，先集中追问；不影响登记的，标明待补充内容后即可创建。
自检由 Agent 在提交前完成，不必把检查清单写入问题正文，也不要求用户额外审批已获授权且信息充分的创建操作。`;

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="/" aria-label="问题簿首页" onClick={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) { event.preventDefault(); navigate(null); } }}><span className="brand-icon"><BookOpen size={21} strokeWidth={1.7} /></span><span>问题簿<small>ISSUE NOTE</small></span></a>
      <div className="workspace-tag"><span className="workspace-avatar">W</span><span>我的工作空间<small>轻量协作 · 保持简单</small></span></div>
      <span className="nav-label">工作台</span>
      <nav className="main-nav" aria-label="问题导航"><button aria-label="全部问题" title="全部问题" className={status === '全部问题' ? 'selected' : ''} onClick={() => showList('全部问题')}><LayoutList size={18} /><span>全部问题</span><small>{issues.length}</small></button><div className="nav-separator" />{issueStatuses.map(s => { const Icon = statusIcons[s]; return <button key={s} aria-label={s} title={s} className={status === s ? 'selected' : ''} onClick={() => showList(s)}><Icon size={18} /><span>{s}</span><small>{counts[s]}</small></button>; })}</nav>
      <div className="sidebar-bottom"><button className="agent-entry" aria-label="连接 AI Agent" title="连接 AI Agent" onClick={() => setAgent(true)}><span className="agent-icon"><Bot size={19} /></span><span>连接 AI Agent<small>让分析与记录自然衔接</small></span><ArrowUpRight size={15} /></button><div className="storage-state"><span className={`connection-dot ${health?.ok ? '' : 'offline'}`} /><span>{health?.ok ? '本地工作台已连接' : '正在连接工作台'}</span>{health?.authRequired && <button className="icon-button" title="访问密钥" aria-label="设置访问密钥" onClick={() => setAuth(true)}><KeyRound size={13} /></button>}</div><div className="sidebar-footnote">少一点沟通损耗，多一点清晰。</div></div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb"><span>我的工作空间</span><ChevronRight size={13} /><strong>{issueId ? issueId === 'new' ? '提交问题' : '问题详情' : '问题工作台'}</strong></div><div className="topbar-right"><span className="git-status"><GitBranch size={14} />修改自动留痕</span><ThemeToggle /><span className="user-avatar" title="工作空间">W</span></div></header>
      <main className="main-content" hidden={Boolean(issueId)}>
        <div className="page-heading"><div><div className="eyebrow">A LITTLE CLARITY, EVERY DAY</div><h1>问题工作台<span className="heading-dot">.</span></h1><p>记录问题，理清方案，跟进每一次修复。</p></div><div className="heading-actions"><button className="button" onClick={() => setImporting(true)}><FileUp size={16} />导入 Markdown</button><button className="button primary" onClick={() => navigate('new')}><Plus size={18} />提交问题</button></div></div>
        <div className="stats-grid">{issueStatuses.map((s, i) => { const Icon = statusIcons[s]; return <button key={s} className={`stat ${status === s ? 'active' : ''}`} onClick={() => setStatus(status === s ? '全部问题' : s)}><div><span className={`stat-icon stat-icon-${i}`}><Icon size={18} /></span><span className="stat-label">{s}</span></div><strong>{loading ? '—' : counts[s]}<span>{['等待理清与安排', '正在推进修改', '等待回归确认', '每一步都有结果'][i]}</span></strong></button>; })}</div>
        <section className="issues-section" aria-label="问题列表">
          <div className="list-toolbar"><div className="list-heading"><h2>{status}</h2><span className="count-pill">{filtered.length}</span></div><div className="list-tools"><div className="search-box"><Search size={16} /><input ref={searchRef} aria-label="搜索问题" placeholder="搜索问题或编号…" value={query} onChange={e => setQuery(e.target.value)} />{query ? <button className="icon-button" onClick={() => setQuery('')} aria-label="清空搜索"><X size={13} /></button> : <kbd>/</kbd>}</div><button className={`button filter-button ${filters || activeFilters ? 'active' : ''}`} aria-expanded={filters} onClick={() => setFilters(!filters)}><SlidersHorizontal size={15} />筛选{activeFilters && <i />}</button></div></div>
          {filters && <div className="filter-row"><select aria-label="筛选问题类型" value={type} onChange={e => setType(e.target.value)}><option>全部类型</option>{issueTypes.map(v => <option key={v}>{v}</option>)}</select><select aria-label="筛选所属模块" value={module} onChange={e => setModule(e.target.value)}><option>全部模块</option><option>未分类</option>{modules.filter(v => v !== '未分类').map(v => <option key={v}>{v}</option>)}</select>{activeFilters && <button className="text-button" onClick={() => { setType('全部类型'); setModule('全部模块'); }}>清除筛选</button>}</div>}
          {loadError ? <div className="load-error"><AlertCircle size={26} /><h3>暂时无法连接工作台</h3><p>{loadError}</p><button className="button" onClick={() => void refresh(true)}><RefreshCw size={15} />重新连接</button></div> : loading ? <div className="list-loading"><Spinner /><span>正在整理问题…</span></div> : filtered.length ? <div className="table-scroll"><table className="issue-table"><thead><tr><th className="issue-main-cell">问题</th><th>状态</th><th>所属模块</th><th>负责人</th><th>修改进度</th><th>最近更新</th><th aria-label="查看详情" /></tr></thead><tbody>{filtered.map(issue => <tr key={issue.id} onClick={() => void openIssue(issue)}><td className="issue-main-cell"><div className="issue-row-meta"><span className="issue-id">{issue.id}</span><Status value={issue.type} />{issue.priority === '紧急' && <span className="urgent-label">紧急</span>}</div><button className="issue-title" onClick={e => { e.stopPropagation(); void openIssue(issue); }}>{issue.title}</button></td><td><Status value={issue.status} /></td><td className="module-cell"><ModuleTag value={issue.module} /></td><td><Assignees values={issue.assignees} /></td><td><div className="progress-pair"><Progress issue={issue} side="frontend" /><Progress issue={issue} side="backend" /></div></td><td className="date-cell" title={dateTime(issue.updatedAt)}>{relativeDate(issue.updatedAt)}</td><td><ChevronRight size={16} className="row-chevron" /></td></tr>)}</tbody></table></div> : <div className="empty-state">
            {issues.length === 0 ? <><div className="empty-illustration" aria-hidden="true"><div className="note-behind" /><div className="note-front"><div className="note-header"><span /><i /><i /></div><div className="note-line long" /><div className="note-line" /><div className="note-check"><Check size={13} /><div /></div><div className="note-line short" /></div><div className="floating-plus"><Plus size={19} /></div><span className="illustration-dot one" /><span className="illustration-dot two" /></div><h3>从一个小发现开始</h3><p>把测试中的问题记下来，<br />让分析、修改和验证都有迹可循。</p><button className="button primary" onClick={() => navigate('new')}><Plus size={17} />记录第一个问题</button><button className="text-button empty-import" onClick={() => setImporting(true)}>已有 AI 分析？导入 Markdown <ArrowRight size={14} /></button></> : <><div className="filtered-icon"><Search size={26} /></div><h3>{query || activeFilters ? '没有找到匹配的问题' : status === '已关闭' ? '还没有关闭的问题' : '这里暂时没有待办问题'}</h3><p>{query || activeFilters ? '试试其他关键词，或调整筛选条件。' : '新问题会在这里出现，继续保持清晰。'}</p>{(query || activeFilters) && <button className="button" onClick={() => { setQuery(''); setType('全部类型'); setModule('全部模块'); }}>清除搜索与筛选</button>}</>}
          </div>}
          <div className="list-footer"><span>{loading ? '正在读取…' : `共 ${filtered.length} 个问题`}{status === '全部问题' && !showClosed && counts['已关闭'] > 0 && ` · 已隐藏 ${counts['已关闭']} 个已关闭问题`}</span>{status === '全部问题' && <label className="toggle-label"><input type="checkbox" checked={showClosed} onChange={e => setShowClosed(e.target.checked)} /><span className="toggle" />显示已关闭</label>}</div>
        </section>
        <div className="workspace-footer"><span><FileText size={13} />每个问题，一份 Markdown。</span><button onClick={() => void api.template().then(copyText).then(() => notify('空白 Markdown 模板已复制')).catch(e => notify(e.message, true))}><Copy size={13} />复制问题模板</button></div>
      </main>
      {issueId && <main className="main-content issue-content">
        {issueId === 'new' || (!issueLoading && pageIssue?.id === issueId) ? <IssuePage key={issueId} issue={issueId === 'new' ? undefined : pageIssue} onClose={() => navigate(null)} onSaved={onSaved} notify={notify} registerGuard={registerGuard} /> : <>
          <div className="issue-page-navigation"><button className="back-to-list" onClick={() => navigate(null)}><ArrowLeft size={16} />返回问题列表</button><span>{issueId}</span></div>
          <div className="issue-page issue-route-state">{issueLoading ? <><Spinner /><p>正在读取问题…</p></> : <><AlertCircle size={28} /><h2>暂时无法打开这个问题</h2><p>{issueError}</p><button className="button" onClick={() => setIssueRetry(count => count + 1)}><RefreshCw size={15} />重新加载</button></>}</div>
        </>}
      </main>}
    </div>
    {importing && <ImportModal onClose={() => setImporting(false)} onImported={issue => { setImporting(false); onSaved(issue); }} notify={notify} />}
    {agent && <Modal title="连接 AI Agent" subtitle="使用 Markdown 交换信息，或让 Agent 直接操作问题。" wide onClose={() => setAgent(false)} footer={<><button className="button" onClick={() => setAgent(false)}>关闭</button><button className="button primary" onClick={() => void copyText(agentGuide).then(() => notify('接入说明已复制，粘贴给 AI Agent 即可')).catch(e => notify(e.message, true))}><Copy size={16} />复制 Agent 接入说明</button></>}>
      <div className="agent-options"><section><span className="agent-option-icon"><FileText size={22} /></span><h3>复制 · 分析 · 回填</h3><p>在问题详情复制 Markdown，交给任意 Agent 分析，再导入它返回的内容。</p><button className="text-button" onClick={() => void api.template().then(copyText).then(() => notify('空白模板已复制')).catch(e => notify(e.message, true))}>复制空白模板 <ArrowUpRight size={14} /></button></section><section><span className="agent-option-icon blue"><Terminal size={22} /></span><h3>通过 API 直接操作</h3><p>让 Agent 查询问题、补充分析、更新方案和状态，修改会自动保留历史。</p><span className="endpoint-label">{window.location.origin}/api</span></section></div>
      <h3 className="api-heading">API 速查</h3><div className="api-table">{[['GET', '/api/issues', '搜索与筛选问题'], ['POST', '/api/issues', '创建问题'], ['PATCH', '/api/issues/{id}', '更新内容与状态，需传 version'], ['GET', '/api/issues/{id}/markdown', '导出 Markdown'], ['POST', '/api/issues/import', '预览、创建或回填 Markdown']].map(([method, path, purpose]) => <div key={method + path}><code className={`method ${method.toLowerCase()}`}>{method}</code><code>{path}</code><span>{purpose}</span></div>)}</div><p className="api-note">Agent 需要能够访问此地址。复制接入说明后，它会获得字段、状态、版本冲突处理规则，以及创建内容规范和创建前自检规则。</p>
    </Modal>}
    {auth && <Modal title="连接工作台" subtitle="此工作台设置了访问密钥，无需注册账号。" onClose={() => setAuth(false)} footer={<button className="button primary" disabled={!key || authBusy} onClick={async () => { setAuthBusy(true); sessionStorage.setItem('issue-note-key', key); try { await request('/api/session', { method: 'POST', body: '{}' }); setAuth(false); setKey(''); await refresh(true); notify('已连接工作台'); } catch (e) { sessionStorage.removeItem('issue-note-key'); notify((e as Error).message, true); } finally { setAuthBusy(false); } }}>{authBusy ? <Spinner /> : <KeyRound size={16} />}连接</button>}><Field label="访问密钥"><input type="password" autoComplete="current-password" value={key} onChange={e => setKey(e.target.value)} placeholder="输入启动服务时设置的 API_KEY" /></Field></Modal>}
    {toast && <div role={toast.error ? 'alert' : 'status'} className={`toast ${toast.error ? 'error' : ''}`}>{toast.error ? <AlertCircle size={18} /> : <CircleCheck size={18} />}<span>{toast.text}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setToast(undefined)}><X size={15} /></button></div>}
  </div>;
}
