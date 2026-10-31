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

// NOTE The UltraHDR files are brighter than the JPEG backgrounds
const ultraHdrIntensity = 0.4;

export const loadEnvironment = (scene, name) => {
  loaders.ultraHdr.load(`./assets/${name}-HDR.jpg`, (env) => {
    env.mapping = Three.EquirectangularReflectionMapping;
    scene.environment = env;
    scene.environmentIntensity = ultraHdrIntensity;
  });

  loaders.texture.load(`./assets/${name}-${backgroundSize}.jpg`, (background) => {
    background.mapping = Three.EquirectangularRefractionMapping;
    background.colorSpace = Three.SRGBColorSpace;
    scene.background = background;
    scene.backgroundIntensity = 1.0;
  });
};
