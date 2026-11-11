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

test("S13: the defaults are the current behaviour: brackets, arrow, no changes, tokens on, name gentle", () => {
	assert.deepEqual(DEFAULT_CONFIG, {
		phaseStyle: "brackets",
		subagentStyle: "arrow",
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
		phaseStyle: "sparkles",
		subagentStyle: "emoji",
		changes: "yes",
		name: 42,
		showSubagent: "no",
		showJobs: false,
		colors: "yes",
	}), {
		phaseStyle: "brackets",
		subagentStyle: "emoji",
		changes: false,
		name: "gentle",
		showSubagent: true,
		showJobs: false,
		colors: false,
	});
	assert.deepEqual(normalizeConfig({ phaseStyle: "emoji", subagentStyle: "arrow", changes: true }), {
		...DEFAULT_CONFIG,
		phaseStyle: "emoji",
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
		writeFileSync(partial, JSON.stringify({ subagentStyle: "emoji", showJobs: false }));
		assert.deepEqual(loadConfig(partial), { ...DEFAULT_CONFIG, subagentStyle: "emoji", showJobs: false });
	});
});

test("S13: saving creates the directory and writes normalized JSON with two spaces", () => {
	withTempDir((dir) => {
		const path = join(dir, "nested", "config.json");
		saveConfig(path, { ...DEFAULT_CONFIG, name: "  my\u001b[1m panel  ", phaseStyle: "emoji" });
		assert.equal(readFileSync(path, "utf8"), `${JSON.stringify({
			...DEFAULT_CONFIG,
			phaseStyle: "emoji",
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

test("S13: an environment variable forces its option, a file alone does not", () => {
	const fromFile: HerdrStatusConfig = { ...DEFAULT_CONFIG, phaseStyle: "emoji", changes: true };
	const plain = effectiveConfig(fromFile, {});
	assert.deepEqual(plain.config, fromFile, "no variable, the file decides");
	assert.deepEqual([...plain.forced], [], "nothing is forced");

	const style = effectiveConfig(fromFile, { [STYLE_ENV]: "EMOJI" });
	assert.equal(style.config.phaseStyle, "brackets", "only the exact emoji value opts in");
	assert.deepEqual([...style.forced], ["phaseStyle"]);

	const emoji = effectiveConfig(fromFile, { [STYLE_ENV]: "emoji" });
	assert.equal(emoji.config.phaseStyle, "emoji");

	const off = effectiveConfig(fromFile, { [CHANGES_ENV]: "0" });
	assert.equal(off.config.changes, false, "a defined variable always wins over the file");
	assert.deepEqual([...off.forced], ["changes"]);

	const on = effectiveConfig({ ...DEFAULT_CONFIG, changes: false }, { [CHANGES_ENV]: "1" });
	assert.equal(on.config.changes, true);
	assert.deepEqual([...on.forced], ["changes"]);

	const both = effectiveConfig(DEFAULT_CONFIG, { [STYLE_ENV]: "", [CHANGES_ENV]: "1" });
	assert.deepEqual([...both.forced], ["phaseStyle", "changes"], "an empty value still counts as defined");
	assert.equal(both.config.phaseStyle, "brackets");
});

test("S13: every option is listed once, with its value and the variable that forces it", () => {
	assert.deepEqual([...OPTION_IDS], ["phaseStyle", "subagentStyle", "changes", "showSubagent", "showJobs", "colors", "name"]);
	const config: HerdrStatusConfig = { ...DEFAULT_CONFIG, subagentStyle: "emoji", showJobs: false };
	const { forced } = effectiveConfig(config, { [STYLE_ENV]: "emoji", [CHANGES_ENV]: "0" });
	const rows = optionRows(config, forced);
	assert.deepEqual(rows.map((row) => row.id), [...OPTION_IDS], "one row per option, in a stable order");
	assert.deepEqual(rows.map((row) => row.value), ["brackets", "emoji", "off", "on", "off", "off", "gentle"]);
	assert.equal(rows[0].forcedBy, STYLE_ENV, "a forced option carries its variable");
	assert.equal(rows[2].forcedBy, CHANGES_ENV);
	assert.equal(rows[1].forcedBy, undefined, "an unforced option can be edited");
	assert.ok(rows.every((row) => row.label.length > 0), "every row has a label");
});

test("S13: cycling turns one option to its other value and leaves the rest alone", () => {
	const config = { ...DEFAULT_CONFIG };
	const phase = cycleOption(config, "phaseStyle");
	assert.equal(phase.phaseStyle, "emoji");
	assert.equal(cycleOption(phase, "phaseStyle").phaseStyle, "brackets", "it cycles back");
	assert.equal(cycleOption(config, "subagentStyle").subagentStyle, "emoji");
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

test("S15: the one-line description names every option, for the non-TUI report", () => {
	const text = describeConfig({ ...DEFAULT_CONFIG, subagentStyle: "emoji", changes: true, showJobs: false, name: "side" });
	for (const part of ["brackets", "emoji", "off", "on", "side"]) assert.ok(text.includes(part), `${part} in ${text}`);
	assert.ok(text.includes("colors"));
	assert.ok(!text.includes("gentle"), "the chosen name replaces the default");
});
