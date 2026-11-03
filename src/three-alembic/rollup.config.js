import { createLibraryConfigs } from '../../rollup.shared.js';

export default createLibraryConfigs({
  name: 'three-alembic',
  external: ['three', /^three\//, 'alembic-web'],
  // NOTE webgl is the WebGLRenderer entry point (three-alembic/webgl)
  entries: ['index', 'webgl'],
});
