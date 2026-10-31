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

reader.container; // 'Ogawa'
reader.archive; // Container archive

// NOTE Read a file that is already in memory (Uint8Array)
const readerFromBytes = await new Alembic.AlembicReader().read(source);
```

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
