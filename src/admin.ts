import type { ActionElement, Block, BlockResponse } from "@emdash-cms/blocks";
import type { PluginContext } from "emdash/plugin";
import { z } from "zod";
import { readConfig, type Config } from "./config";
import { projectUrl } from "./revid-api";
import { videos, type VideoRecord } from "./store";
import { makeVideo, refreshVideo } from "./video";

/** The Revid videos page: settings and the latest videos. */

const settingsValues = z.object({
	apiKey: z.string().optional(),
	autoVideo: z.boolean().optional(),
	autoCollections: z.string().optional(),
	aspectRatio: z.enum(["9:16", "16:9", "1:1"]).optional(),
	targetDuration: z.coerce.number().int().min(10).max(180).optional(),
});

const interaction = z.discriminatedUnion("type", [
	z.object({ type: z.literal("page_load"), page: z.string().optional() }),
	z.object({ type: z.literal("panel_load") }),
	z.object({ type: z.literal("block_action"), action_id: z.string(), value: z.unknown().optional() }),
	z.object({ type: z.literal("form_submit"), action_id: z.string(), values: z.record(z.string(), z.unknown()) }),
]);

export type Interaction = z.infer<typeof interaction>;

export function parseInteraction(input: unknown): Interaction | null {
	const parsed = interaction.safeParse(input);
	return parsed.success ? parsed.data : null;
}

const STATUS_LABELS: Record<string, string> = {
	generating: "Making",
	ready: "Ready",
	failed: "Failed",
};

export function statusLabel(status: string): string {
	return STATUS_LABELS[status] ?? status;
}

function videoRow(video: VideoRecord): Record<string, unknown> {
	return {
		title: video.title || video.entryId,
		status: statusLabel(video.status),
		createdAt: video.createdAt,
		entry: { type: "link", label: "Entry", target: { kind: "content", collection: video.collection, id: video.entryId } },
		video: video.videoUrl
			? { type: "link", label: "Watch", target: { kind: "external", url: video.videoUrl } }
			: { type: "link", label: "Open in Revid", target: { kind: "external", url: projectUrl(video.pid) } },
	};
}

function settingsForm(config: Config): Block {
	return {
		type: "form",
		block_id: "settings",
		fields: [
			{
				type: "secret_input",
				action_id: "apiKey",
				label: "Revid API key",
				placeholder: "From revid.ai/account, API tab",
				has_value: Boolean(config.apiKey),
			},
			{ type: "toggle", action_id: "autoVideo", label: "Make a video when a post is published", initial_value: config.autoVideo },
			{
				type: "text_input",
				action_id: "autoCollections",
				label: "Collections for automatic videos (comma separated)",
				initial_value: config.autoCollections.join(", "),
			},
			{
				type: "select",
				action_id: "aspectRatio",
				label: "Aspect ratio",
				options: [
					{ label: "9:16 (TikTok, Reels, Shorts)", value: "9:16" },
					{ label: "16:9 (YouTube)", value: "16:9" },
					{ label: "1:1 (square)", value: "1:1" },
				],
				initial_value: config.aspectRatio,
			},
			{
				type: "number_input",
				action_id: "targetDuration",
				label: "Target length in seconds",
				initial_value: config.targetDuration,
				min: 10,
				max: 180,
			},
		],
		submit: { label: "Save", action_id: "save_settings" },
	};
}

export async function renderPage(ctx: PluginContext, toast?: BlockResponse["toast"]): Promise<BlockResponse> {
	const config = await readConfig(ctx);
	const recent = await videos(ctx).recent();
	const blocks: Block[] = [{ type: "header", text: "Revid videos" }];
	if (!config.apiKey) {
		blocks.push({
			type: "banner",
			title: "Connect your Revid account",
			description: "Paste an API key from revid.ai/account (API tab). Making videos uses your Revid credits.",
		});
	}
	blocks.push(
		{
			type: "context",
			text: "Open an entry and choose \"Make a Revid video\" in its menu, or turn on automatic videos below. Your site's AI agent can do the same through the MCP tools.",
		},
		{
			type: "table",
			block_id: "videos",
			page_action_id: "videos_page",
			columns: [
				{ key: "title", label: "Entry" },
				{ key: "status", label: "Status", format: "badge" },
				{ key: "createdAt", label: "Started", format: "relative_time" },
				{ key: "entry", label: "", format: "element" },
				{ key: "video", label: "Video", format: "element" },
			],
			rows: recent.map(videoRow),
			empty_text: "No videos yet.",
		},
		{ type: "actions", elements: [{ type: "button", action_id: "refresh", label: "Refresh status" }] },
		{ type: "divider" },
		{ type: "header", text: "Settings" },
		settingsForm(config),
	);
	return { blocks, ...(toast ? { toast } : {}) };
}

