import type { NextConfig } from "next";
import { MEDIA_LIMITS } from "./src/lib/media/limits";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
  // Leave room for handlers to detect overflow before Proxy truncates a network chunk.
  experimental: { proxyClientMaxBodySize: MEDIA_LIMITS.uploadBodyBytes + 1024 * 1024 },
};

export default nextConfig;
