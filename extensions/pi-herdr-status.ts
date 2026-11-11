/**
 * pi-herdr-status: shows the running subagent in the Herdr sidebar as the
 * `$subagent` token, e.g. `explore` or `worker (3)`.
 *
 * Only presentation metadata (`pane.report_metadata`). Pane state
 * (working/blocked/idle) and desktop notifications stay with Herdr's official
 * Pi integration and Herdr's own [ui.toast]/[ui.sound] settings, so this
 * extension never reports state, never reacts to UI prompts and never notifies.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { MetadataPublisher, herdrPane, socketSend, type Env, type PublisherOptions, type Send } from "../src/herdr.ts";
import { SubagentTracker } from "../src/tracker.ts";

/** gentle-pi's content-free notification bus; subagent status changes carry taskId and status. */
export const STATUS_CHANNEL = "gentle-pi:notification:source";

export type ExtensionDeps = {
	env?: Env;
	send?: Send;
	setInterval?: PublisherOptions["setInterval"];
	clearInterval?: PublisherOptions["clearInterval"];
};

type Ctx = { mode?: string } | undefined;
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

		const tracker = new SubagentTracker();
		let publisher: MetadataPublisher | undefined;
		const publish = () => publisher?.set(tracker.label());

		const off = pi.events.on(STATUS_CHANNEL, (data: unknown) => {
			if (!publisher || !record(data) || data.source !== "subagent") return;
			if (typeof data.taskId !== "string" || typeof data.status !== "string") return;
			tracker.status(data.taskId, data.status);
			publish();
		});

		pi.on("session_start", (_event, ctx) => {
			if ((ctx as Ctx)?.mode !== "tui") return;
			tracker.reset();
			if (!publisher) {
				publisher = new MetadataPublisher({
					pane: herdr.pane,
					send: deps.send ?? socketSend(herdr.socket),
					setInterval: deps.setInterval,
					clearInterval: deps.clearInterval,
				});
			}
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
			const current = publisher;
			publisher = undefined;
			await current?.dispose();
		});
	};
}

export default createExtension();
