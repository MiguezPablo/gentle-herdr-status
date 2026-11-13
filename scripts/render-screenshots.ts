/**
 * Genera los SVG de `docs/screenshots/`, que son las capturas del README: no son
 * screenshots reales sino dibujos reproducibles y versionados. El texto sale de las mismas
 * funciones que publican los tokens (`phaseToken`, `SubagentTracker.label`,
 * `JobsTracker.label`, `changesToken`) y los colores de la fila que escribe la
 * sincronización (`sidebarRows`, con la paleta Catppuccin Mocha de `herdr-config.ts`), así
 * que una captura no puede decir algo distinto del sidebar.
 *
 * `node scripts/render-screenshots.ts` (o `npm run screenshots`) reescribe los archivos.
 * `test/screenshots.test.ts` compara el render puro con lo commiteado y falla si quedaron
 * viejos. El render es determinista: mismas entradas, mismos bytes.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { changesParts, changesToken } from "../src/changes.ts";
import { DEFAULT_CONFIG, type HerdrStatusConfig } from "../src/config.ts";
import {
	CHANGES_ADDED_TOKEN,
	CHANGES_DELETED_TOKEN,
	CHANGES_TOKEN,
	JOBS_TOKEN,
	NAME_TOKEN,
	PHASE_TOKEN,
	TOKEN,
} from "../src/herdr.ts";
import { PALETTE, sidebarRows, type RowCell } from "../src/herdr-config.ts";
import { JOBS_EMOJI, JobsTracker } from "../src/jobs.ts";
import { ODD_PHASES, PHASE_EMOJIS, WORKING_EMOJI, phaseToken, type Style } from "../src/phase.ts";
import { OTHER_SUBAGENT_EMOJI, SUBAGENT_EMOJIS, SubagentTracker } from "../src/tracker.ts";

/** Fila de Herdr que no escribe este paquete (`state_icon`, `machine`, `workspace`, `tab`). */
const STATE_ROW = "● acme · 1";
/** Id de sesión de mentira: el snapshot de jobs sólo se aplica si coincide. */
const SESSION_ID = "screenshot";

/** Colores de Catppuccin Mocha para el cromo del dibujo (base, mantle, surface0). */
const BACKGROUND = "#1e1e2e";
const CARD_FILL = "#181825";
const CARD_STROKE = "#313244";

const FONT_SIZE = 13;
/** Avance de la monoespaciada, redondeado para arriba así un glifo ancho nunca se corta. */
const CHAR_WIDTH = 8;
const LINE_HEIGHT = 20;
const PADDING = 14;
const RADIUS = 8;

/** Un emoji ocupa dos columnas de la monoespaciada, como en una terminal. */
const EMOJI_COLUMNS = 2;
/** Lado del Twemoji inline, apenas más grande que la fuente para que se lea como emoji. */
const EMOJI_SIZE = 15;
/** Cuánto baja el emoji respecto de la línea base del texto. */
const EMOJI_BASELINE = 2;

/** Assets de Twemoji, al lado de este script; la generación nunca toca la red. */
const TWEMOJI_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "twemoji");

/** Todo emoji que el generador puede emitir, sacado de los mapas reales de los módulos. */
const EMOJI: ReadonlySet<string> = new Set([
	...Object.values(PHASE_EMOJIS),
	WORKING_EMOJI,
	...Object.values(SUBAGENT_EMOJIS),
	OTHER_SUBAGENT_EMOJI,
	JOBS_EMOJI,
]);

/** Un trozo de una línea con su color; `column` fija una columna explícita (dos columnas). */
type Segment = { text: string; fill: string; column?: number; spaceBefore?: boolean };
type Scene = {
	style?: Style;
	/** Valor que recibe `phaseToken`; ausente = el agente está idle y no hay fase. */
	phase?: string;
	changes?: { added: number; deleted: number };
	/** Agentes en orden de lanzamiento (el más viejo primero). */
	subagents?: readonly string[];
	/** Labels de jobs corriendo, del más viejo al más nuevo. */
	jobs?: readonly string[];
	colors?: boolean;
};

