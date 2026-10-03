import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cx } from './ui';

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);
  const width = { sm: 'max-w-[420px]', md: 'max-w-[560px]', lg: 'max-w-[760px]', xl: 'max-w-[1000px]' }[size];
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className={cx('m-auto w-[calc(100vw-2rem)] rounded-[12px] border border-line bg-surface p-0 shadow-[var(--shadow)] backdrop:bg-black/40', width)}
    >
      {open && (
        <div className="flex max-h-[min(85vh,900px)] flex-col">
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div className="min-w-0">
              <h2 className="text-lg font-semibold text-ink">{title}</h2>
              {description && <p className="mt-0.5 text-sm text-ink-2">{description}</p>}
            </div>
            <button aria-label="Close" onClick={onClose} className="-mr-1.5 rounded p-1 text-ink-3 hover:bg-sunken hover:text-ink">
              <X className="size-4" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 scroll-thin">{children}</div>
          {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}
