import { Dialog } from './Dialog';
import { Kbd } from './ui';

const ROWS: Array<[string[], string]> = [
  [['Ctrl', 'K'], 'Jump to a session, page or action'],
  [['/'], 'Focus the search or filter on this page'],
  [['T'], 'Switch light / dark mode'],
  [['G', 'O'], 'Go to overview'],
  [['G', 'S'], 'Go to sessions'],
  [['G', 'P'], 'Go to projects'],
  [['G', 'A'], 'Go to analytics'],
  [['G', 'I'], 'Go to inbox'],
  [['G', 'D'], 'Go to devices'],
  [['G', 'F'], 'Go to sync folder'],
  [['J', 'K'], 'Next / previous prompt in a conversation'],
  [['?'], 'Show these shortcuts'],
];

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts" size="sm">
      <table className="w-full text-base">
        <tbody>
          {ROWS.map(([keys, label]) => (
            <tr key={label} className="border-b border-line last:border-0">
              <td className="py-2 pr-4">
                <span className="flex gap-1">
                  {keys.map((k) => (
                    <Kbd key={k}>{k}</Kbd>
                  ))}
                </span>
              </td>
              <td className="py-2 text-ink-2">{label}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Dialog>
  );
}
