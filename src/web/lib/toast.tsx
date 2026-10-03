import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';

export type Tone = 'info' | 'success' | 'error';
interface Toast {
  id: number;
  tone: Tone;
  message: string;
  action?: { label: string; onClick: () => void };
}

interface ToastApi {
  toast: (t: { tone?: Tone; message: string; action?: Toast['action']; durationMs?: number }) => void;
}

const Ctx = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const toast = useCallback<ToastApi['toast']>(
    ({ tone = 'info', message, action, durationMs }) => {
      const id = ++seq.current;
      setToasts((t) => [...t.slice(-3), { id, tone, message, action }]);
      setTimeout(() => dismiss(id), durationMs ?? (tone === 'error' ? 8000 : 4500));
    },
    [dismiss],
  );
  const value = useMemo(() => ({ toast }), [toast]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.tone === 'error' ? 'alert' : 'status'}
            className="pointer-events-auto flex items-start gap-3 rounded-[10px] border border-line bg-raised px-3.5 py-3 text-sm text-ink shadow-[var(--shadow)]"
          >
            {t.tone === 'success' ? (
              <CircleCheck className="mt-px size-4 shrink-0 text-good" aria-hidden />
            ) : t.tone === 'error' ? (
              <CircleAlert className="mt-px size-4 shrink-0 text-bad" aria-hidden />
            ) : (
              <Info className="mt-px size-4 shrink-0 text-info" aria-hidden />
            )}
            <div className="min-w-0 flex-1">
              <p className="break-words">{t.message}</p>
              {t.action && (
                <button
                  className="mt-1.5 text-sm font-semibold underline decoration-signal-line decoration-2 underline-offset-2"
                  onClick={() => {
                    t.action!.onClick();
                    dismiss(t.id);
                  }}
                >
                  {t.action.label}
                </button>
              )}
            </div>
            <button aria-label="Dismiss" className="-mr-1 rounded p-0.5 text-ink-3 hover:text-ink" onClick={() => dismiss(t.id)}>
              <X className="size-4" />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastApi['toast'] {
  const v = useContext(Ctx);
  if (!v) throw new Error('useToast outside ToastProvider');
  return v.toast;
}
