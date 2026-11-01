import { WabcCodec, WabcFile, computeSmoothNormals } from 'alembic-web';

// NOTE Jobs of the .wabc workers (WabcWorkers). The same code runs in a worker and, without workers, in the page.
// Results are typed arrays for a BufferGeometry: counter-clockwise triangles, as three.js front faces.

const getTrack = (context, node) => {
  if (!context.tracks.has(node)) {
    context.tracks.set(node, context.file.getGeometry(node));
  }

  return context.tracks.get(node);
};

// NOTE Clockwise triangles (a, b, c) of the .wabc file to (a, c, b). A mesh without an index gets one.
const toCounterClockwise = (index, vertexCount) => {
  const out = index
    ? Uint32Array.from(index)
    : Uint32Array.from({ length: vertexCount }, (_, vertex) => vertex);

  for (let corner = 0; corner < out.length; corner += 3) {
    const second = out[corner + 1];

    out[corner + 1] = out[corner + 2];
    out[corner + 2] = second;
  }

  return out;
};

// NOTE Mesh arrays. "smooth": normals made here. "flat": no normals; three.js node materials shade a geometry without
// normals flat. "stored": the normals of the file.
const finishMesh = ({ position, normal, uv, index, vertexCount }, normals) => {
  const result = {
    vertexCount,
    position,
    normal:
      normals === 'smooth'
        ? computeSmoothNormals(position, index)
        : normals === 'stored'
        ? normal
        : null,
    uv: uv ?? null,
    index: toCounterClockwise(index, vertexCount),
  };

  return result;
};

const getTransfer = (result) =>
  [
    result.position,
    result.normal,
    result.uv,
    result.index,
    result.signs,
    result.edges,
    result.tCodes,
  ]
    .filter((array) => array?.buffer)
    .map((array) => array.buffer)
    .filter((buffer, position, list) => list.indexOf(buffer) === position);

export const createContext = (bytes) => ({ file: new WabcFile(bytes), tracks: new Map() });

// NOTE "read": one sample of any track. "decode": the signs of a surface sample (in order). "build": the mesh of
// decoded signs. Gives { result, transfer }.
export const runJob = async (context, { type, node, sample, decoded }) => {
  const track = getTrack(context, node);
  let result;

  if (type === 'decode') {
    const { signs, edges, tCodes } = await track.decodeSurface(sample);

    // NOTE The track keeps its own signs for the next sample, so a copy is given
    result = { signs: signs.slice(), edges: edges.slice(), tCodes: tCodes.slice() };
  } else if (type === 'build') {
    const { positions, index } = WabcCodec.buildSurfaceMesh(decoded, track.track);

    result = finishMesh(
      { position: positions, index, vertexCount: positions.length / 3 },
      track.normals
    );
  } else {
    const geometry = await track.readSample(sample);

    result =
      context.file.nodes[node].type === 'mesh'
        ? finishMesh(geometry, track.normals)
        : { vertexCount: geometry.vertexCount, position: geometry.position };
  }

  return { result, transfer: getTransfer(result) };
};
