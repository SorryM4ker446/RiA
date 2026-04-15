import { google } from "@ai-sdk/google";
import { DEFAULT_MODEL } from "@/config/model";

export function getDefaultModel() {
  return google(DEFAULT_MODEL);
}
