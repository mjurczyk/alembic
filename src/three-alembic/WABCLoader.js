import * as Three from 'three';
import { WabcFile, loadWabc } from 'alembic-web';
import { WABCAnimation, applySampleArrays } from './WABCAnimation.js';
import { WabcWorkers } from './wabc/WabcWorkers.js';

// NOTE Geometry of one .wabc sample (WabcFile) as a BufferGeometry. The .wabc triangles are clockwise (as Alembic),
// three.js front faces are counter-clockwise, so corners 2 and 3 of each triangle change places.
// Flat and smooth normals are made here (src/wabc/FORMAT.md 6.7): from counter-clockwise triangles, three.js gives them.
export const createWabcGeometry = (sample, type) => {
  const geometry = new Three.BufferGeometry();

  geometry.setAttribute('position', new Three.BufferAttribute(sample.position, 3));

  if (type === 'points') {
    return geometry;
  }

  if (sample.uv) {
    geometry.setAttribute('uv', new Three.BufferAttribute(sample.uv, 2));
  }

  if (sample.normals === 'stored' && sample.normal) {
    geometry.setAttribute('normal', new Three.BufferAttribute(sample.normal, 3));
  }

  const count = sample.index ? sample.index.length : sample.vertexCount;
  const index = new Uint32Array(count);

  for (let corner = 0; corner < count; corner += 3) {
    const at = (item) => (sample.index ? sample.index[corner + item] : corner + item);

    index[corner] = at(0);
    index[corner + 1] = at(2);
    index[corner + 2] = at(1);
  }

  geometry.setIndex(new Three.BufferAttribute(index, 1));

  if (sample.normals === 'flat') {
    const flat = geometry.toNonIndexed();

    geometry.dispose();
    flat.computeVertexNormals();

    return flat;
  }

  if (sample.normals === 'smooth') {
    geometry.computeVertexNormals();
  }

  return geometry;
};

const createNode = (node) => {
  let object;

  if (node.type === 'mesh') {
    object = new Three.Mesh(new Three.BufferGeometry(), new Three.MeshStandardMaterial());
  } else if (node.type === 'points') {
    object = new Three.Points(new Three.BufferGeometry(), new Three.PointsMaterial());
  } else {
    object = new Three.Group();
  }

  object.name = node.name;
  object.userData = {
    fullName: node.path,
    schema: { mesh: 'PolyMesh', points: 'Points' }[node.type] ?? null,
  };
  object.matrixAutoUpdate = false;

  return object;
};

// NOTE Loader of .wabc files, as ABCLoader for .abc files. Gives a Group, or a WABCAnimation if the file is animated.
// "world" files: all nodes are children of the root, because their matrices already have the matrices of the parents.
class WABCLoader extends Three.Loader {
  constructor(manager) {
    super(manager);
  }

  load(url, onLoad, _onProgress_ /* NOTE Unused */, onError) {
    const resolvedUrl = this.manager.resolveURL(this.path + url);

    this.manager.itemStart(resolvedUrl);

    loadWabc(resolvedUrl)
      .then((file) => this.parse(file))
      .then((group) => {
        onLoad(group);
        this.manager.itemEnd(resolvedUrl);
      })
      .catch((error) => {
        if (onError) {
          onError(error);
        } else {
          console.error(error);
        }

        this.manager.itemError(resolvedUrl);
        this.manager.itemEnd(resolvedUrl);
      });
  }

  // NOTE Source: the bytes of a file (Uint8Array or ArrayBuffer), or a WabcFile. Samples are read by workers
  // (WabcWorkers): surface signs on one worker, meshes on the others. Without workers, in the page.
  async parse(source) {
    const file =
      source instanceof WabcFile
        ? source
        : new WabcFile(source instanceof ArrayBuffer ? new Uint8Array(source) : source);
    const workers = new WabcWorkers(file.bytes);
    const isWorld = file.space === 'world';
    const entries = [];

    for (let index = 0; index < file.nodes.length; index++) {
      const node = file.nodes[index];
      const object = createNode(node);
      const matrices = await file.readMatrices(index);
      const track = file.getGeometry(index);
      const isSurface = track?.mode === 'surface';

      // NOTE Animated geometries change their size, so their bounds are not kept
      object.frustumCulled = !(track && track.numSamples > 1);

      // NOTE PointsMaterial has one size for all points: the width of a set (FORMAT.md 3.12)
      if (node.type === 'points') {
        object.material.sizeAttenuation = track?.track.width !== undefined;
        object.material.size = track?.track.width ?? 1;
      }

      entries.push({
        node: object,
        parent: node.parent,
        matrices,
        matrixTimes: matrices.map((_, sample) => file.getMatrixTime(index, sample)),
        track,
        cache: new Map(),
        requested: new Set(),
        shown: -1,
        wanted: 0,
        readArrays: (sample) =>
          isSurface
            ? workers.decode(index, sample).then((decoded) => workers.build(index, decoded))
            : workers.read(index, sample),
        applyArrays: (arrays) => applySampleArrays(object, arrays),
      });

      object.matrix.fromArray(matrices[0]);
    }

    // NOTE The timeline: the times of the track with the most samples
    const longest = entries
      .filter(({ track, matrices }) => (track?.numSamples ?? 0) > 1 || matrices.length > 1)
      .map(({ track, matrixTimes }) =>
        (track?.numSamples ?? 0) >= matrixTimes.length
          ? { count: track.numSamples, getTime: (sample) => track.getSampleTime(sample) }
          : { count: matrixTimes.length, getTime: (sample) => matrixTimes[sample] }
      )
      .sort((a, b) => b.count - a.count)[0];
    const root = longest ? new WABCAnimation(entries, longest, workers) : new Three.Group();

    root.name = file.header.source?.file ?? '';
    entries.forEach(({ node, parent }) => {
      (isWorld || parent === -1 ? root : entries[parent].node).add(node);
    });

    // NOTE The first sample of each geometry, before the root is given
    await Promise.all(
      entries
        .filter(({ track }) => track)
        .map(async (entry) => {
          entry.applyArrays(await entry.readArrays(0));
          entry.shown = 0;
        })
    );

    if (root.isWABCAnimation) {
      root.time = root.startTime;
    } else {
      workers.dispose();
    }

    return root;
  }
}

export { WABCLoader };
