import { Readable } from "node:stream";
import { NextRequest } from "next/server";
import { requireRequestUser } from "@/lib/auth/request-user";
import { deleteMediaAsset, getMediaAsset, openMediaAsset } from "@/lib/media/storage";
import { ApiError, createApiErrorResponse } from "@/lib/server/api-error";

type Params = { params: Promise<{ id: string }> };

async function serve(req: NextRequest, context: Params, headOnly: boolean) {
  try {
    const user = await requireRequestUser(req);
    const { id } = await context.params;
    const asset = await getMediaAsset(user.id, id);
    const headers = new Headers({
      "Content-Type": asset.mediaType, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox", "Accept-Ranges": "bytes",
      "Content-Disposition": `${req.nextUrl.searchParams.get("download") === "1" ? "attachment" : "inline"}; filename="${id}.${asset.relativePath.split(".").at(-1)}"`,
    });
    let start = 0, end = asset.byteSize - 1, status = 200;
    const range = req.headers.get("range");
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (match) {
        if (!match[1] && match[2]) start = Math.max(0, asset.byteSize - Number(match[2]));
        else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
      }
      if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= asset.byteSize) {
        throw new ApiError({ code: "RANGE_NOT_SATISFIABLE", message: "Requested media range is not available", headers: { "Content-Range": `bytes */${asset.byteSize}` } });
      }
      status = 206;
      headers.set("Content-Range", `bytes ${start}-${end}/${asset.byteSize}`);
    }
    headers.set("Content-Length", String(end - start + 1));
    const handle = await openMediaAsset(asset);
    if (headOnly) { await handle.close(); return new Response(null, { status, headers }); }
    const stream = handle.createReadStream({ start, end, autoClose: true });
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status, headers });
  } catch (error) {
    const response = createApiErrorResponse(error, "Failed to read media");
    return headOnly ? new Response(null, { status: response.status, headers: response.headers }) : response;
  }
}

export const GET = (req: NextRequest, context: Params) => serve(req, context, false);
export const HEAD = (req: NextRequest, context: Params) => serve(req, context, true);

export async function DELETE(req: NextRequest, context: Params) {
  try {
    const user = await requireRequestUser(req);
    const { id } = await context.params;
    return Response.json({ data: { freedBytes: await deleteMediaAsset(user.id, id) } });
  } catch (error) { return createApiErrorResponse(error, "Failed to delete media"); }
}
