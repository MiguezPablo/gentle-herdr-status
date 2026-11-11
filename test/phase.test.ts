import assert from "node:assert/strict";
import { test } from "node:test";

import { ODD_PHASES, WORKING_PHASE, phaseToken, readOddPhase } from "../src/phase.ts";

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
