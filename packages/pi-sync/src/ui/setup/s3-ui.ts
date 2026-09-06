import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { refreshTargetCompletions } from "../../commands/setup-completions.js";
import {
	addSyncSetup,
	saveNewV3Settings,
	updateSyncSetup,
} from "../../settings/settings-management.js";
import type { PartialConfig } from "../../settings/settings-types.js";
import { normalizeStoragePath, ownRecord } from "../../settings/settings-validation.js";
import { DEFAULT_SYNC_INCLUDE, syncIncludeSelection } from "../../sync/sync-policy.js";
import { safeTerminalText } from "../terminal-text.js";
import { chooseS3Credentials } from "./s3-credentials-ui.js";
import {
	chooseAdditionalRemoteLocation,
	chooseInitialRemoteLocation,
	promptAvailableSetupStorage,
} from "./setup-location-ui.js";
import { requiredInput, requiredValueInput } from "./text-input.js";

export async function showS3Setup(
	ctx: ExtensionCommandContext,
	preset: string,
	targetName: string,
	signal?: AbortSignal,
) {
	const endpoint = await requiredValueInput(
		ctx,
		preset === "Cloudflare R2"
			? "Cloudflare R2 endpoint\n\nCopy the S3 API endpoint from your R2 account; replace <account-id>."
			: "S3-compatible endpoint\n\nUse your provider's S3 API URL, not its web console.",
		preset === "Cloudflare R2"
			? "https://<account-id>.r2.cloudflarestorage.com"
			: "https://s3.example.com",
		signal,
	);
	if (!endpoint) return false;
	let region = "auto";
	if (preset !== "Cloudflare R2") {
		const selectedRegion = await requiredInput(
			ctx,
			"Storage region\n\nUse the region assigned to your bucket by the provider.",
			"us-east-1",
			signal,
		);
		if (!selectedRegion) return false;
		region = selectedRegion;
	}
	const location = await chooseInitialRemoteLocation(ctx, preset, targetName, signal);
	if (!location) return false;
	const { connectionName, bucket, path: storagePath } = location;
	const credentials = await chooseS3Credentials(ctx, signal);
	if (!credentials) return false;
	const contentChoice = await ctx.ui.select(
		"Choose an initial sync preset",
		["Recommended Pi settings", "Minimal settings", "Cancel"],
		{ signal },
	);
	if (signal?.aborted || !contentChoice || contentChoice === "Cancel") return false;
	const syncFiles =
		contentChoice === "Minimal settings"
			? ["settings.json", "AGENTS.md"]
			: [...DEFAULT_SYNC_INCLUDE];
	const automaticChoice = await ctx.ui.select(
		"Automatic sync for this setup",
		["Enable automatic sync", "Keep automatic sync off", "Cancel"],
		{ signal },
	);
	if (signal?.aborted || !automaticChoice || automaticChoice === "Cancel") return false;
	const sessionChoice = await ctx.ui.select(
		"Session conversations\n\nSessions can contain prompts, tool output, paths, screenshots, and secrets.",
		["Keep sessions off (recommended)", "Include session conversations", "Cancel"],
		{ signal },
	);
	if (signal?.aborted || !sessionChoice || sessionChoice === "Cancel") return false;
	const syncSessions = sessionChoice === "Include session conversations";
	if (
		syncSessions &&
		!(await ctx.ui.confirm(
			"Include session conversations?",
			"I understand that session JSONL can contain prompts, tool output, paths, screenshots, and secrets.",
			{ signal },
		))
	) {
		return false;
	}
	const autoSync = automaticChoice === "Enable automatic sync";
	const choice = await ctx.ui.select(
		[
			"Review sync setup",
			"",
			`Sync setup: ${safeTerminalText(targetName)}`,
			`Storage connection: ${safeTerminalText(connectionName)} (${preset})`,
			`Endpoint: ${safeTerminalText(endpoint)}`,
			`Bucket: ${safeTerminalText(bucket)}`,
			`Storage location: ${safeTerminalText(storagePath)}`,
			"Bucket must already exist. pi-sync will not create it.",
			`Included content: ${syncFiles.length} built-in groups · Sessions: ${syncSessions ? "On — privacy warning acknowledged" : "Off"}`,
			`Automatic sync: ${autoSync ? "On" : "Off"}`,
			`Credentials: ${safeTerminalText(credentials.summary)}`,
		].join("\n"),
		["Save sync setup", "Cancel"],
		{ signal },
	);
	if (signal?.aborted || choice !== "Save sync setup") return false;
	await saveNewV3Settings(
		{
			setupName: targetName,
			connectionName,
			connection: {
				type: "s3",
				endpoint,
				region,
				credentials: {
					accessKeyId: credentials.profileFields.accessKeyId ?? "",
					secretAccessKey: credentials.profileFields.secretAccessKey ?? "",
				},
			},
			setup: {
				storage: { connection: connectionName, bucket, path: storagePath },
				sync: {
					include: [...syncFiles, ...(syncSessions ? ["sessions"] : [])],
					automatic: autoSync,
				},
			},
		},
		signal,
	);
	if (signal?.aborted) return false;
	await refreshTargetCompletions();
	if (signal?.aborted) return true;
	ctx.ui.notify(
		credentials.ready
			? `Sync setup “${safeTerminalText(targetName)}” is ready. Use Sync now when ready.`
			: `Saved sync setup “${safeTerminalText(targetName)}”; add credentials before syncing.`,
		"info",
	);
	return true;
}

