/**
 * pi-herdr-status: shows the running subagent, what the orchestrator is doing and the
 * jobs it launched in the Herdr sidebar, as the `$name` token (`gentle`), the `$phase`
 * token (a gentle-pi ODD phase in square brackets, such as `[exploring]`, else
 * `[working]`), the `$subagent` token (`↳ explore` or `↳ worker (+2)`) and the `$jobs`
 * token (`⏵ CI for PR 1834` or `⏵ logs (+1)`).
 *
 * Only presentation metadata (`pane.report_metadata`). Pane state
 * (working/blocked/idle) and desktop notifications stay with Herdr's official
 * Pi integration and Herdr's own [ui.toast]/[ui.sound] settings, so this
 * extension never reports state, never reacts to UI prompts and never notifies.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createDebug, type DebugWriter } from "../src/debug.ts";
import {
	JOBS_TOKEN,
	MetadataPublisher,
	NAME_TOKEN,
	PANEL_NAME,
	PHASE_TOKEN,
	TOKEN,
	herdrPane,
	socketSend,
	type Env,
	type PublisherOptions,
	type Send,
} from "../src/herdr.ts";
import { JOBS_SIDEBAR_EVENT, JobsTracker } from "../src/jobs.ts";
import { phaseToken, readOddPhase, type PhaseReader } from "../src/phase.ts";
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
	/** Replaces the opt-in diagnostic writer (tests); by default it reads `PI_HERDR_STATUS_DEBUG`. */
	debug?: DebugWriter;
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
		// Off by default: with `PI_HERDR_STATUS_DEBUG` unset the writer does nothing.
		const debug = deps.debug ?? createDebug({ env });

		const tracker = new SubagentTracker();
		const jobs = new JobsTracker();
		let publisher: MetadataPublisher | undefined;
		let sessionId: string | undefined;
		let working = false;

		type PhaseRead = { raw: unknown; token: string | null };

		/** `$phase`: only while the agent works, read on the turn and tool events, never polled. */
		const phase = (): PhaseRead => {
			if (!working) return { raw: null, token: null };
			if (sessionId === undefined) return { raw: null, token: phaseToken(undefined) };
			try {
				const raw = readPhase(sessionId);
				return { raw: raw ?? null, token: phaseToken(raw) };
			} catch {
				return { raw: null, token: phaseToken(undefined) };
			}
		};

		/**
		 * Pi's session id as this event's ctx sees it. gentle-pi reads it fresh on every
		 * event too, so a resumed, forked or new session changes it after `session_start`
		 * and the ODD phase must be looked up under the id the event actually belongs to.
		 */
		const ctxSessionId = (ctx: unknown): string | undefined => {
			try {
				return (ctx as Ctx)?.sessionManager?.getSessionId?.();
			} catch {
				return undefined;
			}
		};

		/** Keep the last known id when an event's ctx carries none, so the lookup still works. */
		const syncSessionId = (seen: string | undefined): void => {
			sessionId = seen ?? sessionId;
		};

		/** Push every token in one report; returns what the phase lookup saw, for the diagnostic. */
		const report = (): PhaseRead => {
			const read = phase();
			// `$name` no depende del turno: el panel se llama `gentle` hasta el shutdown.
			publisher?.set(NAME_TOKEN, PANEL_NAME);
			publisher?.set(TOKEN, tracker.label());
			publisher?.set(PHASE_TOKEN, read.token);
			// `$jobs` tampoco depende del turno: un job sigue vivo sin turno en curso.
			publisher?.set(JOBS_TOKEN, jobs.label());
			return read;
		};

		/** Report, then append one diagnostic line for this event (nothing when the variable is unset). */
		const publish = (
			event: "session_start" | "agent_start" | "agent_end" | "tool_call" | "tool_result",
			seen: { toolName?: string; ctxSessionId?: string } = {},
		): void => {
			if (!publisher) return;
			const read = report();
			debug({
				event,
				toolName: seen.toolName,
				ctxSessionId: seen.ctxSessionId,
				sessionId,
				rawPhase: read.raw,
				token: read.token,
			});
		};

		const off = pi.events.on(STATUS_CHANNEL, (data: unknown) => {
			if (!publisher || !record(data) || data.source !== "subagent") return;
			if (typeof data.taskId !== "string" || typeof data.status !== "string") return;
			tracker.status(data.taskId, data.status);
			report();
		});

		// Cada evento de gentle-pi reemplaza el snapshot completo de jobs de esta sesión.
		const offJobs = pi.events.on(JOBS_SIDEBAR_EVENT, (data: unknown) => {
			if (!publisher) return;
			jobs.snapshot(data, sessionId);
			report();
		});

		pi.on("session_start", (_event, ctx) => {
			const context = ctx as Ctx;
			if (context?.mode !== "tui") return;
			tracker.reset();
			jobs.reset();
			working = false;
			const seen = ctxSessionId(context);
			sessionId = seen;
			if (!publisher) {
				publisher = new MetadataPublisher({
					pane: herdr.pane,
					tokens: [NAME_TOKEN, TOKEN, PHASE_TOKEN, JOBS_TOKEN],
					send: deps.send ?? socketSend(herdr.socket),
					setInterval: deps.setInterval,
					clearInterval: deps.clearInterval,
				});
			}
			publish("session_start", { ctxSessionId: seen });
		});

		pi.on("agent_start", (_event, ctx) => {
			if (!publisher) return;
			const seen = ctxSessionId(ctx);
			syncSessionId(seen);
			working = true;
			publish("agent_start", { ctxSessionId: seen });
		});

		pi.on("agent_end", () => {
			if (!publisher || !working) return;
			working = false;
			publish("agent_end");
		});

		pi.on("tool_call", (event, ctx) => {
			if (!publisher) return;
			const { toolCallId, toolName, input } = event as ToolEvent;
			if (typeof toolCallId !== "string" || typeof toolName !== "string") return;
			const seen = ctxSessionId(ctx);
			syncSessionId(seen);
			tracker.toolCall(toolCallId, toolName, input);
			publish("tool_call", { toolName, ctxSessionId: seen });
		});

		pi.on("tool_result", (event, ctx) => {
			if (!publisher) return;
			const { toolCallId, toolName, details } = event as ToolEvent;
			if (typeof toolCallId !== "string" || typeof toolName !== "string") return;
			const seen = ctxSessionId(ctx);
			syncSessionId(seen);
			tracker.toolResult(toolCallId, toolName, details);
			publish("tool_result", { toolName, ctxSessionId: seen });
		});

		pi.on("session_shutdown", async () => {
			if (typeof off === "function") off();
			if (typeof offJobs === "function") offJobs();
			tracker.reset();
			jobs.reset();
			working = false;
			sessionId = undefined;
			const current = publisher;
			publisher = undefined;
			await current?.dispose();
		});
	};
}

export default createExtension();
