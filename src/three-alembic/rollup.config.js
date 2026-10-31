import { createLibraryConfigs } from '../../rollup.shared.js';

export default createLibraryConfigs({
  name: 'three-alembic',
  external: ['three', /^three\//, 'alembic'],
});
