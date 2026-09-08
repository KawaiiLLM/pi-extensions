import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { correctCodexFastMessageCost } from "../src/codex-fast.js";
import { registerCodexFastMode } from "../src/codex-fast-runtime.js";
import {
	loadStatuslineSettings,
	saveCodexFastMode,
	saveStatuslineSettingsDocument,
} from "../src/settings.js";
import { showUsageMenu } from "../src/usage-menu.js";
import { createUsageRefresher } from "../src/usage-refresh.js";

initTheme("dark", false);
const model = {
	id: "gpt-5.6-sol",
	name: "GPT",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 128_000,
};
const payload = () => ({
	rate_limit: {
		primary_window: {
			used_percent: 13,
			limit_window_seconds: 604800,
			reset_at: Math.floor(Date.now() / 1000) + 3600,
		},
	},
	additional_rate_limits: [
		{
			metered_feature: "spark",
			limit_name: "Spark",
			rate_limit: {
				primary_window: {
					used_percent: 0,
					limit_window_seconds: 18000,
					reset_at: Math.floor(Date.now() / 1000) + 18000,
				},
			},
		},
	],
});

function fixture(t: { onTestFinished(fn: () => void): void }) {
	const root = mkdtempSync(join(tmpdir(), "pi-statusline-management-"));
	t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "pi-statusline.json");
	const mock = createMockPi();
	let loaded = loadStatuslineSettings(path);
	const fast = registerCodexFastMode(mock.pi, {
		getLoaded: () => loaded,
		owns: () => true,
		save(_ctx, enabled) {
			loaded = saveCodexFastMode(path, enabled);
		},
	});
	return { root, path, mock, fast, getLoaded: () => loaded };
}
async function emit(
	mock: ReturnType<typeof createMockPi>,
	name: string,
	event: unknown,
	ctx: unknown,
) {
	let result: unknown;
	for (const handler of mock.events.get(name) ?? []) result = await handler(event, ctx);
	return result;
}

test("Fast persists without replacing appearance or unknown settings; invalid files stay untouched", async (t) => {
	const f = fixture(t);
	writeFileSync(f.path, JSON.stringify({ palettePreset: "sunset", unknown: { keep: true } }));
	const { ctx } = createMockContext({ model, mode: "rpc", hasUI: true });
	await f.mock.commands.get("fast")?.handler("", ctx);
	assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), {
		palettePreset: "sunset",
		unknown: { keep: true },
		codexFastMode: true,
	});
	const appearance = JSON.parse(readFileSync(f.path, "utf8"));
	appearance.palettePreset = "ocean";
	saveStatuslineSettingsDocument(f.path, JSON.stringify(appearance));
	await f.mock.commands.get("fast")?.handler("", ctx);
	assert.equal(JSON.parse(readFileSync(f.path, "utf8")).palettePreset, "ocean");
	assert.equal(f.getLoaded().config.codexFastMode, false);
	writeFileSync(f.path, "{broken");
	await f.mock.commands.get("fast")?.handler("", ctx);
	assert.equal(readFileSync(f.path, "utf8"), "{broken");
	assert.equal(f.getLoaded().config.codexFastMode, false);
});

test("a first Fast save retains legacy appearance without rewriting the legacy file", (t) => {
	const f = fixture(t);
	const legacy = join(f.root, "pi-statusline-settings.json");
	const original = JSON.stringify({ palettePreset: "sunset", unknown: "keep" });
	writeFileSync(legacy, original);
	const saved = saveCodexFastMode(f.path, true);
	assert.equal(saved.config.palettePreset, "sunset");
	assert.equal(saved.config.codexFastMode, true);
	assert.equal(JSON.parse(readFileSync(f.path, "utf8")).unknown, "keep");
	assert.equal(readFileSync(legacy, "utf8"), original);
});

