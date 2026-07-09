import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone output for the Docker image (Dockerfile copies .next/standalone).
  output: "standalone",
};

export default nextConfig;
