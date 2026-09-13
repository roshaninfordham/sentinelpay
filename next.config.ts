import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep the dev-mode badge out of the demo recording and screenshots.
  devIndicators: false,
  // The app consumes engine source directly; dist is built only in publish CI.
  transpilePackages: ["@sentinelpay/engine"],
};

export default nextConfig;
