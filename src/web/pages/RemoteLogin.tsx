import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { LogoMark } from '../components/Logo';
import { Button, TextInput } from '../components/ui';

/** Shown when this dashboard is opened from another device on the network. */
export function RemoteLogin({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="grid min-h-dvh place-items-center bg-bg px-4">
      <form
        className="w-full max-w-[400px] rounded-[12px] border border-line bg-surface p-6"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            await api.post('/api/auth/login', { token });
            onDone();
          } catch (err) {
            setError(err instanceof ApiError ? err.message : 'Something went wrong');
          } finally {
            setBusy(false);
          }
        }}
      >
        <LogoMark className="size-9" />
        <h1 className="mt-4 text-xl font-semibold">Enter the access token</h1>
        <p className="mt-1 text-base text-ink-2">
          You're opening Handoff from another device. On the computer running it, go to Devices and copy the access token.
        </p>
        <TextInput
          icon={KeyRound}
          className="mt-5"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Access token"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          aria-label="Access token"
        />
        {error && <p className="mt-2 text-sm text-bad">{error}</p>}
        <Button variant="primary" type="submit" className="mt-4 w-full" loading={busy} disabled={!token.trim()}>
          Continue
        </Button>
      </form>
    </div>
  );
}
