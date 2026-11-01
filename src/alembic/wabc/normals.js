// NOTE Normals that the loader makes (src/wabc/FORMAT.md 6.7). Triangles (a, b, c) are clockwise when seen from
// outside, so (c − a) × (b − a) points outside.

const addFaceNormal = (positions, a, b, c, target) => {
  const acX = positions[c * 3] - positions[a * 3];
  const acY = positions[c * 3 + 1] - positions[a * 3 + 1];
  const acZ = positions[c * 3 + 2] - positions[a * 3 + 2];
  const abX = positions[b * 3] - positions[a * 3];
  const abY = positions[b * 3 + 1] - positions[a * 3 + 1];
  const abZ = positions[b * 3 + 2] - positions[a * 3 + 2];

  target[0] = acY * abZ - acZ * abY;
  target[1] = acZ * abX - acX * abZ;
  target[2] = acX * abY - acY * abX;

  return target;
};

const getTriangles = (index, vertexCount) =>
  index ?? Uint32Array.from({ length: vertexCount }, (_, vertex) => vertex);

const normalize = (normals) => {
  for (let item = 0; item < normals.length; item += 3) {
    const length = Math.hypot(normals[item], normals[item + 1], normals[item + 2]);

    if (length > 0) {
      normals[item] /= length;
      normals[item + 1] /= length;
      normals[item + 2] /= length;
    }
  }

  return normals;
};

// NOTE "smooth": the normalized sum of the face normals of the triangles of each vertex
export const computeSmoothNormals = (positions, index) => {
  const vertexCount = positions.length / 3;
  const triangles = getTriangles(index, vertexCount);
  const sums = new Float64Array(vertexCount * 3);
  const face = [0, 0, 0];

  for (let corner = 0; corner < triangles.length; corner += 3) {
    const a = triangles[corner];
    const b = triangles[corner + 1];
    const c = triangles[corner + 2];

    addFaceNormal(positions, a, b, c, face);

    for (const vertex of [a, b, c]) {
      sums[vertex * 3] += face[0];
      sums[vertex * 3 + 1] += face[1];
      sums[vertex * 3 + 2] += face[2];
    }
  }

  return normalize(Float32Array.from(sums));
};

// NOTE "flat": the face normal at the 3 corners of each triangle. The triangles get their own vertices: the positions
// are copied for each triangle corner, and there is no index.
export const computeFlatNormals = (positions, index) => {
  const triangles = getTriangles(index, positions.length / 3);
  const flatPositions = new Float32Array(triangles.length * 3);
  const normals = new Float32Array(triangles.length * 3);
  const face = [0, 0, 0];

  for (let corner = 0; corner < triangles.length; corner += 3) {
    addFaceNormal(positions, triangles[corner], triangles[corner + 1], triangles[corner + 2], face);

    for (let item = 0; item < 3; item++) {
      const vertex = triangles[corner + item];

      flatPositions.set(positions.subarray(vertex * 3, vertex * 3 + 3), (corner + item) * 3);
      normals.set(face, (corner + item) * 3);
    }
  }

  return { positions: flatPositions, normals: normalize(normals) };
};