test("Fast snapshots the request state, corrects costs once, and clears pending work on shutdown", async (t) => {
	const f = fixture(t);
	const { ctx } = createMockContext({ model, mode: "rpc", hasUI: true });
	const command = f.mock.commands.get("fast");
	assert.ok(command);
	await command.handler("", ctx);
	const body = await emit(f.mock, "before_provider_request", { payload: { input: [] } }, ctx);
	assert.deepEqual(body, { input: [], service_tier: "priority" });
	await command?.handler("", ctx);
	const message = {
		role: "assistant",
		provider: model.provider,
		model: model.id,
		usage: {
			input: 100,
			output: 20,
			cacheRead: 10,
			cacheWrite: 0,
			totalTokens: 130,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	assert.deepEqual(await emit(f.mock, "message_end", { message }, ctx), {
		message: correctCodexFastMessageCost(message, model as never, true),
	});
	assert.equal(await emit(f.mock, "message_end", { message }, ctx), undefined);
	assert.deepEqual(await emit(f.mock, "before_provider_request", { payload: {} }, ctx), {
		service_tier: "default",
	});
	await command?.handler("", ctx);
	await emit(f.mock, "before_provider_request", { payload: {} }, ctx);
	const alreadyPriced = correctCodexFastMessageCost(message, model as never, true);
	assert.equal(await emit(f.mock, "message_end", { message: alreadyPriced }, ctx), undefined);
	await emit(f.mock, "before_provider_request", { payload: {} }, ctx);
	await emit(f.mock, "session_shutdown", {}, ctx);
	assert.equal(await emit(f.mock, "message_end", { message }, ctx), undefined);
	const headless = createMockContext({ model, mode: "print", hasUI: false }).ctx;
	await assert.rejects(() => command.handler("", headless) as Promise<unknown>, /TUI or RPC/);
});

test("a settings editor opened before a Fast change cannot overwrite that change", async (t) => {
	const f = fixture(t);
	const { handleStatuslineCommand } = await import("../src/commands.js");
	writeFileSync(f.path, JSON.stringify({ palettePreset: "sunset", codexFastMode: false }));
	let applied = false;
	const { ctx, notifications } = createMockContext({
		mode: "tui",
		hasUI: true,
		editor: async () => {
			saveCodexFastMode(f.path, true);
			return JSON.stringify({ palettePreset: "ocean", codexFastMode: false });
		},
	});
	await handleStatuslineCommand("settings", ctx, {
		settingsPath: f.path,
		getLoaded: () => loadStatuslineSettings(f.path),
		apply: () => {
			applied = true;
		},
	});
	assert.equal(applied, false);
	assert.equal(loadStatuslineSettings(f.path).config.codexFastMode, true);
	assert.ok(notifications.some((notice) => /changed while the editor/.test(notice.message)));
});

test("RPC usage menu shares reports and forced refresh, offers Fast, and has no redemption action", async (t) => {
	const f = fixture(t);
	const original = globalThis.fetch;
	t.onTestFinished(() => {
		globalThis.fetch = original;
	});
	let fetches = 0;
	globalThis.fetch = async (_url, init) => {
		assert.notEqual(init?.method, "POST");
		fetches++;
		return new Response(JSON.stringify(payload()));
	};
	const optionsSeen: string[][] = [];
	const titles: string[] = [];
	const choices = ["Refresh usage", "Turn Fast on", "Close"];
	const { ctx } = createMockContext({
		model,
		mode: "rpc",
		hasUI: true,
		select: async (title: string, options: string[]) => {
			titles.push(title);
			optionsSeen.push(options);
			return choices.shift();
		},
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "token" }),
			getProviderAuth: async () => ({ auth: { apiKey: "token" } }),
			getAvailable: () => [model],
			getAll: () => [model],
			getProviderAuthStatus: () => ({ configured: true }),
		},
	});
	const usage = createUsageRefresher(f.mock.pi, {
		sessionsDir: f.root,
		onUpdate: () => undefined,
		credentialReader: () => ({
			type: "oauth",
			access: "token",
			refresh: "refresh",
			accountId: "account",
			expires: Date.now() + 60_000,
		}),
	});
	t.onTestFinished(() => usage.stop());
	const first = await usage.query(ctx);
	assert.equal(first.usage?.fiveHour, undefined);
	assert.equal(first.report?.buckets.length, 2);
	await showUsageMenu(ctx, {
		usage,
		fast: f.fast,
		signal: new AbortController().signal,
		isCurrent: () => true,
	});
	assert.equal(fetches, 2);
	assert.equal(f.getLoaded().config.codexFastMode, true);
	assert.ok(optionsSeen[0]?.includes("Turn Fast on"));
	assert.ok(optionsSeen.at(-1)?.includes("Turn Fast off"));
	assert.ok(optionsSeen.flat().every((label) => !/redeem|reset/i.test(label)));
	assert.ok(titles.some((title) => /Spark/.test(title)));
});
