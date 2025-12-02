import type { NextConfig } from "next";


const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  
  // Explicitly acknowledge Turbopack (Next.js 16 default) while keeping webpack config for compatibility
  turbopack: {},
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

  // Webpack configuration to handle optional dependencies (replacing Turbopack)
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      // Ignore optional keyv adapters that Ably's dependencies try to load
      '@keyv/redis': false,
      '@keyv/mongo': false,
      '@keyv/sqlite': false,
      '@keyv/postgres': false,
      '@keyv/mysql': false,
      '@keyv/etcd': false,
      '@keyv/offline': false,
      '@keyv/tiered': false,
    };
    return config;
  },
};

export default nextConfig;
