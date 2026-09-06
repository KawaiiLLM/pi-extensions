import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { setSyncSetupCompletions } from "../commands/command.js";
import type { CommandOptions } from "../commands/command-types.js";
import { loadConfig, loadPartialConfig } from "../settings/config.js";
import { isMissingConfigError } from "../settings/config-errors.js";
import { consumeLocalConfigMigrationNotice } from "../settings/config-file.js";
import { configuredSyncSetupNames } from "../settings/settings-store.js";
import { snapshotOptionsForContext } from "../snapshot/session-paths.js";
import { recoverSnapshotTransactionsOnStartup } from "../snapshot/snapshot-transaction.js";
import { withLock } from "../state/lock.js";
import { stateDirectoryMigrationNotice } from "../state/state-directory.js";
import { ensureStateDir, readStateForConfig } from "../state/sync-state-store.js";
import { throwIfAborted } from "./signals.js";
import { errorMessage } from "./sync-errors.js";
import type { SyncLoaders } from "./sync-loaders.js";
import { type RemoteSelectionDecision, RemoteSelectionMismatchError } from "./sync-policy.js";

const AUTO_SYNC_OPTIONS: CommandOptions = {
	yes: true,
	force: false,
	stale: false,
	silent: true,
	reload: false,
	auto: true,
	args: [],
};

const STATUS_KEY = "sync";

export async function startSession(
	ctx: ExtensionContext,
	signal: AbortSignal,
	loaders: SyncLoaders,
) {
	if (signal.aborted) return;
	try {
		const migrationNotice = stateDirectoryMigrationNotice();
		if (migrationNotice) ctx.ui.notify(migrationNotice, "warning");
	} catch (error) {
		ctx.ui.notify(`pi-sync state directory requires attention: ${errorMessage(error)}`, "error");
		return;
	}
	try {
		await recoverSnapshotTransactionsOnStartup();
		if (signal.aborted) return;
	} catch (error) {
		if (signal.aborted) return;
		ctx.ui.notify(`pi-sync recovery required: ${errorMessage(error)}`, "error");
		return;
	}
	try {
		setSyncSetupCompletions(await configuredSyncSetupNames());
		if (signal.aborted) return;
	} catch {
		if (signal.aborted) return;
		setSyncSetupCompletions([]);
	}
	const migrationNotice = consumeLocalConfigMigrationNotice();
	if (migrationNotice) ctx.ui.notify(migrationNotice, "warning");
	if (signal.aborted) return;
	return autoSync(ctx, signal, loaders);
}

async function autoSync(
	ctx: ExtensionContext,
	signal: AbortSignal,
	loaders: SyncLoaders,
): Promise<RemoteSelectionDecision | undefined> {
	try {
		const partial = await loadPartialConfig();
		throwIfAborted(signal);
		if (!partial.automatic) return;
		await ensureStateDir();
		throwIfAborted(signal);
		await loadConfig();
		throwIfAborted(signal);
		const operations = await loaders.operations();
		throwIfAborted(signal);
		await withLock("auto-sync", () => {
			throwIfAborted(signal);
			return operations.syncBoth(ctx, { ...AUTO_SYNC_OPTIONS, signal });
		});
	} catch (error) {
		if (signal.aborted || isMissingConfigError(error)) return;
		ctx.ui.setStatus(STATUS_KEY, undefined);
		if (error instanceof RemoteSelectionMismatchError) return error.decision;
		ctx.ui.notify(`pi-sync auto sync skipped: ${errorMessage(error)}`, "warning");
	}
}

export async function autoPushSessions(
	ctx: ExtensionContext,
	signal: AbortSignal,
	loaders: SyncLoaders,
) {
	try {
		const partial = await loadPartialConfig();
		throwIfAborted(signal);
		if (!partial.automatic) return;
		if (!partial.include.includes("sessions")) return;
		await ensureStateDir();
		throwIfAborted(signal);
		const config = await loadConfig();
		throwIfAborted(signal);
		if (!config.include.includes("sessions")) return;
		const [operations, snapshotModule, syncStateModule] = await Promise.all([
			loaders.operations(),
			loaders.snapshot(),
			loaders.syncState(),
		]);
		throwIfAborted(signal);
		await withLock("auto-session-push", async () => {
			throwIfAborted(signal);
			const state = await readStateForConfig(config);
			throwIfAborted(signal);
			const local = await snapshotModule.createSnapshot(
				config.snapshotIdentity,
				snapshotOptionsForContext(ctx, config),
			);
			throwIfAborted(signal);
			if (!syncStateModule.hasLocalChanges(local, state, config)) return;
			await operations.push(ctx, { ...AUTO_SYNC_OPTIONS, signal }, { config, state, local });
		});
	} catch (error) {
		if (signal.aborted || isMissingConfigError(error)) return;
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.notify(`pi-sync session push skipped: ${errorMessage(error)}`, "warning");
	}
}
