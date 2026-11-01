# alembic

> [!NOTE]
> WABC (`.wabc`) is a live proposal. The format can change. See the [WABC format specification](src/wabc/FORMAT.md).

> [!TIP]
> Convert `.abc` files to `.wabc` before you use them on the web: `npx webabc water.abc` (or `npm install -g webabc`, then `wabc water.abc`). A `.wabc` file is much smaller. `.abc` files also load directly.

> [!WARNING]
> Experimental: Alembic support for three.js currently only supports TSL and r187. Backwards compatibility coming ASAP.

Alembic (`.abc`) for JavaScript.

| Package         | Folder              | Use                                                          |
| --------------- | ------------------- | ------------------------------------------------------------ |
| `alembic-web`   | `src/alembic`       | Reads `.abc` files. No dependencies. No renderer.            |
| `three-alembic` | `src/three-alembic` | three.js WebGL rendering of `.abc` files.                    |
| `webabc`        | `src/wabc`          | CLI. Converts `.abc` files into web-optimised `.wabc` files. |

## Usage

### With `three.js`:

```js
import * as Three from 'three';
import { WebGPURenderer } from 'three/webgpu';
import * as AlembicThree from 'three-alembic';

const renderer = new WebGPURenderer({ antialias: true });
const scene = new Three.Scene();
const camera = new Three.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000.0);

let animation = null;

// NOTE Load a .wabc file. An animated file gives a WABCAnimation; a static file gives a Group.
new AlembicThree.WABCLoader().load('./assets/water.wabc', (model) => {
  // NOTE Use createVertexAnimationMaterial for materials of animated objects
  const water = AlembicThree.createVertexAnimationMaterial(
    new Three.MeshPhysicalMaterial({ transmission: 1.0, roughness: 0.03, ior: 1.333 }),
  );

  model.traverse((child) => {
    if (child.isMesh) {
      child.material = water;
    }
  });

  if (model.isWABCAnimation) {
    animation = model;
    animation.fps = 24;
    animation.play();
  }

  scene.add(model);
});

const timer = new Three.Timer();

renderer.setAnimationLoop((timestamp) => {
  timer.update(timestamp);
  animation?.update(timer.getDelta());
  renderer.render(scene, camera);
});
```

#### Loading .abc files

`.abc` files load directly too, with the same objects and playback. The browser then downloads the full file.

```js
new AlembicThree.ABCLoader().load('./assets/water.abc', (model) => {
  if (model.isABCAnimation) {
    animation = model;
    animation.play();
  }

  scene.add(model);
});

// NOTE Start at 1.5 seconds: new AlembicThree.ABCLoader().setOptions({ time: 1.5 }).load(url, onLoad)
```

### Without library:

```js
import * as Alembic from 'alembic-web';

// NOTE .abc files
const reader = await Alembic.loadAlembic('./assets/model.abc');

const mesh = reader.archive.findObject('/Cube/Cube_241');
const positions = mesh.properties.get('.geom').get('P');

// NOTE Positions of the frame at 0.5 seconds
const frame = positions.timeSampling.getSampleIndex(0.5, positions.numSamples);
const { values } = positions.getSample(frame);

// NOTE .wabc files
const file = await Alembic.loadWabc('./assets/water.wabc');

const node = file.nodes.findIndex(({ type }) => type === 'mesh');
const geometry = file.getGeometry(node);

// NOTE Positions and triangles of the last frame
const { position, index } = await geometry.readSample(geometry.numSamples - 1);
```

## Docs

### loadAlembic

- `loadAlembic( url ): Promise<Alembic.AlembicReader>`

Loads Alembic file and reads its objects. Objects can be accessed via `.archive` property of the value returned from the Promise. The Promise rejects on network errors, HTTP errors (for example 404), and files that are not Alembic files.

---

## Containers

| Container | Support |
| --------- | ------- |
| Ogawa     | ✅ Yes  |
| HDF5      | ❌ No   |

File format: [`src/alembic/FORMAT.md`](src/alembic/FORMAT.md).

## Development

```sh
git clone https://github.com/mjurczyk/alembic
cd ./alembic
npm install
npm run build
```
