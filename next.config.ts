import type { NextConfig } from "next";

const ALLOWED_ORIGINS = [
  "https://anielab.app",
  "https://www.anielab.app",
  "https://app.anielab.app",
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/api/:path*",
        headers: [
          // Restrict to anielab.app domains (Caddy adds Origin header).
          {
            key: "Access-Control-Allow-Origin",
            value: ALLOWED_ORIGINS.join(","),
          },
          {
            key: "Access-Control-Allow-Methods",
            value: "GET, POST, PATCH, DELETE, OPTIONS",
          },
          {
            key: "Access-Control-Allow-Headers",
            value: "Content-Type, Authorization, X-Admin-Password",
          },
          { key: "Access-Control-Max-Age", value: "86400" },
        ],
      },
    ];
  },
};

export default nextConfig;