function escapeXml(text: string): string {
	return text
		.replace(/&/gu, "&amp;")
		.replace(/</gu, "&lt;")
		.replace(/>/gu, "&gt;")
		.replace(/"/gu, "&quot;");
}

function charCount(text: string): number {
	return Array.from(text).length;
}

/** Codepoints en hex minúscula, unidos con `-`: el nombre de archivo de Twemoji. */
function codepointName(emoji: string): string {
	return Array.from(emoji).map((character) => character.codePointAt(0)!.toString(16)).join("-");
}

/** Nombre del asset de Twemoji: codepoints en hex minúscula, unidos con `-`. */
function assetName(emoji: string): string {
	return `${codepointName(emoji)}.svg`;
}

/** Contenido interno de un asset ya leído, para no repetir el disco en cada aparición. */
const twemojiCache = new Map<string, string>();

/**
 * Contenido interno del SVG de Twemoji (sin `<svg>` ni prólogo), listo para anidar. Si el
 * asset no está vendido, falla nombrando el codepoint: generar nunca baja nada de la red.
 */
function twemojiInner(emoji: string): string {
	const cached = twemojiCache.get(emoji);
	if (cached !== undefined) return cached;
	const name = assetName(emoji);
	const file = join(TWEMOJI_DIRECTORY, name);
	let svg: string;
	try {
		svg = readFileSync(file, "utf8");
	} catch {
		const codepoint = codepointName(emoji);
		throw new Error(`missing Twemoji asset for this emoji (U+${codepoint.toUpperCase()}): ${file}; vendor it under scripts/twemoji/`);
	}
	// Sin prólogo y sin el `<svg>` exterior: se anida el contenido, que ya trae su viewBox.
	const inner = /^\s*(?:<\?xml[^>]*\?>\s*)?<svg\b[^>]*>([\s\S]*)<\/svg>\s*$/u.exec(svg);
	if (inner === null) throw new Error(`${file} is not a Twemoji SVG`);
	twemojiCache.set(emoji, inner[1]);
	return inner[1];
}

/** Un emoji como SVG anidado de dos columnas, alineado con la línea base del texto. */
function emojiMarkup(emoji: string, x: number, baseline: number): string {
	const y = baseline + EMOJI_BASELINE - EMOJI_SIZE;
	return `<svg x="${x}" y="${y}" width="${EMOJI_SIZE}" height="${EMOJI_SIZE}" viewBox="0 0 36 36" data-emoji="${codepointName(emoji)}">${twemojiInner(emoji)}</svg>`;
}

/** Los tokens de una escena, armados con las funciones reales del sidebar. */
function sceneTokens(scene: Scene): Record<string, string | null> {
	const style = scene.style ?? "plain";
	const count = scene.changes === undefined
		? null
		: changesToken(scene.changes.added, scene.changes.deleted);
	const parts = changesParts(count);
	const tokens: Record<string, string | null> = {
		[NAME_TOKEN]: DEFAULT_CONFIG.name,
		[PHASE_TOKEN]: scene.phase === undefined ? null : phaseToken(scene.phase, style),
		[CHANGES_TOKEN]: count,
		[CHANGES_ADDED_TOKEN]: parts?.added ?? null,
		[CHANGES_DELETED_TOKEN]: parts?.deleted ?? null,
		[TOKEN]: null,
		[JOBS_TOKEN]: null,
	};
	const subagents = new SubagentTracker();
	(scene.subagents ?? []).forEach((agent, index) => {
		// El nombre real de gentle-pi trae el prefijo que el tracker recorta.
		subagents.toolCall(`call-${index}`, "subagent_run", { agent: `gentle-ai-${agent}` });
	});
	tokens[TOKEN] = subagents.label(style);
	const jobs = new JobsTracker();
	jobs.snapshot(
		{
			sessionId: SESSION_ID,
			snapshot: { jobs: (scene.jobs ?? []).map((label, index) => ({ label, startedAt: index + 1 })) },
		},
		SESSION_ID,
	);
	tokens[JOBS_TOKEN] = jobs.label(style);
	return tokens;
}

/** Celdas de la fila de esta escena, para sacar de ahí el `fg` que escribiría el sync. */
function sceneCells(config: HerdrStatusConfig): Map<string, RowCell> {
	const cells = new Map<string, RowCell>();
	for (const cell of sidebarRows(config).flat()) {
		const name = typeof cell === "string" ? cell : cell.token;
		if (name.startsWith("$")) cells.set(name.slice(1), cell);
	}
	return cells;
}

/**
 * `fg` de un token: sin colores la celda es un string y el texto va neutro; con colores sale
 * de la celda que arma la sincronización (reglas de fase, `fg` de subagente/jobs/changes) y,
 * si no hay regla que coincida, del neutro.
 */
function tokenFill(cells: ReadonlyMap<string, RowCell>, token: string, value: string): string {
	const cell = cells.get(token);
	if (cell === undefined || typeof cell === "string") return PALETTE.neutral;
	const rule = cell.rules?.find((candidate) => value.toLowerCase().includes(candidate.contains.toLowerCase()));
	return rule?.fg ?? cell.fg ?? PALETTE.neutral;
}

/** Filas del sidebar tal como las apila Herdr: estado, nombre/fase/changes, subagente, jobs. */
function entryLines(scene: Scene): Segment[][] {
	const tokens = sceneTokens(scene);
	const config: HerdrStatusConfig = {
		...DEFAULT_CONFIG,
		changes: scene.changes !== undefined,
		colors: scene.colors ?? false,
	};
	const cells = sceneCells(config);
	const fill = (token: string, value: string): string => tokenFill(cells, token, value);

	const lines: Segment[][] = [[{ text: STATE_ROW, fill: PALETTE.neutral }]];
	// La fila del nombre sale de las celdas reales: sin colores es `$changes`, con colores son
	// `$changes_added` y `$changes_deleted`, cada una con su color (S16).
	const nameRow: Segment[] = [];
	for (const nameRowCell of (sidebarRows(config)[1] ?? [])) {
		const name = typeof nameRowCell === "string" ? nameRowCell : nameRowCell.token;
		const token = name.slice(1);
		const value = tokens[token];
		if (value === null || value === undefined) continue;
		// La separación entre celdas es una columna del layout, nunca un espacio en el texto:
		// un renderizador recorta el espacio inicial de un `<text>`.
		nameRow.push({ text: value, fill: fill(token, value), spaceBefore: nameRow.length > 0 });
	}
	lines.push(nameRow);
	for (const token of [TOKEN, JOBS_TOKEN]) {
		const value = tokens[token];
		if (value === null) continue;
		lines.push([{ text: value, fill: fill(token, value) }]);
	}
	return lines;
}

/** Las dos columnas de `phases.svg`: la fase en `plain` y la misma en `emoji`. */
function phaseLines(): Segment[][] {
	const words = [...ODD_PHASES, undefined];
	const plainWidth = Math.max(...words.map((value) => charCount(phaseToken(value))));
	const column = plainWidth + 4;
	const header = [
		{ text: "plain", fill: PALETTE.overlay },
		{ text: "emoji", fill: PALETTE.overlay, column },
	];
	return [
		header,
		...words.map((value) => [
			{ text: phaseToken(value), fill: PALETTE.neutral },
			{ text: phaseToken(value, "emoji"), fill: PALETTE.neutral, column },
		]),
	];
}

/** Junta segmentos contiguos del mismo color para que una fila sin color sea un solo texto. */
function compact(line: readonly Segment[]): Segment[] {
	const merged: Segment[] = [];
	for (const segment of line) {
		const last = merged.at(-1);
		if (last !== undefined && last.column === undefined && segment.column === undefined && last.fill === segment.fill) {
			// Al fusionar, la columna de separación se vuelve espacio interno: nunca inicial ni final.
			last.text += segment.spaceBefore === true ? ` ${segment.text}` : segment.text;
		} else {
			merged.push({ ...segment });
		}
	}
	return merged;
}

/** Posición de cada segmento; `spaceBefore` avanza una columna sin escribir un espacio. */
type RenderedLine = { elements: string[]; end: number };

/**
 * Dibuja una línea en píxeles: el texto va en `<text>` y cada emoji es un SVG anidado que
 * ocupa dos columnas, así el texto que sigue arranca en la columna correcta y ningún emoji
 * queda como glifo de la fuente del visor. Nunca emite `<text>` con espacio al borde.
 */
function renderLine(line: readonly Segment[], y: number): RenderedLine {
	const elements: string[] = [];
	let cursor = PADDING;
	const flush = (text: string, fill: string): void => {
		if (text.length === 0) return;
		const x = cursor;
		cursor += charCount(text) * CHAR_WIDTH;
		const visible = text.replace(/\s+$/u, "");
		if (visible.length > 0) elements.push(`<text x="${x}" y="${y}" fill="${fill}">${escapeXml(visible)}</text>`);
	};
	for (const segment of line) {
		if (segment.column !== undefined) cursor = PADDING + segment.column * CHAR_WIDTH;
		if (segment.spaceBefore === true) cursor += CHAR_WIDTH;
		let pending = "";
		const flushPending = (): void => {
			flush(pending, segment.fill);
			pending = "";
		};
		for (const character of Array.from(segment.text)) {
			if (EMOJI.has(character)) {
				flushPending();
				elements.push(emojiMarkup(character, cursor, y));
				cursor += EMOJI_COLUMNS * CHAR_WIDTH;
			} else if (pending.length === 0 && /\s/u.test(character)) {
				// El espacio inicial es avance del cursor, no texto: así ningún `<text>` arranca en blanco.
				cursor += CHAR_WIDTH;
			} else {
				pending += character;
			}
		}
		flushPending();
	}
	return { elements, end: cursor };
}

/** Un SVG autocontenido: fondo oscuro, tarjeta redondeada y una línea de texto por fila. */
function renderSvg(title: string, rows: readonly Segment[][]): string {
	const lines = rows.map(compact);
	const drawn = lines.map((line, index) => renderLine(line, PADDING + FONT_SIZE + index * LINE_HEIGHT));
	const width = Math.ceil(Math.max(...drawn.map((line) => line.end)) + PADDING);
	const height = PADDING * 2 + lines.length * LINE_HEIGHT;
	const body = drawn.flatMap((line) => line.elements);
	return [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">`,
		`<title>${escapeXml(title)}</title>`,
		`<rect width="${width}" height="${height}" fill="${BACKGROUND}"/>`,
		`<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="${RADIUS}" fill="${CARD_FILL}" stroke="${CARD_STROKE}"/>`,
		`<g font-family="ui-monospace, &quot;JetBrains Mono&quot;, Menlo, Consolas, monospace" font-size="${FONT_SIZE}" xml:space="preserve">`,
		...body,
		"</g>",
		"</svg>",
		"",
	].join("\n");
}

/** Cada captura del README con la escena que dibuja. */
const SCENES: ReadonlyArray<{ file: string; title: string; scene: Scene }> = [
	{
		file: "idle.svg",
		title: "Herdr sidebar while the agent is idle: only the name row",
		scene: {},
	},
	{
		file: "plain.svg",
		title: "Herdr sidebar entry with the plain style",
		scene: { phase: "exploring", subagents: ["explore", "worker"], jobs: ["CI for PR 1834"] },
	},
	{
		file: "emoji.svg",
		title: "The same entry with the emoji style",
		scene: { style: "emoji", phase: "exploring", subagents: ["explore", "worker"], jobs: ["CI for PR 1834"] },
	},
	{
		file: "changes.svg",
		title: "The entry with the $changes counter next to the name",
		scene: {
			phase: "exploring",
			changes: { added: 120, deleted: 40 },
			subagents: ["explore", "worker"],
			jobs: ["CI for PR 1834"],
		},
	},
	{
		file: "colors.svg",
		title: "The entry with colors: true and the Catppuccin Mocha fallback palette",
		scene: {
			phase: "exploring",
			changes: { added: 120, deleted: 40 },
			subagents: ["explore", "worker"],
			jobs: ["CI for PR 1834"],
			colors: true,
		},
	},
	{
		file: "subagents-jobs.svg",
		title: "Two subagents and two jobs running, each row with its (+N) counter",
		scene: { phase: "implementing", subagents: ["verify", "explore"], jobs: ["logs", "CI for PR 1834"] },
	},
];

/**
 * Render puro de todas las capturas: `{ "<archivo>.svg": contenido }`. No toca el
 * filesystem, así que el test puede compararlo con lo commiteado.
 */
export function renderScreenshots(): Record<string, string> {
	const rendered: Record<string, string> = {};
	for (const entry of SCENES) rendered[entry.file] = renderSvg(entry.title, entryLines(entry.scene));
	rendered["phases.svg"] = renderSvg("Every phase, plain on the left and emoji on the right", phaseLines());
	return rendered;
}

/** Sólo escribe cuando se ejecuta como script, nunca cuando lo importa el test. */
const invokedDirectly = process.argv[1] !== undefined
	&& import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
	const directory = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "screenshots");
	mkdirSync(directory, { recursive: true });
	for (const [file, content] of Object.entries(renderScreenshots())) {
		writeFileSync(join(directory, file), content);
	}
}
