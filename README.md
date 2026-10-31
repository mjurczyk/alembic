# alembic

Alembic (`.abc`) for JavaScript.

| Package         | Folder              | Use                                                          |
| --------------- | ------------------- | ------------------------------------------------------------ |
| `alembic`       | `src/alembic`       | Reads `.abc` files. No dependencies. No renderer.            |
| `three-alembic` | `src/three-alembic` | three.js WebGL rendering of `.abc` files.                    |
| `wabc`          | `src/wabc`          | CLI. Converts `.abc` files into web-optimised `.wabc` files. |

## Usage

```js
import * as Alembic from 'alembic';

const reader = await Alembic.loadAlembic('./assets/model.abc');

const mesh = reader.archive.findObject('/Cube/Cube_241');
const positions = mesh.properties.get('.geom').get('P');

// NOTE Positions of the frame at 0.5 seconds
const frame = positions.timeSampling.getSampleIndex(0.5, positions.numSamples);
const { values } = positions.getSample(frame);
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
