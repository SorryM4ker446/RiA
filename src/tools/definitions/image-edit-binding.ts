import { assetIdFromUrl, mediaUrl } from "@/lib/media/message-codec";
import { conversationImageIds, recentConversationImages, type ConversationImageScope } from "@/lib/media/conversation-images";
import { resolveImageInputs } from "@/lib/media/messages";
import { openMediaAsset } from "@/lib/media/storage";
import { ApiError } from "@/lib/server/api-error";
import type { ToolApprovalRefusal } from "@/tools/types";
import type { GenerateImageInput } from "./generate-image";

type ImageEditRequest = { text: string; files: readonly { url: string; mediaType: string; filename?: string }[] };
type Picture = { mediaId: string; name?: string };

const missingOriginal = "No picture was made. Ask the user to identify or attach the original image before editing it.";
const previousPicture = /\b(?:last|previous|latest|this|that) (?:image|photo|picture|illustration|one)\b|上一张|前一张|刚才的?(?:那张|图|照片)|这张(?:图|照片)|那张(?:图|照片)|换背景/iu;
const originalPicture = /\b(?:the|from|on|with|use) original(?: (?:image|photo|picture|one))?\b|原图/iu;
const pictureSelection = /\b(first|second|third|fourth|fifth|sixth|left|right)\s+(?:image|photo|picture|illustration|one)\b|第([一二三四五六1-6])张|(左|右)边(?:的|那)?(?:一张|张|图|照片)/giu;
const positions = ["first", "second", "third", "fourth", "fifth", "sixth"];
const allPictures = /\b(?:both|all) (?:of the |the )?(?:attached |reference )?(?:images|photos|pictures|ones)\b|\b(?:both|all of them)\b|全部|所有|每张|都(?:改|修|换|圈|加)|(?:两|三|四|五|六)张(?:都|一起|合成)/iu;

// Only the user's words are consulted here, never instructions in a picture or tool result.
function asksForImageEdit(text = "") {
  const namedEdit = /\b(?:edit|retouch|redraw|rework|modify|recolor|update|revise|change|remake)\b[^\n.!?]{0,70}\b(?:image|photo|picture|illustration|background|original|reference|last one|previous one)\b|\b(?:based on|using|use)\b[^\n.!?]{0,55}\b(?:image|photo|picture|original|reference)\b|\bmake (?:its|the) (?:background|foreground)\b|\b(?:make|turn) (?:it|this|that|the previous one) (?:into|more|less|look)\b|(?:改图|修图|重绘|重画|换背景|换成夜景)|(?:基于|参考|沿用|用)(?:这|那|上|刚|附|前|原|同)[^，。！？\n]{0,16}(?:图|照片)|(?:这张|那张|上一张|前一张|原图|附图|图片|照片)[^，。！？\n]{0,22}(?:改|修|换|重做|调整|变成)|(?:改|修|换|调整)[^，。！？\n]{0,14}(?:这张图|原图|上一张|照片)/iu;
  const localEdit = /\b(?:add|remove|erase|circle|highlight|move)\b[^.!?\n]{0,85}\b(?:corner|edge|foreground|background)\b|\b(?:keep|leave)\b[^.!?\n]{0,70}\bunchanged\b|(?:左上|右上|左下|右下|四个)角[^，。！？\n]{0,18}(?:加|圈|涂|抹|去掉|删除|标注|画)|(?:编号|构图|人物|背景|原样|尺寸|其他|其余)[^，。！？\n]{0,12}(?:保持不变|维持不变|不要变|别改|不动)/iu;
  return namedEdit.test(text) || localEdit.test(text);
}

function asksForNewImage(text: string) {
  return /\b(?:draw|generate|create|design|render|paint|sketch)\b|\b(?:make|produce|need|want) (?:me )?(?:a|an|one|another|a new) (?:image|picture|photo|illustration|drawing|poster|logo|sketch)\b|(?:画|绘制|生成|制作|设计|创作)(?:一|个|幅|张|只|座|些|图|图片|海报|插画)|(?:请|帮我|给我|再)画|(?:给我|我想要|我需要)一(?:张|幅)[^，。！？\n]{0,32}(?:插画|海报|图片|照片|概念图|设计图|配图)/iu.test(text);
}

