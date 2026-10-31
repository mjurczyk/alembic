import * as Three from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import Stats from 'stats.js';
import packageInfo from '../../../three-alembic/package.json';
import { exampleABC } from './examples/abc';

export const camera = new Three.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.01,
  10000.0
);
export const scene = new Three.Scene();
// NOTE ?webgl uses the WebGL2 fallback of WebGPURenderer
export const renderer = new WebGPURenderer({
  antialias: true,
  forceWebGL: new URLSearchParams(window.location.search).has('webgl'),
});
export const controls = new OrbitControls(camera, renderer.domElement);

document.querySelector('.package-version').innerHTML = `v${packageInfo.version}`;

const stats = new Stats();
document.body.appendChild(stats.dom);

const init = () => {
  camera.position.set(-10.0, 8.0, 8.0);

  scene.background = new Three.Color(0x598eff);

  renderer.outputColorSpace = Three.SRGBColorSpace;
  renderer.setSize(window.innerWidth, window.innerHeight);

  document.body.appendChild(renderer.domElement);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();

    renderer.setSize(window.innerWidth, window.innerHeight);
  });
};

const animate = () => {
  stats.begin();

  controls.update();
  renderer.render(scene, camera);

  stats.end();
};

init();
renderer.setAnimationLoop(animate);
exampleABC({ scene });
