/**
 * Reads the ODD phase gentle-pi shows in its prompt label, so the sidebar can
 * repeat it next to `pi` (`pi [exploring]`) instead of guessing. The phase is the only
 * bracketed token: parentheses already mark the subagent count (`↳ explore (+1)`).
 *
 * Evidence (gentle-pi 4.7.0, lib/odd-phase.ts): the phase of each session lives in a
 * process-global registry stored under `Symbol.for("gentle-pi.odd-phase-registry")`,
 * because Pi loads extensions with separate module caches. The registry exposes only
 * `get(sessionId)` as a method on that instance, so it must be called bound (its body
 * reads `this.phases`); there is no change event, since gentle-pi's single
 * `setRenderRequest` slot belongs to its prompt. Because polling the registry every
 * second only for this token was not worth it, the extension reads it on the events it
 * already handles (turn start, tool call, tool result) and never on a timer of its own.
 *
 * The registry is optional: gentle-pi may not be loaded, an older version may not
 * expose `get`, a future one may change the shape, or it may throw. Every one of those
 * cases reads as "no phase available" and the sidebar falls back to `working`, so the
 * row never shows a phase that is not actually running.
 *
 * Style is opt-in: with `PI_HERDR_STATUS_STYLE=emoji` the phase token is an emoji plus
 * the word (`🔍 exploring`) instead of the bracketed word (`[exploring]`), because the
 * shape is recognized faster than the word. Anything else, including the variable being
 * unset, keeps the bracketed form byte for byte. Only `$phase` changes: `$subagent`,
 * `$jobs` and `$name` are left alone.
 */
import type { Env } from "./herdr.ts";

/** Phases gentle-pi cycles through; each is shown verbatim as one lowercase word, bracketed. */
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

/** Opt-in switch for the emoji style. */
export const STYLE_ENV = "PI_HERDR_STATUS_STYLE";
/** The only value that turns the emoji style on; any other value keeps the brackets. */
export const EMOJI_STYLE = "emoji";

/**
 * One single-codepoint emoji per phase, with no U+FE0F variation selector so every
 * terminal renders one glyph. It is a fallback shape, not a replacement: the word is
 * still there, because an emoji alone is ambiguous (a hammer is not "implementing").
 */
export const PHASE_EMOJIS: Readonly<Record<string, string>> = {
	authorizing: "🔐",
	exploring: "🔍",
	researching: "📚",
	deciding: "🤔",
	planning: "📝",
	implementing: "🔨",
	checking: "✅",
	closing: "🏁",
};

/** Emoji of the fallback phase (`working`): the agent works, no phase was reported. */
export const WORKING_EMOJI = "⏳";

/** How the phase token is rendered: `[exploring]` by default, `🔍 exploring` when opted in. */
export type PhaseStyle = "brackets" | "emoji";

/** The style this `env` asks for: only the exact value `emoji` opts in. */
export function phaseStyle(env: Env): PhaseStyle {
	return env[STYLE_ENV] === EMOJI_STYLE ? "emoji" : "brackets";
}

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
		// Called bound to the registry: gentle-pi's is a class whose `get` reads `this.phases`.
		return (get as (id: string) => unknown).call(registry, sessionId);
	} catch {
		return undefined;
	}
};

/**
 * Sidebar token for a reported phase: `[<known ODD phase>]` (else `[working]`), or
 * `<emoji> <phase>` (else `⏳ working`) when the emoji style is on.
 */
export function phaseToken(value: unknown, style: PhaseStyle = "brackets"): string {
	const word = phaseWord(value);
	if (style === "emoji") return `${PHASE_EMOJIS[word] ?? WORKING_EMOJI} ${word}`;
	return `[${word}]`;
}

/** The bare phase word, so the brackets are added in exactly one place. */
function phaseWord(value: unknown): string {
	if (typeof value !== "string") return WORKING_PHASE;
	const word = value.trim().toLowerCase().replace(/[\u2026.]+$/u, "").trim();
	return (ODD_PHASES as readonly string[]).includes(word) ? word : WORKING_PHASE;
}
