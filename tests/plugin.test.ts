import { afterEach, describe, expect, it } from "vitest";

import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";

// Secret settings are encrypted at rest; a fixed all-zero key is enough for tests.
process.env.EMDASH_ENCRYPTION_KEY = `emdash_enc_v1_${"A".repeat(43)}`;

const RENDER_URL = "https://www.revid.ai/api/public/v3/render";
const STATUS_URL = "https://www.revid.ai/api/public/v3/status?pid=p_test";

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

async function setup() {
	host = await createPluginRuntimeTestHost({ site: { url: "https://blog.example.com" } });
	await host.fixtures.collection({
		slug: "posts",
		label: "Posts",
		fields: [
			{ slug: "title", label: "Title", type: "string" },
			{ slug: "content", label: "Content", type: "portableText" },
		],
	});
	const admin = await host.fixtures.user({ email: "admin@example.com", role: "admin" });
	const entry = await host.fixtures.content("posts", {
		slug: "grow-a-newsletter",
		data: {
			title: "Ten ways to grow a newsletter",
			content: [
				{
					_type: "block",
					_key: "a",
					style: "normal",
					markDefs: [],
					children: [{ _type: "span", _key: "b", text: "Start with one clear promise.", marks: [] }],
				},
			],
		},
	});
	return { host, admin, entry };
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("admin page", () => {
	it("asks for an API key until one is saved", async () => {
		const { host } = await setup();
		const before = await host.admin.loadPage("/videos");
		expect(JSON.stringify(before.blocks)).toContain("Connect your Revid account");

		await host.actions.plugin.updateSettings({ apiKey: "rk_test" });
		const after = await host.admin.loadPage("/videos");
		expect(JSON.stringify(after.blocks)).not.toContain("Connect your Revid account");
		expect(JSON.stringify(after.blocks)).toContain("No videos yet.");
	});
});

describe("make a video", () => {
	it("sends a draft's text to Revid and follows the render", async () => {
		const { host, entry } = await setup();
		await host.actions.plugin.updateSettings({ apiKey: "rk_test", aspectRatio: "16:9", targetDuration: 30 });
		await host.http.respond(RENDER_URL, json({ success: 1, pid: "p_test" }));

		const response = await host.admin.invokeEditorAction("make-video", "posts", entry.id);
		expect(response.toast?.type).toBe("success");

		const [request] = host.http.requests();
		expect(request.url).toBe(RENDER_URL);
		expect(request.method).toBe("POST");
		expect(request.headers.key).toBe("rk_test");
		const payload = JSON.parse(new TextDecoder().decode(request.body));
		expect(payload.workflow).toBe("prompt-to-video");
		expect(payload.source.prompt).toContain("Ten ways to grow a newsletter");
		expect(payload.source.prompt).toContain("Start with one clear promise.");
		expect(payload.aspectRatio).toBe("16:9");
		expect(payload.options.targetDuration).toBe(30);

		const stored = await host.inspect.storage.get<Record<string, unknown>>("videos", `posts:${entry.id}`);
		expect(stored).toMatchObject({ pid: "p_test", status: "generating", title: "Ten ways to grow a newsletter" });
		const tasks = await host.inspect.scheduledTasks();
		expect(JSON.stringify(tasks)).toContain(`check_posts_${entry.id}`);

		await host.http.respond(STATUS_URL, json({ success: 1, status: "ready", videoUrl: "https://cdn.revid.ai/v/test.mp4" }));
		const panel = await host.admin.actEditorPanel("video", "posts", entry.id, "refresh_one");
		expect(JSON.stringify(panel.blocks)).toContain("https://cdn.revid.ai/v/test.mp4");
		expect(await host.inspect.storage.get("videos", `posts:${entry.id}`)).toMatchObject({ status: "ready" });
	});

	it("reports a Revid refusal without saving a video", async () => {
		const { host, entry } = await setup();
		await host.actions.plugin.updateSettings({ apiKey: "rk_test" });
		await host.http.respond(RENDER_URL, json({ success: 0, error: "No active plan" }, 402));

		const response = await host.admin.invokeEditorAction("make-video", "posts", entry.id);
		expect(response.toast).toMatchObject({ type: "error" });
		expect(response.toast?.message).toContain("No active plan");
		expect(await host.inspect.storage.get("videos", `posts:${entry.id}`)).toBeNull();
	});

	it("needs an API key", async () => {
		const { host, entry } = await setup();
		const response = await host.admin.invokeEditorAction("make-video", "posts", entry.id);
		expect(response.toast?.message).toContain("API key");
		expect(host.http.requests()).toHaveLength(0);
	});
});

describe("MCP tools", () => {
	it("starts a video and reads its status", async () => {
		const { host, admin, entry } = await setup();
		await host.actions.plugin.updateSettings({ apiKey: "rk_test" });
		await host.http.respond(RENDER_URL, json({ success: 1, pid: "p_test" }));

		const started = await host.actions.routes.request("mcp/make-video", {
			method: "POST",
			body: { collection: "posts", id: entry.id },
			headers: { "x-emdash-request": "1" },
			user: admin,
		});
		expect(started.status).toBe(200);
		expect(JSON.stringify(await started.json())).toContain("https://www.revid.ai/editor/p_test");

		await host.http.respond(STATUS_URL, json({ success: 1, status: "generating", progress: 0.4 }));
		const status = await host.actions.routes.request("mcp/video-status", {
			method: "POST",
			body: { collection: "posts", id: entry.id },
			headers: { "x-emdash-request": "1" },
			user: admin,
		});
		expect(JSON.stringify(await status.json())).toContain("Making");
	});
});

describe("automatic videos", () => {
	it("makes one video when a post is published", async () => {
		const { host, entry } = await setup();
		await host.actions.plugin.updateSettings({ apiKey: "rk_test", autoVideo: true });
		await host.http.respond(RENDER_URL, json({ success: 1, pid: "p_test" }));

		const published = await host.actions.content.publish("posts", entry.id);
		expect(published.success).toBe(true);
		await host.waitForDeferredTasks();

		const renders = host.http.requests().filter((request) => request.url === RENDER_URL);
		expect(renders).toHaveLength(1);
		const payload = JSON.parse(new TextDecoder().decode(renders[0].body));
		expect(payload.workflow).toBe("article-to-video");
		expect(payload.source.url).toBe(await host.inspect.content.publicUrl("posts", entry.id));
		expect(payload.source.url).toContain("grow-a-newsletter");
		expect(await host.inspect.storage.get("videos", `posts:${entry.id}`)).toMatchObject({ pid: "p_test" });
	});

	it("stays off by default", async () => {
		const { host, entry } = await setup();
		await host.actions.plugin.updateSettings({ apiKey: "rk_test" });
		await host.actions.content.publish("posts", entry.id);
		await host.waitForDeferredTasks();
		expect(host.http.requests()).toHaveLength(0);
	});
});
