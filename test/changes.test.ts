import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	CHANGES_ENV,
	ChangesCounter,
	EMPTY_TREE,
	changesEnabled,
	changesToken,
	type GitRun,
	type ReadFile,
} from "../src/changes.ts";

const HEAD = "rev-parse --verify --quiet HEAD";
const DIFF = (base: string) => `diff --numstat ${base}`;
const UNTRACKED = "ls-files --others --exclude-standard";

/** git falso: cada comando esperado devuelve su salida; cualquier otro es un error del test. */
function fakeGit(outputs: Record<string, string | Error>) {
	const calls: string[] = [];
	const run: GitRun = async (args) => {
		const key = args.join(" ");
		calls.push(key);
		const output = outputs[key];
		if (output === undefined) throw new Error(`unexpected git call: ${key}`);
		if (output instanceof Error) throw output;
		return output;
	};
	return { run, calls };
}

/** Un repo con HEAD, sin untracked: sólo importa el numstat que pida el test. */
function repo(numstat: string, outputs: Record<string, string | Error> = {}) {
	return fakeGit({
		[HEAD]: "abc123\n",
		[DIFF("abc123")]: numstat,
		[UNTRACKED]: "",
		...outputs,
	});
}

/** Lee cada untracked del mapa; un archivo que no está es un error del test. */
function fakeRead(files: Record<string, Buffer | string>) {
	const read: ReadFile = async (path) => {
		const content = files[path];
		if (content === undefined) throw new Error(`unexpected read: ${path}`);
		return typeof content === "string" ? Buffer.from(content) : content;
	};
	return read;
}

/** Corre un refresco y espera el valor publicado; el guard de timeout no debe quedar colgado. */
async function measure(counter: ChangesCounter, cwd = "/repo"): Promise<string | null> {
	let done: (token: string | null) => void = () => {};
	const seen = new Promise<string | null>((resolve) => { done = resolve; });
	counter.refresh(cwd);
	return Promise.race([seen, new Promise<string | null>((resolve) => setTimeout(() => resolve(counter.token()), 200))]);
}

test("S12: only the exact value 1 turns the token on", () => {
	assert.equal(changesEnabled({ [CHANGES_ENV]: "1" }), true);
	for (const value of [undefined, "", "0", "true", "yes", " 1", "1 ", "ONE"]) {
		assert.equal(changesEnabled({ [CHANGES_ENV]: value }), false, JSON.stringify(value));
	}
});

test("S12: the token is +added -deleted with an ASCII hyphen, and null when nothing changed", () => {
	assert.equal(changesToken(120, 40), "+120 -40");
	assert.equal(changesToken(5, 0), "+5 -0", "a zero part is still shown");
	assert.equal(changesToken(0, 7), "+0 -7");
	assert.equal(changesToken(0, 0), null, "no changes, no token");
});

test("S12: sums every numstat row against HEAD and ignores binary rows", async () => {
	const git = repo("100\t40\tsrc/a.ts\n20\t0\tsrc/b.ts\n-\t-\tlogo.png\n");
	const tokens: (string | null)[] = [];
	const counter = new ChangesCounter({ cwd: "/repo", run: git.run, onChange: (token) => tokens.push(token) });
	assert.equal(await measure(counter), "+120 -40");
	assert.deepEqual(git.calls, [HEAD, DIFF("abc123"), UNTRACKED], "one diff against HEAD, no shell");
	assert.deepEqual(tokens, ["+120 -40"]);
});

test("S12: an untracked text file adds its lines and a binary one is skipped", async () => {
	const git = repo("", { [UNTRACKED]: "notes.md\nlogo.png\n" });
	const read = fakeRead({
		"/repo/notes.md": "uno\ndos\ntres\n",
		"/repo/logo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
	});
	const counter = new ChangesCounter({ cwd: "/repo", run: git.run, readFile: read, onChange: () => {} });
	assert.equal(await measure(counter), "+3 -0", "three lines of text, the binary contributes nothing");
});

test("S12: a repo without commits compares against git's empty tree", async () => {
	const git = fakeGit({
		[HEAD]: new Error("fatal: Needed a single revision"),
		[DIFF(EMPTY_TREE)]: "12\t3\tREADME.md\n",
		[UNTRACKED]: "",
	});
	const counter = new ChangesCounter({ cwd: "/repo", run: git.run, onChange: () => {} });
	assert.equal(await measure(counter), "+12 -3");
	assert.deepEqual(git.calls, [HEAD, DIFF(EMPTY_TREE), UNTRACKED]);
});

