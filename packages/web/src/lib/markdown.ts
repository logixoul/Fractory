import DOMPurify from "dompurify";
import { marked } from "marked";

let hooked = false;

/** Markdown → sanitized HTML. Model output is untrusted: DOMPurify always runs. */
export function renderMarkdown(md: string): string {
  if (!hooked) {
    DOMPurify.addHook("afterSanitizeAttributes", (node) => {
      if (node.tagName === "A") {
        node.setAttribute("rel", "noopener noreferrer");
        node.setAttribute("target", "_blank");
      }
    });
    hooked = true;
  }
  const html = marked.parse(md, { async: false, gfm: true });
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, FORBID_TAGS: ["style", "form", "input", "img"] });
}
