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
// NOTE npm run dev:webgl uses WebGLRenderer and three-alembic/webgl. ?webgl uses the WebGL2 fallback of WebGPURenderer.
export const renderer =
  import.meta.env.VITE_RENDERER === 'webgl'
    ? new Three.WebGLRenderer({ antialias: true })
    : new WebGPURenderer({
        antialias: true,
        forceWebGL: new URLSearchParams(window.location.search).has('webgl'),
        trackTimestamp: true,
      });
export const controls = new OrbitControls(camera, renderer.domElement);

document.querySelector('.package-version').innerHTML = `v${packageInfo.version}`;

const stats = new Stats();
document.body.appendChild(stats.dom);

const renderScene = () => renderer.render(scene, camera);
let renderFrame = renderScene;

// NOTE An example can draw each frame with its own function, for example with a RenderPipeline. null: the default.
export const setRenderFrame = (render) => {
  renderFrame = render ?? renderScene;
};

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

// NOTE Sums since the last read
const renderTimes = { frames: 0, cpuTime: 0.0, gpuFrames: 0, gpuTime: 0.0, gpuPending: false };
let framesToResolve = 0;

// NOTE Mean CPU and GPU milliseconds of a frame since the last call. null: no data, or no timestamp queries.
export const readRenderTimes = () => {
  const { frames, cpuTime, gpuFrames, gpuTime } = renderTimes;

  Object.assign(renderTimes, { frames: 0, cpuTime: 0.0, gpuFrames: 0, gpuTime: 0.0 });

  return {
    cpuTime: frames ? cpuTime / frames : null,
    gpuTime: gpuFrames ? gpuTime / gpuFrames : null,
  };
};

// NOTE The query pool keeps the passes of all frames since the last resolve. Only one resolve runs at a time.
const resolveGpuTime = () => {
  framesToResolve++;

  if (!renderer.backend?.trackTimestamp || renderTimes.gpuPending) {
    return;
  }

  const frames = framesToResolve;

  framesToResolve = 0;
  renderTimes.gpuPending = true;
  renderer.resolveTimestampsAsync().then((time) => {
    renderTimes.gpuPending = false;

    if (Number.isFinite(time)) {
      renderTimes.gpuTime += time;
      renderTimes.gpuFrames += frames;
    }
  });
};

const animate = () => {
  stats.begin();

  const start = performance.now();

  controls.update();
  renderFrame();
  renderTimes.cpuTime += performance.now() - start;
  renderTimes.frames++;
  resolveGpuTime();

  stats.end();
};

init();
renderer.setAnimationLoop(animate);
exampleABC({ scene });
