import { writeToClipboard } from "@/lib/clipboard";
import type { MessageKey } from "@/lib/locale/zh-CN";
import { IMAGE_MEDIA_TYPES, MEDIA_LIMITS } from "@/lib/media/limits";

const ignoredContent = "[data-chat-copy-ignore], .answer-fold-toggle, .code-block-head, .chat-picture-actions";
const imageType = (type: string) => (IMAGE_MEDIA_TYPES as readonly string[]).includes(type);

export function capturedSelection(selection: Selection, range: Range, body: HTMLElement) {
  const content = document.createElement("template");
  const withinBody = body.contains(range.commonAncestorContainer);
  if (withinBody) content.content.append(range.cloneContents());
  else {
    // A drag can span several messages, or start outside the transcript. Copy
    // the selected body fragments in order and leave the surrounding UI out.
    const bodies = body.closest(".chat-transcript")?.querySelectorAll("[data-chat-copy-body]") ?? [body];
    for (const selected of bodies) {
      if (!range.intersectsNode(selected)) continue;
      const part = range.cloneRange();
      if (!selected.contains(part.startContainer)) part.setStart(selected, 0);
      if (!selected.contains(part.endContainer)) part.setEnd(selected, selected.childNodes.length);
      if (part.collapsed) continue;
      if (content.content.childNodes.length) content.content.append(document.createElement("br"));
      content.content.append(part.cloneContents());
    }
  }
  const hasControls = content.content.querySelector(ignoredContent) !== null;
  content.content.querySelectorAll(ignoredContent).forEach(node => node.remove());
  for (const button of content.content.querySelectorAll("button")) button.replaceWith(...button.childNodes);

  // Preserve rendered line breaks. When a selection spans controls, omit their
  // text and derive the breaks from the remaining prose and code structure.
  const plain = withinBody && !hasControls ? selection.toString() : proseText(content.content).replace(/^\n+|\n+$/g, "");
  return { content, plain, hasImages: content.content.querySelector("img") !== null };
}

function proseText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (node instanceof HTMLBRElement) return "\n";
  if (node instanceof HTMLElement && node.matches("pre")) return `\n${node.textContent}\n`;
  if (node instanceof HTMLTableRowElement) {
    return Array.from(node.cells, cell => proseText(cell).replace(/\n+$/, "")).join("\t") + "\n";
  }
  const text = Array.from(node.childNodes, proseText).join("");
  return node instanceof HTMLElement && node.matches("p, li, blockquote, h1, h2, h3, h4, h5, h6") ? `${text}\n` : text;
}

function dataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function clipboardHtml(template: HTMLTemplateElement) {
  for (const image of template.content.querySelectorAll("img")) {
    const source = new URL(image.getAttribute("src") ?? "", location.href);
    // The viewer's sizing hints belong to its layout. Rich-text editors use
    // the clipboard image's own proportions.
    for (const attribute of ["srcset", "sizes", "width", "height", "loading"]) image.removeAttribute(attribute);
    if (source.protocol === "data:") continue;
    if (source.origin !== location.origin && source.protocol === "https:") {
      // An external Markdown image can be referenced by an HTML editor even
      // if its server does not allow this page to read the bytes.
      image.src = source.href;
      continue;
    }
    const response = await fetch(source);
    const blob = await response.blob();
    if (!response.ok || !imageType(blob.type)) throw new Error("Image unavailable");
    image.src = await dataUrl(blob);
  }
  return new Blob([template.innerHTML], { type: "text/html" });
}

export async function copyChatSelection(selection: ReturnType<typeof capturedSelection>) {
  if (!selection.hasImages) {
    // A selection can intentionally consist of spaces or a newline.
    if (selection.plain.trim()) return (await writeToClipboard(selection.plain)) === "copied";
    await navigator.clipboard.writeText(selection.plain);
    return true;
  }
  await navigator.clipboard.write([new ClipboardItem({
    "text/plain": new Blob([selection.plain], { type: "text/plain" }),
    "text/html": clipboardHtml(selection.content),
  })]);
  return true;
}

export async function copyChatImage(image: HTMLImageElement) {
  const png = async () => {
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image unavailable");
    context.drawImage(image, 0, 0);
    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Image unavailable")), "image/png");
    });
  };
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png() })]);
  return true;
}

/** Extract embedded images only. Pasting HTML never downloads or inserts markup. */
export function embeddedClipboardImages(html: string): { files: File[] } | { error: MessageKey } {
  if (!html) return { files: [] };
  if (html.length > Math.ceil(MEDIA_LIMITS.totalAttachmentBytes * 4 / 3) + 1024 * 1024) {
    return /data:image\/(?:png|jpeg|webp|gif);base64,/i.test(html) ? { error: "lib.media.totalAttachmentSize" } : { files: [] };
  }
  const template = document.createElement("template");
  template.innerHTML = html;
  const files: File[] = [];
  let totalBytes = 0;
  for (const image of template.content.querySelectorAll("img")) {
    const value = /^data:(image\/(png|jpeg|webp|gif));base64,([a-z\d+/]+={0,2})$/i.exec(image.getAttribute("src") ?? "");
    if (!value) continue;
    const [, type, extension, encoded] = value;
    if (encoded.length > Math.ceil(MEDIA_LIMITS.attachmentBytes / 3) * 4) return { error: "lib.media.attachmentSize" };
    let bytes: Uint8Array<ArrayBuffer>;
    try { bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0)); } catch { continue; }
    totalBytes += bytes.byteLength;
    if (files.length === MEDIA_LIMITS.attachmentCount) return { error: "lib.media.tooManyAttachments" };
    if (bytes.byteLength > MEDIA_LIMITS.attachmentBytes) return { error: "lib.media.attachmentSize" };
    if (totalBytes > MEDIA_LIMITS.totalAttachmentBytes) return { error: "lib.media.totalAttachmentSize" };
    files.push(new File([bytes], `clipboard-${files.length + 1}.${extension.toLowerCase()}`, { type: type.toLowerCase() }));
  }
  return { files };
}
