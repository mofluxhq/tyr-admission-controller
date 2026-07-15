import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only run TypeScript sources under test/. Excluding dist/ prevents
    // stale compiled test artifacts from being executed (and double-run)
    // whenever a build has produced dist/test/*.js.
    include: ["test/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
  },
});
