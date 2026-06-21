/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // pg + aws-sdk are server-only; keep them external to the serverless bundle.
  experimental: { serverComponentsExternalPackages: ['pg', '@aws-sdk/dsql-signer'] },
};
module.exports = nextConfig;