export async function showAddS3Target(
	ctx: ExtensionCommandContext,
	raw: Record<string, unknown>,
	profile: string,
	name: string,
	signal?: AbortSignal,
) {
	const location = await chooseAdditionalRemoteLocation(ctx, raw, profile, name, signal);
	if (!location) return;
	const storage = await promptAvailableSetupStorage(
		ctx,
		{ connection: profile, ...location },
		signal,
	);
	if (!storage) return;
	const { bucket, path: storagePath } = storage;
	const preset = await ctx.ui.select(
		"Choose included content",
		["Recommended Pi settings", "Minimal settings", "Cancel"],
		{ signal },
	);
	if (!preset || preset === "Cancel") return;
	const syncFiles =
		preset === "Minimal settings" ? ["settings.json", "AGENTS.md"] : [...DEFAULT_SYNC_INCLUDE];
	const overlapsExistingTarget = Object.values(ownRecord(raw.syncSetups) ?? {}).some((value) => {
		const existing = ownRecord(value);
		const sync = ownRecord(existing?.sync);
		const selected = syncIncludeSelection(
			Array.isArray(sync?.include) ? sync.include : [],
		).builtIns;
		return selected.some((item) => syncFiles.includes(item));
	});
	const choice = await ctx.ui.select(
		[
			"Review new sync setup",
			"",
			`Sync setup: ${safeTerminalText(name)}`,
			`Storage connection: ${safeTerminalText(profile)}`,
			`Bucket: ${safeTerminalText(bucket)}`,
			`Storage location: ${safeTerminalText(storagePath)}`,
			"Bucket must already exist. pi-sync will not create it.",
			`Included content: ${syncFiles.length} built-in groups · Sessions: Off`,
			...(overlapsExistingTarget
				? [
						"Warning: this setup shares local content with another setup; only the current setup syncs automatically.",
					]
				: []),
			"Adding this setup does not sync or modify remote data.",
		].join("\n"),
		["Add sync setup", "Cancel"],
		{ signal },
	);
	if (signal?.aborted || choice !== "Add sync setup") return;
	await addSyncSetup(
		name,
		{
			storage: { connection: profile, bucket, path: storagePath },
			sync: { include: syncFiles, automatic: true },
		},
		signal,
	);
	if (signal?.aborted) return;
	await refreshTargetCompletions();
	ctx.ui.notify(`Added sync setup “${safeTerminalText(name)}”.`, "info");
}

export async function showEditS3Target(
	ctx: ExtensionCommandContext,
	partial: PartialConfig,
	signal?: AbortSignal,
) {
	const bucket = await requiredInput(ctx, "Bucket", partial.bucket ?? "pi-sync", signal);
	if (!bucket) return;
	const storagePath = await requiredInput(
		ctx,
		"Storage path\n\nObject-key prefix inside the bucket, not your local filesystem.",
		partial.storagePath,
		signal,
	);
	if (!storagePath) return;
	const normalizedPath = normalizeStoragePath(storagePath);
	const choice = await ctx.ui.select(
		[
			`Review sync setup “${safeTerminalText(partial.setupName)}”`,
			"",
			`Bucket: ${safeTerminalText(partial.bucket ?? "missing")} → ${safeTerminalText(bucket)}`,
			`Storage path: ${safeTerminalText(partial.storagePath ?? "missing")} → ${safeTerminalText(normalizedPath)}`,
			"Saving changes the future storage location only; it does not move or delete remote data.",
		].join("\n"),
		["Save sync setup", "Cancel"],
		{ signal },
	);
	if (signal?.aborted || choice !== "Save sync setup") return;
	await updateSyncSetup(
		partial.setupName,
		(setup) => {
			if (typeof setup.storage.bucket !== "string") {
				throw new Error("Sync setup storage type changed; reopen it.");
			}
			return {
				...setup,
				storage: { ...setup.storage, bucket, path: normalizedPath },
			};
		},
		{ expectedStorage: partial, signal },
	);
	if (signal?.aborted) return;
	ctx.ui.notify(`Saved sync setup “${safeTerminalText(partial.setupName)}”.`, "info");
}
