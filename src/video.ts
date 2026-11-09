import type { PluginContext } from "emdash/plugin";
import { readConfig } from "./config";
import { entryText, entryTitle } from "./entry-text";
import { getStatus, RevidApiError, startRender, type RenderPayload } from "./revid-api";
import { videos, type VideoRecord } from "./store";

/**
 * Making a video takes one call to Revid, then a few minutes of rendering.
 * A one-shot cron task checks the project every two minutes until it is
 * ready or failed, at most MAX_CHECKS times. The admin page and the MCP
 * status tool can also refresh it on demand.
 */

const CHECK_DELAY_MS = 2 * 60 * 1000;
const MAX_CHECKS = 20;

export type MakeVideoResult =
	| { ok: true; video: VideoRecord }
	| { ok: false; error: "not_configured" | "not_found" | "already_running" | "revid_error"; message: string };

function isFinal(status: string): boolean {
	return status === "ready" || status === "failed";
}

/** Revid reports `ready`, a failure, or one of several in-progress states. */
function normalizeStatus(status: string, error: string | null, videoUrl: string | null): string {
	if (status === "ready" && videoUrl) return "ready";
	if (/fail|error|cancel/i.test(status) || (error && status !== "ready")) return "failed";
	return "generating";
}

function taskName(collection: string, entryId: string): string {
	return `check_${collection}_${entryId}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 128);
}

async function scheduleCheck(ctx: PluginContext, record: VideoRecord): Promise<void> {
	if (!ctx.cron) return;
	await ctx.cron.schedule(taskName(record.collection, record.entryId), {
		schedule: new Date(Date.now() + CHECK_DELAY_MS).toISOString(),
		data: { collection: record.collection, entryId: record.entryId },
	});
}

/**
 * Starts a Revid video for one saved entry. A published entry with a public
 * URL uses article-to-video on that page; any other entry sends its text as
 * a prompt. Worst case: 7 bridge calls.
 */
export async function makeVideo(
	ctx: PluginContext,
	collection: string,
	entryId: string,
	options: { force?: boolean } = {},
): Promise<MakeVideoResult> {
	const config = await readConfig(ctx); // 1
	if (!config.apiKey) {
		return { ok: false, error: "not_configured", message: "Add your Revid API key on the Revid videos page first." };
	}
	const store = videos(ctx);
	const existing = await store.get(collection, entryId); // 2
	if (existing && existing.status === "generating" && !options.force) {
		return { ok: false, error: "already_running", message: "A video for this entry is still being made." };
	}
	const entry = await ctx.content?.get(collection, entryId); // 3
	if (!entry) return { ok: false, error: "not_found", message: "The entry does not exist." };

	const publicUrl =
		entry.status === "published" && ctx.content?.getPublicUrl ? await ctx.content.getPublicUrl(collection, entryId) : null; // 4
	const title = entryTitle(entry.data) || entry.slug || entryId;
	const payload: RenderPayload = publicUrl
		? { workflow: "article-to-video", source: { url: publicUrl }, aspectRatio: config.aspectRatio, options: { targetDuration: config.targetDuration } }
		: {
				workflow: "prompt-to-video",
				source: { prompt: `Make a short video that presents this article.\n\n${entryText(entry.data)}` },
				aspectRatio: config.aspectRatio,
				options: { targetDuration: config.targetDuration },
			};
	payload.metadata = { source: "emdash", collection, entryId };

	let pid: string;
	try {
		pid = await startRender(ctx, config.apiKey, payload); // 5
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.log.warn("Revid render failed to start", { collection, entryId, message });
		return {
			ok: false,
			error: "revid_error",
			message: error instanceof RevidApiError && error.status === 402 ? `Revid needs an active plan or more credits: ${message}` : message,
		};
	}

	const now = new Date().toISOString();
	const record: VideoRecord = {
		collection,
		entryId,
		title,
		pid,
		status: "generating",
		videoUrl: null,
		error: null,
		createdAt: now,
		updatedAt: now,
		checks: 0,
	};
	await store.put(record); // 6
	await scheduleCheck(ctx, record); // 7
	return { ok: true, video: record };
}

/** Asks Revid for the project's state and saves it. Worst case: 4 bridge calls. */
export async function refreshVideo(ctx: PluginContext, record: VideoRecord, apiKey: string): Promise<VideoRecord> {
	if (isFinal(record.status)) return record;
	const status = await getStatus(ctx, apiKey, record.pid); // 1
	const next: VideoRecord = {
		...record,
		status: normalizeStatus(status.status, status.error, status.videoUrl),
		videoUrl: status.videoUrl,
		error: status.error,
		updatedAt: new Date().toISOString(),
	};
	await videos(ctx).put(next); // 2
	return next;
}

/** Cron step: checks one project and schedules the next check while it renders. */
export async function runCheckTask(ctx: PluginContext, collection: string, entryId: string): Promise<void> {
	const config = await readConfig(ctx);
	if (!config.apiKey) return;
	const record = await videos(ctx).get(collection, entryId);
	if (!record || isFinal(record.status)) return;
	const next = await refreshVideo(ctx, { ...record, checks: record.checks + 1 }, config.apiKey);
	if (!isFinal(next.status) && next.checks < MAX_CHECKS) await scheduleCheck(ctx, next);
}
