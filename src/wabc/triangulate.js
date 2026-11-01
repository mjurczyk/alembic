// NOTE Faces to triangles (FORMAT.md 8.4). A face with n corners gives n − 2 triangles.
// Each triangle keeps the corner order of its face. The output has face corner indices.

const getPoint = (faceIndices, corner) => faceIndices[corner] * 3;

// NOTE Newell normal of the face
const getFaceNormal = (positions, faceIndices, start, count) => {
  let x = 0;
  let y = 0;
  let z = 0;

  for (let corner = 0; corner < count; corner++) {
    const a = getPoint(faceIndices, start + corner);
    const b = getPoint(faceIndices, start + ((corner + 1) % count));

    x += (positions[a + 1] - positions[b + 1]) * (positions[a + 2] + positions[b + 2]);
    y += (positions[a + 2] - positions[b + 2]) * (positions[a] + positions[b]);
    z += (positions[a] - positions[b]) * (positions[a + 1] + positions[b + 1]);
  }

  return [x, y, z];
};

const isConvex = (positions, faceIndices, start, count, normal) => {
  for (let corner = 0; corner < count; corner++) {
    const a = getPoint(faceIndices, start + corner);
    const b = getPoint(faceIndices, start + ((corner + 1) % count));
    const c = getPoint(faceIndices, start + ((corner + 2) % count));
    const abX = positions[b] - positions[a];
    const abY = positions[b + 1] - positions[a + 1];
    const abZ = positions[b + 2] - positions[a + 2];
    const bcX = positions[c] - positions[b];
    const bcY = positions[c + 1] - positions[b + 1];
    const bcZ = positions[c + 2] - positions[b + 2];
    const turn =
      (abY * bcZ - abZ * bcY) * normal[0] +
      (abZ * bcX - abX * bcZ) * normal[1] +
      (abX * bcY - abY * bcX) * normal[2];

    if (turn < 0) {
      return false;
    }
  }

  return true;
};

const cross2 = (a, b, c) => (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);

// NOTE True if "p" is in the triangle a, b, c or on its edges. "sign" is the turn of the face.
const isInTriangle = (p, a, b, c, sign) =>
  sign * cross2(a, b, p) >= 0 && sign * cross2(b, c, p) >= 0 && sign * cross2(c, a, p) >= 0;

// NOTE Ear clipping in the plane of the face. The remaining corners give a fan if no ear is found.
const clipEars = (positions, faceIndices, start, count, normal, out, offset) => {
  const absolute = normal.map(Math.abs);
  const [u, v] =
    absolute[0] >= absolute[1] && absolute[0] >= absolute[2]
      ? [1, 2]
      : absolute[1] >= absolute[2]
      ? [2, 0]
      : [0, 1];
  const points = [];

  for (let corner = 0; corner < count; corner++) {
    const point = getPoint(faceIndices, start + corner);

    points.push([positions[point + u], positions[point + v]]);
  }

  let area = 0;

  for (let corner = 0; corner < count; corner++) {
    const [ax, ay] = points[corner];
    const [bx, by] = points[(corner + 1) % count];

    area += ax * by - bx * ay;
  }

  const sign = Math.sign(area);
  const remaining = [...Array(count).keys()];
  let position = offset;
  const addTriangle = (a, b, c) => {
    out[position++] = start + a;
    out[position++] = start + b;
    out[position++] = start + c;
  };

  while (remaining.length > 3) {
    let clipped = false;

    for (let item = 0; item < remaining.length; item++) {
      const previous = remaining[(item + remaining.length - 1) % remaining.length];
      const current = remaining[item];
      const next = remaining[(item + 1) % remaining.length];
      const [a, b, c] = [points[previous], points[current], points[next]];

      if (sign === 0 || sign * cross2(a, b, c) <= 0) {
        continue;
      }

      const blocked = remaining.some(
        (other) =>
          other !== previous &&
          other !== current &&
          other !== next &&
          isInTriangle(points[other], a, b, c, sign)
      );

      if (!blocked) {
        addTriangle(previous, current, next);
        remaining.splice(item, 1);
        clipped = true;
        break;
      }
    }

    if (!clipped) {
      break;
    }
  }

  for (let item = 1; item < remaining.length - 1; item++) {
    addTriangle(remaining[0], remaining[item], remaining[item + 1]);
  }

  return position;
};

// NOTE Fan from corner 0 for convex faces, triangles and faces without area. Ear clipping for concave faces.
export const triangulateFaces = (positions, faceIndices, faceCounts) => {
  let numTriangles = 0;
  let onlyTriangles = true;

  for (const count of faceCounts) {
    numTriangles += Math.max(count - 2, 0);
    onlyTriangles = onlyTriangles && count === 3;
  }

  const triangles = new Uint32Array(numTriangles * 3);

  if (onlyTriangles) {
    for (let corner = 0; corner < triangles.length; corner++) {
      triangles[corner] = corner;
    }

    return triangles;
  }

  let start = 0;
  let offset = 0;

  for (const count of faceCounts) {
    if (count > 3) {
      const normal = getFaceNormal(positions, faceIndices, start, count);
      const hasArea = normal.some((value) => value !== 0);

      if (hasArea && !isConvex(positions, faceIndices, start, count, normal)) {
        offset = clipEars(positions, faceIndices, start, count, normal, triangles, offset);
        start += count;
        continue;
      }
    }

    for (let corner = 1; corner < count - 1; corner++) {
      triangles[offset++] = start;
      triangles[offset++] = start + corner;
      triangles[offset++] = start + corner + 1;
    }

    start += Math.max(count, 0);
  }

  return triangles;
};
