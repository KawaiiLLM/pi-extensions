// Adapted from pi-usage at 530b081e: settings and status publication belong to pi-statusline.
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	codexFastAvailability,
	correctCodexFastMessageCost,
	rewriteCodexFastPayload,
} from "./codex-fast.js";
import type { LoadedStatuslineSettings } from "./settings.js";
import type { PiModel } from "./usage-query/types.js";

export const FAST_USAGE_WARNING = "Fast uses more of your plan allowance.";

export interface FastModeOptions {
	getLoaded(): LoadedStatuslineSettings;
	save(ctx: ExtensionCommandContext, enabled: boolean): void;
	owns(ctx: ExtensionContext): boolean;
}

export function registerCodexFastMode(pi: ExtensionAPI, options: FastModeOptions) {
	const pending = new Map<string, { model: PiModel; fastRequested: boolean }>();
	const availability = (model: PiModel | undefined) =>
		codexFastAvailability(model, options.getLoaded().config.codexFastMode);
	const toggle = async (ctx: ExtensionCommandContext): Promise<boolean> => {
		if (!options.owns(ctx)) return false;
		const state = availability(ctx.model);
		if (state.kind !== "available") {
			ctx.ui.notify(
				state.kind === "unavailable" ? state.reason : "Fast requires an active OpenAI Codex model.",
				"warning",
			);
			return false;
		}
		try {
			options.save(ctx, !state.enabled);
		} catch (error) {
			ctx.ui.notify(
				`Could not save Fast mode: ${error instanceof Error ? error.message : "settings error"}`,
				"error",
			);
			return false;
		}
		ctx.ui.notify(
			state.enabled ? "Codex Fast disabled." : `Codex Fast enabled. ${FAST_USAGE_WARNING}`,
			"info",
		);
		return true;
	};

	pi.registerCommand("fast", {
		description: "Toggle Codex Fast mode",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) throw new Error("/fast requires TUI or RPC mode.");
			if (args.trim()) {
				ctx.ui.notify("/fast does not accept arguments.", "warning");
				return;
			}
			await toggle(ctx);
		},
	});
	pi.on("before_provider_request", (event, ctx) => {
		if (!options.owns(ctx)) return;
		const rewritten = rewriteCodexFastPayload(
			event.payload,
			ctx.model,
			options.getLoaded().config.codexFastMode,
		);
		if (ctx.model) {
			pending.set(requestKey(ctx, ctx.model.provider, ctx.model.id), {
				model: ctx.model,
				fastRequested: isRecord(rewritten) && rewritten.service_tier === "priority",
			});
		}
		return rewritten;
	});
	pi.on("message_end", (event, ctx) => {
		if (!options.owns(ctx)) return;
		const message = event.message;
		if (
			!isRecord(message) ||
			message.role !== "assistant" ||
			typeof message.provider !== "string" ||
			typeof message.model !== "string"
		)
			return;
		const key = requestKey(ctx, message.provider, message.model);
		const request = pending.get(key);
		pending.delete(key);
		if (!request) return;
		const corrected = correctCodexFastMessageCost(message, request.model, request.fastRequested);
		return corrected ? { message: corrected as never } : undefined;
	});
	pi.on("session_start", () => pending.clear());
	pi.on("session_tree", () => pending.clear());
	pi.on("session_shutdown", () => pending.clear());
	return { availability, toggle };
}

function requestKey(ctx: ExtensionContext, provider: string, model: string): string {
	return `${ctx.sessionManager.getSessionId()}:${provider}/${model}`;
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
