// Copyright 2026 Alexander Komarov
// SPDX-License-Identifier: Apache-2.0

/**
 * A Pi ResourceLoader that loads nothing from disk (plan M3). Pi's default
 * loader discovers extensions, skills, prompt templates, themes and context
 * files (AGENTS.md, CLAUDE.md) from the working directory and ~/.pi; an Iyye
 * session must not pick any of those up. The only resource is the system
 * prompt the host composes.
 */

import {
	createExtensionRuntime,
	DefaultResourceLoader,
	type ExtensionFactory,
	type LoadExtensionsResult,
	type ResourceLoader,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

export class IyyeResourceLoader implements ResourceLoader {
	private systemPrompt: string;
	private readonly extensions: LoadExtensionsResult;

	/** `extensions`: only Iyye's own inline extensions (see `loadInlineExtensions`); none by default. */
	constructor(systemPrompt: string, extensions?: LoadExtensionsResult) {
		this.systemPrompt = systemPrompt;
		this.extensions = extensions ?? { extensions: [], errors: [], runtime: createExtensionRuntime() };
	}

	/** Takes effect when Pi next rebuilds the prompt (the next turn). */
	setSystemPrompt(prompt: string): void {
		this.systemPrompt = prompt;
	}

	getExtensions() {
		return this.extensions;
	}

	getSkills() {
		return { skills: [], diagnostics: [] };
	}

	getPrompts() {
		return { prompts: [], diagnostics: [] };
	}

	getThemes() {
		return { themes: [], diagnostics: [] };
	}

	getAgentsFiles() {
		return { agentsFiles: [] };
	}

	getSystemPrompt(): string {
		return this.systemPrompt;
	}

	getSystemPromptSource() {
		return undefined;
	}

	getAppendSystemPrompt(): string[] {
		return [];
	}

	getAppendSystemPromptSources() {
		return [];
	}

	extendResources(): void {
		// Nothing may be added: extensions are not trusted resident components (HLD §2.3).
	}

	async reload(): Promise<void> {}
}

/**
 * Load Iyye's own inline extensions (for example the per-turn memory hook)
 * through Pi's supported loader with every kind of discovery off: no
 * extension files, skills, prompt templates, themes or context files, and
 * in-memory settings. The L0 spike verified that this loads only the inline
 * factories. Any load error is fatal: a session must not run without a hook
 * Iyye relies on.
 */
export async function loadInlineExtensions(
	factories: ExtensionFactory[],
	cwd: string,
	agentDir: string,
): Promise<LoadExtensionsResult> {
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager: SettingsManager.inMemory({}),
		extensionFactories: factories,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();
	const result = loader.getExtensions();
	if (result.errors.length > 0) {
		throw new Error(`inline extension failed to load: ${result.errors.map((e) => e.error).join("; ")}`);
	}
	if (result.extensions.length !== factories.length) {
		throw new Error(`expected ${factories.length} inline extension(s), Pi loaded ${result.extensions.length}`);
	}
	return result;
}
