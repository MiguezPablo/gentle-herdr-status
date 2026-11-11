import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CHANGES_ENV } from "../src/changes.ts";
import {
	CONFIG_ENV,
	DEFAULT_CONFIG,
	OPTION_IDS,
	applyName,
	configFilePath,
	cycleOption,
	describeConfig,
	effectiveConfig,
	loadConfig,
	normalizeConfig,
	optionRows,
	saveConfig,
	type HerdrStatusConfig,
} from "../src/config.ts";
import { STYLE_ENV } from "../src/phase.ts";
import { PANEL_NAME } from "../src/herdr.ts";

/** Todo test escribe en un directorio temporal, nunca en el archivo real del usuario. */
function withTempDir(run: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "pi-herdr-status-config-"));
	try {
		run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("S13/S17: the defaults are the current behaviour: plain style, no changes, tokens on, name gentle", () => {
	assert.deepEqual(DEFAULT_CONFIG, {
		style: "plain",
		changes: false,
		name: PANEL_NAME,
		showSubagent: true,
		showJobs: true,
		colors: false,
	});
	assert.equal(PANEL_NAME, "gentle");
	for (const raw of [undefined, null, "config", 7, [], {}]) {
		assert.deepEqual(normalizeConfig(raw), DEFAULT_CONFIG, JSON.stringify(raw));
	}
});

test("S13: an invalid field falls back to its own default and the valid ones are kept", () => {
	assert.deepEqual(normalizeConfig({
		style: "sparkles",
		changes: "yes",
		name: 42,
		showSubagent: "no",
		showJobs: false,
		colors: "yes",
	}), {
		style: "plain",
		changes: false,
		name: "gentle",
		showSubagent: true,
		showJobs: false,
		colors: false,
	});
	assert.deepEqual(normalizeConfig({ style: "emoji", changes: true }), {
		...DEFAULT_CONFIG,
		style: "emoji",
		changes: true,
	});
});

test("S13: the name is sanitized, capped at 32 characters and never empty", () => {
	assert.equal(normalizeConfig({ name: "  " }).name, "gentle", "blank falls back to gentle");
	assert.equal(normalizeConfig({ name: "my  panel" }).name, "my panel", "whitespace is collapsed");
	assert.equal(normalizeConfig({ name: "evil\u001b[31mname" }).name, "evilname", "escape sequences are dropped");
	assert.equal(normalizeConfig({ name: "x".repeat(40) }).name, "x".repeat(32), "capped at 32");
	assert.equal(normalizeConfig({ name: "\u0000\u0001" }).name, "gentle", "only control characters falls back too");
});

test("S13: the config path comes from the injected env, XDG first, then HOME", () => {
	assert.equal(
		configFilePath({ HOME: "/home/u" }),
		join("/home/u", ".config", "pi-herdr-status", "config.json"),
		"no XDG falls back to ~/.config",
	);
	assert.equal(
		configFilePath({ HOME: "/home/u", XDG_CONFIG_HOME: "/xdg" }),
		join("/xdg", "pi-herdr-status", "config.json"),
		"XDG wins over HOME",
	);
	assert.equal(
		configFilePath({ HOME: "/home/u", XDG_CONFIG_HOME: "/xdg", [CONFIG_ENV]: "/custom/config.json" }),
		"/custom/config.json",
		"the explicit path wins over both",
	);
	assert.equal(CONFIG_ENV, "PI_HERDR_STATUS_CONFIG");
});

test("S13: a missing or malformed file reads as the defaults, never throwing", () => {
	withTempDir((dir) => {
		assert.deepEqual(loadConfig(join(dir, "absent.json")), DEFAULT_CONFIG, "no file");
		for (const content of ["", "{", "not json", "null", "[]", "7", '"path"']) {
			const path = join(dir, "broken.json");
			writeFileSync(path, content);
			assert.deepEqual(loadConfig(path), DEFAULT_CONFIG, JSON.stringify(content));
		}
		const partial = join(dir, "partial.json");
		writeFileSync(partial, JSON.stringify({ style: "emoji", showJobs: false }));
		assert.deepEqual(loadConfig(partial), { ...DEFAULT_CONFIG, style: "emoji", showJobs: false });
	});
});

test("S13: saving creates the directory and writes normalized JSON with two spaces", () => {
	withTempDir((dir) => {
		const path = join(dir, "nested", "config.json");
		saveConfig(path, { ...DEFAULT_CONFIG, name: "  my\u001b[1m panel  ", style: "emoji" });
		assert.equal(readFileSync(path, "utf8"), `${JSON.stringify({
			...DEFAULT_CONFIG,
			style: "emoji",
			name: "my panel",
		}, null, 2)}\n`, "normalized, two spaces, trailing newline");
		assert.deepEqual(readdirSync(join(dir, "nested")), ["config.json"], "the temporary file is gone");
	});
});

test("S13: saving twice replaces the file atomically and keeps it parseable", () => {
	withTempDir((dir) => {
		const path = join(dir, "config.json");
		saveConfig(path, DEFAULT_CONFIG);
		const next: HerdrStatusConfig = { ...DEFAULT_CONFIG, changes: true, name: "second" };
		saveConfig(path, next);
		assert.deepEqual(loadConfig(path), next, "the last save wins");
		assert.deepEqual(readdirSync(dir), ["config.json"], "no temporary file is left behind");
	});
});

test("S13/S17: an environment variable forces its option, a file alone does not", () => {
	const fromFile: HerdrStatusConfig = { ...DEFAULT_CONFIG, style: "emoji", changes: true };
	const plain = effectiveConfig(fromFile, {});
	assert.deepEqual(plain.config, fromFile, "no variable, the file decides");
	assert.deepEqual([...plain.forced], [], "nothing is forced");

	const style = effectiveConfig(fromFile, { [STYLE_ENV]: "EMOJI" });
	assert.equal(style.config.style, "plain", "only the exact emoji value opts in");
	assert.deepEqual([...style.forced], ["style"]);

	const emoji = effectiveConfig(fromFile, { [STYLE_ENV]: "emoji" });
	assert.equal(emoji.config.style, "emoji");

	// El env fuerza el estilo entero: no hay una variable por token.
	assert.equal(effectiveConfig({ ...DEFAULT_CONFIG, style: "plain" }, { [STYLE_ENV]: "emoji" }).config.style, "emoji");

	const off = effectiveConfig(fromFile, { [CHANGES_ENV]: "0" });
	assert.equal(off.config.changes, false, "a defined variable always wins over the file");
	assert.deepEqual([...off.forced], ["changes"]);

	const on = effectiveConfig({ ...DEFAULT_CONFIG, changes: false }, { [CHANGES_ENV]: "1" });
	assert.equal(on.config.changes, true);
	assert.deepEqual([...on.forced], ["changes"]);

	const both = effectiveConfig(DEFAULT_CONFIG, { [STYLE_ENV]: "", [CHANGES_ENV]: "1" });
	assert.deepEqual([...both.forced], ["style", "changes"], "an empty value still counts as defined");
	assert.equal(both.config.style, "plain");
});

test("S17: one Style row replaces the phase and subagent styles, and no jobsStyle exists", () => {
	assert.deepEqual([...OPTION_IDS], ["style", "changes", "showSubagent", "showJobs", "colors", "name"]);
	for (const gone of ["phaseStyle", "subagentStyle", "jobsStyle"]) {
		assert.ok(!(OPTION_IDS as readonly string[]).includes(gone), `${gone} is not an option any more`);
	}
	const config: HerdrStatusConfig = { ...DEFAULT_CONFIG, style: "emoji", showJobs: false };
	const { forced } = effectiveConfig(config, { [STYLE_ENV]: "emoji", [CHANGES_ENV]: "0" });
	const rows = optionRows(config, forced);
	assert.deepEqual(rows.map((row) => row.id), [...OPTION_IDS], "one row per option, in a stable order");
	assert.deepEqual(rows.map((row) => row.value), ["emoji", "off", "on", "off", "off", "gentle"]);
	assert.equal(rows.filter((row) => row.id === "style").length, 1, "the style is one row");
	assert.equal(rows[0].label, "Style", "the row reads Style");
	assert.equal(rows[0].forcedBy, STYLE_ENV, "a forced option carries its variable");
	assert.equal(rows[1].forcedBy, CHANGES_ENV);
	assert.equal(rows[2].forcedBy, undefined, "an unforced option can be edited");
	assert.ok(rows.every((row) => row.label.length > 0), "every row has a label");
});

test("S13/S17: cycling turns one option to its other value and leaves the rest alone", () => {
	const config = { ...DEFAULT_CONFIG };
	const emoji = cycleOption(config, "style");
	assert.equal(emoji.style, "emoji");
	assert.equal(cycleOption(emoji, "style").style, "plain", "it cycles back");
	assert.equal(cycleOption(config, "changes").changes, true);
	assert.equal(cycleOption(config, "showSubagent").showSubagent, false);
	assert.equal(cycleOption(config, "showJobs").showJobs, false);
	assert.equal(cycleOption(config, "colors").colors, true);
	assert.deepEqual(cycleOption(config, "name"), config, "the name is text, it does not cycle");
	assert.deepEqual(config, DEFAULT_CONFIG, "the original config is never mutated");
});

test("S13: renaming normalizes like the loaded file and never leaves the name empty", () => {
	assert.equal(applyName(DEFAULT_CONFIG, "  side  ").name, "side");
	assert.equal(applyName(DEFAULT_CONFIG, "side\u001b]0;t\u0007bar").name, "sidebar", "an OSC title is dropped");
	assert.equal(applyName(DEFAULT_CONFIG, "x".repeat(40)).name, "x".repeat(32));
	assert.equal(applyName(DEFAULT_CONFIG, "   ").name, "gentle");
	assert.equal(applyName(DEFAULT_CONFIG, "").name, "gentle");
});

test("S15/S17: the one-line description names every option, for the non-TUI report", () => {
	const text = describeConfig({ ...DEFAULT_CONFIG, style: "emoji", changes: true, showJobs: false, name: "side" });
	for (const part of ["style emoji", "off", "on", "side"]) assert.ok(text.includes(part), `${part} in ${text}`);
	assert.ok(text.includes("colors"));
	assert.ok(!text.includes("gentle"), "the chosen name replaces the default");
	assert.ok(!text.includes("brackets"), "the old phase style is not described any more");
});

test("S17: a file with the old style fields migrates; emoji in either one means the emoji style", () => {
	assert.equal(normalizeConfig({ phaseStyle: "emoji" }).style, "emoji");
	assert.equal(normalizeConfig({ subagentStyle: "emoji" }).style, "emoji");
	assert.equal(normalizeConfig({ phaseStyle: "brackets", subagentStyle: "arrow" }).style, "plain");
	assert.equal(normalizeConfig({ phaseStyle: "emoji", subagentStyle: "arrow" }).style, "emoji", "either one is enough");
	assert.equal(normalizeConfig({ phaseStyle: "brackets", subagentStyle: "emoji" }).style, "emoji");
	assert.equal(normalizeConfig({ phaseStyle: "sparkles", subagentStyle: "arrow" }).style, "plain", "an invalid old field is not emoji");
	assert.equal(normalizeConfig({ style: "plain", phaseStyle: "emoji", subagentStyle: "emoji" }).style, "plain", "a valid style wins over the old fields");
	assert.equal(normalizeConfig({ style: "emoji", subagentStyle: "arrow" }).style, "emoji", "and the old fields never turn it off");
	assert.equal(normalizeConfig({ style: "sparkles" }).style, "plain", "an invalid style falls back to plain");
	assert.equal(normalizeConfig({ style: "sparkles", phaseStyle: "emoji" }).style, "emoji", "an invalid style reads as absent, so the migration still applies");
	// Sin archivo ni variables el estilo es plain: los tokens salen como siempre.
	assert.equal(DEFAULT_CONFIG.style, "plain");
});

test("S17: saving writes only style, so the old fields are discarded", () => {
	withTempDir((dir) => {
		const path = join(dir, "config.json");
		writeFileSync(path, JSON.stringify({ phaseStyle: "emoji", subagentStyle: "arrow", changes: true }));
		const loaded = loadConfig(path);
		assert.equal(loaded.style, "emoji", "the legacy file reads as the emoji style");
		saveConfig(path, loaded);
		const stored: Record<string, unknown> = JSON.parse(readFileSync(path, "utf8"));
		assert.deepEqual(Object.keys(stored).sort(), ["changes", "colors", "name", "showJobs", "showSubagent", "style"]);
		assert.deepEqual(stored, { ...DEFAULT_CONFIG, style: "emoji", changes: true }, "only the new shape is written");
	});
});
