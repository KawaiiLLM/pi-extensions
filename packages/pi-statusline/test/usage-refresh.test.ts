import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { createUsageRefresher, type UsageRuntime } from "../src/usage-refresh.js";

const codexModel = {
	id: "gpt-5.6-sol",
	name: "GPT-5.6 Sol",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
};

const credentialReader = () => ({
	type: "oauth",
	access: "codex-token",
	refresh: "refresh-token",
	expires: Date.now() + 60_000,
	accountId: "account-123",
});

function codexContext(token = "codex-token") {
	return createMockContext({
		model: codexModel,
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: token }),
			getProviderAuth: async () => ({ auth: { apiKey: token } }),
			getAvailable: () => [codexModel],
			getAll: () => [codexModel],
			getProviderAuthStatus: () => ({ configured: true }),
			getProviderDisplayName: (provider: string) => provider,
		},
	}).ctx;
}

function payload(nowSeconds: number) {
	return {
		rate_limit: {
			primary_window: {
				used_percent: 12,
				limit_window_seconds: 5 * 3600,
				reset_at: nowSeconds + 285 * 60,
			},
			secondary_window: {
				used_percent: 8,
				limit_window_seconds: 7 * 24 * 3600,
				reset_at: nowSeconds + 7_185 * 60,
			},
		},
	};
}

test("failed queries retain only a freshly matched account and late responses cannot restore old usage", async (t) => {
	const originalFetch = globalThis.fetch;
	t.onTestFinished(() => {
		globalThis.fetch = originalFetch;
	});
	const root = mkdtempSync(join(tmpdir(), "pi-statusline-identity-"));
	t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
	let token = "account-a-token";
	let fail = false;
	let duringFetch: (() => void) | undefined;
	globalThis.fetch = async () => {
		duringFetch?.();
		if (fail) throw new Error("network unavailable");
		return new Response(JSON.stringify(payload(Math.floor(Date.now() / 1000))));
	};
	const ctx = createMockContext({
		model: codexModel,
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: token }),
			getProviderAuth: async () => ({ auth: { apiKey: token } }),
			getAvailable: () => [codexModel],
			getAll: () => [codexModel],
			getProviderAuthStatus: () => ({ configured: true }),
		},
	}).ctx;
	const updates: Array<UsageRuntime | undefined> = [];
	const service = createUsageRefresher(createMockPi().pi, {
		sessionsDir: root,
		onUpdate: (value) => updates.push(value),
		credentialReader: () => ({ ...credentialReader(), access: token }),
	});
	t.onTestFinished(() => service.stop());
	assert.ok((await service.query(ctx)).report);
	fail = true;
	const failed = await service.query(ctx, true);
	assert.ok(failed.report);
	assert.match(failed.error ?? "", /network unavailable/);
	duringFetch = () => {
		token = "account-b-token";
	};
	const switched = await service.query(ctx, true);
	assert.equal(switched.report, undefined);
	assert.equal(updates.at(-1), undefined);
	fail = false;
	duringFetch = undefined;
	assert.ok((await service.query(ctx, true)).report);
	let release!: (response: Response) => void;
	let started!: () => void;
	const ready = new Promise<void>((resolve) => {
		started = resolve;
	});
	globalThis.fetch = () =>
		new Promise<Response>((resolve) => {
			release = resolve;
			started();
		});
	const late = service.query(ctx, true);
	await ready;
	service.stop();
	release(new Response(JSON.stringify(payload(Math.floor(Date.now() / 1000)))));
	await assert.rejects(late, { name: "AbortError" });
	assert.equal(updates.at(-1), undefined);
});

function sessionsWithReply(root: string, at: Date, total: number) {
	const directory = join(root, "--workspace--");
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, "2026-09-05T00-00-00-000Z_a.jsonl"),
		JSON.stringify({
			type: "message",
			timestamp: at.toISOString(),
			message: { role: "assistant", provider: "openai-codex", usage: { cost: { total } } },
		}),
	);
}

