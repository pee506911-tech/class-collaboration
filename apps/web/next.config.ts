import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  reactStrictMode: false, // Disable strict mode to prevent double-mounting in dev (causes connection leaks)

  // Security headers
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'X-Frame-Options',
            value: 'DENY',
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
          },
          {
            key: 'X-XSS-Protection',
            value: '1; mode=block',
          },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
          },
        ],
      },
    ];
  },

  // Ensure both roots match for monorepo support
  outputFileTracingRoot: path.join(__dirname, '../..'),

  // Turbopack configuration to handle optional dependencies
  turbopack: {
    root: path.join(__dirname, '../..'), // Point to monorepo root for workspace support
    resolveAlias: {
      // Ignore optional keyv adapters that Ably's dependencies try to load
      // These are Node.js-only optional dependencies not needed in browser
      // Using empty path to prevent resolution
      '@keyv/redis': './empty.js',
      '@keyv/mongo': './empty.js',
      '@keyv/sqlite': './empty.js',
      '@keyv/postgres': './empty.js',
      '@keyv/mysql': './empty.js',
      '@keyv/etcd': './empty.js',
      '@keyv/offline': './empty.js',
      '@keyv/tiered': './empty.js',
    },
  },
};

export default nextConfig;
