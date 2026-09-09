import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Sum of what one provider's replies cost, at the prices Pi's model registry
 * carries, across every session on disk since `sinceMs`. Session files are
 * append-only and named by start time, but a session opened before the window
 * can still hold replies inside it, so files are screened by mtime and entries
 * by their own timestamp.
 *
 * Forking a session copies its history into the new file, entry ids and all, so
 * a reply is charged the first time it is seen and skipped everywhere after.
 */
export async function sumProviderSpend(
	sessionsDir: string,
	providerId: string,
	sinceMs: number,
	signal?: AbortSignal,
): Promise<number> {
	let total = 0;
	const charged = new Set<string>();
	for (const file of await listSessionFiles(sessionsDir)) {
		signal?.throwIfAborted();
		let modifiedAt: number;
		try {
			modifiedAt = (await stat(file)).mtimeMs;
		} catch {
			continue;
		}
		if (modifiedAt < sinceMs) continue;
		let text: string;
		try {
			text = await readFile(file, "utf8");
		} catch {
			continue;
		}
		for (const line of text.split("\n")) {
			if (!line.includes('"assistant"')) continue;
			const entry = parseLine(line);
			const cost = entryCost(entry, providerId, sinceMs);
			if (cost === 0) continue;
			const id = isRecord(entry) && typeof entry.id === "string" ? entry.id : undefined;
			if (id !== undefined) {
				if (charged.has(id)) continue;
				charged.add(id);
			}
			total += cost;
		}
	}
	return total;
}

function parseLine(line: string): unknown {
	try {
		return JSON.parse(line);
	} catch {
		return undefined;
	}
}

export function entryCost(entry: unknown, providerId: string, sinceMs: number): number {
	if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) return 0;
	const message = entry.message;
	if (message.role !== "assistant" || message.provider !== providerId) return 0;
	const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
	if (!Number.isFinite(at) || at < sinceMs) return 0;
	const usage = isRecord(message.usage) ? message.usage : undefined;
	const cost = isRecord(usage?.cost) ? usage.cost.total : undefined;
	return typeof cost === "number" && Number.isFinite(cost) ? cost : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Pi keeps `sessions/<cwd-slug>/<started-at>_<id>.jsonl`; one directory level is enough. */
async function listSessionFiles(sessionsDir: string): Promise<string[]> {
	const files: string[] = [];
	let entries: Dirent[];
	try {
		entries = await readdir(sessionsDir, { withFileTypes: true });
	} catch {
		return files;
	}
	for (const entry of entries) {
		if (entry.isFile() && entry.name.endsWith(".jsonl")) {
			files.push(join(sessionsDir, entry.name));
			continue;
		}
		if (!entry.isDirectory()) continue;
		const directory = join(sessionsDir, entry.name);
		let names: string[];
		try {
			names = await readdir(directory);
		} catch {
			continue;
		}
		for (const name of names) {
			if (name.endsWith(".jsonl")) files.push(join(directory, name));
		}
	}
	return files;
}
