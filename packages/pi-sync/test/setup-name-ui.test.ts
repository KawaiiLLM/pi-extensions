import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { ExtensionInputComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { readLocalConfigObject } from "../src/config.js";
import { showSetupWizard } from "../src/manager-ui.js";
import { promptInitialSetupName } from "../src/setup-name-ui.js";
import { withTempHome } from "./helpers.js";

initTheme("dark", false);

test.each([32, 80])("Pi core name input renders guidance within %s columns", async (width) => {
	let lines: string[] = [];
	let submitted = false;
	const { ctx } = createMockContext({
		hasUI: true,
		mode: "tui",
		input: async (title: string, placeholder?: string) => {
			let answer: string | undefined;
			const input = new ExtensionInputComponent(
				title,
				placeholder,
				(value) => {
					submitted = true;
					answer = value;
				},
				() => {},
			);
			try {
				input.focused = true;
				lines = input.render(width);
				input.handleInput("\r");
				return answer;
			} finally {
				input.dispose();
			}
		},
	});
	assert.equal(await promptInitialSetupName(ctx, "Git"), "default");
	assert.equal(submitted, true);
	assert.ok(lines.every((line) => visibleWidth(line) <= width));
	const text = stripVTControlCharacters(lines.join(" ")).replace(/\s+/gu, " ");
	assert.match(text, /Name this sync setup/u);
	assert.match(text, /Examples: home, work, personal\. Leave blank to use default\./u);
	assert.match(text, /Used in suggested storage paths and Git branches\./u);
	assert.match(text, /Sync content and automatic sync are chosen separately\./u);
});

test("Pi core name input cancellation does not accept the default", async () => {
	let cancelled = false;
	const { ctx } = createMockContext({
		hasUI: true,
		mode: "tui",
		input: async (title: string, placeholder?: string) => {
			const input = new ExtensionInputComponent(
				title,
				placeholder,
				() => {},
				() => {
					cancelled = true;
				},
			);
			try {
				input.handleInput("\u001b");
				return undefined;
			} finally {
				input.dispose();
			}
		},
	});
	assert.equal(await promptInitialSetupName(ctx, "Git"), undefined);
	assert.equal(cancelled, true);
});

const presets = ["Cloudflare R2", "Other S3-compatible storage", "WebDAV", "Git"];
const invalidCommonNames = [
	".",
	"..",
	"team/../work",
	"team/./work",
	"team//work",
	"/work",
	"team\\work",
	"__proto__",
	"prototype",
	"constructor",
	"a".repeat(101),
	"work\u001b[31m",
	"work\u0085profile",
];
const invalidGitNames = [
	"work profile",
	"work..profile",
	"work@{profile}",
	"work~profile",
	"work^profile",
	"work:profile",
	"work?profile",
	"work*profile",
	"work[profile",
	"work]profile",
	".hidden",
	"team/.hidden",
	"work.lock",
	"team.lock/work",
	"work.",
	"work/",
];

const invalidCases = [
	...presets.flatMap((preset) => invalidCommonNames.map((name) => ({ preset, name }))),
	...invalidGitNames.map((name) => ({ preset: "Git", name })),
];

test.each(invalidCases)(
	"$preset rejects name $name before backend prompts and allows correction",
	async ({ preset, name }) => {
		await withTempHome(async (agentDir) => {
			const answers = [name, "default", undefined];
			const titles: string[] = [];
			let selectCalls = 0;
			const { ctx, notifications } = createMockContext({
				hasUI: true,
				mode: "tui",
				select: async () => (selectCalls++ === 0 ? preset : undefined),
				input: async (title: string) => {
					titles.push(title);
					return answers.shift();
				},
			});
			assert.equal(await showSetupWizard(ctx), false);
			assert.equal(titles.length, 3);
			assert.match(titles[0], /^Name this sync setup/u);
			assert.equal(titles[1], titles[0]);
			assert.doesNotMatch(titles[2], /^Name this sync setup/u);
			assert.equal(selectCalls, 1);
			assert.equal(notifications.length, 1);
			assert.equal(notifications[0].level, "warning");
			assert.match(notifications[0].message, /Enter another name/u);
			assert.equal(notifications[0].message.includes("\u001b"), false);
			assert.equal(notifications[0].message.includes("\u0085"), false);
			assert.equal(await readLocalConfigObject(), undefined);
			assert.equal(existsSync(path.join(agentDir, "pi-sync")), false);
		});
	},
);

const validCases = [
	...presets.flatMap((preset) =>
		["default", "team/work", "-work", "refs/work", "@", "工作", "a".repeat(100)].map((name) => ({
			preset,
			name,
		})),
	),
	...presets
		.filter((preset) => preset !== "Git")
		.flatMap((preset) =>
			["work profile", ".git", "work.lock", "work..profile", "work/"].map((name) => ({
				preset,
				name,
			})),
		),
];

test.each(validCases)("$preset accepts backend-valid name $name", async ({ preset, name }) => {
	await withTempHome(async () => {
		const titles: string[] = [];
		const { ctx, notifications } = createMockContext({
			hasUI: true,
			mode: "tui",
			select: async () => preset,
			input: async (title: string) => {
				titles.push(title);
				return titles.length === 1 ? name : undefined;
			},
		});
		assert.equal(await showSetupWizard(ctx), false);
		assert.equal(titles.length, 2);
		assert.doesNotMatch(titles[1], /^Name this sync setup/u);
		assert.deepEqual(notifications, []);
	});
});

test.each([false, true])(
	"name correction cancellation (abort=%s) never advances setup",
	async (abort) => {
		await withTempHome(async () => {
			const controller = new AbortController();
			const titles: string[] = [];
			const signals: (AbortSignal | undefined)[] = [];
			const { ctx, notifications } = createMockContext({
				hasUI: true,
				mode: "tui",
				select: async () => "Git",
				input: async (title: string, _placeholder?: string, options?: { signal?: AbortSignal }) => {
					titles.push(title);
					signals.push(options?.signal);
					if (titles.length === 1) return "work profile";
					if (abort) {
						controller.abort(new DOMException("Session shut down", "AbortError"));
						return "default";
					}
					return undefined;
				},
			});
			const setup = showSetupWizard(ctx, controller.signal);
			if (abort) await assert.rejects(setup, { name: "AbortError" });
			else assert.equal(await setup, false);
			assert.equal(titles.length, 2);
			assert.equal(titles[1], titles[0]);
			assert.deepEqual(signals, [controller.signal, controller.signal]);
			assert.equal(notifications.length, 1);
			assert.equal(await readLocalConfigObject(), undefined);
		});
	},
);
