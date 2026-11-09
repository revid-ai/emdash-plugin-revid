/**
 * Builds the text Revid writes the video from when an entry has no public URL
 * yet: the title, then the plain text of its string and Portable Text fields.
 */

const MAX_PROMPT_CHARS = 4000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Plain text of a Portable Text array: one line per block. */
export function portableTextToPlain(value: unknown): string {
	if (!Array.isArray(value)) return "";
	const lines: string[] = [];
	for (const block of value) {
		if (!isRecord(block) || block._type !== "block" || !Array.isArray(block.children)) continue;
		const line = block.children
			.map((child) => (isRecord(child) && typeof child.text === "string" ? child.text : ""))
			.join("")
			.trim();
		if (line) lines.push(line);
	}
	return lines.join("\n");
}

export function entryTitle(data: Record<string, unknown>): string {
	for (const key of ["title", "name", "headline"]) {
		const value = data[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return "";
}

/** The title and body text of an entry, trimmed to what a prompt can carry. */
export function entryText(data: Record<string, unknown>): string {
	const title = entryTitle(data);
	const parts: string[] = [];
	for (const [key, value] of Object.entries(data)) {
		if (key === "title" || key.startsWith("_")) continue;
		const plain = Array.isArray(value) ? portableTextToPlain(value) : "";
		if (plain) parts.push(plain);
		else if (typeof value === "string" && value.length > 40 && !/^https?:\/\//.test(value)) parts.push(value.trim());
	}
	const body = parts.join("\n\n");
	return `${title}\n\n${body}`.trim().slice(0, MAX_PROMPT_CHARS);
}
