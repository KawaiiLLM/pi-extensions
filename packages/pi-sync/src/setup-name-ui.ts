import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { normalizeStoragePath, validateConfigName } from "./config.js";
import { errorMessage, requiredInput, safeTerminalText } from "./manager-helpers.js";
import { normalizeWebDavPath } from "./webdav-config.js";

export async function promptInitialSetupName(
	ctx: ExtensionCommandContext,
	preset: string,
	signal?: AbortSignal,
) {
	while (!signal?.aborted) {
		const name = await requiredInput(
			ctx,
			[
				"Name this sync setup",
				"",
				"Examples: home, work, personal.",
				"Also names the storage connection; no second name is needed.",
				preset === "Git"
					? "Git branch and storage path are chosen separately."
					: "Used in the suggested storage path.",
				"Sync content and automatic sync are chosen separately.",
			].join("\n"),
			"default",
			signal,
		);
		if (!name) return undefined;
		try {
			validateConfigName(name, "sync setup");
			// Validate the same suggestions the backend prompts will offer, without changing the name.
			const suggestedPath = `pi-sync/${name}`;
			if (preset !== "Git") normalizeStoragePath(suggestedPath);
			if (preset === "WebDAV") {
				normalizeWebDavPath(suggestedPath);
			}
			return name;
		} catch (error) {
			ctx.ui.notify(
				`This name cannot be used for the sync setup or its suggested storage location. ${safeTerminalText(errorMessage(error))} Enter another name (for example, default).`,
				"warning",
			);
		}
	}
	return undefined;
}
