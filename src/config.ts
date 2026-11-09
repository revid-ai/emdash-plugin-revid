import type { PluginContext } from "emdash/plugin";

export type AspectRatio = "9:16" | "16:9" | "1:1";

export interface Config {
	apiKey: string | null;
	autoVideo: boolean;
	autoCollections: string[];
	aspectRatio: AspectRatio;
	targetDuration: number;
}

const ASPECT_RATIOS: AspectRatio[] = ["9:16", "16:9", "1:1"];

function text(entries: Map<string, unknown>, key: string): string | null {
	const value = entries.get(key);
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Reads every setting in one bridge call. */
export async function readConfig(ctx: PluginContext): Promise<Config> {
	const entries = new Map((await ctx.settings.list()).map((entry) => [entry.key, entry.value] as const));
	const ratio = text(entries, "aspectRatio");
	const duration = Number(entries.get("targetDuration"));
	return {
		apiKey: text(entries, "apiKey"),
		autoVideo: entries.get("autoVideo") === true,
		autoCollections: (text(entries, "autoCollections") ?? "posts")
			.split(",")
			.map((slug) => slug.trim())
			.filter(Boolean),
		aspectRatio: ASPECT_RATIOS.find((value) => value === ratio) ?? "9:16",
		targetDuration: Number.isFinite(duration) ? Math.min(180, Math.max(10, Math.round(duration))) : 45,
	};
}
