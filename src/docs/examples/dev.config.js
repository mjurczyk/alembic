import { defineConfig } from 'vite';
import { inlineWorker } from '../../../rollup.shared.js';

// NOTE VITE_RENDERER=webgl runs the examples with WebGLRenderer and three-alembic/webgl
const useWebGLRenderer = process.env.VITE_RENDERER === 'webgl';

export default defineConfig({
  plugins: [inlineWorker()],
  // NOTE Own dependency cache. Then both dev servers can run at the same time.
  cacheDir: useWebGLRenderer ? 'node_modules/.vite-webgl' : 'node_modules/.vite',
  resolve: {
    alias: useWebGLRenderer
      ? [{ find: /^three-alembic$/, replacement: 'three-alembic/webgl' }]
      : [],
  },
});
