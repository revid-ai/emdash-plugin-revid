import type { PluginContext } from "emdash/plugin";

/** The latest video made from one entry. Keyed by `<collection>:<entryId>`. */
export interface VideoRecord {
	collection: string;
	entryId: string;
	title: string;
	pid: string;
	/** Revid project status: generating, ready, failed, or `starting` before Revid answers. */
	status: string;
	videoUrl: string | null;
	error: string | null;
	createdAt: string;
	updatedAt: string;
	/** Status checks done by the cron chain. */
	checks: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

export function toVideoRecord(value: unknown): VideoRecord | null {
	if (!isRecord(value)) return null;
	const collection = str(value.collection);
	const entryId = str(value.entryId);
	const pid = str(value.pid);
	if (!collection || !entryId || !pid) return null;
	return {
		collection,
		entryId,
		pid,
		title: str(value.title) ?? "",
		status: str(value.status) ?? "unknown",
		videoUrl: str(value.videoUrl),
		error: str(value.error),
		createdAt: str(value.createdAt) ?? "",
		updatedAt: str(value.updatedAt) ?? "",
		checks: typeof value.checks === "number" ? value.checks : 0,
	};
}

export function videoKey(collection: string, entryId: string): string {
	return `${collection}:${entryId}`;
}

export function videos(ctx: PluginContext) {
	const store = ctx.storage.videos;
	if (!store) throw new Error("The videos storage collection is not declared");
	return {
		async get(collection: string, entryId: string): Promise<VideoRecord | null> {
			return toVideoRecord(await store.get(videoKey(collection, entryId)));
		},
		async put(record: VideoRecord): Promise<void> {
			await store.put(videoKey(record.collection, record.entryId), record);
		},
		async recent(limit = 25): Promise<VideoRecord[]> {
			const page = await store.query({ orderBy: { createdAt: "desc" }, limit });
			return page.items.flatMap((item) => toVideoRecord(item.data) ?? []);
		},
	};
}
