import assert from "node:assert/strict";
import { test } from "node:test";

import { JOBS_PREFIX, JobsTracker } from "../src/jobs.ts";

/** Un job corriendo: gentle-pi lo publica sin `status`. */
const running = (id: string, label: string, startedAt: number) => ({ id, label, startedAt });
/** Un job terminado: llega con `status` para que el sidebar lo pueda desvanecer. */
const finished = (id: string, label: string, startedAt: number) =>
	({ id, label, startedAt, status: "exited", endedAt: startedAt + 5, exitCode: 0 });

const snapshot = (sessionId: string, jobs: unknown[]) => ({ sessionId, snapshot: { jobs } });

test("no running job shows no token at all", () => {
	const tracker = new JobsTracker();
	assert.equal(tracker.label(), null);
	tracker.snapshot(snapshot("s1", []), "s1");
	assert.equal(tracker.label(), null);
});

test("one running job shows its label after the arrow, without a count", () => {
	const tracker = new JobsTracker();
	tracker.snapshot(snapshot("s1", [running("j1", "CI for PR 1834", 10)]), "s1");
	assert.equal(tracker.label(), `${JOBS_PREFIX}CI for PR 1834`);
});

test("two or more running jobs show the oldest one and the total count", () => {
	const tracker = new JobsTracker();
	tracker.snapshot(snapshot("s1", [
		running("j3", "dev server", 30),
		running("j1", "CI for PR 1834", 10),
		running("j2", "logs", 20),
	]), "s1");
	assert.equal(tracker.label(), `${JOBS_PREFIX}CI for PR 1834 (3)`, "the oldest job, with the count");
});

test("finished jobs are listed but never shown nor counted", () => {
	const tracker = new JobsTracker();
	tracker.snapshot(snapshot("s1", [finished("j1", "old build", 10), running("j2", "logs", 20)]), "s1");
	assert.equal(tracker.label(), `${JOBS_PREFIX}logs`, "a finished job still in the snapshot does not count");
	tracker.snapshot(snapshot("s1", [finished("j1", "old build", 10)]), "s1");
	assert.equal(tracker.label(), null, "with no running job the token is cleared");
});

test("each event replaces the whole state", () => {
	const tracker = new JobsTracker();
	tracker.snapshot(snapshot("s1", [running("j1", "logs", 10), running("j2", "dev server", 20)]), "s1");
	assert.equal(tracker.label(), `${JOBS_PREFIX}logs (2)`);
	tracker.snapshot(snapshot("s1", [running("j2", "dev server", 20)]), "s1");
	assert.equal(tracker.label(), `${JOBS_PREFIX}dev server`, "the job the snapshot dropped is gone");
});

test("the label is sanitized and capped like the subagent one, and empty becomes job", () => {
	const tracker = new JobsTracker();
	tracker.snapshot(snapshot("s1", [running("j1", "  npm\u0007test\nrun  ", 10)]), "s1");
	assert.equal(tracker.label(), `${JOBS_PREFIX}npm test run`, "one printable line");
	tracker.snapshot(snapshot("s1", [running("j1", " x ".repeat(40), 10)]), "s1");
	assert.equal(tracker.label(), `${JOBS_PREFIX}${"x ".repeat(16).trim()}`, "capped at 32 characters");
	assert.ok(tracker.label()!.length <= JOBS_PREFIX.length + 32, "at most 32 characters of label");
	tracker.snapshot(snapshot("s1", [running("j1", "   ", 10)]), "s1");
	assert.equal(tracker.label(), `${JOBS_PREFIX}job`, "an empty label falls back to job");
});

test("an event of another session is ignored and keeps the current state", () => {
	const tracker = new JobsTracker();
	tracker.snapshot(snapshot("s1", [running("j1", "logs", 10)]), "s1");
	tracker.snapshot(snapshot("s2", [running("j9", "other", 10)]), "s1");
	assert.equal(tracker.label(), `${JOBS_PREFIX}logs`, "another session never replaces this one");
	tracker.snapshot(snapshot("s2", []), "s1");
	assert.equal(tracker.label(), `${JOBS_PREFIX}logs`, "and never clears it either");
});

test("a malformed payload is ignored and keeps the current state", () => {
	const tracker = new JobsTracker();
	tracker.snapshot(snapshot("s1", [running("j1", "logs", 10)]), "s1");
	const malformed: unknown[] = [
		undefined,
		null,
		"jobs",
		[],
		{ sessionId: "s1" },
		{ sessionId: "s1", snapshot: "jobs" },
		{ sessionId: "s1", snapshot: { jobs: "logs" } },
		{ snapshot: { jobs: [] } },
		{ sessionId: 42, snapshot: { jobs: [] } },
	];
	for (const payload of malformed) {
		tracker.snapshot(payload, "s1");
		assert.equal(tracker.label(), `${JOBS_PREFIX}logs`, JSON.stringify(payload));
	}
	tracker.snapshot({ sessionId: "s1", snapshot: { jobs: [{ label: "sin startedAt" }, { id: "j2" }, 7] } }, "s1");
	assert.equal(tracker.label(), null, "a valid snapshot without usable jobs clears the token");
});

test("reset drops every job", () => {
	const tracker = new JobsTracker();
	tracker.snapshot(snapshot("s1", [running("j1", "logs", 10)]), "s1");
	tracker.reset();
	assert.equal(tracker.label(), null);
});
