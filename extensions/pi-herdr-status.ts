/**
 * pi-herdr-status: shows the running subagent, what the orchestrator is doing and the
 * jobs it launched in the Herdr sidebar, as the `$name` token (`gentle`), the `$phase`
 * token (a gentle-pi ODD phase in square brackets, such as `[exploring]`, else
 * `[working]`), the `$subagent` token (`↳ explore` or `↳ worker (+2)`) and the `$jobs`
 * token (`⏵ CI for PR 1834` or `⏵ logs (+1)`) and, opt-in, the `$changes` token
 * (`+120 -40`, the uncommitted lines of the session's git repo).
 *
 * With `PI_HERDR_STATUS_STYLE=emoji` the `$phase` token is shown as an emoji plus the
 * phase word (`🔍 exploring`) instead of the bracketed word (`[exploring]`); every other
 * token and the whole default behaviour stay the same.
 *
 * With `PI_HERDR_STATUS_CHANGES=1` the `$changes` token counts the uncommitted lines of
 * the session's git repo (`+120 -40`); without that exact value it is never computed and
 * the token is published as null.
 *
 * Only presentation metadata (`pane.report_metadata`). Pane state
 * (working/blocked/idle) and desktop notifications stay with Herdr's official
 * Pi integration and Herdr's own [ui.toast]/[ui.sound] settings, so this
 * extension never reports state, never reacts to UI prompts and never notifies.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createDebug, type DebugWriter } from "../src/debug.ts";
import { ChangesCounter, changesEnabled, type GitRun } from "../src/changes.ts";
import {
	CHANGES_TOKEN,
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
import { phaseStyle, phaseToken, readOddPhase, type PhaseReader, type PhaseStyle } from "../src/phase.ts";
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
	/** Replaces the git runner of the opt-in `$changes` counter (tests); by default it runs git. */
	runGit?: GitRun;
};

type Ctx = {
	mode?: string;
	cwd?: unknown;
	sessionManager?: { getSessionId?: () => string };
} | undefined;
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
		// Sólo el valor exacto `emoji` cambia el aspecto; sin la variable todo queda igual.
		const style: PhaseStyle = phaseStyle(env);
		// Off by default: with `PI_HERDR_STATUS_DEBUG` unset the writer does nothing.
		const debug = deps.debug ?? createDebug({ env });

		const tracker = new SubagentTracker();
		const jobs = new JobsTracker();
		// Opt-in (S12): sin `PI_HERDR_STATUS_CHANGES=1` no hay contador y nunca se ejecuta git.
		const changes = changesEnabled(env)
			? new ChangesCounter({
				cwd: process.cwd(),
				run: deps.runGit,
				// Una medición terminada se publica en el mismo reporte que los demás tokens.
				onChange: () => { report(); },
			})
			: undefined;
		let publisher: MetadataPublisher | undefined;
		let sessionId: string | undefined;
		let working = false;

		type PhaseRead = { raw: unknown; token: string | null };

		/** `$phase`: only while the agent works, read on the turn and tool events, never polled. */
		const phase = (): PhaseRead => {
			if (!working) return { raw: null, token: null };
			if (sessionId === undefined) return { raw: null, token: phaseToken(undefined, style) };
			try {
				const raw = readPhase(sessionId);
				return { raw: raw ?? null, token: phaseToken(raw, style) };
			} catch {
				return { raw: null, token: phaseToken(undefined, style) };
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

		/** Session cwd of this event, when its ctx reports one; else the last known one is kept. */
		const ctxCwd = (ctx: unknown): string | undefined => {
			try {
				const cwd = (ctx as Ctx)?.cwd;
				return typeof cwd === "string" && cwd.length > 0 ? cwd : undefined;
			} catch {
				return undefined;
			}
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
			// `$changes` se publica igual que `$jobs`; sin la variable siempre va limpio.
			publisher?.set(CHANGES_TOKEN, changes?.token() ?? null);
			return read;
		};

		/** Dispara una medición de `$changes` sin bloquear el evento, con el cwd de su ctx. */
		const refreshChanges = (ctx: unknown): void => {
			changes?.refresh(ctxCwd(ctx));
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
			// Un job cambió: pudo dejar cambios en el repo, así que se remide.
			refreshChanges(undefined);
		});

		pi.on("session_start", (_event, ctx) => {
			const context = ctx as Ctx;
			if (context?.mode !== "tui") return;
			tracker.reset();
			jobs.reset();
			changes?.reset();
			working = false;
			const seen = ctxSessionId(context);
			sessionId = seen;
			if (!publisher) {
				publisher = new MetadataPublisher({
					pane: herdr.pane,
					tokens: [NAME_TOKEN, TOKEN, PHASE_TOKEN, JOBS_TOKEN, CHANGES_TOKEN],
					send: deps.send ?? socketSend(herdr.socket),
					setInterval: deps.setInterval,
					clearInterval: deps.clearInterval,
				});
			}
			publish("session_start", { ctxSessionId: seen });
			refreshChanges(context);
		});

		pi.on("agent_start", (_event, ctx) => {
			if (!publisher) return;
			const seen = ctxSessionId(ctx);
			syncSessionId(seen);
			working = true;
			publish("agent_start", { ctxSessionId: seen });
			refreshChanges(ctx);
		});

		pi.on("agent_end", (_event, ctx) => {
			if (!publisher || !working) return;
			working = false;
			publish("agent_end");
			refreshChanges(ctx);
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
			// Cubre edit/write/bash y el fin de un subagente: cualquier herramienta puede tocar el repo.
			refreshChanges(ctx);
		});

		pi.on("session_shutdown", async () => {
			if (typeof off === "function") off();
			if (typeof offJobs === "function") offJobs();
			tracker.reset();
			jobs.reset();
			changes?.dispose();
			working = false;
			sessionId = undefined;
			const current = publisher;
			publisher = undefined;
			await current?.dispose();
		});
	};
}

export default createExtension();
