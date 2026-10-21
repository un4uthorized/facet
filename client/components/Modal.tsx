import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

interface ModalProps {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
  compact?: boolean;
}

export function Modal({ title, description, children, onClose, busy = false, compact = false }: ModalProps) {
  const titleId = useId();
  const descriptionId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const pending = useRef(busy);
  pending.current = busy;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    const shell = panel.current?.closest<HTMLElement>('.workspace-shell');
    const shellOverflow = shell?.style.overflow ?? '';
    const background = Array.from(shell?.children ?? []).filter((element): element is HTMLElement => element instanceof HTMLElement && !element.classList.contains('workspace-modal-backdrop'));
    const previousInert = background.map(element => element.inert);
    document.body.style.overflow = 'hidden';
    if (shell) shell.style.overflow = 'hidden';
    background.forEach(element => { element.inert = true; });
    const focusable = () => Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? []).filter(element => !element.hidden && !element.closest('[hidden]'));
    const firstInput = panel.current?.querySelector<HTMLElement>('input:not(:disabled)');
    (firstInput ?? focusable()[0] ?? panel.current)?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!pending.current) close.current();
      }
      if (event.key === 'Tab') {
        const elements = focusable();
        const first = elements[0];
        const last = elements[elements.length - 1];
        if (!first) { event.preventDefault(); panel.current?.focus(); }
        else if (!panel.current?.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); }
        else if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (shell) shell.style.overflow = shellOverflow;
      background.forEach((element, index) => { element.inert = previousInert[index] ?? false; });
      if (previousFocus?.isConnected) previousFocus.focus();
      else document.querySelector<HTMLElement>('[data-dialog-fallback]')?.focus();
    };
  }, []);

  return (
    <div className={`workspace-modal-backdrop${compact ? ' workspace-modal-backdrop--compact' : ''}`} onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <div ref={panel} className={`workspace-modal${compact ? ' workspace-modal--compact' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined} tabIndex={-1}>
        <div className="workspace-modal__header">
          <div><h2 id={titleId}>{title}</h2>{description && <p id={descriptionId}>{description}</p>}</div>
          <button className="workspace-icon-button" type="button" onClick={onClose} disabled={busy} aria-label="Fechar" title="Fechar"><X /></button>
        </div>
        {children}
      </div>
    </div>
  );
}
