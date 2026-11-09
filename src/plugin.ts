import type { SandboxedPlugin } from "emdash/plugin";
import { z } from "zod";
import { panelAction, parseInteraction, refreshAll, renderPage, renderPanel, saveSettings, statusLabel } from "./admin";
import { readConfig } from "./config";
import { projectUrl } from "./revid-api";
import { videos, type VideoRecord } from "./store";
import { makeVideo, refreshVideo, runCheckTask } from "./video";

/**
 * Revid for EmDash. Turns a saved entry into a short video with Revid
 * (voice, captions, music), from the entry menu, automatically on publish,
 * or through MCP tools for the site's AI agent.
 */

const entryInput = z.object({
	collection: z.string().min(1).max(63).describe("Collection slug, for example posts"),
	id: z.string().min(1).max(128).describe("Entry ID"),
});

const videoOutput = z.object({
	ok: z.boolean(),
	status: z.string().optional(),
	videoUrl: z.string().nullable().optional(),
	projectUrl: z.string().optional(),
	message: z.string().optional(),
});

function videoResult(video: VideoRecord) {
	return {
		ok: true,
		status: statusLabel(video.status),
		videoUrl: video.videoUrl,
		projectUrl: projectUrl(video.pid),
		...(video.error ? { message: video.error } : {}),
	};
}

const plugin: SandboxedPlugin = {
	hooks: {
		"content:afterPublish": async (event, ctx) => {
			const id = typeof event.content.id === "string" ? event.content.id : null;
			if (!id) return;
			const config = await readConfig(ctx);
			if (!config.autoVideo || !config.apiKey || !config.autoCollections.includes(event.collection)) return;
			// One automatic video per entry: republishing an edit does not spend credits again.
			if (await videos(ctx).get(event.collection, id)) return;
			const result = await makeVideo(ctx, event.collection, id);
			if (!result.ok) ctx.log.warn("Automatic Revid video not started", { collection: event.collection, id, error: result.message });
		},
		cron: async (event, ctx) => {
			const collection = typeof event.data?.collection === "string" ? event.data.collection : null;
			const entryId = typeof event.data?.entryId === "string" ? event.data.entryId : null;
			if (collection && entryId) await runCheckTask(ctx, collection, entryId);
		},
	},

	routes: {
		admin: {
			permission: "plugins:manage",
			handler: async (routeCtx, ctx) => {
				const interaction = parseInteraction(routeCtx.input);
				if (interaction?.type === "form_submit" && interaction.action_id === "save_settings") {
					return saveSettings(ctx, interaction.values);
				}
				if (interaction?.type === "block_action" && interaction.action_id === "refresh") return refreshAll(ctx);
				return renderPage(ctx);
			},
		},

		"editor/panel": {
			permission: "content:read",
			handler: async (routeCtx, ctx) => {
				const entry = routeCtx.ui?.entry;
				if (!entry) return { blocks: [] };
				const interaction = parseInteraction(routeCtx.input);
				if (interaction?.type === "block_action") {
					return panelAction(ctx, entry.collection, entry.id, interaction.action_id);
				}
				return renderPanel(ctx, entry.collection, entry.id);
			},
		},

		"editor/make-video": {
			permission: "content:edit_own",
			handler: async (routeCtx, ctx) => {
				const entry = routeCtx.ui?.entry;
				if (!entry) return { toast: { type: "error", message: "Save the entry first." } };
				const result = await makeVideo(ctx, entry.collection, entry.id, { force: true });
				return result.ok
					? { toast: { type: "success", message: "Revid is making the video. Open the Revid video panel to follow it." } }
					: { toast: { type: "error", message: result.message } };
			},
		},

		"mcp/make-video": {
			permission: "content:edit_own",
			handler: async (routeCtx, ctx) => {
				const parsed = entryInput.safeParse(routeCtx.input);
				if (!parsed.success) return { ok: false, message: "Pass the collection and the entry ID." };
				const result = await makeVideo(ctx, parsed.data.collection, parsed.data.id);
				return result.ok ? videoResult(result.video) : { ok: false, message: result.message };
			},
		},

		"mcp/video-status": {
			permission: "content:read",
			handler: async (routeCtx, ctx) => {
				const parsed = entryInput.safeParse(routeCtx.input);
				if (!parsed.success) return { ok: false, message: "Pass the collection and the entry ID." };
				const record = await videos(ctx).get(parsed.data.collection, parsed.data.id);
				if (!record) return { ok: false, message: "No Revid video was made from this entry." };
				const config = await readConfig(ctx);
				const video = config.apiKey ? await refreshVideo(ctx, record, config.apiKey) : record;
				return videoResult(video);
			},
		},
	},

	mcp: {
		tools: {
			make_video: {
				description:
					"Make a short video (voice, captions, music) from a saved entry with Revid. A published entry is summarized from its public page; a draft from its text. Rendering takes a few minutes and uses credits from the connected Revid account. Follow it with video_status.",
				route: "mcp/make-video",
				input: entryInput,
				output: videoOutput,
				destructive: true,
			},
			video_status: {
				description: "Get the state of the latest Revid video made from an entry: Making, Ready (with the mp4 URL) or Failed.",
				route: "mcp/video-status",
				input: entryInput,
				output: videoOutput,
			},
		},
	},
};

export default plugin;
