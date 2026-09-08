import assert from "node:assert/strict";
import { test } from "vitest";
import { normalizeCodexBackendPayload } from "../src/usage-query/providers/codex.js";
import type { UsageBucket, UsageReport } from "../src/usage-query/types.js";
import {
	CAROUSEL_PERIOD_MS,
	formatEstimatedCost,
	formatTimeRemaining,
	formatUsageWindow,
	minutesUntil,
	rotateFrames,
	selectUsageWindows,
	usageWindowDollars,
	usageWindowStart,
} from "../src/usage-windows.js";

const FIVE_HOURS = 300;
const SEVEN_DAYS = 7 * 24 * 60;
const RESET_5H = 1_789_000_000;
const RESET_7D = 1_788_982_066;

function bucket(id: string, overrides: Partial<UsageBucket> = {}): UsageBucket {
	return { id, label: id, groupId: "codex", unit: "percent", used: 10, limit: 100, ...overrides };
}

function report(buckets: UsageBucket[]): UsageReport {
	return {
		providerId: "openai-codex",
		providerName: "OpenAI Codex",
		capturedAt: 0,
		source: "test",
		semantics: { kind: "consumer-subscription", label: "test" },
		buckets,
		metrics: [],
	};
}

// Which window a bucket is comes from its own length: reports have been seen
// with the 5-hour window first and, later, only a 7-day one in that position.
test("windows are classified by their length, not by report order", () => {
	const fiveHour = bucket("codex:primary", {
		used: 12,
		windowMinutes: FIVE_HOURS,
		resetsAt: RESET_5H,
	});
	const weekly = bucket("codex:secondary", {
		used: 6,
		windowMinutes: SEVEN_DAYS,
		resetsAt: RESET_7D,
	});
	const expected = {
		fiveHour: {
			bucketId: "codex:primary",
			usedPercent: 12,
			windowMinutes: FIVE_HOURS,
			resetsAt: RESET_5H,
		},
		weekly: {
			bucketId: "codex:secondary",
			usedPercent: 6,
			windowMinutes: SEVEN_DAYS,
			resetsAt: RESET_7D,
		},
	};
	assert.deepEqual(selectUsageWindows(report([fiveHour, weekly])), expected);
	assert.deepEqual(selectUsageWindows(report([weekly, fiveHour])), expected);
	assert.deepEqual(selectUsageWindows(report([weekly])), { weekly: expected.weekly });
});

test("a day-long window counts as weekly and the first bucket of a class wins", () => {
	const daily = bucket("plan:day", { windowMinutes: 24 * 60, resetsAt: RESET_7D });
	const later = bucket("plan:week", { windowMinutes: SEVEN_DAYS, resetsAt: RESET_7D });
	assert.equal(selectUsageWindows(report([daily, later])).weekly?.bucketId, "plan:day");
});

test("buckets without a percent, a length, or a reset instant are not windows", () => {
	const windows = selectUsageWindows(
		report([
			bucket("usd", { unit: "usd", windowMinutes: FIVE_HOURS, resetsAt: RESET_5H }),
			bucket("no-used", { used: undefined, windowMinutes: FIVE_HOURS, resetsAt: RESET_5H }),
			bucket("no-length", { resetsAt: RESET_5H }),
			bucket("zero-length", { windowMinutes: 0, resetsAt: RESET_5H }),
			bucket("no-reset", { windowMinutes: FIVE_HOURS }),
		]),
	);
	assert.deepEqual(windows, {});
});

