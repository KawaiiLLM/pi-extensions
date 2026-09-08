import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { entryCost, sumProviderSpend } from "../src/usage-spend.js";

const SINCE = Date.parse("2026-09-01T00:00:00Z");

function reply(provider: string, at: string, total: number): string {
	return JSON.stringify({
		type: "message",
		timestamp: at,
		message: { role: "assistant", provider, usage: { cost: { total } } },
	});
}

test("only this provider's assistant replies inside the window cost anything", () => {
	assert.equal(
		entryCost(
			JSON.parse(reply("openai-codex", "2026-09-02T00:00:00Z", 0.5)),
			"openai-codex",
			SINCE,
		),
		0.5,
	);
	assert.equal(
		entryCost(JSON.parse(reply("anthropic", "2026-09-02T00:00:00Z", 0.5)), "openai-codex", SINCE),
		0,
	);
	assert.equal(
		entryCost(
			JSON.parse(reply("openai-codex", "2026-08-31T23:59:59Z", 0.5)),
			"openai-codex",
			SINCE,
		),
		0,
	);
	assert.equal(
		entryCost(
			{
				type: "message",
				timestamp: "2026-09-02T00:00:00Z",
				message: { role: "user", provider: "openai-codex" },
			},
			"openai-codex",
			SINCE,
		),
		0,
	);
	assert.equal(
		entryCost({ type: "session", timestamp: "2026-09-02T00:00:00Z" }, "openai-codex", SINCE),
		0,
	);
	assert.equal(entryCost("not an entry", "openai-codex", SINCE), 0);
	assert.equal(
		entryCost(
			{
				type: "message",
				timestamp: "2026-09-02T00:00:00Z",
				message: { role: "assistant", provider: "openai-codex", usage: {} },
			},
			"openai-codex",
			SINCE,
		),
		0,
	);
});

test("spend sums across session directories, screening files by mtime and entries by time", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-statusline-spend-"));
	try {
		const recent = join(root, "--workspace-a--");
		const other = join(root, "--workspace-b--");
		mkdirSync(recent);
		mkdirSync(other);
		writeFileSync(
			join(recent, "2026-08-31T20-00-00-000Z_a.jsonl"),
			[
				JSON.stringify({ type: "session", timestamp: "2026-08-31T20:00:00Z" }),
				reply("openai-codex", "2026-08-31T21:00:00Z", 1),
				reply("openai-codex", "2026-09-01T01:00:00Z", 0.25),
				reply("anthropic", "2026-09-01T02:00:00Z", 4),
				"not json",
				"",
			].join("\n"),
		);
		writeFileSync(
			join(other, "2026-09-02T00-00-00-000Z_b.jsonl"),
			reply("openai-codex", "2026-09-02T00:00:00Z", 0.5),
		);
		writeFileSync(join(other, "notes.txt"), reply("openai-codex", "2026-09-02T00:00:00Z", 100));
		const stale = join(other, "2026-08-01T00-00-00-000Z_c.jsonl");
		writeFileSync(stale, reply("openai-codex", "2026-09-02T00:00:00Z", 100));
		const staleAt = new Date("2026-08-01T00:00:00Z");
		utimesSync(stale, staleAt, staleAt);

		assert.equal(await sumProviderSpend(root, "openai-codex", SINCE), 0.75);
		assert.equal(await sumProviderSpend(root, "anthropic", SINCE), 4);
		assert.equal(await sumProviderSpend(join(root, "missing"), "openai-codex", SINCE), 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("an aborted scan stops rather than finishing the sum", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-statusline-spend-"));
	try {
		writeFileSync(join(root, "a.jsonl"), reply("openai-codex", "2026-09-02T00:00:00Z", 1));
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(sumProviderSpend(root, "openai-codex", SINCE, controller.signal));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
