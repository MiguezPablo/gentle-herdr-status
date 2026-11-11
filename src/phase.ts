/**
 * Reads the ODD phase gentle-pi shows in its prompt label, so the sidebar can
 * repeat it next to `pi` (`pi exploring`) instead of guessing.
 *
 * Evidence (gentle-pi 4.7.0, lib/odd-phase.ts): the phase of each session lives in a
 * process-global registry stored under `Symbol.for("gentle-pi.odd-phase-registry")`,
 * because Pi loads extensions with separate module caches. The registry exposes only
 * `get(sessionId)`; there is no change event, since gentle-pi's single
 * `setRenderRequest` slot belongs to its prompt.
 *
 * The registry is optional: gentle-pi may not be loaded, an older version may not
 * expose `get`, a future one may change the shape, or it may throw. Every one of those
 * cases reads as "no phase available" and the sidebar falls back to `working`, so the
 * row never shows a phase that is not actually running.
 */

/** Phases gentle-pi cycles through; each is shown verbatim as one lowercase word. */
export const ODD_PHASES = [
	"authorizing",
	"exploring",
	"researching",
	"deciding",
	"planning",
	"implementing",
	"checking",
	"closing",
] as const;

/** Shown while the agent works but gentle-pi reports no usable phase. */
export const WORKING_PHASE = "working";

/** How often the registry is re-read while the agent works (gentle-pi has no event). */
export const PHASE_POLL_MS = 1_000;

/** gentle-pi's registry key; the same symbol is the only bridge across loaders. */
const REGISTRY = Symbol.for("gentle-pi.odd-phase-registry");

export type PhaseReader = (sessionId: string) => unknown;

/** Default reader: gentle-pi's optional registry, never throwing. */
export const readOddPhase: PhaseReader = (sessionId) => {
	try {
		const registry = (globalThis as unknown as Record<symbol, unknown>)[REGISTRY];
		if (typeof registry !== "object" || registry === null) return undefined;
		const get = (registry as { get?: unknown }).get;
		if (typeof get !== "function") return undefined;
		return (get as (id: string) => unknown)(sessionId);
	} catch {
		return undefined;
	}
};

/** Sidebar word for a reported phase: a known ODD phase, else `working`. */
export function phaseToken(value: unknown): string {
	if (typeof value !== "string") return WORKING_PHASE;
	const word = value.trim().toLowerCase().replace(/[\u2026.]+$/u, "").trim();
	return (ODD_PHASES as readonly string[]).includes(word) ? word : WORKING_PHASE;
}
