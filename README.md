# Revid for EmDash

Turn your [EmDash](https://emdashcms.com) posts into short videos with [Revid](https://www.revid.ai): a script written from the post, a natural voiceover, captions, visuals and music, ready for TikTok, Instagram Reels, YouTube Shorts and X.

- **From the editor.** Open a saved entry, choose **Make a Revid video** in its menu, and follow the render in the **Revid video** panel.
- **On publish.** Turn on automatic videos and each newly published post gets one video.
- **For your site's AI agent.** The plugin exposes two MCP tools, `make_video` and `video_status`, once an administrator enables them.

A published entry is summarized from its public page (Revid's `article-to-video` workflow). A draft is sent as text (`prompt-to-video`). Videos render in your Revid account, where you can edit, export and schedule them.

## Install

1. In your EmDash admin, open the plugin registry, search for **Revid**, and approve its permissions:
   - read content (to send the entry to Revid);
   - network requests to `www.revid.ai` only.
2. Open **Revid videos** and paste an API key from [revid.ai/account](https://www.revid.ai/account) (API tab). Making videos needs a Revid plan and uses its credits. The key is stored encrypted.
3. Pick the aspect ratio (9:16, 16:9 or 1:1) and the target length, and turn on automatic videos if you want them.

## What it stores and sends

- One record per entry in the plugin's `videos` collection: the Revid project ID, status and video URL.
- Requests go to the [Revid public API](https://www.revid.ai/docs) (`/api/public/v3/render` and `/status`) with your API key. Nothing else leaves your site.
- A cron task checks a render every two minutes until it is ready or failed (at most 20 checks).

## Develop

```sh
pnpm install
pnpm run validate
pnpm run typecheck
pnpm run test     # builds and runs the plugin in workerd through EmDash's sandbox bridge
pnpm run bundle
```

## Publish

```sh
pnpm run login -- tmaker.io
pnpm run publish
```

The manifest pins the publisher DID. A login to another account fails with `MANIFEST_PUBLISHER_MISMATCH`.

## License

MIT
