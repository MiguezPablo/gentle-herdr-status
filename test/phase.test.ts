import assert from "node:assert/strict";
import { test } from "node:test";

import {
	EMOJI_STYLE,
	ODD_PHASES,
	PHASE_EMOJIS,
	STYLE_ENV,
	WORKING_EMOJI,
	WORKING_PHASE,
	phaseStyle,
	phaseToken,
	readOddPhase,
} from "../src/phase.ts";

/** gentle-pi's registry key; the extension reads it through the same symbol. */
const REGISTRY = Symbol.for("gentle-pi.odd-phase-registry");

function withRegistry(value: unknown, run: () => void): void {
	const holder = globalThis as unknown as Record<symbol, unknown>;
	const saved = holder[REGISTRY];
	holder[REGISTRY] = value;
	try {
		run();
	} finally {
		if (saved === undefined) delete holder[REGISTRY];
		else holder[REGISTRY] = saved;
	}
}

test("every ODD phase is shown verbatim in square brackets, without ellipsis", () => {
	for (const phase of ODD_PHASES) {
		assert.equal(phaseToken(phase), `[${phase}]`);
		assert.equal(phaseToken(`${phase}…`), `[${phase}]`, "no ellipsis in the sidebar");
		assert.equal(phaseToken(` ${phase.toUpperCase()} `), `[${phase}]`);
	}
});

test("S11: with the emoji style each ODD phase is emoji + word, without brackets", () => {
	const expected: Record<string, string> = {
		authorizing: "🔐",
		exploring: "🔍",
		researching: "📚",
		deciding: "🤔",
		planning: "📝",
		implementing: "🔨",
		checking: "🔬",
		closing: "🏁",
	};
	assert.deepEqual(PHASE_EMOJIS, expected, "the map is exactly the agreed one");
	for (const phase of ODD_PHASES) {
		assert.equal(phaseToken(phase, "emoji"), `${expected[phase]} ${phase}`);
		assert.equal(phaseToken(`${phase.toUpperCase()}…`, "emoji"), `${expected[phase]} ${phase}`, "trim, lowercase and ellipsis are unchanged");
	}
});

test("S11: an unknown or missing phase falls back to the hourglass and working", () => {
	for (const value of [undefined, null, "", "dancing", "exploring now", 3, {}, []]) {
		assert.equal(phaseToken(value, "emoji"), `${WORKING_EMOJI} ${WORKING_PHASE}`, String(value));
	}
	assert.equal(WORKING_EMOJI, "⏳", "the fallback emoji is the hourglass");
});

test("S11: every emoji is a single codepoint, with no U+FE0F variation selector", () => {
	for (const emoji of [...Object.values(PHASE_EMOJIS), WORKING_EMOJI]) {
		assert.ok(!emoji.includes("\uFE0F"), `${emoji} must not carry the variation selector`);
		assert.equal([...emoji].length, 1, `${emoji} is one codepoint`);
	}
});

test("S11: only the exact value emoji opts in; unset or any other value keeps the brackets", () => {
	assert.equal(STYLE_ENV, "PI_HERDR_STATUS_STYLE");
	assert.equal(EMOJI_STYLE, "emoji");
	assert.equal(phaseStyle({ [STYLE_ENV]: "emoji" }), "emoji");
	assert.equal(phaseStyle({}), "brackets", "no variable at all");
	for (const value of [undefined, "", "EMOJI", " emoji", "emoji ", "1", "true", "brackets"]) {
		assert.equal(phaseStyle({ [STYLE_ENV]: value }), "brackets", JSON.stringify(value));
	}
});

test("PRESERVE: without the variable the bracketed token is byte-for-byte the same", () => {
	for (const phase of ODD_PHASES) {
		assert.equal(phaseToken(phase), `[${phase}]`, "the default style is the bracketed one");
		assert.equal(phaseToken(phase, phaseStyle({})), `[${phase}]`);
		assert.equal(phaseToken(phase, phaseStyle({ [STYLE_ENV]: "emoji" })), `${PHASE_EMOJIS[phase]} ${phase}`);
	}
	assert.equal(phaseToken(undefined, phaseStyle({ [STYLE_ENV]: "Emoji" })), "[working]", "the value is case sensitive");
});

test("a missing or unknown phase falls back to [working]", () => {
	for (const value of [undefined, null, "", "dancing", "exploring now", "[]", 3, {}, []]) {
		assert.equal(phaseToken(value), `[${WORKING_PHASE}]`, String(value));
	}
	assert.equal(WORKING_PHASE, "working");
	assert.equal(phaseToken(undefined), "[working]", "the brackets never stay empty");
});

test("PRESERVE: the default reader still asks gentle-pi's process-global registry for the session", () => {
	const asked: string[] = [];
	withRegistry({
		get: (sessionId: string) => {
			asked.push(sessionId);
			return "researching";
		},
	}, () => assert.equal(readOddPhase("s1"), "researching"));
	assert.deepEqual(asked, ["s1"]);
});

test("a class-shaped registry is read through its own instance, not as an unbound method", () => {
	// gentle-pi's real registry is a class whose `get` reads `this.phases`.
	class OddPhaseRegistry {
		private readonly phases = new Map<string, { phase: string; source: string }>();

		set(sessionId: string, phase: string): void {
			this.phases.set(sessionId, { phase, source: "odd" });
		}

		get(sessionId: string): string | undefined {
			return sessionId ? this.phases.get(sessionId)?.phase : undefined;
		}
	}

	const registry = new OddPhaseRegistry();
	registry.set("s1", "exploring");

	withRegistry(registry, () => {
		assert.equal(readOddPhase("s1"), "exploring", "a phase `get` needs its own instance as `this`");
		assert.equal(readOddPhase("other"), undefined, "an untracked session has no phase");
	});
});

test("an absent, malformed or throwing registry reads as no phase", () => {
	withRegistry(undefined, () => assert.equal(readOddPhase("s1"), undefined));
	withRegistry({}, () => assert.equal(readOddPhase("s1"), undefined));
	withRegistry({ get: "nope" }, () => assert.equal(readOddPhase("s1"), undefined));
	withRegistry({ get: () => { throw new Error("boom"); } }, () => assert.equal(readOddPhase("s1"), undefined));
});
