import { useEffect, useRef, useState, type ReactNode } from 'react';
import { X, LoaderCircle, Paperclip, FileText } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Attachment, IssueDraft } from '../shared/model';
import { api } from './api';

export function Spinner() { return <LoaderCircle size={17} className="spin" aria-label="加载中" />; }
export function Status({ value }: { value: string }) {
  const cls = ({ 待处理: 'pending', 处理中: 'working', 待验证: 'review', 已关闭: 'closed', 缺陷: 'bug', 需求变更: 'change', 待确认: 'unknown' } as Record<string, string>)[value] || '';
  return <span className={`badge ${cls}`}>{['待处理', '处理中', '待验证', '已关闭'].includes(value) && <i />}{value}</span>;
}
export function ModuleTag({ value }: { value: string }) {
  return <span className={`module-tag ${value ? '' : 'unclassified'}`}>{value || '未分类'}</span>;
}
export function Assignees({ values }: { values: IssueDraft['assignees'] }) {
  return <span className="assignee-badges" aria-label={`负责人：${values.join('、')}`}>{values.map(value => <span key={value} className={`assignee-badge assignee-tone ${value === '前端' ? 'frontend' : 'backend'}`}>{value}</span>)}</span>;
}
export function Field({ label, children, hint, required, className = '' }: { label: string; children: ReactNode; hint?: string; required?: boolean; className?: string }) {
  return <label className={`field ${className}`}><span className="field-label">{label}{required && <b> *</b>}{hint && <small>{hint}</small>}</span>{children}</label>;
}
export function Markdown({ text, placeholder = '暂未填写' }: { text: string; placeholder?: string }) {
  return text ? <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
    img: ({ src, alt }) => src?.startsWith('/attachments/') ? <img src={src} alt={alt || '问题截图'} loading="lazy" /> : <a href={src} target="_blank" rel="noreferrer">{alt || '查看外部图片'}</a>,
  }}>{text}</ReactMarkdown></div> : <p className="placeholder">{placeholder}</p>;
}

export function Modal({ title, subtitle, children, footer, onClose, wide = false }: {
  title: string; subtitle?: string; children: ReactNode; footer?: ReactNode; onClose: () => void; wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const element = ref.current;
    element?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current(); }
      if (event.key === 'Tab' && element) {
        const list = Array.from(element.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]')).filter(e => e.tabIndex >= 0 && e.getClientRects().length);
        if (!list.length) { event.preventDefault(); return; }
        if (event.shiftKey && (document.activeElement === list[0] || document.activeElement === element)) { event.preventDefault(); list.at(-1)?.focus(); }
        else if (!event.shiftKey && (document.activeElement === list.at(-1) || document.activeElement === element)) { event.preventDefault(); list[0].focus(); }
      }
    };
    document.addEventListener('keydown', keydown, true);
    return () => { document.removeEventListener('keydown', keydown, true); previous?.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
      <div className="modal-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" onClick={onClose} aria-label="关闭弹窗"><X size={20} /></button></div>
      <div className="modal-content">{children}</div>{footer && <div className="modal-footer">{footer}</div>}
    </div>
  </div>;
}

export function Attachments({ files, onChange, onError, onBusy }: { files: Attachment[]; onChange?: (files: Attachment[]) => void; onError: (message: string) => void; onBusy?: (busy: boolean) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  async function upload(list: FileList | null) {
    if (!list?.length || busyRef.current) return;
    if (files.length + list.length > 30) { onError('每个问题最多 30 个附件。'); return; }
    busyRef.current = true; setBusy(true); onBusy?.(true);
    const next = [...files];
    try {
      for (const file of Array.from(list)) {
        if (file.size > 10 * 1024 * 1024) throw new Error('单个附件不能超过 10 MB。');
        next.push(await api.upload(file));
        onChange?.([...next]);
      }
    } catch (error) { onError((error as Error).message); }
    finally { busyRef.current = false; setBusy(false); onBusy?.(false); if (input.current) input.current.value = ''; }
  }
  return <div className="attachments">
    {!!files.length && <div className="attachment-grid">{files.map(file => <div className="attachment" key={file.id}>
      <a href={file.url} target="_blank" rel="noreferrer">
        {file.mime.startsWith('image/') ? <img src={file.url} alt={file.name} /> : <div className="file-thumb"><FileText size={22} /></div>}
        <span title={file.name}>{file.name}<small>{file.size < 1024 * 1024 ? `${Math.ceil(file.size / 1024)} KB` : `${(file.size / 1024 / 1024).toFixed(1)} MB`}</small></span>
      </a>
      {onChange && <button type="button" className="attachment-remove" disabled={busy} aria-label={`移除附件 ${file.name}`} onClick={() => onChange(files.filter(f => f.id !== file.id))}><X size={13} /></button>}
    </div>)}</div>}
    {onChange && <>
      <input type="file" multiple ref={input} tabIndex={-1} className="visually-hidden" aria-label="选择问题附件" accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain,video/mp4,video/webm" onChange={e => void upload(e.target.files)} />
      <button type="button" className="upload-zone" disabled={busy} onClick={() => input.current?.click()} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); void upload(e.dataTransfer.files); }}>
        {busy ? <Spinner /> : <Paperclip size={17} />}<span>{busy ? '正在上传附件…' : '点击或拖放截图、文件'}</span><small>单个文件 ≤ 10 MB</small>
      </button>
    </>}
  </div>;
}
