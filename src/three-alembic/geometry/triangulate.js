import * as Three from 'three';

const contourPool = [];
const normal = new Three.Vector3();

// NOTE Newell normal of the face. It points to the side from which the corners go counter-clockwise.
const getFaceNormal = (positions, faceIndices, start, count) => {
  normal.set(0, 0, 0);

  for (let corner = 0; corner < count; corner++) {
    const a = faceIndices[start + corner] * 3;
    const b = faceIndices[start + ((corner + 1) % count)] * 3;

    normal.x += (positions[a + 1] - positions[b + 1]) * (positions[a + 2] + positions[b + 2]);
    normal.y += (positions[a + 2] - positions[b + 2]) * (positions[a] + positions[b]);
    normal.z += (positions[a] - positions[b]) * (positions[a + 1] + positions[b + 1]);
  }

  return normal;
};

const isConvex = (positions, faceIndices, start, count) => {
  for (let corner = 0; corner < count; corner++) {
    const a = faceIndices[start + corner] * 3;
    const b = faceIndices[start + ((corner + 1) % count)] * 3;
    const c = faceIndices[start + ((corner + 2) % count)] * 3;
    const abX = positions[b] - positions[a];
    const abY = positions[b + 1] - positions[a + 1];
    const abZ = positions[b + 2] - positions[a + 2];
    const bcX = positions[c] - positions[b];
    const bcY = positions[c + 1] - positions[b + 1];
    const bcZ = positions[c + 2] - positions[b + 2];
    const turn =
      (abY * bcZ - abZ * bcY) * normal.x +
      (abZ * bcX - abX * bcZ) * normal.y +
      (abX * bcY - abY * bcX) * normal.z;

    if (turn < 0) {
      return false;
    }
  }

  return true;
};

// NOTE Ear clipping of a concave face, in the plane of the face. Gives null if it does not give count - 2 triangles.
const clipEars = (positions, faceIndices, start, count) => {
  const absX = Math.abs(normal.x);
  const absY = Math.abs(normal.y);
  const absZ = Math.abs(normal.z);
  const [u, v] = absX >= absY && absX >= absZ ? [1, 2] : absY >= absZ ? [2, 0] : [0, 1];

  while (contourPool.length < count) {
    contourPool.push(new Three.Vector2());
  }

  const contour = contourPool.slice(0, count);

  contour.forEach((point, corner) => {
    const position = faceIndices[start + corner] * 3;

    point.set(positions[position + u], positions[position + v]);
  });

  const faceArea = Three.ShapeUtils.area(contour);
  const triangles = Three.ShapeUtils.triangulateShape(contour, []);

  if (triangles.length !== count - 2) {
    return null;
  }

  // NOTE Earcut can change the corner order. Each triangle must turn the same way as the face.
  return triangles.map((triangle) => {
    const area = Three.ShapeUtils.area(triangle.map((corner) => contourPool[corner]));

    return Math.sign(area) === Math.sign(faceArea)
      ? triangle
      : [triangle[0], triangle[2], triangle[1]];
  });
};

// NOTE Yields after each part of the work (see runProgressive). Returns 3 face corners (positions in faceIndices) for each triangle.
// Alembic faces are clockwise, three.js front faces are counter-clockwise (FORMAT.md 3.2). Each triangle is reversed.
export function* triangulateFaces(positions, faceIndices, faceCounts) {
  let numTriangles = 0;

  for (const count of faceCounts) {
    numTriangles += Math.max(count - 2, 0);
  }

  const triangles = new Uint32Array(numTriangles * 3);
  let start = 0;
  let offset = 0;

  const addTriangle = (a, b, c) => {
    triangles[offset++] = start + a;
    triangles[offset++] = start + c;
    triangles[offset++] = start + b;
  };

  for (let face = 0; face < faceCounts.length; face++) {
    const count = faceCounts[face];
    const clipped =
      count > 3 &&
      getFaceNormal(positions, faceIndices, start, count).lengthSq() > 0 &&
      !isConvex(positions, faceIndices, start, count)
        ? clipEars(positions, faceIndices, start, count)
        : null;

    if (clipped) {
      clipped.forEach(([a, b, c]) => addTriangle(a, b, c));
    } else {
      // NOTE Convex faces, triangles, and faces that ear clipping cannot split (for example, zero area)
      for (let corner = 1; corner < count - 1; corner++) {
        addTriangle(0, corner, corner + 1);
      }
    }

    start += count;

    if (face % 4096 === 4095) {
      yield;
    }
  }

  return triangles;
}
