"use client";

import { useEffect, useRef, useState } from 'react';
import { clientApi } from '../../lib/clientApi';
import type { DesktopBrowserResponse } from '../../lib/browserDesktopTypes';
import styles from './BrowserWorkspacePanel.module.css';

type WebDialog = NonNullable<DesktopBrowserResponse['dialog']>;

/** Separate mailbox: the browser command queue is waiting for this decision. */
export function BrowserOperatorDialog({ active, profile, controlId, label }: {
  active: boolean; profile: string; controlId?: string; label: (key: string) => string;
}) {
  const [dialog, setDialog] = useState<WebDialog | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const resolved = useRef('');
  const box = useRef<HTMLDivElement>(null);
  const scope = `${profile}:${controlId || ''}`;
  const currentScope = useRef(scope); currentScope.current = scope;
  useEffect(() => {
    setDialog(null); setError(''); setSending(false); resolved.current = '';
    if (!active || !controlId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    let request: AbortController;
    const poll = async () => {
      if (!alive) return;
      request = new AbortController();
      const timeout = setTimeout(() => request.abort(), 3000);
      try {
        const data = await clientApi.browserSurface({ operation: 'dialog', profile_id: profile }, request.signal);
        if (alive && data.ok) {
          const next = data.dialog && data.dialog.id !== resolved.current ? data.dialog : null;
          setDialog(previous => previous?.id === next?.id ? previous : next);
        }
      } catch { /* Observation failure cannot approve or replay a browser action. */ }
      finally { clearTimeout(timeout); if (alive) timer = setTimeout(poll, 350); }
    };
    void poll();
    return () => { alive = false; clearTimeout(timer); request?.abort(); };
  }, [active, profile, controlId]);
  useEffect(() => {
    if (!dialog) return;
    const previous = document.activeElement as HTMLElement | null;
    setText(dialog.default_value || ''); setError('');
    box.current?.querySelector<HTMLElement>('input,button')?.focus();
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, [dialog?.id]);
  async function answer(accept: boolean) {
    if (!dialog || sending) return;
    const originalScope = scope;
    setSending(true); setError('');
    try {
      const result = await clientApi.browserDesktop({ operation: 'dialog', profile_id: profile,
        control_id: controlId, dialog_id: dialog.id, accept, ...(accept && dialog.type === 'prompt' ? { text } : {}) });
      if (currentScope.current !== originalScope) return;
      if (!result.ok) throw new Error(result.error);
      resolved.current = dialog.id; setDialog(null);
    } catch { if (currentScope.current === originalScope) setError(label('dialogChanged')); }
    finally { if (currentScope.current === originalScope) setSending(false); }
  }
  if (!dialog || !active) return null;
  return <div className={styles.dialogBackdrop} onClick={event => event.stopPropagation()} onKeyDown={event => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); void answer(false); }
    if (event.key === 'Tab') {
      const fields = Array.from(box.current?.querySelectorAll<HTMLElement>('input:not(:disabled),button:not(:disabled)') || []);
      if (!fields.length) { event.preventDefault(); return; }
      const first = fields[0], last = fields[fields.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  }}>
    <div ref={box} className={styles.webDialog} role="dialog" aria-modal="true" aria-labelledby="browser-dialog-title" aria-describedby="browser-dialog-message">
      <h3 id="browser-dialog-title">{label('dialogTitle')}</h3>
      <p className={styles.muted}>{dialog.url}</p>
      <p id="browser-dialog-message">{dialog.message}</p>
      <form onSubmit={event => { event.preventDefault(); void answer(true); }}>
        {dialog.type === 'prompt' && <input className="input w-full" aria-label={label('dialogInput')} value={text} onChange={event => setText(event.target.value)} disabled={sending} maxLength={10000} autoComplete="off" />}
        {error && <p role="alert">{error}</p>}
        <p className={styles.muted}>{label('dialogTimeout')}</p>
        <div className={styles.dialogActions}>
          <button type="button" className="btn btn-ghost" disabled={sending} onClick={() => void answer(false)}>{label('dialogCancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={sending}>{label('dialogAccept')}</button>
        </div>
      </form>
    </div>
  </div>;
}
