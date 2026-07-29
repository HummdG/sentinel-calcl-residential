/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // No ESLint set up for this project; keep `next build` from trying to run it.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
