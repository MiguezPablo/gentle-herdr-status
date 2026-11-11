/**
 * pi-herdr-status: shows the running subagent and what the orchestrator is doing in
 * the Herdr sidebar, as the `$subagent` token (`↳ explore` or `↳ worker (3)`) and the
 * `$phase` token (a gentle-pi ODD phase such as `exploring`, else `working`).
 *
 * Only presentation metadata (`pane.report_metadata`). Pane state
 * (working/blocked/idle) and desktop notifications stay with Herdr's official
 * Pi integration and Herdr's own [ui.toast]/[ui.sound] settings, so this
 * extension never reports state, never reacts to UI prompts and never notifies.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	MetadataPublisher,
	PHASE_TOKEN,
	TOKEN,
	herdrPane,
	socketSend,
	type Env,
	type PublisherOptions,
	type Send,
} from "../src/herdr.ts";
import { PHASE_POLL_MS, phaseToken, readOddPhase, type PhaseReader } from "../src/phase.ts";
import { SubagentTracker } from "../src/tracker.ts";

/** gentle-pi's content-free notification bus; subagent status changes carry taskId and status. */
export const STATUS_CHANNEL = "gentle-pi:notification:source";

export type ExtensionDeps = {
	env?: Env;
	send?: Send;
	setInterval?: PublisherOptions["setInterval"];
	clearInterval?: PublisherOptions["clearInterval"];
	/** Replaces gentle-pi's ODD phase registry (tests). */
	readPhase?: PhaseReader;
};

type Ctx = { mode?: string; sessionManager?: { getSessionId?: () => string } } | undefined;
type ToolEvent = { toolCallId?: unknown; toolName?: unknown; input?: unknown; details?: unknown };

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createExtension(deps: ExtensionDeps = {}) {
	return (pi: ExtensionAPI): void => {
		const env = deps.env ?? process.env;
		const herdr = herdrPane(env);
		// Gentle agents children run headless (`--mode rpc`) and must never publish.
		if (!herdr || env.GENTLE_PI_AGENTS_CHILD === "1") return;

		const readPhase = deps.readPhase ?? readOddPhase;
		const startInterval = deps.setInterval ?? ((fn: () => void, ms: number) => {
			const id = setInterval(fn, ms);
			id.unref?.();
			return id;
		});
		const stopInterval = deps.clearInterval
			?? ((id: unknown) => clearInterval(id as ReturnType<typeof setInterval>));

		const tracker = new SubagentTracker();
		let publisher: MetadataPublisher | undefined;
		let sessionId: string | undefined;
		let working = false;
		let poll: unknown;

		/** `$phase`: only while the agent works; the registry has no event, so it is re-read. */
		const phase = (): string | null => {
			if (!working) return null;
			if (sessionId === undefined) return phaseToken(undefined);
			try {
				return phaseToken(readPhase(sessionId));
			} catch {
				return phaseToken(undefined);
			}
		};

		const publish = () => {
			if (!publisher) return;
			publisher.set(TOKEN, tracker.label());
			publisher.set(PHASE_TOKEN, phase());
		};

		const syncPoll = () => {
			const active = working && publisher !== undefined;
			if (active && poll === undefined) poll = startInterval(publish, PHASE_POLL_MS);
			else if (!active && poll !== undefined) {
				stopInterval(poll);
				poll = undefined;
			}
		};

		const off = pi.events.on(STATUS_CHANNEL, (data: unknown) => {
			if (!publisher || !record(data) || data.source !== "subagent") return;
			if (typeof data.taskId !== "string" || typeof data.status !== "string") return;
			tracker.status(data.taskId, data.status);
			publish();
		});

		pi.on("session_start", (_event, ctx) => {
			const context = ctx as Ctx;
			if (context?.mode !== "tui") return;
			tracker.reset();
			working = false;
			try {
				sessionId = context.sessionManager?.getSessionId?.();
			} catch {
				sessionId = undefined;
			}
			if (!publisher) {
				publisher = new MetadataPublisher({
					pane: herdr.pane,
					tokens: [TOKEN, PHASE_TOKEN],
					send: deps.send ?? socketSend(herdr.socket),
					setInterval: deps.setInterval,
					clearInterval: deps.clearInterval,
				});
			}
			syncPoll();
			publish();
		});

		pi.on("agent_start", () => {
			if (!publisher) return;
			working = true;
			syncPoll();
			publish();
		});

		pi.on("agent_end", () => {
			if (!publisher || !working) return;
			working = false;
			syncPoll();
			publish();
		});

		pi.on("tool_call", (event) => {
			if (!publisher) return;
			const { toolCallId, toolName, input } = event as ToolEvent;
			if (typeof toolCallId !== "string" || typeof toolName !== "string") return;
			tracker.toolCall(toolCallId, toolName, input);
			publish();
		});

		pi.on("tool_result", (event) => {
			if (!publisher) return;
			const { toolCallId, toolName, details } = event as ToolEvent;
			if (typeof toolCallId !== "string" || typeof toolName !== "string") return;
			tracker.toolResult(toolCallId, toolName, details);
			publish();
		});

		pi.on("session_shutdown", async () => {
			if (typeof off === "function") off();
			tracker.reset();
			working = false;
			sessionId = undefined;
			syncPoll();
			const current = publisher;
			publisher = undefined;
			await current?.dispose();
		});
	};
}

export default createExtension();
