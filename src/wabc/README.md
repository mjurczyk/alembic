# webabc

The `wabc` CLI (`npm install -g webabc`). Converts `.abc` files into web-optimised `.wabc` files. Needs only Node.js.

```
wabc <input>... [options]
```

- `<input>` - `.abc` files, or folders with `.abc` files (also in sub-folders). Large files (more than 2 GiB) work.
- `-o, --output <path>` - the output file (one input file) or folder. Without it, each `.wabc` file is put next to its `.abc` file. With a folder input, the output folder gets the same sub-folders.
- `-b, --bits <16|32>` - positions, uv and point widths as 16-bit integers (default, smaller) or 32-bit floats (exact).
- `-n, --normal-bits <8|16|32>` - normals as 8-bit integers (smallest), 16-bit integers (default) or 32-bit floats. Flat and smooth normals are not stored at all: the loader makes them.
- `--surface-bits <0-8>` - meshes made from a grid, for example liquid simulations: only the inside and outside of the grid is stored, and the loader makes the triangles. The number sets the precision (default `3`: the error is at most 1/16 of a grid cell). `0` turns this off.
- `--point-precision <n>` - points that all have one width: the positions are stored on a grid of width / n (default `32`). The order of the points is not kept. `0` turns this off.
- `--objects <paths>` - only these objects, with the objects below them. Full names, comma-separated, for example `--objects /Cube/Cube_241`.
- `--samples <first[:last]>` - only these samples, for example `--samples 0:99`. The numbers are the samples of the animated object with the most samples, from 0. Other objects keep their samples in the same time range.
- `-s, --space <world|local>` - each object gets its world matrix (default), or its matrix relative to its parent.
- `-c, --compression <deflate|brotli>` - `brotli` files are smaller, and take much longer to make.
- `-j, --jobs <n>` - the number of files converted at the same time (default `1`). Each file is kept in memory while it is converted.
- `-h, --help` - shows the options.

For example, `wabc demo.abc -o build/demo.wabc`, or `wabc scenes/ -o web/scenes/ -j 4`.

The `.wabc` format is described in `FORMAT.md`.
