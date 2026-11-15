import type { NextConfig } from "next";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

const config: NextConfig = {
  // the engine and signer are TypeScript workspace packages
  transpilePackages: ["@brake/engine", "brake-signer"],
  serverExternalPackages: ["pg", "viem"],
  outputFileTracingRoot: root,
  // the engine reads seed fixtures and deploy records from disk at runtime
  outputFileTracingIncludes: {
    "/api/**": ["../../seed/**/*", "../../evidence/deploy-44005-*.json"],
  },
  poweredByHeader: false,
  // the workspace packages use NodeNext-style "./x.js" imports that point at .ts sources
  webpack: (config) => {
    config.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"] };
    return config;
  },
};
export default config;
