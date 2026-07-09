import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone output for the Docker image and direct VPS deployment (see
  // README's Docker section / .env.example) - copies only the files needed
  // to run into .next/standalone.
  output: "standalone",

  // Pins the file-tracing root to this frontend/ directory itself. Without
  // this, Next.js walks UP the filesystem looking for the nearest lockfile
  // or workspace root to decide where "the project" starts - and this repo
  // has its own package.json at the repo root (for the unrelated Foundry/
  // keeper tooling) one level above frontend/. If a lockfile ever ends up
  // there too (e.g. someone runs `npm install` from the repo root on a
  // shared VPS), Next mistakes the whole monorepo for the project root and
  // nests the standalone output accordingly: server.js lands at
  // .next/standalone/frontend/server.js instead of .next/standalone/
  // server.js, and - critically - .next/standalone/frontend/.next/static
  // instead of .next/standalone/.next/static. Copying static assets to the
  // "normal" (non-nested) path in that situation means every /_next/
  // static/* request 404s and the page renders as unstyled raw HTML with
  // no error - exactly the "CSS/JS not loading" symptom this fixes.
  // Pinning the root here makes the output layout deterministic on every
  // machine (sandbox, CI, Docker, any VPS) regardless of what else exists
  // above this directory.
  outputFileTracingRoot: path.join(__dirname),
};

export default nextConfig;
