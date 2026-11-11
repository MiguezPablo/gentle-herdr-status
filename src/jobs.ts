/**
 * Jobs del orquestador en una fila propia del sidebar: `⏵ label` cuando corre uno, y
 * `⏵ label (+N)` con el más viejo (por `startedAt`) más cuántos otros corren cuando hay dos
 * o más. Con el estilo emoji el prefijo es `🔄 ` en lugar de `⏵ ` (`🔄 build (+1)`); el resto
 * del label no cambia. Sin jobs corriendo no hay token, igual que el subagente. Un empate de
 * `startedAt` lo gana el que viene primero en el snapshot (el orden de inserción se conserva).
 *
 * Fuente (gentle-pi, `lib/jobs-sidebar-state.ts`): el evento `gentle-ai:jobs-sidebar` del
 * bus de Pi trae `{ sessionId, snapshot: { jobs } }`. Cada evento reemplaza el estado
 * completo: los jobs corriendo vienen sin `status`, y los terminados hace poco traen
 * `status` ("exited" | "stopped" | "failed") más `endedAt`/`exitCode`. Sólo se muestran
 * los corriendo, y se ignora cualquier evento de otra sesión o con forma inválida. Ese
 * evento es un interno de gentle-pi y puede cambiar sin aviso.
 */
import type { Style } from "./phase.ts";
import { sanitizeName } from "./tracker.ts";

/** Evento interno de gentle-pi (constante JOBS_SIDEBAR_EVENT) con el snapshot de jobs. */
export const JOBS_SIDEBAR_EVENT = "gentle-ai:jobs-sidebar";
/** Marca la fila como jobs del orquestador; nunca forma parte del label saneado. */
export const JOBS_PREFIX = "⏵ ";
/**
 * Prefijo del estilo emoji: un solo codepoint (U+1F504), sin selector de variación U+FE0F, así
 * que el terminal dibuja un glifo. Reemplaza a `⏵ `; el resto del label es igual.
 */
export const JOBS_EMOJI = "🔄";
/** Label de reemplazo cuando gentle-pi manda un label vacío. */
const FALLBACK_LABEL = "job";

type RunningJob = { label: string; startedAt: number };

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Un job que sigue corriendo; los terminados (con `status`) o malformados no cuentan. */
function runningJob(value: unknown): RunningJob | undefined {
	if (!record(value)) return undefined;
	if (typeof value.label !== "string") return undefined;
	if (typeof value.startedAt !== "number" || !Number.isFinite(value.startedAt)) return undefined;
	if (value.status !== undefined) return undefined;
	return { label: value.label, startedAt: value.startedAt };
}

export class JobsTracker {
	/** Sólo los jobs corriendo, ordenados del más viejo al más nuevo. */
	private running: RunningJob[] = [];

	/**
	 * Aplica el snapshot de un evento: reemplaza el estado completo cuando el evento es
	 * de esta sesión y tiene la forma esperada, y no toca nada en cualquier otro caso.
	 */
	snapshot(payload: unknown, sessionId: string | undefined): void {
		if (sessionId === undefined || !record(payload)) return;
		if (typeof payload.sessionId !== "string" || payload.sessionId !== sessionId) return;
		const snapshot = payload.snapshot;
		if (!record(snapshot) || !Array.isArray(snapshot.jobs)) return;
		const running: RunningJob[] = [];
		for (const entry of snapshot.jobs) {
			const job = runningJob(entry);
			if (job) running.push(job);
		}
		this.running = running.sort((a, b) => a.startedAt - b.startedAt);
	}

	label(style: Style = "plain"): string | null {
		const first = this.running[0];
		if (!first) return null;
		const name = sanitizeName(first.label) || FALLBACK_LABEL;
		const others = this.running.length - 1;
		const prefix = style === "emoji" ? `${JOBS_EMOJI} ` : JOBS_PREFIX;
		return others >= 1 ? `${prefix}${name} (+${others})` : `${prefix}${name}`;
	}

	reset(): void {
		this.running = [];
	}
}