function nextUpdate(updates: Array<UsageRuntime | undefined>, from: number) {
	return new Promise<UsageRuntime | undefined>((resolve, reject) => {
		const deadline = Date.now() + 2_000;
		const poll = () => {
			if (updates.length > from) return resolve(updates[updates.length - 1]);
			if (Date.now() > deadline) return reject(new Error("no usage update arrived"));
			setTimeout(poll, 5);
		};
		poll();
	});
}

test("the refresher prices both windows from session spend and serves the cache afterwards", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-statusline-refresh-"));
	const originalFetch = globalThis.fetch;
	t.onTestFinished(() => {
		globalThis.fetch = originalFetch;
		rmSync(root, { recursive: true, force: true });
	});
	vi.useFakeTimers({ toFake: ["Date"] });
	t.onTestFinished(() => {
		vi.useRealTimers();
	});
	const now = Date.now();
	let fetches = 0;
	globalThis.fetch = async (input) => {
		fetches += 1;
		assert.equal(String(input), "https://chatgpt.com/backend-api/wham/usage");
		return new Response(JSON.stringify(payload(Math.floor(now / 1000))), { status: 200 });
	};
	sessionsWithReply(root, new Date(now - 600_000), 51.76);

	const updates: Array<UsageRuntime | undefined> = [];
	const refresher = createUsageRefresher(createMockPi().pi, {
		sessionsDir: root,
		credentialReader,
		onUpdate: (usage) => updates.push(usage),
	});
	t.onTestFinished(() => refresher.stop());

	const ctx = codexContext();
	const { usage } = await refresher.query(ctx);
	assert.equal(fetches, 1);
	assert.equal(usage?.providerId, "openai-codex");
	assert.equal(usage?.fiveHour?.usedPercent, 12);
	assert.equal(usage?.fiveHour?.windowMinutes, 300);
	assert.equal(usage?.weekly?.usedPercent, 8);
	assert.equal(usage?.weekly?.windowMinutes, 7 * 24 * 60);
	// The 5h window opened 15 minutes ago (it resets in 4h 45m), so a $51.76 reply from ten
	// minutes ago sits inside both windows: 12% of the 5h one, 8% of the week.
	assert.equal(Math.round(usage?.fiveHour?.windowDollars ?? 0), 431);
	assert.equal(Math.round(usage?.weekly?.windowDollars ?? 0), 647);

	vi.setSystemTime(now + 4 * 60_000);
	const cached = await refresher.query(ctx);
	assert.equal(cached.usage?.fiveHour?.usedPercent, 12);
	assert.equal(fetches, 1);
	vi.setSystemTime(now + 6 * 60_000);
	await refresher.query(ctx);
	assert.equal(fetches, 2, "cache hits do not extend the five-minute lifetime");
	await refresher.query(ctx, true);
	assert.equal(fetches, 3);
});

test("providers without a subscription clear the windows and a failed query keeps them", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-statusline-refresh-"));
	const originalFetch = globalThis.fetch;
	t.onTestFinished(() => {
		globalThis.fetch = originalFetch;
		rmSync(root, { recursive: true, force: true });
	});
	let fail = false;
	globalThis.fetch = async () => {
		if (fail) throw new Error("network down");
		return new Response(JSON.stringify(payload(Math.floor(Date.now() / 1000))), { status: 200 });
	};

	const updates: Array<UsageRuntime | undefined> = [];
	const refresher = createUsageRefresher(createMockPi().pi, {
		sessionsDir: root,
		credentialReader,
		onUpdate: (usage) => updates.push(usage),
	});
	t.onTestFinished(() => refresher.stop());

	refresher.refresh(codexContext());
	assert.ok(await nextUpdate(updates, 0));

	refresher.refresh(
		createMockContext({ model: { id: "claude-sonnet-4", provider: "anthropic" } }).ctx,
	);
	assert.equal(await nextUpdate(updates, 1), undefined);

	// A rotated credential misses the cache, so this refresh really asks the endpoint and fails.
	fail = true;
	refresher.refresh(codexContext("rotated-token"));
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(updates.length, 2);
});