test("S12: a failing or hanging git reads as null, never the previous value", async () => {
	const git = repo("4\t1\ta.ts\n");
	let fail = false;
	const run: GitRun = async (args, cwd) => {
		if (fail && args[0] === "diff") throw new Error("fatal: not a git repository");
		return git.run(args, cwd);
	};
	const tokens: (string | null)[] = [];
	const counter = new ChangesCounter({ cwd: "/repo", run, onChange: (token) => tokens.push(token) });
	assert.equal(await measure(counter), "+4 -1");
	fail = true;
	assert.equal(await measure(counter), null, "an error clears the token instead of keeping it");
	assert.deepEqual(tokens, ["+4 -1", null]);

	const hanging: GitRun = () => new Promise(() => {});
	const stuck = new ChangesCounter({ cwd: "/repo", run: hanging, timeoutMs: 10, onChange: () => {} });
	assert.equal(await measure(stuck), null, "a git that never answers times out");
});

test("S12: at most one measurement in flight, plus exactly one queued re-measurement", async () => {
	let release: (() => void) | undefined;
	let waitOnce = true;
	const calls: string[] = [];
	const run: GitRun = async (args) => {
		const key = args.join(" ");
		calls.push(key);
		if (key === HEAD) return "abc123\n";
		if (key.startsWith("diff --numstat")) {
			if (waitOnce) {
				waitOnce = false;
				await new Promise<void>((resolve) => { release = resolve; });
			}
			return "7\t2\ta.ts\n";
		}
		if (key === UNTRACKED) return "";
		throw new Error(`unexpected git call: ${key}`);
	};
	const tokens: (string | null)[] = [];
	const counter = new ChangesCounter({ cwd: "/repo", run, onChange: (token) => tokens.push(token) });
	counter.refresh("/repo");
	assert.equal(calls.filter((call) => call === HEAD).length, 1);
	for (let i = 0; i < 5; i++) counter.refresh("/repo");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(calls.filter((call) => call === HEAD).length, 1, "events during a measurement never start another one");
	release?.();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(calls.filter((call) => call === HEAD).length, 2, "they collapse into exactly one more");
	assert.equal(counter.token(), "+7 -2");
	assert.deepEqual(tokens, ["+7 -2", "+7 -2"], "each finished measurement publishes");
});

test("S12: a disposed counter publishes nothing more", async () => {
	let release: (() => void) | undefined;
	const run: GitRun = async (args) => {
		const key = args.join(" ");
		if (key === HEAD) return "abc123\n";
		if (key.startsWith("diff --numstat")) {
			await new Promise<void>((resolve) => { release = resolve; });
			return "3\t0\ta.ts\n";
		}
		return "";
	};
	const tokens: (string | null)[] = [];
	const counter = new ChangesCounter({ cwd: "/repo", run, onChange: (token) => tokens.push(token) });
	counter.refresh("/repo");
	counter.dispose();
	release?.();
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(tokens, [], "shutdown drops the result instead of publishing it");
	assert.equal(counter.token(), null);
});

/** git disponible en la máquina: sin él el test de integración se salta. */
function hasGit(): boolean {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

test("S12: integration: a real temp repo counts staged, unstaged and untracked lines", async (t) => {
	if (!hasGit()) {
		t.skip("git is not installed");
		return;
	}
	const dir = mkdtempSync(join(tmpdir(), "pi-herdr-status-changes-"));
	const clean = mkdtempSync(join(tmpdir(), "pi-herdr-status-changes-"));
	const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
	try {
		git("init", "-q", "-b", "main");
		writeFileSync(join(dir, "tracked.txt"), "uno\ndos\ntres\n");
		git("add", "tracked.txt");
		git("-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "init");
		writeFileSync(join(dir, "tracked.txt"), "uno\ndos\ntres\ncuatro\ncinco\n");
		writeFileSync(join(dir, "new.txt"), "a\nb\n");
		const counter = new ChangesCounter({ cwd: dir, onChange: () => {} });
		assert.equal(await measure(counter, dir), "+4 -0", "two added lines plus two untracked lines");

		// Repo sin commits: el staged se mide contra el árbol vacío.
		execFileSync("git", ["init", "-q", "-b", "main"], { cwd: clean, stdio: "ignore" });
		writeFileSync(join(clean, "first.txt"), "x\ny\nz\n");
		execFileSync("git", ["add", "first.txt"], { cwd: clean, stdio: "ignore" });
		const empty = new ChangesCounter({ cwd: clean, onChange: () => {} });
		assert.equal(await measure(empty, clean), "+3 -0", "no HEAD yet, compared against the empty tree");
	} finally {
		rmSync(dir, { recursive: true, force: true });
		rmSync(clean, { recursive: true, force: true });
	}
});
