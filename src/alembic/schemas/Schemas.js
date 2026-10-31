import { Points } from './Points.js';
import { PolyMesh } from './PolyMesh.js';
import { Xform } from './Xform.js';

// NOTE Key is the "schema" value of the object metadata (FORMAT.md 3.1).
// Other schemas (FORMAT.md section 5) are skipped. Their children are still read.
const schemaClasses = {
  AbcGeom_PolyMesh_v1: PolyMesh,
  AbcGeom_Xform_v3: Xform,
  AbcGeom_Points_v1: Points,
};

export const createSchema = (object) => {
  const SchemaClass = schemaClasses[object.metadata.schema];

  return SchemaClass ? new SchemaClass(object) : null;
};
