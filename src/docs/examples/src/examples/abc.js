import * as Three from 'three';
import { loadAlembic } from 'alembic';
import { ABCLoader } from 'three-alembic';
import { SimpleDropzone } from 'simple-dropzone';
import { camera, controls } from '../main';
import { dropTarget, getController, setGuiFields } from '../utils/gui';
import { setLoading } from '../utils/loading';
import { loadEnvironment, loaders } from '../utils/resources';

let targetScene, model;
let dropId = 0;

const params = {
  playing: true,
  fps: 24,
  loop: true,
  frame: 0,
  time: 0.0,
  display: 'water',
};

const originalMaterials = new Map();
const displayMaterials = {
  normals: new Three.MeshNormalMaterial(),
  uv: new Three.MeshBasicMaterial(),
  // NOTE Clear water: refraction (ior 1.333), reflections of the environment, blue tint that gets deeper with thickness
  water: new Three.MeshPhysicalMaterial({
    color: 0xffffff,
    metalness: 0.0,
    roughness: 0.03,
    transmission: 1.0,
    ior: 1.333,
    attenuationColor: new Three.Color(0x6fc3df),
  }),
};

loaders.texture.load('./assets/uv-1-4K.jpg', (texture) => {
  texture.colorSpace = Three.SRGBColorSpace;
  displayMaterials.uv.map = texture;
  displayMaterials.uv.needsUpdate = true;
});

const applyDisplay = () => {
  originalMaterials.forEach((material, mesh) => {
    mesh.material = displayMaterials[params.display] ?? material;
  });
};

const removeModel = () => {
  if (!model) {
    return;
  }

  // NOTE The display materials are shared. Only the materials of the model are disposed.
  originalMaterials.forEach((material, mesh) => {
    mesh.material = material;
  });
  originalMaterials.clear();

  model.removeFromParent();

  if (model.isABCAnimation) {
    model.dispose();
  } else {
    model.traverse((child) => {
      child.geometry?.dispose();
      child.material?.dispose();
    });
  }

  model = null;
};

// NOTE Camera looks at the model from the side, at a distance that shows all of it
const frameModel = () => {
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
  camera.position.copy(center).add(new Three.Vector3(-1.0, 0.7, 1.0).setLength(radius * 2.5));
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

// NOTE Frame and Time show the same sample. The field that was not changed follows the other one.
// Fields show the requested frame. It is on screen when it is built.
const showAnimationFrame = (frame) => {
  model.frame = frame;

  setFieldValue('frame', model.targetFrame);
  setFieldValue('time', model.timeSampling.getSampleTime(model.targetFrame));
};

const applyPlaybackParams = () => {
  if (!model?.isABCAnimation) {
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
  const { totalFrames, timeSampling } = model;
  const minTime = timeSampling.getSampleTime(0);
  const maxTime = timeSampling.getSampleTime(totalFrames - 1);

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
          onChange: (value) => showAnimationFrame(value),
        },
        {
          id: 'time',
          name: 'Time (s)',
          defaultValue: params.time,
          min: minTime,
          max: maxTime,
          step: 0.001,
          onChange: (value) => {
            showAnimationFrame(timeSampling.getSampleIndex(value, totalFrames));
            setFieldValue('time', value);
          },
        },
      ],
    },
  ];
};

const showGui = () => {
  setGuiFields([
    ...(model?.isABCAnimation ? getPlaybackFields() : []),
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

const showModel = (group) => {
  model = group;
  model.traverse((child) => {
    if (child.isMesh) {
      originalMaterials.set(child, child.material);
    }
  });

  if (model.isABCAnimation) {
    params.fps = Math.round(model.fps);
    params.frame = model.frame;
    params.time = model.timeSampling.getSampleTime(model.frame);
  }

  applyDisplay();
  applyPlaybackParams();
  targetScene.add(model);
  frameModel();
  showGui();
};

const loadFile = (file) => {
  const currentDropId = ++dropId;
  const url = URL.createObjectURL(file);
  const startTime = performance.now();

  removeModel();
  showGui();
  setLoading('abc', true);
  dropTarget.innerHTML = '[Loading file - please wait...]';

  loadAlembic(url)
    .then((reader) => new ABCLoader().parse(reader))
    .then((group) => {
      if (currentDropId !== dropId) {
        if (group.isABCAnimation) {
          group.dispose();
        }

        return;
      }

      console.info(
        'Alembic file loaded',
        file.name,
        `${(performance.now() - startTime).toFixed(0)}ms`
      );

      dropTarget.innerHTML = '[Drop .ABC here]';
      showModel(group);
    })
    .catch((error) => {
      if (currentDropId === dropId) {
        dropTarget.innerHTML = '[Error - please try again]';
      }

      console.error(error);
    })
    .finally(() => {
      URL.revokeObjectURL(url);

      if (currentDropId === dropId) {
        setLoading('abc', false);
      }
    });
};

const dropzone = new SimpleDropzone(dropTarget, document.createElement('input'));

dropTarget.innerHTML = '[Drop .ABC here]';

dropzone.on('drop', ({ files }) => {
  const file = Array.from(files.values()).find(({ name }) => name.toLowerCase().endsWith('.abc'));

  if (!file) {
    dropTarget.innerHTML = '[No .ABC file - please try again]';

    return;
  }

  loadFile(file);
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

  let lastTime = performance.now();

  setInterval(() => {
    const now = performance.now();

    if (model?.isABCAnimation) {
      const previousFrame = model.targetFrame;

      model.update((now - lastTime) / 1000.0);

      if (model.targetFrame !== previousFrame) {
        setFieldValue('frame', model.targetFrame);
        setFieldValue('time', model.timeSampling.getSampleTime(model.targetFrame));
      }
    }

    lastTime = now;
  }, 1000 / 60);
};
