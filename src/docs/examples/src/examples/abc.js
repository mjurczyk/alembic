import * as Three from 'three';
import { WabcFile, loadAlembic, loadWabc } from 'alembic-web';
import { ABCLoader, WABCLoader, createVertexAnimationMaterial } from 'three-alembic';
import { SimpleDropzone } from 'simple-dropzone';
import { camera, controls } from '../main';
import { dropTarget, getController, setGuiFields } from '../utils/gui';
import { fetchWithProgress, setLoading, setLoadingProgress } from '../utils/loading';
import { loadEnvironment, loaders } from '../utils/resources';

let targetScene, model;
// NOTE The .abc file dropped with a .wabc file, to compare them
let reference = null;
let dropId = 0;

const isAnimation = (object) => object?.isABCAnimation || object?.isWABCAnimation;

const params = {
  playing: true,
  // NOTE Frames per second of the playback. A new file starts at the fps of the file.
  fps: 24,
  loop: true,
  frame: 0,
  display: 'water',
  compare: 'wabc',
  errorScale: 1.0,
  maxError: 0.0,
};

const originalMaterials = new Map();
// NOTE Display materials also show the vertex animation of animated files
const displayMaterials = {
  normals: createVertexAnimationMaterial(new Three.MeshNormalMaterial()),
  uv: createVertexAnimationMaterial(new Three.MeshBasicMaterial()),
  // NOTE Clear water: refraction (ior 1.333), reflections of the environment, blue tint that gets deeper with thickness
  water: createVertexAnimationMaterial(
    new Three.MeshPhysicalMaterial({
      color: 0xffffff,
      metalness: 0.0,
      roughness: 0.03,
      transmission: 1.0,
      ior: 1.333,
      attenuationColor: new Three.Color(0x6fc3df),
    })
  ),
};

loaders.texture.load('./assets/uv-1-4K.jpg', (texture) => {
  texture.colorSpace = Three.SRGBColorSpace;
  displayMaterials.uv.map = texture;
  displayMaterials.uv.needsUpdate = true;
});

// NOTE Compare: the .abc mesh as a white wire over the .wabc mesh; error: the .wabc mesh coloured by its distance
const wireMaterial = createVertexAnimationMaterial(
  new Three.MeshBasicMaterial({ color: 0xffffff, wireframe: true })
);
const errorMaterial = new Three.MeshBasicMaterial({ vertexColors: true });

const applyDisplay = () => {
  originalMaterials.forEach((material, mesh) => {
    mesh.material =
      params.compare === 'error' && !mesh.userData.isReference
        ? errorMaterial
        : mesh.userData.isReference && params.compare === 'both'
        ? wireMaterial
        : displayMaterials[params.display] ?? material;
  });

  if (model) {
    model.visible = params.compare !== 'abc' || !reference;
  }

  if (reference) {
    reference.visible = params.compare === 'abc' || params.compare === 'both';
  }

  errorState.geometries.clear();
};

// NOTE Distance of each .wabc vertex to the nearest .abc vertex of the mesh with the same full name, in world space.
// Colours: blue (0) to green, yellow and red (the error scale and more). Made again when a geometry changes.
const errorState = { geometries: new Map() };
const errorColor = new Three.Color();

// NOTE A .wabc geometry keeps spare room in its buffers: only "userData.vertexCount" vertices are used
const getWorldPositions = (mesh) => {
  const attribute = mesh.geometry.getAttribute('position');
  const count = mesh.userData.vertexCount ?? attribute.count;
  const out = new Float32Array(count * 3);
  const point = new Three.Vector3();

  mesh.updateWorldMatrix(true, false);

  for (let vertex = 0; vertex < count; vertex++) {
    point.fromBufferAttribute(attribute, vertex).applyMatrix4(mesh.matrixWorld);
    point.toArray(out, vertex * 3);
  }

  return out;
};

