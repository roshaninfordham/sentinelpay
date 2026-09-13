import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep the dev-mode badge out of the demo recording and screenshots.
  devIndicators: false,
  // The app consumes engine source directly; dist is built only in publish CI.
  transpilePackages: ["payfirewall"],
  // Hosts that are never framed and only share the origin when navigating away. The microphone stays available to
  // this origin for the live vendor call; camera and location are never requested.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "microphone=(self), camera=(), geolocation=()" },
        ],
      },
      {
        // The approval link is a bearer credential in the URL fragment: send no referrer from it at all.
        source: "/approve/:challengeId",
        headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
      },
    ];
  },
};

export default nextConfig;