test("Codex account windows never borrow additional model limits", () => {
	const fiveHour = {
		used_percent: 0,
		limit_window_seconds: FIVE_HOURS * 60,
		reset_at: RESET_5H,
	};
	const weekly = {
		used_percent: 13,
		limit_window_seconds: SEVEN_DAYS * 60,
		reset_at: RESET_7D,
	};
	for (const primary of [weekly, fiveHour, null]) {
		const normalized = normalizeCodexBackendPayload(
			{
				plan_type: "pro",
				rate_limit: { primary_window: primary, secondary_window: null },
				additional_rate_limits: [
					{
						limit_name: "GPT-5.3-Codex-Spark",
						metered_feature: "codex_bengalfox",
						rate_limit: { primary_window: fiveHour, secondary_window: weekly },
					},
				],
			},
			0,
		);
		// Order must not allow model-specific limits to replace account limits either.
		for (const buckets of [normalized.buckets, [...normalized.buckets].reverse()]) {
			const windows = selectUsageWindows({ ...normalized, buckets });
			assert.equal(windows.fiveHour?.bucketId, primary === fiveHour ? "codex:primary" : undefined);
			assert.equal(windows.weekly?.bucketId, primary === weekly ? "codex:primary" : undefined);
			if (primary === fiveHour) assert.equal(windows.fiveHour?.usedPercent, 0);
		}
	}
});

test("other subscription providers keep their own bucket groups", () => {
	const normalized = report([
		bucket("other:primary", { groupId: "other", windowMinutes: FIVE_HOURS, resetsAt: RESET_5H }),
	]);
	normalized.providerId = "other-provider";
	assert.equal(selectUsageWindows(normalized).fiveHour?.bucketId, "other:primary");
});

test("the window opens one length before it resets", () => {
	const window = { bucketId: "w", usedPercent: 1, windowMinutes: FIVE_HOURS, resetsAt: 1_000 };
	assert.equal(usageWindowStart(window), 1_000_000 - FIVE_HOURS * 60_000);
});

// The window's worth is the spend scaled by the share it consumed; below one
// percent the ratio is noise, and with nothing spent there is nothing to scale.
test("window value extrapolates spend and stays quiet below one percent", () => {
	assert.equal(usageWindowDollars(51.76, 8), 647);
	assert.equal(usageWindowDollars(0.66, 0.9), undefined);
	assert.equal(usageWindowDollars(0, 8), undefined);
});

test("time remaining reads in the largest two units", () => {
	assert.equal(formatTimeRemaining(7_185), "4d 23h");
	assert.equal(formatTimeRemaining(1_440), "1d");
	assert.equal(formatTimeRemaining(285), "4h 45m");
	assert.equal(formatTimeRemaining(60), "1h");
	assert.equal(formatTimeRemaining(12), "12m");
	assert.equal(formatTimeRemaining(0), "0m");
});

test("minutes until a reset never go negative", () => {
	assert.equal(minutesUntil(1_000, 1_000_000 - 90_000), 2);
	assert.equal(minutesUntil(1_000, 2_000_000), 0);
});

test("estimated cost shows whole dollars and hides anything under one", () => {
	assert.equal(formatEstimatedCost(3_064.4), "$3064");
	assert.equal(formatEstimatedCost(1), "$1");
	assert.equal(formatEstimatedCost(0.5), "<$1");
});

test("the carousel alternates countdown and value on its period at a fixed width", () => {
	const now = 1_000_000_000;
	const window = {
		bucketId: "w",
		usedPercent: 12.4,
		windowMinutes: FIVE_HOURS,
		resetsAt: now / 1000 + 285 * 60,
	};
	const frameStart = Math.floor(now / CAROUSEL_PERIOD_MS) * CAROUSEL_PERIOD_MS;
	const first = formatUsageWindow(window, 647, frameStart);
	const second = formatUsageWindow(window, 647, frameStart + CAROUSEL_PERIOD_MS);
	assert.deepEqual([first.trim(), second.trim()].sort(), ["12% ($647)", "12% (4h 45m)"]);
	assert.equal(first.length, second.length);
	assert.equal(formatUsageWindow(window, undefined, frameStart), "12% (4h 45m)");
	assert.equal(
		formatUsageWindow(window, undefined, frameStart + CAROUSEL_PERIOD_MS),
		"12% (4h 45m)",
	);
});

test("rotating frames pads every reading to the widest one", () => {
	assert.equal(rotateFrames(["ab", "abcd"], 0, 10), " ab ");
	assert.equal(rotateFrames(["ab", "abcd"], 10, 10), "abcd");
	assert.equal(rotateFrames(["ab", "abcd"], 20, 10), " ab ");
});