function selectPictures(pictures: Picture[], text: string) {
  const selected: string[] = [];
  for (const match of text.matchAll(pictureSelection)) {
    const order = match[1]?.toLowerCase();
    const index = order === "left" || match[3] === "左" ? 0
      : order === "right" || match[3] === "右" ? pictures.length - 1
      : order ? positions.indexOf(order) : /^[1-6]$/.test(match[2]) ? Number(match[2]) - 1 : "一二三四五六".indexOf(match[2]);
    if (!pictures[index] || ((order === "left" || order === "right" || match[3]) && pictures.length !== 2)) return [];
    selected.push(pictures[index].mediaId);
  }
  const lower = text.toLowerCase();
  for (const picture of pictures) if (picture.name && lower.includes(picture.name.toLowerCase())) selected.push(picture.mediaId);
  if (selected.length) return [...new Set(selected)];
  if (pictures.length === 1 || allPictures.test(text)) return pictures.map(picture => picture.mediaId);
  return [];
}

export async function checkImageEdit(input: GenerateImageInput, chatId?: string | null, userText?: string, scope?: ConversationImageScope) {
  const refs = [...new Set(input.referenceImages ?? [])];
  if (!refs.length) return input.operation === "edit" || asksForImageEdit(userText) ? missingOriginal : null;
  if (!chatId || (await conversationImageIds(chatId, refs, scope)).size !== refs.length) return "No picture was made. One or more reference images are unavailable in this conversation. Ask the user to select or attach the original again.";
  try {
    const assets = await resolveImageInputs(refs.map(id => ({ url: mediaUrl(id) })));
    for (const asset of assets) {
      const handle = await openMediaAsset(asset);
      await handle.close();
    }
  }
  catch { return "No picture was made. The references exceed the image input limits or can no longer be read. Ask the user to select a valid reference."; }
  try { await (await import("@/lib/media/generation")).generationModels("image", true); }
  catch { return "No picture was made. Check that the selected image model or its fallback can accept reference images."; }
  return null;
}

/** Bind from the user's attachments or words before the call can be approved. */
export async function bindImageEdit(input: GenerateImageInput, chatId?: string | null, request?: ImageEditRequest, scope?: ConversationImageScope): Promise<ToolApprovalRefusal | void> {
  const text = request?.text ?? "";
  const supplied = input.referenceImages ?? [];
  const explicit = new Map<string, Picture>();
  for (const file of request?.files ?? []) {
    const mediaId = file.mediaType.startsWith("image/") && assetIdFromUrl(file.url);
    if (mediaId && !explicit.has(mediaId)) explicit.set(mediaId, { mediaId, name: file.filename });
  }
  const standalone = asksForNewImage(text);
  const relative = previousPicture.test(text);
  const original = originalPicture.test(text);
  const images = request && chatId && (relative || original || (!standalone && !supplied.length))
    ? await recentConversationImages(chatId, scope?.through) : [];
  const dependsOnPicture = input.operation === "edit" || supplied.length > 0 || asksForImageEdit(text) || relative || original
    || (!standalone && (explicit.size > 0 || images.length > 0));
  if (dependsOnPicture) {
    input.operation = "edit";
    if (explicit.size) {
      input.referenceImages = selectPictures([...explicit.values()], text);
    } else if (relative) {
      const latest = images.filter(image => image.messageId === images[0]?.messageId);
      input.referenceImages = selectPictures(latest, text);
    } else if (original && images.length === 1) {
      input.referenceImages = [images[0].mediaId];
    }
  }
  const issue = await checkImageEdit(input, chatId, text, scope);
  if (issue && input.referenceImages?.length) return { error: new ApiError({ code: "VALIDATION_ERROR", message: issue }) };
  if (issue) return { output: { skipped: "referenceRequired", note: issue } };
}
