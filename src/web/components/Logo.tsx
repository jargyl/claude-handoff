// Two session strips, one handed across to the other side.
export function LogoMark({ className = 'size-7' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <rect x="3" y="7" width="19" height="7" rx="2" fill="var(--ink)" />
      <rect x="10" y="18" width="19" height="7" rx="2" fill="var(--signal)" />
    </svg>
  );
}
