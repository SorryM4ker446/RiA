import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { ApiError } from "@/lib/server/api-error";

export function credentialEncryptionAvailable() {
  return /^[A-Za-z0-9+/]{43}=$/.test(process.env.RIA_EXTENSION_KEY ?? "");
}

function key() {
  if (!credentialEncryptionAvailable()) throw new ApiError({ code: "CONFIGURATION_ERROR", message: "扩展凭据加密不可用。请使用桌面应用，或为本地服务配置 RIA_EXTENSION_KEY。" });
  return Buffer.from(process.env.RIA_EXTENSION_KEY!, "base64");
}

export function encryptCredentials(id: string, credentials: Record<string, string>): string | null {
  if (!Object.keys(credentials).length) return null;
  const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key(), nonce);
  cipher.setAAD(Buffer.from(id));
  const data = Buffer.concat([cipher.update(JSON.stringify(credentials), "utf8"), cipher.final()]);
  return ["v1", nonce.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(":");
}

export function decryptCredentials(id: string, encrypted: string | null): Record<string, string> {
  if (!encrypted) return {};
  try {
    const [version, nonce, tag, data] = encrypted.split(":");
    if (version !== "v1" || !nonce || !tag || !data) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(nonce, "base64"));
    decipher.setAAD(Buffer.from(id)); decipher.setAuthTag(Buffer.from(tag, "base64"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8"));
  } catch {
    throw new ApiError({ code: "CONFIGURATION_ERROR", message: "无法解密扩展凭据，请重新配置。" });
  }
}
