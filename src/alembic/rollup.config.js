import { createLibraryConfigs } from '../../rollup.shared.js';

// NOTE No external modules. alembic has no dependencies.
export default createLibraryConfigs({ name: 'alembic' });
