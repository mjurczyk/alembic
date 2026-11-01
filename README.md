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

```js
import * as Alembic from 'alembic-web';

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