const colorByError = (mesh, referenceMesh) => {
  const scale = params.errorScale / 1000.0;
  const cell = scale * 2.0;
  const source = getWorldPositions(referenceMesh);
  const target = getWorldPositions(mesh);
  const cells = new Map();
  const key = (x, y, z) =>
    `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;

  for (let point = 0; point < source.length / 3; point++) {
    const id = key(source[point * 3], source[point * 3 + 1], source[point * 3 + 2]);

    (cells.get(id) ?? cells.set(id, []).get(id)).push(point);
  }

  const colors = new Float32Array(target.length);
  let maxError = 0.0;

  for (let vertex = 0; vertex < target.length / 3; vertex++) {
    const [x, y, z] = target.subarray(vertex * 3, vertex * 3 + 3);
    const [cx, cy, cz] = [x, y, z].map((value) => Math.floor(value / cell));
    let best = Infinity;

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          for (const point of cells.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
            best = Math.min(
              best,
              Math.hypot(
                source[point * 3] - x,
                source[point * 3 + 1] - y,
                source[point * 3 + 2] - z
              )
            );
          }
        }
      }
    }

    maxError = Math.max(maxError, best);
    // NOTE Hue 0.66 (blue) at 0, 0 (red) at the scale or more
    errorColor.setHSL(0.66 * (1.0 - Math.min(best / scale, 1.0)), 1.0, 0.5);
    errorColor.toArray(colors, vertex * 3);
  }

  mesh.geometry.setAttribute('color', new Three.BufferAttribute(colors, 3));

  return maxError;
};

const updateErrorColors = () => {
  if (params.compare !== 'error' || !model || !reference) {
    return;
  }

  let changed = false;
  let maxError = 0.0;

  model.traverse((mesh) => {
    if (!mesh.isMesh) {
      return;
    }

    let match = null;

    reference.traverse((child) => {
      if (child.isMesh && child.userData.fullName === mesh.userData.fullName) {
        match = child;
      }
    });

    if (!match?.isMesh) {
      return;
    }

    const state = errorState.geometries.get(mesh);

    if (
      state &&
      state.version === mesh.userData.version &&
      state.reference === match.geometry &&
      state.scale === params.errorScale
    ) {
      maxError = Math.max(maxError, state.maxError);
      return;
    }

    const error = colorByError(mesh, match);

    errorState.geometries.set(mesh, {
      version: mesh.userData.version,
      reference: match.geometry,
      scale: params.errorScale,
      maxError: error,
    });
    maxError = Math.max(maxError, error);
    changed = true;
  });

  if (changed) {
    setFieldValue('maxError', Number((maxError * 1000.0).toFixed(3)));
  }
};

const disposeObject = (object) => {
  object.removeFromParent();

  if (isAnimation(object)) {
    object.dispose();
  } else {
    object.traverse((child) => {
      child.geometry?.dispose();
      child.material?.dispose();
    });
  }
};

const removeModel = () => {
  if (reference) {
    disposeObject(reference);
    reference = null;
  }

  errorState.geometries.clear();

  if (!model) {
    return;
  }

  // NOTE The display materials are shared. Only the materials of the model are disposed.
  originalMaterials.forEach((material, mesh) => {
    mesh.material = material;
  });
  originalMaterials.clear();

  disposeObject(model);
  model = null;
};

// NOTE Camera looks at the model from the side, at a distance that shows all of it.
// "direction" is the side of the camera; "height" moves the camera up, in scene units.
const defaultView = { direction: new Three.Vector3(-1.0, 0.7, 1.0), height: 0.0 };
const demoView = { direction: new Three.Vector3(1.0, 0.7, -1.0), height: 1.0 };

const frameModel = ({ direction, height } = defaultView) => {
  const box = new Three.Box3().setFromObject(model);

  if (box.isEmpty()) {
    return;
  }

  const center = box.getCenter(new Three.Vector3());
  const radius = Math.max(box.getSize(new Three.Vector3()).length() / 2.0, 0.001);

  // NOTE Water thickness and tint depth follow the model size
  displayMaterials.water.thickness = radius * 0.5;
  displayMaterials.water.attenuationDistance = radius * 2.0;

  controls.target.copy(center);
  camera.position.copy(center).add(direction.clone().setLength(radius * 2.5));
  camera.position.y += height;
  camera.near = radius / 100.0;
  camera.far = radius * 100.0;
  camera.updateProjectionMatrix();
};

const setFieldValue = (id, value) => {
  const controller = getController(id);

  params[id] = value;

  if (controller) {
    controller.object[id] = value;
    controller.updateDisplay();
  }
};

// NOTE Frame follows the time of the animation
const showAnimationTime = () => {
  setFieldValue('frame', model.frame);
};

const applyPlaybackParams = () => {
  if (!isAnimation(model)) {
    return;
  }

  model.fps = params.fps;
  model.loop = params.loop;

  if (params.playing) {
    model.play();
  } else {
    model.pause();
  }
};

const getPlaybackFields = () => {
  const { totalFrames } = model;

  return [
    {
      folder: 'Playback',
      children: [
        {
          id: 'playing',
          name: 'Play',
          defaultValue: params.playing,
          onChange: (value) => {
            params.playing = value;
            applyPlaybackParams();
          },
        },
        {
          id: 'fps',
          name: 'FPS',
          defaultValue: params.fps,
          min: 1,
          max: 120,
          step: 1,
          onChange: (value) => {
            params.fps = value;
            applyPlaybackParams();
          },
        },
        {
          id: 'loop',
          name: 'Loop',
          defaultValue: params.loop,
          onChange: (value) => {
            params.loop = value;
            applyPlaybackParams();
          },
        },
        {
          id: 'frame',
          name: 'Frame',
          defaultValue: params.frame,
          min: 0,
          max: totalFrames - 1,
          step: 1,
          onChange: (value) => {
            model.frame = value;
          },
        },
      ],
    },
  ];
};

const getCompareFields = () => [
  {
    folder: 'Compare .abc and .wabc',
    children: [
      {
        id: 'compare',
        name: 'Show',
        defaultValue: params.compare,
        options: { '.wabc': 'wabc', '.abc': 'abc', 'Both (.abc as wire)': 'both', Error: 'error' },
        onChange: (value) => {
          params.compare = value;
          applyDisplay();
          updateErrorColors();
        },
      },
      {
        id: 'errorScale',
        name: 'Error scale (mm)',
        defaultValue: params.errorScale,
        min: 0.05,
        max: 10.0,
        step: 0.05,
        onFinishChange: (value) => {
          params.errorScale = value;
          updateErrorColors();
        },
      },
      {
        id: 'maxError',
        name: 'Max error (mm)',
        defaultValue: params.maxError,
      },
    ],
  },
];

const showGui = () => {
  setGuiFields([
    ...(isAnimation(model) ? getPlaybackFields() : []),
    ...(reference ? getCompareFields() : []),
    {
      folder: 'Scene',
      children: [
        {
          id: 'display',
          name: 'Display',
          defaultValue: params.display,
          options: { Water: 'water', Shaded: 'shaded', Normals: 'normals', UV: 'uv' },
          onChange: (value) => {
            params.display = value;
            applyDisplay();
          },
        },
      ],
    },
  ]);
};

const showModel = (group, referenceGroup = null, view = defaultView) => {
  model = group;
  reference = referenceGroup;
  model.traverse((child) => {
    if (child.isMesh) {
      originalMaterials.set(child, child.material);
    }
  });

  if (reference) {
    reference.traverse((child) => {
      if (child.isMesh) {
        child.userData.isReference = true;
        originalMaterials.set(child, child.material);
      }
    });
    targetScene.add(reference);
  }

  // NOTE Geometries of a .wabc animation change when a sample is read
  model.addEventListener?.('sample', () => updateErrorColors());

  if (isAnimation(model)) {
    params.frame = model.frame;
    params.fps = Math.round(model.fileFps);
  }

  applyDisplay();
  applyPlaybackParams();
  targetScene.add(model);
  frameModel(view);
  showGui();
};

const readAbc = (url) => loadAlembic(url).then((reader) => new ABCLoader().parse(reader));
const readWabc = (url) => loadWabc(url).then((file) => new WABCLoader().parse(file));

// NOTE The default demo, shown until a file is dropped
const demoUrl = './assets/demo-water.wabc';

// NOTE load() gives [abcGroup, wabcGroup]. A newer load or drop cancels this one.
const loadGroups = ({ names, load, onEnd, view }) => {
  const currentDropId = ++dropId;
  const startTime = performance.now();

  removeModel();
  showGui();
  setLoading('abc', true);
  dropTarget.innerHTML = '[Loading file - please wait...]';

  load()
    .then(([abcGroup, wabcGroup]) => {
      if (currentDropId !== dropId) {
        [abcGroup, wabcGroup].forEach((group) => group && isAnimation(group) && group.dispose());

        return;
      }

      console.info('File loaded', names, `${(performance.now() - startTime).toFixed(0)}ms`);

      dropTarget.innerHTML = '[Drop .ABC or .WABC here]';
      params.compare = abcGroup && wabcGroup ? 'both' : 'wabc';
      showModel(wabcGroup ?? abcGroup, wabcGroup ? abcGroup : null, view);
    })
    .catch((error) => {
      if (currentDropId === dropId) {
        dropTarget.innerHTML = '[Error - please try again]';
      }

      console.error(error);
    })
    .finally(() => {
      onEnd?.();

      if (currentDropId === dropId) {
        setLoading('abc', false);
      }
    });
};

// NOTE A .wabc file is shown; a .abc file dropped with it is the reference of the comparison
const loadFiles = ({ abcFile, wabcFile }) => {
  const urls = [abcFile, wabcFile].filter(Boolean).map((file) => URL.createObjectURL(file));
  const [abcUrl, wabcUrl] = [abcFile ? urls[0] : null, wabcFile ? urls.at(-1) : null];

  loadGroups({
    names: [abcFile?.name, wabcFile?.name].filter(Boolean).join(' + '),
    load: () => Promise.all([abcUrl ? readAbc(abcUrl) : null, wabcUrl ? readWabc(wabcUrl) : null]),
    onEnd: () => urls.forEach((url) => URL.revokeObjectURL(url)),
  });
};

// NOTE The demo file is large. The loading indicator shows the download progress.
const loadDemo = () => {
  loadGroups({
    names: demoUrl,
    view: demoView,
    load: () =>
      fetchWithProgress(demoUrl, setLoadingProgress).then((bytes) =>
        Promise.all([null, new WABCLoader().parse(new WabcFile(bytes))])
      ),
  });
};

const dropzone = new SimpleDropzone(dropTarget, document.createElement('input'));

dropTarget.innerHTML = '[Drop .ABC or .WABC here]';

// NOTE One .abc file, one .wabc file, or both (to compare them)
dropzone.on('drop', ({ files }) => {
  const list = Array.from(files.values());
  const abcFile = list.find(({ name }) => name.toLowerCase().endsWith('.abc'));
  const wabcFile = list.find(({ name }) => name.toLowerCase().endsWith('.wabc'));

  if (!abcFile && !wabcFile) {
    dropTarget.innerHTML = '[No .ABC or .WABC file - please try again]';

    return;
  }

  loadFiles({ abcFile, wabcFile });
});

dropzone.on('droperror', ({ message }) => {
  dropTarget.innerHTML = '[Error - please try again]';

  console.error({ message });
});

export const exampleABC = ({ scene }) => {
  targetScene = scene;

  const sun = new Three.DirectionalLight(0xffffff, 1.0);
  sun.position.set(100.0, 200.0, 100.0);
  scene.add(sun);

  scene.add(new Three.HemisphereLight(0x88aaff, 0x443322, 0.5));

  loadEnvironment(scene, 'uv-1');
  showGui();

  // NOTE Rock formation at the scene origin, shared by the demos
  loaders.gltf.load('./assets/demo-rock.glb', (gltf) => {
    scene.add(gltf.scene);
  });

  loadDemo();

  let lastTime = performance.now();

  // NOTE Once for each drawn frame, so the blend between samples moves smoothly
  const update = (now) => {
    if (isAnimation(model) && model.playing) {
      model.update((now - lastTime) / 1000.0);
      showAnimationTime();

      // NOTE Without loop, the playback stops at the end
      if (!model.playing) {
        params.playing = false;
        setFieldValue('playing', false);
      }
    }

    // NOTE The reference follows the time of the .wabc file
    if (isAnimation(model) && isAnimation(reference) && reference.time !== model.time) {
      reference.time = model.time;
    }

    updateErrorColors();
    lastTime = now;
    requestAnimationFrame(update);
  };

  requestAnimationFrame(update);
};
