// web/vite.config.ts
import { defineConfig } from "vite";

export default defineConfig(() => {
  const repo = process.env.GITHUB_REPOSITORY?.split("/")[1]; // "<OWNER>/<REPO>"
  return {
    base: repo ? `/${repo}/` : "/", // GitHub Actions -> /<REPO>/, local dev -> /
  };
});
