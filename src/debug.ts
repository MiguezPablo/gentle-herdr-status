/**
 * Opt-in diagnostic for the `$phase` token. When `PI_HERDR_STATUS_DEBUG` holds a file
 * path, every event that publishes the sidebar tokens appends one JSON line with what
 * that event saw: its name and tool name, the session id its own ctx reported, the id
 * the phase lookup actually used, the ODD registry this process can see (its
 * `typeof`, the sessions it tracks and their phase/source), the raw value the registry
 * returned and the token that went to Herdr.
 *
 * It exists because the phase shown in the sidebar can stay `[working]` while gentle-pi
 * reports another phase: the line tells apart a session-id mismatch, a registry loaded
 * by another module instance, and a phase that was never reported. Off by default (no
 * path, no writes) and never throwing: a diagnostic must not break publishing.
 */
import { appendFileSync } from "node:fs";

import type { Env } from "./herdr.ts";

/** Opt-in switch: a file path, never a boolean. Unset means no diagnostics at all. */
export const DEBUG_ENV = "PI_HERDR_STATUS_DEBUG";

/** gentle-pi's registry key; the same symbol shows which registry *this* loader sees. */
const REGISTRY = Symbol.for("gentle-pi.odd-phase-registry");

/** One session gentle-pi tracks; its store is a private `Map`, so it is read defensively. */
export type TrackedSession = { id: string; phase: unknown; source: unknown };

/** What this process' ODD registry looks like right now. */
export type RegistrySnapshot = { type: string; sessions: TrackedSession[] };

/** What one publishing event saw. */
export type DebugRecord = {
	event: string;
	toolName?: string;
	/** Session id this event's own ctx reported, before any fallback. */
	ctxSessionId?: string;
	/** Session id the phase lookup actually used. */
	sessionId?: string;
	/** Raw value the phase reader returned for that id. */
	rawPhase?: unknown;
	/** Token published to Herdr, `null` when the token is cleared. */
	token: string | null;
};

export type AppendLine = (path: string, line: string) => void;
export type DebugWriter = (record: DebugRecord) => void;

/**
 * The registry's tracked sessions: `[...registry.phases.keys()]` plus each entry's
 * phase and source. A missing, primitive, differently shaped or throwing registry
 * reads as "no sessions" and only its `typeof` survives.
 */
export function registrySnapshot(): RegistrySnapshot {
	let registry: unknown;
	try {
		registry = (globalThis as unknown as Record<symbol, unknown>)[REGISTRY];
	} catch {
		registry = undefined;
	}
	const type = typeof registry;
	const sessions: TrackedSession[] = [];
	try {
		const phases = (registry as { phases?: unknown } | null | undefined)?.phases;
		const keys = (phases as { keys?: unknown } | null | undefined)?.keys;
		const get = (phases as { get?: unknown } | null | undefined)?.get;
		if (typeof keys !== "function") return { type, sessions };
		for (const id of (keys as () => Iterable<unknown>).call(phases) ?? []) {
			let entry: unknown;
			if (typeof get === "function") {
				try {
					entry = (get as (key: unknown) => unknown).call(phases, id);
				} catch {
					entry = undefined;
				}
			}
			const tracked = entry as { phase?: unknown; source?: unknown } | null | undefined;
			sessions.push({ id: String(id), phase: tracked?.phase ?? null, source: tracked?.source ?? null });
		}
	} catch {
		return { type, sessions };
	}
	return { type, sessions };
}

/**
 * A writer for the events of one extension instance: appends one JSON line per record
 * to the configured path, or does nothing when the variable is unset. `append` is
 * injectable (tests) and its failures, like the ones of the default sink, are ignored.
 */
export function createDebug(deps: { env?: Env; append?: AppendLine } = {}): DebugWriter {
	const env = deps.env ?? process.env;
	const path = env[DEBUG_ENV]?.trim();
	if (!path) return () => {};
	const append = deps.append ?? ((target: string, line: string) => appendFileSync(target, line));
	return (record) => {
		try {
			append(path, `${JSON.stringify(line(record))}\n`);
		} catch {
			// A diagnostic never breaks publishing: an unwritable path is simply ignored.
		}
	};
}

/** One self-describing line: `ts` and `pid` tell which process wrote it. */
function line(record: DebugRecord): Record<string, unknown> {
	const snapshot = registrySnapshot();
	return {
		ts: new Date().toISOString(),
		pid: process.pid,
		event: record.event,
		toolName: record.toolName ?? null,
		ctxSessionId: record.ctxSessionId ?? null,
		sessionId: record.sessionId ?? null,
		registryType: snapshot.type,
		registrySessions: snapshot.sessions,
		rawPhase: record.rawPhase ?? null,
		token: record.token,
	};
}
