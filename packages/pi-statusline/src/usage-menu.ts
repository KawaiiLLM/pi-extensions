import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu, runTask } from "@narumitw/pi-tui-kit";
import type { registerCodexFastMode } from "./codex-fast-runtime.js";
import { FAST_USAGE_WARNING } from "./codex-fast-runtime.js";
import { formatUsageReport } from "./usage-format.js";
import { type UsageRefresher, type UsageSnapshot, usageModelIdentity } from "./usage-refresh.js";

export interface UsageMenuOptions {
	usage: UsageRefresher;
	fast: ReturnType<typeof registerCodexFastMode>;
	signal: AbortSignal;
	isCurrent(): boolean;
}

/** Current-account subset of pi-usage's menu; no independent footer or query cache. */
export async function showUsageMenu(
	ctx: ExtensionCommandContext,
	options: UsageMenuOptions,
): Promise<void> {
	if (!ctx.hasUI) throw new Error("/usage requires TUI or RPC mode.");
	const controller = new AbortController();
	const signal = AbortSignal.any([controller.signal, options.signal]);
	const model = usageModelIdentity(ctx);
	const current = () => !signal.aborted && options.isCurrent() && usageModelIdentity(ctx) === model;
	let state: UsageSnapshot = {};
	const refresh = async (force: boolean): Promise<boolean> => {
		if (!current()) return false;
		const result = await runTask(ctx, {
			label: "Refreshing usage…",
			signal,
			isCurrent: current,
			onError: () => undefined,
			task: ({ signal }) => options.usage.query(ctx, force, signal),
		});
		if (!current()) return false;
		if (result.kind === "completed") {
			state = result.value;
			return true;
		}
		if (
			result.kind === "error" &&
			!(result.error instanceof Error && result.error.name === "AbortError")
		) {
			ctx.ui.notify("Usage query failed. Reopen /usage to retry.", "error");
		}
		return false;
	};
	type Screen = "main" | "help";
	type Action = "refresh" | "fast" | "return" | "help";
	const menu = defineMenu<undefined, Screen, Action, ExtensionCommandContext>({
		start: "main",
		screens: {
			main: () => {
				const fast = options.fast.availability(ctx.model);
				return {
					kind: "actions",
					title: "Subscription usage",
					lines: [
						...(state.report ? formatUsageReport(state.report, "current").split("\n") : []),
						...(state.report
							? [`Updated: ${new Date(state.report.capturedAt).toLocaleString()}`]
							: []),
						...(state.error ? [`Usage query failed: ${state.error}`] : []),
						...(fast.kind === "available"
							? [`Fast: ${fast.enabled ? "On" : "Off"}`, FAST_USAGE_WARNING]
							: fast.kind === "unavailable"
								? [`Fast unavailable: ${fast.reason}`]
								: []),
					],
					items: [
						{ id: "refresh", label: "Refresh usage", action: "refresh" },
						...(fast.kind === "available"
							? [
									{
										id: "fast",
										label: `Turn Fast ${fast.enabled ? "off" : "on"}`,
										action: "fast" as const,
									},
								]
							: []),
						{ id: "help", label: "Help", action: "help" },
						{ id: "close", label: "Close", close: true },
					],
					hint: "close",
				};
			},
			help: () => ({
				kind: "actions",
				title: "Usage help",
				lines: [
					"/fast toggles priority routing for supported official Codex models; it uses more allowance.",
					"/usage shares the footer's current-account report. Refresh bypasses its five-minute cache.",
					"Model-specific limits remain separate from account limits.",
					"Preferences: pi-statusline.json. Use /statusline to configure appearance.",
				],
				items: [{ id: "return", label: "Back", action: "return" }],
				hint: "back",
			}),
		},
		actions: {
			refresh: async () => ((await refresh(true)) ? { kind: "stay" } : { kind: "close" }),
			fast: async () => {
				if (!current()) return { kind: "close" };
				await options.fast.toggle(ctx);
				return { kind: "stay" };
			},
			help: () => ({ kind: "to", screen: "help" }),
			return: async () =>
				(await refresh(false)) ? { kind: "to", screen: "main" } : { kind: "close" },
		},
	});
	try {
		if (await refresh(false))
			await runMenu(ctx, menu, { getState: () => undefined, signal, isCurrent: current });
	} finally {
		controller.abort();
	}
}
