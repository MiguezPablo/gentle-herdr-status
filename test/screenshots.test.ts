import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { renderScreenshots } from "../scripts/render-screenshots.ts";
import { JOBS_EMOJI } from "../src/jobs.ts";
import { PHASE_EMOJIS, WORKING_EMOJI } from "../src/phase.ts";
import { OTHER_SUBAGENT_EMOJI, SUBAGENT_EMOJIS } from "../src/tracker.ts";

const DIRECTORY = join(import.meta.dirname, "..", "docs", "screenshots");
const TWEMOJI_DIRECTORY = join(import.meta.dirname, "..", "scripts", "twemoji");
const PADDING = 14;
const CHAR_WIDTH = 8;
const EMOJI_COLUMNS = 2;
const EMOJI_SIZE = 15;
const EMOJI_BASELINE = 2;

/** Todos los emoji que el generador puede emitir, tal como los declaran los módulos. */
const SOURCE_EMOJIS: readonly string[] = [...new Set([
	...Object.values(PHASE_EMOJIS),
	WORKING_EMOJI,
	...Object.values(SUBAGENT_EMOJIS),
	OTHER_SUBAGENT_EMOJI,
	JOBS_EMOJI,
])];

/** Nombre del asset de Twemoji: codepoints en hex minúscula, unidos con `-`. */
function assetName(emoji: string): string {
	return `${Array.from(emoji).map((character) => character.codePointAt(0)!.toString(16)).join("-")}.svg`;
}

/** Contenido de cada `<text>`/`<tspan>` del SVG. */
function textContents(svg: string): string[] {
	return [...svg.matchAll(/<(?:text|tspan)\b[^>]*>([^<]*)<\/(?:text|tspan)>/gu)].map((match) => match[1]);
}

/** Un run dibujado: texto o emoji, con su `x` y el ancho que ocupa en el layout. */
type Run = { x: number; y: number; text: string; width: number };

/** Runs del SVG en orden, incluidos los emoji vectoriales (que ocupan dos columnas). */
function runs(svg: string): Run[] {
	const pattern = /<text x="(\d+)" y="(\d+)"[^>]*>([^<]*)<\/text>|<svg x="(\d+)" y="(\d+)" width="\d+" height="\d+" viewBox="0 0 36 36" data-emoji="([0-9a-f-]+)">/gu;
	return [...svg.matchAll(pattern)].map((match) => {
		if (match[1] !== undefined) {
			return { x: Number(match[1]), y: Number(match[2]), text: match[3], width: Array.from(match[3]).length * CHAR_WIDTH };
		}
		const emoji = String.fromCodePoint(...match[6].split("-").map((hex) => Number.parseInt(hex, 16)));
		// El emoji se dibuja desde arriba: su línea base es la del texto que lo acompaña.
		const baseline = Number(match[5]) + EMOJI_SIZE - EMOJI_BASELINE;
		return { x: Number(match[4]), y: baseline, text: emoji, width: EMOJI_COLUMNS * CHAR_WIDTH };
	});
}

/** Las filas reconstruidas de un SVG, con la separación que marcan las posiciones. */
function rows(svg: string): string[] {
	const lines = new Map<number, Run[]>();
	for (const run of runs(svg)) {
		const line = lines.get(run.y) ?? [];
		line.push(run);
		lines.set(run.y, line);
	}
	return [...lines.entries()]
		.sort(([a], [b]) => a - b)
		.map(([, line]) => {
			let text = "";
			let end = line[0].x;
			for (const run of line) {
				if (run.x > end) text += " ".repeat(Math.round((run.x - end) / CHAR_WIDTH));
				text += run.text;
				end = run.x + run.width;
			}
			return text;
		});
}

/** Las imágenes que el README usa; el generador no puede inventar otras. */
const EXPECTED = [
	"changes.svg",
	"colors.svg",
	"emoji.svg",
	"idle.svg",
	"phases.svg",
	"plain.svg",
	"subagents-jobs.svg",
];

test("rendering produces exactly the committed SVGs", () => {
	const rendered = renderScreenshots();
	assert.deepEqual(Object.keys(rendered).sort(), EXPECTED, "the file set is the one the README references");
	for (const file of EXPECTED) {
		const committed = readFileSync(join(DIRECTORY, file), "utf8");
		assert.equal(committed, rendered[file], `${file} is stale: run npm run screenshots`);
	}
});

test("the SVGs are deterministic, self-contained and valid XML", () => {
	const first = renderScreenshots();
	assert.deepEqual(renderScreenshots(), first, "two renders are byte-identical");

	for (const [file, svg] of Object.entries(first)) {
		assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="\d+" height="\d+" /u, file);
		assert.match(svg, /<\/svg>\n$/u, file);
		// Sin recursos externos: fuentes, imágenes, scripts y referencias `url(...)`.
		assert.doesNotMatch(svg, /<(?:image|script|foreignObject|style|link)\b/iu, file);
		assert.doesNotMatch(svg, /\b(?:href|src)\s*=/iu, file);
		assert.doesNotMatch(svg, /url\s*\(/iu, file);
		// Un XML válido no lleva caracteres de control crudos ni un `&` sin escapar.
		assert.doesNotMatch(svg, /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u, file);
		assert.doesNotMatch(svg, /&(?!(?:amp|lt|gt|quot|apos);)/u, file);
		assert.doesNotMatch(svg, /<\?xml/u, `${file}: no XML prolog`);
	}
});

