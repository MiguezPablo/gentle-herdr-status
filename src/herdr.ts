import { createConnection } from "node:net";

/** Our own reporter id. Herdr reserves the `herdr:` prefix for its integrations. */
export const SOURCE = "pi-herdr-status";
/** Rendered in Herdr sidebar rows as `$subagent`. */
export const TOKEN = "subagent";
/** Pane agent the token applies to (Herdr's official Pi integration reports `pi`). */
export const AGENT = "pi";
/** A shown token expires on its own if this process dies, so it can never stay stale. */
export const TTL_MS = 90_000;
/** While a token is shown it is republished well inside its TTL. */
export const REFRESH_MS = 30_000;
const SEND_TIMEOUT_MS = 1_000;

export type HerdrRequest = {
	id: string;
	method: string;
	params: Record<string, unknown> & { tokens: Record<string, string | null> };
};
export type Send = (request: HerdrRequest) => Promise<boolean>;
export type Env = Record<string, string | undefined>;

export function herdrPane(env: Env): { pane: string; socket: string } | undefined {
	const pane = env.HERDR_PANE_ID?.trim();
	const socket = env.HERDR_SOCKET_PATH?.trim();
	if (env.HERDR_ENV !== "1" || !pane || !socket) return undefined;
	return { pane, socket };
}

/** One request per connection, newline-delimited JSON; resolves true on the first reply. Never throws. */
export function socketSend(path: string, timeoutMs = SEND_TIMEOUT_MS): Send {
	const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\${path}` : path;
	return (request) => new Promise((resolve) => {
		let settled = false;
		const socket = createConnection(endpoint);
		const finish = (delivered: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			resolve(delivered);
		};
		const timer = setTimeout(() => finish(false), timeoutMs);
		timer.unref?.();
		socket.on("error", () => finish(false));
		socket.on("end", () => finish(false));
		socket.on("data", () => finish(true));
		socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
	});
}

export type PublisherOptions = {
	pane: string;
	send: Send;
	setInterval?: (fn: () => void, ms: number) => unknown;
	clearInterval?: (id: unknown) => void;
	now?: () => number;
};

/**
 * Publishes one metadata token. Unchanged values are not resent, a shown value is
 * refreshed before its TTL, and values set while a send is in flight collapse into
 * the latest one. The first value is always sent so a token left by a previous
 * process is wiped.
 */
export class MetadataPublisher {
	private readonly pane: string;
	private readonly send: Send;
	private readonly startInterval: (fn: () => void, ms: number) => unknown;
	private readonly stopInterval: (id: unknown) => void;
	private seq: number;
	private current: string | null | undefined;
	private pending: { value: string | null } | undefined;
	private inFlight: Promise<void> | undefined;
	private refresh: unknown;
	private disposed = false;

	constructor(options: PublisherOptions) {
		this.pane = options.pane;
		this.send = options.send;
		this.startInterval = options.setInterval ?? ((fn, ms) => {
			const id = setInterval(fn, ms);
			id.unref?.();
			return id;
		});
		this.stopInterval = options.clearInterval ?? ((id) => clearInterval(id as ReturnType<typeof setInterval>));
		// Herdr ignores a seq at or below the last accepted one for this source,
		// so a reloaded extension must not restart from zero.
		this.seq = (options.now ?? Date.now)() * 1000;
	}

	set(value: string | null): void {
		if (this.disposed || value === this.current) return;
		this.current = value;
		this.syncRefresh();
		this.enqueue(value);
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		if (this.current) {
			this.current = null;
			this.enqueue(null);
		}
		this.disposed = true;
		this.syncRefresh();
		while (this.inFlight) await this.inFlight;
	}

	private syncRefresh(): void {
		const shown = !this.disposed && typeof this.current === "string";
		if (shown && this.refresh === undefined) {
			this.refresh = this.startInterval(() => {
				if (typeof this.current === "string") this.enqueue(this.current);
			}, REFRESH_MS);
		} else if (!shown && this.refresh !== undefined) {
			this.stopInterval(this.refresh);
			this.refresh = undefined;
		}
	}

	private enqueue(value: string | null): void {
		this.pending = { value };
		if (!this.inFlight) this.inFlight = this.drain();
	}

	private async drain(): Promise<void> {
		try {
			while (this.pending) {
				const { value } = this.pending;
				this.pending = undefined;
				await this.send(this.request(value)).catch(() => false);
			}
		} finally {
			this.inFlight = undefined;
		}
	}

	private request(value: string | null): HerdrRequest {
		const seq = ++this.seq;
		const params: HerdrRequest["params"] = {
			pane_id: this.pane,
			source: SOURCE,
			agent: AGENT,
			tokens: { [TOKEN]: value },
			seq,
		};
		if (value !== null) params.ttl_ms = TTL_MS;
		return { id: `${SOURCE}:${seq}`, method: "pane.report_metadata", params };
	}
}
