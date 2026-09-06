import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { completeSyncArguments, splitArgs } from "./commands/command.js";
import { handleCommand, resolveSelectionAttention } from "./commands/command-handler.js";
import { withStateDirectoryAccess } from "./state/state-directory.js";
import { autoPushSessions, startSession } from "./sync/automatic-sync.js";
import { combineSignals } from "./sync/signals.js";
import { errorMessage } from "./sync/sync-errors.js";
import { createSyncLoaders, type SyncDependencies } from "./sync/sync-loaders.js";
import { formatRemoteSelectionMismatch, type RemoteSelectionDecision } from "./sync/sync-policy.js";
import { createSyncAttentionController } from "./ui/sync-attention.js";

const STATUS_KEY = "sync";

export default function sync(pi: ExtensionAPI, dependencies: Partial<SyncDependencies> = {}) {
	const loaders = createSyncLoaders(dependencies);
	const attention = createSyncAttentionController();
	let sessionAbort = new AbortController();
	let shutdownAbort: AbortController | undefined;

	pi.registerCommand("sync", {
		description: "Sync Pi settings through Git, WebDAV, R2, or S3-compatible storage",
		getArgumentCompletions: completeSyncArguments,
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				throw new Error(
					"/sync requires TUI or RPC mode so results and safety prompts are observable.",
				);
			}
			const run = () => handleCommand(args, ctx, sessionAbort.signal, loaders, attention);
			if (splitArgs(args)[0] === "migrate-state") await run();
			else await withStateDirectoryAccess(run);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		shutdownAbort?.abort(new DOMException("Session replaced", "AbortError"));
		shutdownAbort = undefined;
		sessionAbort.abort(new DOMException("Session replaced", "AbortError"));
		sessionAbort = new AbortController();
		const signal = sessionAbort.signal;
		attention.reset(ctx);
		let decision: RemoteSelectionDecision | undefined;
		try {
			decision = await withStateDirectoryAccess(() => startSession(ctx, signal, loaders));
		} catch (error) {
			if (signal.aborted) return;
			ctx.ui.notify(`pi-sync state access failed: ${errorMessage(error)}`, "error");
			return;
		}
		if (!decision || signal.aborted) return;
		attention.set(decision, "sync");
		if (ctx.mode !== "tui") {
			ctx.ui.notify(
				`pi-sync auto sync skipped: ${formatRemoteSelectionMismatch(
					decision.setupName,
					decision.localInclude,
					decision.remoteInclude,
				)}\nRPC review is read-only.`,
				"warning",
			);
		} else if (attention.markOffered()) {
			await resolveSelectionAttention(ctx, attention, signal, loaders, {
				cancelLabel: "Later",
				withStateAccess: withStateDirectoryAccess,
			});
		}
		if (!signal.aborted) attention.publish(ctx);
	});

	pi.on("session_shutdown", async (event, ctx) => {
		sessionAbort.abort(new DOMException("Session shut down", "AbortError"));
		attention.reset(ctx);
		shutdownAbort?.abort(new DOMException("Session shut down again", "AbortError"));
		const controller = new AbortController();
		shutdownAbort = controller;
		const signal = combineSignals(controller.signal, AbortSignal.timeout(30_000));
		const reason =
			typeof event === "object" && event ? (event as { reason?: string }).reason : undefined;
		try {
			if (reason !== "reload") {
				await withStateDirectoryAccess(async () => {
					if (signal.aborted) return;
					await autoPushSessions(ctx, signal, loaders);
				});
			}
		} catch (error) {
			if (!signal.aborted) {
				ctx.ui.notify(`pi-sync session push skipped: ${errorMessage(error)}`, "warning");
			}
		} finally {
			if (shutdownAbort === controller) shutdownAbort = undefined;
		}
		if (signal.aborted) return;
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}

export type { SyncDependencies } from "./sync/sync-loaders.js";
