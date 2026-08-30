import { readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  OPENROUTER_MODELS, OPENROUTER_IMAGE_MODELS, OPENROUTER_VIDEO_MODELS,
  DEFAULT_MODEL, DEFAULT_IMAGE_MODEL, DEFAULT_VIDEO_MODEL, MODEL_CATALOG_REVISION,
} from "../src/config/model.ts";

export const catalogGroups = [
  { mode: "chat", output: "text", models: OPENROUTER_MODELS, defaultId: DEFAULT_MODEL },
  { mode: "image", output: "image", models: OPENROUTER_IMAGE_MODELS, defaultId: DEFAULT_IMAGE_MODEL },
  { mode: "video", output: "video", models: OPENROUTER_VIDEO_MODELS, defaultId: DEFAULT_VIDEO_MODEL },
];
const modelSchema = z.strictObject({
  id: z.string().min(3).max(200).regex(/^[\w.-]+\/[\w.:-]+$/),
  label: z.string().trim().min(1), description: z.string().trim().min(1), supportsImageInput: z.boolean(),
});

export function checkCatalog(groups = catalogGroups) {
  z.iso.date().parse(MODEL_CATALOG_REVISION);
  for (const group of groups) {
    const models = z.array(modelSchema).min(1).parse(group.models);
    if (new Set(models.map((model) => model.id)).size !== models.length) throw new Error(`Duplicate ${group.mode} model ID`);
    if (!models.some((model) => model.id === group.defaultId)) throw new Error(`Missing ${group.mode} default model`);
  }
}

export function compareCatalogSnapshot(snapshot, groups = catalogGroups) {
  const parsed = z.object({ data: z.array(z.object({
    id: z.string(), architecture: z.object({ input_modalities: z.array(z.string()), output_modalities: z.array(z.string()) }).optional(),
  })).max(20_000) }).parse(snapshot);
  const available = new Map(parsed.data.map((model) => [model.id, model]));
  return groups.flatMap((group) => group.models.flatMap((model) => {
    const remote = available.get(model.id);
    const reason = !remote ? "missing-from-snapshot" : !remote.architecture ? "capabilities-unavailable"
      : !remote.architecture.output_modalities.includes(group.output) ? "output-capability-changed"
        : remote.architecture.input_modalities.includes("image") !== model.supportsImageInput ? "image-input-capability-changed" : null;
    return reason ? [{ mode: group.mode, id: model.id, reason }] : [];
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== "--snapshot")) throw new Error("Usage: npm run models:check -- [--snapshot path-to-models.json]");
    checkCatalog();
    console.log(`Model catalog ${MODEL_CATALOG_REVISION}: local structure and explicit defaults are valid.`);
    if (args.length) {
      if (statSync(args[1]).size > 16 * 1024 * 1024) throw new Error("Model snapshot exceeds 16 MiB");
      const issues = compareCatalogSnapshot(JSON.parse(readFileSync(args[1], "utf8")));
      console.log(JSON.stringify({ reviewRequired: issues }, null, 2));
      if (issues.length) process.exitCode = 1;
    } else console.log("Provider availability was not checked. Supply a saved provider snapshot for comparison.");
  } catch (error) {
    console.error(error instanceof z.ZodError || error instanceof SyntaxError ? "Invalid model catalog or snapshot schema" : error.message);
    process.exitCode = 1;
  }
}