export async function saveSettings(ctx: PluginContext, raw: Record<string, unknown>): Promise<BlockResponse> {
	const parsed = settingsValues.safeParse(raw);
	if (!parsed.success) return renderPage(ctx, { type: "error", message: "Check the settings and try again." });
	const values = parsed.data;
	// An empty secret field means "unchanged", never "delete".
	if (values.apiKey && values.apiKey.trim()) await ctx.settings.set("apiKey", values.apiKey.trim());
	if (values.autoVideo !== undefined) await ctx.settings.set("autoVideo", values.autoVideo);
	if (values.autoCollections !== undefined) await ctx.settings.set("autoCollections", values.autoCollections);
	if (values.aspectRatio) await ctx.settings.set("aspectRatio", values.aspectRatio);
	if (values.targetDuration !== undefined) await ctx.settings.set("targetDuration", values.targetDuration);
	return renderPage(ctx, { type: "success", message: "Settings saved" });
}

/** Refreshes the videos still being made, at most five per click. */
export async function refreshAll(ctx: PluginContext): Promise<BlockResponse> {
	const config = await readConfig(ctx);
	if (config.apiKey) {
		const pending = (await videos(ctx).recent(10)).filter((video) => video.status === "generating").slice(0, 5);
		for (const video of pending) {
			try {
				await refreshVideo(ctx, video, config.apiKey);
			} catch (error) {
				ctx.log.warn("Could not refresh a Revid video", {
					pid: video.pid,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}
	return renderPage(ctx, { type: "info", message: "Status refreshed" });
}

/** The editor panel beside a saved entry. */
export async function renderPanel(ctx: PluginContext, collection: string, entryId: string, toast?: BlockResponse["toast"]): Promise<BlockResponse> {
	const video = await videos(ctx).get(collection, entryId);
	const blocks: Block[] = [];
	if (!video) {
		blocks.push({
			type: "empty",
			title: "No video yet",
			description: "Revid turns this entry into a short video with voice, captions and music.",
			actions: [{ type: "button", action_id: "make_video", label: "Make a video", style: "primary" }],
		});
	} else {
		blocks.push({
			type: "fields",
			fields: [
				{ label: "Status", value: statusLabel(video.status) },
				{ label: "Started", value: video.createdAt },
			],
		});
		if (video.error && video.status === "failed") blocks.push({ type: "banner", variant: "error", description: video.error });
		const elements: ActionElement[] = [];
		if (video.videoUrl) elements.push({ type: "link", label: "Watch", appearance: "primary", target: { kind: "external", url: video.videoUrl } });
		elements.push({ type: "link", label: "Open in Revid", target: { kind: "external", url: projectUrl(video.pid) } });
		if (video.status === "generating") elements.push({ type: "button", action_id: "refresh_one", label: "Refresh" });
		else elements.push({ type: "button", action_id: "make_video", label: "Make a new video" });
		blocks.push({ type: "actions", elements });
	}
	return { blocks, ...(toast ? { toast } : {}) };
}

export async function panelAction(ctx: PluginContext, collection: string, entryId: string, actionId: string): Promise<BlockResponse> {
	if (actionId === "make_video") {
		const result = await makeVideo(ctx, collection, entryId, { force: true });
		return renderPanel(ctx, collection, entryId, result.ok ? { type: "success", message: "Revid is making the video" } : { type: "error", message: result.message });
	}
	if (actionId === "refresh_one") {
		const config = await readConfig(ctx);
		const video = await videos(ctx).get(collection, entryId);
		if (video && config.apiKey) await refreshVideo(ctx, video, config.apiKey);
		return renderPanel(ctx, collection, entryId);
	}
	return renderPanel(ctx, collection, entryId);
}
