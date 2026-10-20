import { getSession, type RoomState } from './api.ts';
import { ServerClock } from './sync.ts';

type Outgoing =
  | { t: 'play' }
  | { t: 'pause' }
  | { t: 'seek'; position: number }
  | { t: 'buffering'; value: boolean }
  | { t: 'position'; value: number }
  | { t: 'quality'; value: string }
  | { t: 'external'; value: boolean }
  | { t: 'progress'; sid: string; position: number }
  // Social layer (room.ts)
  | { t: 'presence'; value: 'watching' | 'browsing' }
  | { t: 'vote' | 'withdraw' | 'start' | 'cancelRequest'; id: string }
  | { t: 'cancel'; what: 'autostart' | 'autonext' }
  | { t: 'mode'; value: 'all' | 'host' }
  | { t: 'host'; uid: string }
  | { t: 'request'; kind: 'play' | 'pause' | 'seek'; position?: number }
  | { t: 'request'; kind: 'start'; id: string }
  | { t: 'admit' | 'refuse' | 'kick'; uid: string }
  | { t: 'copilot'; uid: string; value: boolean }
  | { t: 'autoAdmit'; value: boolean }
  | { t: 'respond'; id: string; accept: boolean }
  | { t: 'voteAction'; kind: 'pause' | 'skip' };

/** Sync socket with automatic reconnect and clock estimation. */
export class Connection {
  readonly clock = new ServerClock();
  onState: (s: RoomState) => void = () => {};
  onNotice: (text: string) => void = () => {};
  onStatus: (connected: boolean) => void = () => {};
  /** Waiting room (website): not let in yet. */
  onLobby: (info: { host: string | null; members: number }) => void = () => {};
  /** Kicked or refused: the socket is closed for good. */
  onKicked: (reason: string) => void = () => {};

  private ws: WebSocket | null = null;
  private retry = 0;
  private pingTimer = 0;
  private closed = false;

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/ws?token=${encodeURIComponent(getSession())}`);
    this.ws = ws;

    ws.onopen = () => {
      this.retry = 0;
      this.onStatus(true);
      // A few quick pings to estimate the clock, then one every 10 s.
      for (let i = 0; i < 4; i++) setTimeout(() => this.ping(), i * 300);
      clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.ping(), 10_000);
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.t === 'pong') this.clock.add(msg.c, msg.s, Date.now());
      else if (msg.t === 'state') this.onState(msg as RoomState);
      else if (msg.t === 'notice') this.onNotice(msg.text);
      else if (msg.t === 'lobby') this.onLobby(msg);
      else if (msg.t === 'kicked') {
        this.closed = true;
        this.onKicked(String(msg.reason || 'kicked'));
      }
    };
    ws.onclose = (ev) => {
      clearInterval(this.pingTimer);
      this.onStatus(false);
      if (this.closed || ev.code === 4001 || ev.code === 4003) return;
      const delay = Math.min(10_000, 500 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
  }

  private ping() {
    this.raw({ t: 'ping', c: Date.now() });
  }

  private raw(msg: object) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  send(msg: Outgoing) {
    this.raw(msg);
  }

  close() {
    this.closed = true;
    this.ws?.close();
  }
}
