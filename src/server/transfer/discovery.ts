// Finds other Claude Handoff instances on the local network with small UDP
// beacons (multicast + broadcast), so pairing is "pick a device, type its code".

import dgram from 'node:dgram';
import type { DiscoveredDevice } from '../../shared/types.js';

const GROUP = '239.255.42.99';
const PORT = 47420;
const APP = 'claude-handoff';

interface Beacon {
  app: string;
  v: 1;
  id: string;
  name: string;
  port: number;
}

export class Discovery {
  private socket?: dgram.Socket;
  private timer?: NodeJS.Timeout;
  private seen = new Map<string, DiscoveredDevice>();

  constructor(private me: () => { id: string; name: string; port: number }) {}

  get running(): boolean {
    return !!this.socket;
  }

  start(): void {
    if (this.socket) return;
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('error', () => this.stop());
    sock.on('message', (buf, rinfo) => {
      let b: Beacon;
      try {
        b = JSON.parse(buf.toString('utf8'));
      } catch {
        return;
      }
      if (b?.app !== APP || typeof b.id !== 'string' || b.id === this.me().id) return;
      const port = Number(b.port) || 7420;
      this.seen.set(b.id, {
        id: b.id,
        name: String(b.name ?? 'Unknown').slice(0, 80),
        address: rinfo.address,
        port,
        url: `http://${rinfo.address}:${port}`,
        lastSeen: Date.now(),
        paired: false,
      });
    });
    sock.bind(PORT, () => {
      try {
        sock.setBroadcast(true);
        sock.setMulticastTTL(1);
        sock.addMembership(GROUP);
      } catch {
        /* multicast unavailable: broadcast still works on most home networks */
      }
      this.announce();
      this.timer = setInterval(() => this.announce(), 5000);
    });
    this.socket = sock;
  }

  private announce(): void {
    if (!this.socket) return;
    const me = this.me();
    const msg = Buffer.from(JSON.stringify({ app: APP, v: 1, id: me.id, name: me.name, port: me.port } satisfies Beacon));
    for (const target of [GROUP, '255.255.255.255']) {
      this.socket.send(msg, PORT, target, () => void 0);
    }
  }

  stop(): void {
    clearInterval(this.timer);
    try {
      this.socket?.close();
    } catch {
      /* already closed */
    }
    this.socket = undefined;
  }

  list(pairedIds: Set<string>): DiscoveredDevice[] {
    const cutoff = Date.now() - 20_000;
    return [...this.seen.values()]
      .filter((d) => d.lastSeen > cutoff)
      .map((d) => ({ ...d, paired: pairedIds.has(d.id) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}
