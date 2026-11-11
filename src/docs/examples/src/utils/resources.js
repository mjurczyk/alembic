import * as Three from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { UltraHDRLoader } from 'three/examples/jsm/loaders/UltraHDRLoader.js';
import { isPhone } from './device';

export const loaders = {
  texture: new Three.TextureLoader(),
  ultraHdr: new UltraHDRLoader(),
  gltf: new GLTFLoader(),
};

// NOTE 8K backgrounds crash iOS Safari. Phones get 4K backgrounds.
const backgroundSize = isPhone ? '4K' : '8K';

// NOTE These environments have no JPEG background. The UltraHDR file is also the background.
const ultraHdrBackgrounds = ['night', 'sky-midday', 'sky-dusk', 'sky-cloudy', 'sky-night'];

// NOTE The UltraHDR files are brighter than the JPEG backgrounds. The sky files (three-environment-shadows) are not.
const getUltraHdrIntensity = (name) => (name.startsWith('sky-') ? 1.0 : 0.4);

// NOTE A newer environment cancels an older one that is still loading
let environmentId = 0;

const replaceTexture = (scene, key, texture) => {
  const previous = scene[key];

  scene[key] = texture;

  if (previous?.isTexture && previous !== scene.environment && previous !== scene.background) {
    previous.dispose();
  }
};

export const loadEnvironment = (scene, name) => {
  const currentId = ++environmentId;
  const useUltraHdrBackground = ultraHdrBackgrounds.includes(name);
  const ultraHdrIntensity = getUltraHdrIntensity(name);

  loaders.ultraHdr.load(`./assets/${name}-HDR.jpg`, (env) => {
    if (currentId !== environmentId) {
      env.dispose();

      return;
    }

    env.mapping = Three.EquirectangularReflectionMapping;
    replaceTexture(scene, 'environment', env);
    scene.environmentIntensity = ultraHdrIntensity;

    if (useUltraHdrBackground) {
      replaceTexture(scene, 'background', env);
      scene.backgroundIntensity = ultraHdrIntensity;
    }
  });

  if (!useUltraHdrBackground) {
    loaders.texture.load(`./assets/${name}-${backgroundSize}.jpg`, (background) => {
      if (currentId !== environmentId) {
        background.dispose();

        return;
      }

      background.mapping = Three.EquirectangularRefractionMapping;
      background.colorSpace = Three.SRGBColorSpace;
      replaceTexture(scene, 'background', background);
      scene.backgroundIntensity = 1.0;
    });
  }
};
