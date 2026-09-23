import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Test files share the JSON stores under ./data; parallel files race on read-modify-write.
  test: { fileParallelism: false },
});