test("every emoji the source can emit has a vendored Twemoji asset", () => {
	const expected = SOURCE_EMOJIS.map(assetName).sort();
	assert.deepEqual(
		readdirSync(TWEMOJI_DIRECTORY).filter((file) => file.endsWith(".svg")).sort(),
		expected,
		"the vendored set is exactly the emoji the source can emit",
	);
	for (const emoji of SOURCE_EMOJIS) {
		const file = join(TWEMOJI_DIRECTORY, assetName(emoji));
		assert.ok(existsSync(file), `missing vendored asset for ${emoji}: ${file}`);
		const content = readFileSync(file, "utf8");
		assert.match(content, /^<svg\b/u, `${file} is an SVG without a prolog`);
		assert.match(content, /viewBox="0 0 36 36"/u, `${file} keeps Twemoji's 36x36 grid`);
	}
});

test("no text element contains an emoji: every emoji is an inline vector", () => {
	const rendered = renderScreenshots();
	for (const [file, svg] of Object.entries(rendered)) {
		for (const content of textContents(svg)) {
			assert.doesNotMatch(content, /\p{Extended_Pictographic}/u, `${file}: emoji in text ${JSON.stringify(content)}`);
			for (const emoji of SOURCE_EMOJIS) {
				assert.ok(!content.includes(emoji), `${file}: ${emoji} is still a text glyph`);
			}
		}
	}
	for (const file of ["emoji.svg", "phases.svg"]) {
		assert.match(rendered[file], /<svg x="\d+" y="\d+" width="15" height="15" viewBox="0 0 36 36" data-emoji="[0-9a-f-]+">/u, `${file} inlines Twemoji vectors`);
	}
});

test("every run fits inside the card, so nothing clips", () => {
	for (const [file, svg] of Object.entries(renderScreenshots())) {
		const width = Number(/<svg [^>]*width="(\d+)"/u.exec(svg)![1]);
		for (const run of runs(svg)) {
			assert.ok(run.x >= PADDING, `${file}: ${run.text} starts before the padding`);
			assert.ok(run.x + run.width <= width, `${file}: ${run.text} overflows the ${width}px card`);
		}
	}
});

test("no text starts or ends with whitespace, so the pixels match the plain rows", () => {
	const rendered = renderScreenshots();
	for (const [file, svg] of Object.entries(rendered)) {
		const contents = textContents(svg);
		assert.ok(contents.length > 0, `${file} has text`);
		for (const content of contents) {
			// Un espacio al borde del contenido lo recorta el renderizador: la separación va en el `x`.
			assert.doesNotMatch(content, /^\s/u, `${file}: leading whitespace in ${JSON.stringify(content)}`);
			assert.doesNotMatch(content, /\s$/u, `${file}: trailing whitespace in ${JSON.stringify(content)}`);
			assert.doesNotMatch(content, /\s{2,}/u, `${file}: repeated whitespace in ${JSON.stringify(content)}`);
		}
	}
});

test("S16: the colored counter paints +N with the success hex and -N with the error hex", () => {
	const svg = renderScreenshots()["colors.svg"];
	assert.match(svg, /<text x="[\d.]+" y="\d+" fill="#a6e3a1">\+120<\/text>/u, "the added count is green, like Gentle Shell");
	assert.match(svg, /<text x="[\d.]+" y="\d+" fill="#f38ba8">-40<\/text>/u, "the deleted count is red");
});

test("each SVG keeps the sidebar row layout: state row, name/phase/changes, subagent, jobs", () => {
	const rendered = renderScreenshots();

	assert.deepEqual(rows(rendered["plain.svg"]), [
		"● acme · 1",
		"gentle [exploring]",
		"↳ explore (+1)",
		"⏵ CI for PR 1834",
	], "unset tokens hide their row");

	assert.deepEqual(rows(rendered["idle.svg"]), ["● acme · 1", "gentle"], "idle keeps only the name row");

	assert.deepEqual(rows(rendered["subagents-jobs.svg"]), [
		"● acme · 1",
		"gentle [implementing]",
		"↳ verify (+1)",
		"⏵ logs (+1)",
	]);

	assert.equal(rows(rendered["changes.svg"])[1], "gentle [exploring] +120 -40");
	assert.equal(
		rows(rendered["colors.svg"])[1],
		"gentle [exploring] +120 -40",
		"with colors on the two cells read exactly as the single one",
	);

	assert.deepEqual(rows(rendered["emoji.svg"]), [
		"● acme · 1",
		"gentle 🔍 exploring",
		"🧭 explore (+1)",
		"🔄 CI for PR 1834",
	]);
});
