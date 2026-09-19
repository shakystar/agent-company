import { useEffect, useId, useRef, type CSSProperties, type ReactNode } from 'react';
import { ArrowUpRight, Check, CircleAlert, LoaderCircle, X } from 'lucide-react';
import type { Agent, AgentStatus, RunStatus } from '../shared/types';

export const colors = ['#72836b', '#b47f67', '#7a87a4', '#ad9564', '#917ba2', '#658e91'];
export function Avatar({ agent, size = 'normal' }: { agent: Pick<Agent, 'name' | 'color'>; size?: 'small' | 'normal' | 'large' }) {
  return <span className={`avatar avatar-${size}`} style={{ '--agent-color': agent.color || colors[0] } as CSSProperties} aria-hidden="true"><span>{agent.name.trim().slice(0, 1).toLocaleUpperCase()}</span></span>;
}

const labels: Record<AgentStatus | RunStatus, string> = { idle: '대기', running: '실행 중', paused: '일시 정지', queued: '대기 중', starting: '준비 중', waiting: '응답 대기', succeeded: '완료', failed: '실패', cancelled: '취소', superseded: '새 실행으로 이어짐' };
export function Status({ status }: { status: AgentStatus | RunStatus }) {
  return <span className={`status status-${status}`}><i />{labels[status]}</span>;
}

export function Empty({ icon, title, detail, action }: { icon: ReactNode; title: string; detail?: string; action?: ReactNode }) {
  return <div className="empty-state"><span className="empty-icon">{icon}</span><h3>{title}</h3>{detail ? <p>{detail}</p> : null}{action}</div>;
}
export function ErrorNotice({ message }: { message: string }) {
  return message ? <div className="error-notice" role="alert"><CircleAlert size={17} /><span>{message}</span></div> : null;
}
export function Submit({ pending, children }: { pending: boolean; children: ReactNode }) {
  return <button className="button primary" type="submit" disabled={pending}>{pending ? <LoaderCircle size={16} className="spin" /> : null}{children}</button>;
}
export function Modal({ title, eyebrow, children, onClose, busy = false, wide = false }: { title: string; eyebrow?: string; children: ReactNode; onClose: () => void; busy?: boolean; wide?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return <dialog ref={dialog} aria-labelledby={titleId} className={`modal ${wide ? 'modal-wide' : ''}`} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} onClick={event => { if (event.target === dialog.current && !busy) { const bounds = dialog.current!.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose(); } }}>
    <div className="modal-heading"><div>{eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}<h2 id={titleId}>{title}</h2></div><button className="icon-button" aria-label="닫기" onClick={onClose} disabled={busy}><X size={20} /></button></div>
    {children}
  </dialog>;
}
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="field"><span>{label}</span>{children}{hint ? <small>{hint}</small> : null}</label>;
}
export function ColorPicker({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  return <div className="color-picker" role="group" aria-label="에이전트 색상">{colors.map((color, index) => <button type="button" key={color} style={{ background: color }} aria-label={`색상 ${index + 1}`} aria-pressed={value === color} onClick={() => onChange(color)}>{value === color ? <Check size={15} /> : null}</button>)}</div>;
}
export function TextContent({ text, className = '' }: { text: string; className?: string }) {
  return <div className={`text-content ${className}`}>{text}</div>;
}
export function DateLabel({ value, time = false }: { value: string; time?: boolean }) {
  return <time dateTime={value} title={new Date(value).toLocaleString('ko-KR')}>{new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric', ...(time ? { hour: '2-digit' as const, minute: '2-digit' as const } : {}) }).format(new Date(value))}</time>;
}
export function SectionTitle({ title, detail, action }: { title: string; detail?: string; action?: ReactNode }) {
  return <div className="section-heading"><div><h2>{title}</h2>{detail ? <p>{detail}</p> : null}</div>{action}</div>;
}
export function TextLink({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return <button className="text-link" onClick={onClick}>{children}<ArrowUpRight size={15} /></button>;
}
