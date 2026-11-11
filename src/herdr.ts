import { createConnection } from "node:net";

/** Our own reporter id. Herdr reserves the `herdr:` prefix for its integrations. */
export const SOURCE = "pi-herdr-status";
/** Rendered in Herdr sidebar rows as `$subagent`. */
export const TOKEN = "subagent";
/** Rendered in Herdr sidebar rows as `$phase`: what the orchestrator is doing. */
export const PHASE_TOKEN = "phase";
/** Rendered in Herdr sidebar rows as `$name`: the panel name, `gentle` instead of `pi`. */
export const NAME_TOKEN = "name";
/** Rendered in Herdr sidebar rows as `$jobs`: the running gentle-pi jobs, in their own row. */
export const JOBS_TOKEN = "jobs";
/** Rendered in Herdr sidebar rows as `$changes`: uncommitted lines, opt-in (S12). */
export const CHANGES_TOKEN = "changes";
/** Fixed `$name` value: the panel is called `gentle`, no colors, so it never depends on the theme. */
export const PANEL_NAME = "gentle";
/** Pane agent the token applies to (Herdr's official Pi integration reports `pi`). */
export const AGENT = "pi";
/** A shown token expires on its own if this process dies, so it can never stay stale. */
export const TTL_MS = 90_000;
/** While a token is shown it is republished well inside its TTL. */
export const REFRESH_MS = 30_000;
const SEND_TIMEOUT_MS = 1_000;

/** Token name -> value, `null` when the token is unset. */
export type Tokens = Record<string, string | null>;
export type HerdrRequest = {
	id: string;
	method: string;
	params: Record<string, unknown> & { tokens: Tokens };
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
	/** Tokens this source owns; every report carries all of them, `null` when unset. */
	tokens?: readonly string[];
	send: Send;
	setInterval?: (fn: () => void, ms: number) => unknown;
	clearInterval?: (id: unknown) => void;
	now?: () => number;
};

/**
 * Publishes the metadata tokens of one source. Herdr orders reports of a source by
 * `seq`, so several tokens share one publisher and one monotonic seq stream: every
 * report carries the current value of every known token, `null` when unset. Unchanged
 * values are not resent, a shown value is refreshed before its TTL, and values set
 * while a send is in flight collapse into the latest one. The first report is always
 * sent so tokens left by a previous process are wiped.
 */
export class MetadataPublisher {
	private readonly pane: string;
	private readonly send: Send;
	private readonly startInterval: (fn: () => void, ms: number) => unknown;
	private readonly stopInterval: (id: unknown) => void;
	private seq: number;
	private readonly values = new Map<string, string | null>();
	private reported = false;
	private pending: Tokens | undefined;
	private inFlight: Promise<void> | undefined;
	private refresh: unknown;
	private disposed = false;

	constructor(options: PublisherOptions) {
		this.pane = options.pane;
		this.send = options.send;
		for (const token of options.tokens ?? []) this.values.set(token, null);
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

	set(token: string, value: string | null): void {
		if (this.disposed) return;
		if (this.reported && this.values.has(token) && this.values.get(token) === value) return;
		this.values.set(token, value);
		this.syncRefresh();
		this.enqueue();
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		if (this.shown()) {
			for (const token of this.values.keys()) this.values.set(token, null);
			this.enqueue();
		}
		this.syncRefresh();
		while (this.inFlight) await this.inFlight;
	}

	private shown(): boolean {
		for (const value of this.values.values()) if (typeof value === "string") return true;
		return false;
	}

	private syncRefresh(): void {
		const shown = !this.disposed && this.shown();
		if (shown && this.refresh === undefined) {
			this.refresh = this.startInterval(() => {
				if (this.shown()) this.enqueue();
			}, REFRESH_MS);
		} else if (!shown && this.refresh !== undefined) {
			this.stopInterval(this.refresh);
			this.refresh = undefined;
		}
	}

	private enqueue(): void {
		this.reported = true;
		this.pending = this.snapshot();
		if (!this.inFlight) this.inFlight = this.drain();
	}

	private snapshot(): Tokens {
		const tokens: Tokens = {};
		for (const [token, value] of this.values) tokens[token] = value;
		return tokens;
	}

	private async drain(): Promise<void> {
		try {
			while (this.pending) {
				const tokens = this.pending;
				this.pending = undefined;
				await this.send(this.request(tokens)).catch(() => false);
			}
		} finally {
			this.inFlight = undefined;
		}
	}

	private request(tokens: Tokens): HerdrRequest {
		const seq = ++this.seq;
		const params: HerdrRequest["params"] = {
			pane_id: this.pane,
			source: SOURCE,
			agent: AGENT,
			tokens,
			seq,
		};
		if (Object.values(tokens).some((value) => typeof value === "string")) params.ttl_ms = TTL_MS;
		return { id: `${SOURCE}:${seq}`, method: "pane.report_metadata", params };
	}
}
