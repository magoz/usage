import type { NextConfig } from "next";
import { getAllowedDevOrigins } from "./next-dev-origins";

const nextConfig: NextConfig = {
  cacheComponents: true,
  allowedDevOrigins: getAllowedDevOrigins(process.env.PORTLESS_URL),
  experimental: {
    turbopackFileSystemCacheForDev: true,
  },
};

export default nextConfig;
