import { useRef, useState } from 'react';
import { ArrowRight, Check, Copy, FileUp, FileText, RefreshCw, Sparkles, AlertCircle } from 'lucide-react';
import type { ImportPreview, Issue } from '../shared/model';
import { api, copyText } from './api';
import { Assignees, Markdown, Modal, ModuleTag, Spinner, Status } from './components';

export default function ImportModal({ onClose, onImported, notify }: { onClose: () => void; onImported: (issue: Issue) => void; notify: (message: string, error?: boolean) => void }) {
  const [markdown, setMarkdown] = useState('');
  const [preview, setPreview] = useState<ImportPreview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const file = useRef<HTMLInputElement>(null);
  async function readFile(input: File | undefined) {
    if (!input) return;
    if (!/\.(md|markdown|txt)$/i.test(input.name)) { setError('请选择 .md、.markdown 或 .txt 文件。'); return; }
    if (input.size > 1_000_000) { setError('Markdown 文件不能超过 1 MB。'); return; }
    try { setMarkdown(await input.text()); setPreview(undefined); setError(''); } catch { setError('读取文件失败，请重试。'); }
  }
  async function parse() {
    setBusy(true); setError('');
    try { setPreview(await api.preview(markdown)); } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function save() {
    if (!preview) return;
    setBusy(true); setError('');
    try { const result = await api.import(markdown, preview.expectedVersion); onImported(result); notify(preview.mode === 'update' ? '已将分析回填到原问题' : 'Markdown 已导入'); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  const stale = preview?.existing && preview.expectedVersion !== preview.existing.version;
  return <Modal title="导入 Markdown" subtitle="把 AI 的分析，变成可以跟进的问题。" wide onClose={() => { if (!busy) onClose(); }} footer={<><span className="footer-note">{preview?.mode === 'update' ? `即将更新 ${preview.existing?.id}，历史会保留` : '先预览，确认后才会保存'}</span><button className="button" disabled={busy} onClick={() => { if (preview) setPreview(undefined); else onClose(); }}>{preview ? '返回编辑' : '取消'}</button>{preview ? <button className="button primary" disabled={busy || Boolean(stale)} onClick={() => void save()}>{busy ? <Spinner /> : <Check size={16} />}{preview.mode === 'update' ? '确认更新问题' : '确认创建问题'}</button> : <button className="button primary" disabled={busy || !markdown.trim()} onClick={() => void parse()}>{busy ? <Spinner /> : <ArrowRight size={16} />}预览导入</button>}</>}>
    {error && <div role="alert" className="notice error"><AlertCircle size={16} />{error}</div>}
    {!preview ? <>
      <div className="import-tools"><button className="button small" disabled={busy} onClick={() => file.current?.click()}><FileUp size={15} />选择 MD 文件</button><button className="text-button" onClick={() => void api.template().then(copyText).then(() => notify('空白模板已复制，可交给任意 AI Agent')).catch(e => notify(e.message, true))}><Copy size={14} />复制空白模板</button><input className="visually-hidden" ref={file} type="file" accept=".md,.markdown,.txt" aria-label="选择 Markdown 文件" onChange={e => void readFile(e.target.files?.[0])} /></div>
      <textarea className="markdown-input" spellCheck={false} aria-label="Markdown 内容" value={markdown} onChange={e => { setMarkdown(e.target.value); setError(''); }} placeholder={'在这里粘贴 Markdown，或选择一个 .md 文件…\n\n# 问题标题\n\n## 问题描述\n发生了什么？\n\n## 根因分析\nAI 的排查结论…'} onDragOver={e => e.preventDefault()} onDrop={e => { if (e.dataTransfer.files.length) { e.preventDefault(); void readFile(e.dataTransfer.files[0]); } }} />
      <div className="import-tip"><Sparkles size={16} /><p>带有已有问题编号的内容，会识别为回填更新。没有编号则创建新问题；缺少的字段可以后续补充。</p></div>
    </> : <div className="import-preview">
      <div className={`notice ${preview.mode === 'update' ? 'sage' : ''}`}>{preview.mode === 'update' ? <RefreshCw size={17} /> : <FileText size={17} />}<div><strong>{preview.mode === 'update' ? `更新已有问题 ${preview.existing?.id}` : '创建一个新问题'}</strong><p>{preview.mode === 'update' ? '只更新导入中包含的字段，请核对以下合并结果。' : '编号将在保存时自动分配。'}</p></div></div>
      {preview.warnings.map((warning, i) => <div className="notice warning" key={i}><AlertCircle size={16} />{warning}</div>)}
      <h3 className="preview-title">{preview.issue.title}</h3><div className="preview-meta"><Status value={preview.issue.type} /><Status value={preview.issue.status} /><ModuleTag value={preview.issue.module} /><Assignees values={preview.issue.assignees} /></div>
      <div className="preview-fields"><span>前端：{preview.issue.frontendRequired} · {preview.issue.frontendStatus}</span><span>后端：{preview.issue.backendRequired} · {preview.issue.backendStatus}</span></div>
      {([['description', '问题描述'], ['process', '业务流程与复现步骤'], ['expected', '预期结果'], ['actual', '实际结果'], ['rootCause', '根因分析'], ['frontendPlan', '前端修改方案'], ['backendPlan', '后端修改方案'], ['verification', '验证结果'], ['notes', '补充说明']] as const).filter(([key]) => preview.issue[key] || (preview.existing && preview.existing[key])).map(([key, label]) => <section className="preview-section" key={key}><h4>{label}{preview.existing && preview.existing[key] !== preview.issue[key] && <em>将更新</em>}</h4><Markdown text={preview.issue[key]} placeholder="将清空此项内容" /></section>)}
      {!!preview.issue.attachments.length && <p className="muted">保留 {preview.issue.attachments.length} 个附件。附件文件需存在于当前工作台。</p>}
    </div>}
  </Modal>;
}
