import type { PluginContext } from "emdash/plugin";

/**
 * The Revid public API v3. Docs: https://www.revid.ai/docs
 * Every call sends the API key in the `key` header and a descriptive
 * User-Agent (Revid's edge refuses some default library agents).
 */

export const API_BASE = "https://www.revid.ai/api/public/v3";
const USER_AGENT = "revid-emdash-plugin/0.1";

export class RevidApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "RevidApiError";
	}
}

export interface RenderPayload {
	workflow: "article-to-video" | "prompt-to-video";
	source: { url: string } | { prompt: string };
	aspectRatio: string;
	options: { targetDuration: number };
	metadata?: Record<string, string>;
}

export interface ProjectStatus {
	status: string;
	videoUrl: string | null;
	error: string | null;
	progress: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function call(
	ctx: PluginContext,
	apiKey: string,
	path: string,
	init: { method: "GET" | "POST"; body?: unknown },
): Promise<Record<string, unknown>> {
	if (!ctx.http) throw new Error("The network:request capability is not granted");
	const response = await ctx.http.fetch(`${API_BASE}${path}`, {
		method: init.method,
		headers: {
			key: apiKey,
			"content-type": "application/json",
			"user-agent": USER_AGENT,
		},
		...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
	});
	let body: unknown = null;
	try {
		body = await response.json();
	} catch {
		// Non-JSON answers fall through to the status check.
	}
	const data = isRecord(body) ? body : {};
	if (!response.ok || data.success === 0) {
		const message =
			typeof data.error === "string" && data.error
				? data.error
				: typeof data.message === "string" && data.message
					? data.message
					: `Revid answered ${response.status}`;
		throw new RevidApiError(response.status, message);
	}
	return data;
}

/** Starts a render and returns its project id. */
export async function startRender(ctx: PluginContext, apiKey: string, payload: RenderPayload): Promise<string> {
	const data = await call(ctx, apiKey, "/render", { method: "POST", body: payload });
	if (typeof data.pid !== "string" || !data.pid) throw new RevidApiError(502, "Revid did not return a project id");
	return data.pid;
}

export async function getStatus(ctx: PluginContext, apiKey: string, pid: string): Promise<ProjectStatus> {
	const data = await call(ctx, apiKey, `/status?pid=${encodeURIComponent(pid)}`, { method: "GET" });
	return {
		status: typeof data.status === "string" ? data.status : "unknown",
		videoUrl: typeof data.videoUrl === "string" ? data.videoUrl : null,
		error: typeof data.error === "string" ? data.error : null,
		progress: typeof data.progress === "number" ? data.progress : null,
	};
}

export function projectUrl(pid: string): string {
	return `https://www.revid.ai/editor/${encodeURIComponent(pid)}`;
}
