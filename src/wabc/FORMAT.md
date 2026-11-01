# `.wabc` file format

This document defines `.wabc`, an optimised copy of the scene of one `.abc` file. It describes, byte by byte, what is stored where, and why. Each optimisation comes from the `.abc` research in `../alembic/FORMAT.md` (called [ABC] below), or from a measurement on the demo files of [ABC].

## Contents

0. [Conventions and checks](#0-conventions-and-checks)
1. [What is optimised](#1-what-is-optimised)
2. [File layout](#2-file-layout)
3. [Header](#3-header)
4. [Chunks](#4-chunks)
5. [Value encoding](#5-value-encoding)
6. [Samples rebuilt by the loader](#6-samples-rebuilt-by-the-loader)
7. [Chunk order](#7-chunk-order)
8. [Conversion from `.abc`](#8-conversion-from-abc)
9. [Versions and extensions](#9-versions-and-extensions)
10. [Reader validation](#10-reader-validation)
11. [Byte accounting](#11-byte-accounting)
12. [References](#12-references)

- [Appendix A. Worked example](#appendix-a-worked-example)
- [Appendix B. Inflated chunk sizes](#appendix-b-inflated-chunk-sizes)

---

## 0. Conventions and checks

### 0.1 Conventions

- MUST, MUST NOT: a requirement. SHOULD, SHOULD NOT: a recommendation. MAY: an option.
- All integers and floats are little-endian. `u16`, `u32`: unsigned integers. `i8`, `i16`: signed two's complement integers. `f32`, `f64`: IEEE 754 binary32 and binary64.
- `ceil(x)`, `floor(x)`: the smallest integer not less than `x`, the largest integer not more than `x`. `round(x)`: the nearest integer, halves away from zero. `clamp(x, a, b)`: `min(max(x, a), b)`. `x % n`: the remainder of `x / n`, for `x >= 0`.
- Matrix: 16 `f32` values in the order of an Xform matrix op ([ABC] 3.4). Value `4j + k` is Imath `m[j][k]`. A point is a row vector: `p' = p × M`. The translation is in values 12, 13 and 14.
- Array indices start at 0.

### 0.2 How each statement is checked

Each subsection ends with a **Check** line:

- **[ABC] x.y**: a fact of the `.abc` format or of the demo files, from the research document.
- **demo**: measured on all 250 frames of `demo.abc` and `demo-nonparticle.abc`, and of `demo-smooth.abc` (1 113 189 646 bytes: one PolyMesh on the same grid as the other two files, without `N`). The measurement scripts are research scripts, not in the repository. The CLI (`src/wabc`) converted the 3 files. The decoders `src/wabc/rehydrate.js` and `src/wabc/points.js` read the files back (section 11). Where a number is from some frames only, the Check line names the frames.
- **local**: measured on test files made with libAlembic 1.8.12. `test-anim.abc`: animated and static meshes and points, with and without `N`, uniform, cyclic and acyclic time samplings, animated and sheared Xforms. `flag.abc`: Appendix A.
- **/wabc rule**: a decision of this project. The Check line gives the measured reason.

---

## 1. What is optimised

The sample values of `demo-nonparticle.abc` are 2 305 664 067 of its 2 305 723 951 bytes ([ABC] 7.1). By property, before shared blocks are removed:

| Property ([ABC] 3.2)  | Bytes, 250 frames | Share | In `.wabc`                                                        |
| --------------------- | ----------------- | ----- | ----------------------------------------------------------------- |
| `N` (`fvr`, `f32[3]`) | 1 297 844 496     | 56 %  | Not stored: the loader calculates the flat normals (8.4)          |
| `.faceIndices`        | 432 614 832       | 19 %  | Not stored: the loader makes the triangles from the grid (6.5)    |
| `P`                   | 216 231 528       | 9 %   | The sign of each grid node, and 3 bits on each crossed edge (6.5) |
| `Pref`                | 216 231 528       | 9 %   | Not stored (8.6)                                                  |
| `.faceCounts`         | 144 204 944       | 6 %   | Not stored: all faces have 3 corners (8.4)                        |
| `.selfBnds`           | 12 000            | 0 %   | Not stored: the `position` range is the bounds (3.9)              |

The optimisations, and the step of an `.abc` reader that each one removes:

| `.abc` ([ABC])                                                                                           | `.wabc`                                                                                                                           | Section  |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Ogawa groups, object headers and property headers are walked to find the data (1, 2).                    | One JSON header gives all objects, and the position and length of each chunk.                                                     | 2, 3     |
| Objects are a tree of compounds (2.5).                                                                   | One flat list of nodes. Each node has the index of its parent.                                                                    | 3.4      |
| An Xform stores ops and channel values. `.inherits` can change for each sample (3.4).                    | One evaluated matrix for each sample: world, or local with `.inherits` applied.                                                   | 3.5, 8.2 |
| Faces can have any number of corners (3.2).                                                              | Triangles.                                                                                                                        | 8.4      |
| `N` and `uv` have a scope and can have indices (3.3).                                                    | One value of each attribute for each vertex.                                                                                      | 8.4      |
| `P`, `N` and `uv` are separate `f32` arrays (3.2, 3.3).                                                  | One interleaved vertex buffer, with 16-bit or 8-bit values relative to the bounds.                                                | 4.3, 5   |
| A homogeneous mesh stores all `P` (and `N`) values again for each sample (3.2).                          | One base geometry, and for each sample only position deltas (and normals), in one texture layer.                                  | 6        |
| A heterogeneous mesh, and points whose count changes, store full samples (3.2, 3.5).                     | One full geometry for each sample.                                                                                                | 3.7      |
| `N` is stored for each face corner (3.2, 3.3).                                                           | Flat and smooth normals are not stored. The loader calculates them.                                                               | 8.4      |
| A mesh made from a grid (all demo meshes) stores all points and faces again for each sample (3.2).       | The inside or outside of each grid node, and the position on each crossed grid edge. The loader makes the vertices and triangles. | 6.5      |
| Points store a position and an id for each point (3.5).                                                  | A set of positions on a grid of the point width / 32, without order and ids.                                                      | 6.6      |
| Uniform, cyclic and acyclic time samplings (4.1).                                                        | Uniform and acyclic time samplings.                                                                                               | 3.3, 8.3 |
| The samples of a property can be anywhere in the file, and blocks are shared (1.5).                      | The sample chunks are in time order. A reader can show frame 0 from the first bytes.                                              | 7        |
| A data block is a size and raw bytes (1.4). The sample bytes are the array values, not compressed (7.1). | Each chunk is compressed alone, with deflate or brotli.                                                                           | 4.1      |

The header identifies the source `.abc` file with the SHA-256 digest of all its bytes.

Result (section 11): `demo-nonparticle.abc` (2 305 723 951 bytes) becomes 7 738 098 bytes (0.34 %). `demo-smooth.abc` (1 113 189 646 bytes) becomes 8 726 323 bytes (0.78 %). `demo.abc` (2 506 108 821 bytes) becomes 18 252 661 bytes (0.73 %), with the particles.

**Check**: [ABC] 7.1 (sample value bytes); demo (array sizes of all 250 samples of each property, the same in both files; their sum is 2 307 139 328 bytes, 1 475 261 bytes more than the sample values on disk, because of shared blocks; section 11).

---

## 2. File layout

| Offset            | Size         | Field        | Value                                                              |
| ----------------- | ------------ | ------------ | ------------------------------------------------------------------ |
| 0                 | 4            | magic        | ASCII `WABC` (`57 41 42 43`)                                       |
| 4                 | 4            | version      | `u32`. This document defines version 1.                            |
| 8                 | 4            | headerLength | `u32`. Length of the header in bytes.                              |
| 12                | headerLength | header       | One JSON object, UTF-8, without a byte order mark (section 3).     |
| 12 + headerLength | rest of file | data section | The chunks (section 4), in the order of section 7. No other bytes. |

`dataStart = 12 + headerLength`. Each chunk offset in the header is relative to `dataStart`.

**Check**: /wabc rule (the header gives the byte range of each chunk, so a reader reads only the chunks that it needs; the JSON header of the converted `demo-nonparticle.abc` is 27 005 bytes, 0.35 % of the file, section 11); demo and local (decoders of 0.2).

---

## 3. Header

### 3.1 Rules

- A reader MUST ignore members that this document does not define.
- An `f32` value is a JSON number that is exactly an `f32` value. An `f64` value is a JSON number that gives the `f64` value when it is parsed.
- A chunk reference is an object with `offset` (integer, relative to `dataStart`) and `length` (integer, compressed length in bytes).

**Check**: local (`test-anim.abc`: all 2 524 `f32` values of the header are exact `f32` values after `JSON.parse`, and all 92 `f64` values are unchanged).

### 3.2 Top-level object

| Member               | Type             | Required | Description                                                                                                                        |
| -------------------- | ---------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `writer`             | string           | yes      | Name and version of the program that made the file, for example `"wabc 0.1.0"`.                                                    |
| `source`             | object           | yes      | `file`: file name of the `.abc` file, without directories. `sha256`: SHA-256 digest of all its bytes, 64 lowercase hex characters. |
| `compression`        | string           | yes      | `"deflate"` or `"brotli"` (4.1).                                                                                                   |
| `space`              | string           | yes      | `"world"` or `"local"` (3.5).                                                                                                      |
| `timeSamplings`      | array            | yes      | Time samplings (3.3). MAY be empty.                                                                                                |
| `nodes`              | array            | yes      | Nodes (3.4), parents before children. MAY be empty.                                                                                |
| `extensionsUsed`     | array of strings | no       | Extensions in the file (section 9).                                                                                                |
| `extensionsRequired` | array of strings | no       | Extensions that a reader must support to read the file. Each one MUST also be in `extensionsUsed`.                                 |

**Check**: demo and local (prototype writer and reader; `sha256` of `demo.abc`, `demo-nonparticle.abc` and `flag.abc` is equal to the output of `shasum -a 256`).

### 3.3 Time sampling

| `type`      | Members                                      | Time of sample `i`, in seconds |
| ----------- | -------------------------------------------- | ------------------------------ |
| `"uniform"` | `start` (`f64`), `step` (`f64`, more than 0) | `start + i × step`             |
| `"acyclic"` | `times` (array of `f64`, increasing)         | `times[i]`                     |

An `"acyclic"` time sampling MUST have a time for each sample of each track that uses it. A reader SHOULD map a time to samples with the rules of [ABC] 4.2.

**Check**: [ABC] 4.1, 4.2; demo (both files: one uniform time sampling, `start` = `step` = 1/24 s); local (`test-anim.abc`: uniform, cyclic and acyclic; the cyclic one becomes `"acyclic"`, 8.3).

### 3.4 Node

| Member     | Type    | Required             | Description                                                                                          |
| ---------- | ------- | -------------------- | ---------------------------------------------------------------------------------------------------- |
| `name`     | string  | yes                  | Object name.                                                                                         |
| `path`     | string  | yes                  | Full name of the object, for example `"/Cube/Cube_241"`. Unique in the file.                         |
| `parent`   | integer | yes                  | Index of the parent node, or `-1` for a child of `/`. Less than the index of the node.               |
| `type`     | string  | yes                  | `"group"`, `"mesh"` (PolyMesh) or `"points"` (Points). A reader MUST read other values as `"group"`. |
| `matrix`   | object  | no                   | Matrix track (3.5). If absent, the identity matrix.                                                  |
| `geometry` | object  | `"mesh"`, `"points"` | Geometry track (3.6).                                                                                |

**Check**: [ABC] 2.5, 3.1 (object tree, schemas); demo (`demo.abc`: 3 nodes; `demo-nonparticle.abc`: 2 nodes).

### 3.5 Matrix track

| Member         | Type              | Required            | Description               |
| -------------- | ----------------- | ------------------- | ------------------------- |
| `numSamples`   | integer           | yes                 | 1 or more.                |
| `timeSampling` | integer           | if `numSamples` > 1 | Index in `timeSamplings`. |
| `values`       | array of 16 `f32` | if `numSamples` = 1 | The matrix (0.1).         |
| `chunk`        | chunk reference   | if `numSamples` > 1 | Matrix chunk (4.2).       |

- `"world"`: the matrix is the full transform of the node. The matrices of the parents are already in it. `parent` gives only the object tree.
- `"local"`: the matrix is relative to the parent: `world(n) = local(n) × world(parent)`. A node with parent `-1` has `world(n) = local(n)`.

The geometry of a node is in the space of the node: a point `p` is at `p × world(n)`.

**Check**: [ABC] 3.4 (matrix order, `.inherits`); demo (`/Cube` is a constant identity matrix, so no node has a matrix track, in either space); local (`test-anim.abc`: the world matrices of the `"world"` file and the products of the matrices of the `"local"` file are equal in all elements, at all sample times; the `"world"` file is 0.4 % larger).

### 3.6 Geometry track

| Member                             | Type               | Required                         | Description                                                                                                                                                                            |
| ---------------------------------- | ------------------ | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`                             | string             | yes                              | `"static"`, `"vertex"`, `"swap"`, `"surface"` or `"set"` (3.7).                                                                                                                        |
| `numSamples`                       | integer            | yes                              | 1 for `"static"`. 1 or more for the other modes.                                                                                                                                       |
| `timeSampling`                     | integer            | all modes except `"static"`      | Index in `timeSamplings`.                                                                                                                                                              |
| `normals`                          | string             | no                               | Mesh only. `"flat"` or `"smooth"`: the normals are not stored, the loader calculates them (6.7). If absent, the layout has the `normal` attribute.                                     |
| `positions`                        | string             | no                               | `"delta"`: the `n16` position codes are differences from the vertex before (5.4). If absent, they are codes (5.2).                                                                     |
| `layout`                           | object             | `"static"`, `"vertex"`, `"swap"` | Vertex layout of all geometries of the track (3.8).                                                                                                                                    |
| `base`                             | geometry reference | `"static"`, `"vertex"`           | The geometry (`"static"`), or the base geometry (`"vertex"`, section 6).                                                                                                               |
| `animation`                        | object             | `"vertex"`                       | Layer layout (3.10).                                                                                                                                                                   |
| `grid`, `volume`, `tBits`, `table` |                    | `"surface"`                      | The grid surface (3.11).                                                                                                                                                               |
| `width`, `step`                    | `f32`              | `"set"`                          | The point set (3.12).                                                                                                                                                                  |
| `samples`                          | array              | all modes except `"static"`      | One item for each sample, in sample order: layer references (3.10) for `"vertex"`, geometry references (3.9) for `"swap"`, sample references (3.11, 3.12) for `"surface"` and `"set"`. |

**Check**: demo and local (CLI and decoders of 0.2).

### 3.7 Geometry modes

| Mode        | From `.abc`                                                                                                  | Data                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `"static"`  | A PolyMesh or Points schema that does not change.                                                            | One geometry.                                                                                                                         |
| `"vertex"`  | A homogeneous PolyMesh ([ABC] 3.2), or Points with the same count and `.pointIds` in all samples (8.4, 8.5). | One base geometry, and one layer for each sample with position deltas, and MAY have normals (section 6).                              |
| `"swap"`    | A heterogeneous PolyMesh, or Points whose count or ids change.                                               | One full geometry for each sample. The vertex and index counts can change in each sample.                                             |
| `"surface"` | A PolyMesh made from a grid: each point is on a grid edge, each triangle is in one grid cell (8.4).          | For each sample, the sign of each grid node and the position on each crossed edge (6.5). The loader makes the vertices and triangles. |
| `"set"`     | Points that all have one width, in all samples (8.5).                                                        | For each sample, a set of positions on a grid of `step` (6.6). The point order is not kept.                                           |

A reader MAY blend two samples of a `"vertex"` track (6.4). A reader MUST NOT blend two samples of a `"swap"`, `"surface"` or `"set"` track: their vertices do not match.

**Check**: [ABC] 3.2 (the topology of the demo mesh changes on each frame), 3.5 (the point count changes); demo (`demo.abc`, `Cube_241`: 1 715 of 18 017 986 points of a frame have the position of a point of the frame before it, so the frames share no data; `Liquid`: `.pointIds` is `0 … n − 1` in each frame, and from frame to frame the point with the same id moves 4 % of the box diagonal (median) and up to 25 %; deltas by id would be 51 906 937 bytes against 53 417 923 bytes of full samples, 2.8 % less; thus both demo objects are `"swap"`); local (`test-anim.abc`, `n16`, deflate: the `"vertex"` meshes are 36 % to 61 % of the bytes of the same meshes as `"swap"`; the `"vertex"` points track is 99.7 %; with `f32`, 41 % to 72 %, and 75 % for the points).

### 3.8 Vertex layout

| Member       | Type    | Required | Description                                                                                      |
| ------------ | ------- | -------- | ------------------------------------------------------------------------------------------------ |
| `stride`     | integer | yes      | Bytes per vertex. A multiple of 4, 4 or more.                                                    |
| `attributes` | array   | yes      | Objects with `name` (unique), `format` (5.1) and `offset` (byte in the vertex, a multiple of 4). |

`offset + size(format)` MUST NOT be more than `stride`. Attributes MUST NOT overlap. Bytes that no attribute uses MUST be 0.

| Name       | Node type    | Source ([ABC])                 | Formats                  |
| ---------- | ------------ | ------------------------------ | ------------------------ |
| `position` | mesh, points | `P` (3.2, 3.5)                 | `f32x3`, `n16x4`         |
| `normal`   | mesh         | `N` (3.3), or calculated (8.4) | `f32x3`, `n16x4`, `n8x4` |
| `uv`       | mesh         | `uv` (3.3)                     | `f32x2`, `n16x2`         |
| `width`    | points       | `.widths` (3.5)                | `f32`, `n16x2`           |

A mesh MUST have `position`, and `normal` if its track has no `normals` member (3.6). Points MUST have `position`. A writer MAY add attributes whose name starts with `_`. A reader MAY ignore them.

**Check**: /wabc rule (each attribute starts at a multiple of 4 bytes and has a size that is a multiple of 4, so that the vertex buffer is GPU-ready without a copy; demo, `demo.abc`: this costs 3.6 %, 542 867 712 bytes of mesh chunks with `n16x4` against 524 178 134 bytes with 3 components; the `Liquid` widths are 0.05 in all points of all frames, and the `width` attribute (all codes 0, 5.2) changes the size of the points chunks by −1.1 %, 52 846 464 against 53 419 581 bytes, so a constant width needs no other form).

### 3.9 Geometry reference

A chunk reference (3.1) with these members:

| Member         | Type    | Required                                          | Description                                                            |
| -------------- | ------- | ------------------------------------------------- | ---------------------------------------------------------------------- |
| `vertexCount`  | integer | yes                                               | 0 or more.                                                             |
| `indexCount`   | integer | yes                                               | A multiple of 3. 0 for points, and for a mesh without an index buffer. |
| `quantization` | object  | if the layout has an attribute with a range (5.1) | Key: attribute name. Value: range.                                     |

A range has `center` and `extent`: arrays of `f32`, one value for each component of the value (3 for `position`, 2 for `uv`, 1 for `width`). Each `extent` value is 0 or more. Each decoded value is in `[center − extent, center + extent]`. Thus the `position` range is a bounding box of the geometry, and replaces `.selfBnds` ([ABC] 3.1).

A mesh with `indexCount` 0 has no index buffer: triangle `t` is vertices `3t`, `3t + 1` and `3t + 2`. Its `vertexCount` MUST be a multiple of 3.

**Check**: [ABC] 3.1 (`.selfBnds`); 5.3 (a decoded value is `center + f × extent` with `−1 ≤ f ≤ 1`); demo and local (the prototype writer makes each `position` range from all positions of its geometry, 5.2).

### 3.10 Animation object and layer reference

The animation object of a `"vertex"` track. All members are required.

| Member        | Type    | Description                                                                                           |
| ------------- | ------- | ----------------------------------------------------------------------------------------------------- |
| `format`      | string  | Texel format: `"n16x4"` or `"f32x4"` (5.1).                                                           |
| `texelStride` | integer | Texels for each vertex: 1 (position delta) or 2 (position delta and normal).                          |
| `width`       | integer | Texels in one row of a layer. 1 or more.                                                              |
| `height`      | integer | Rows of a layer: `ceil(max(vertexCount × texelStride, 1) / width)`, with the `vertexCount` of `base`. |

A layer reference is a chunk reference (3.1). With the `"n16x4"` format it also has `delta`: the range (3.9) of the position deltas of the layer.

**Check**: local (`test-anim.abc`: prototype writer and reader, all `"vertex"` tracks, both formats).

### 3.11 Surface track

| Member    | Type    | Description                                                                                                                                   |
| --------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `normals` | string  | `"flat"` or `"smooth"` (6.7). Required.                                                                                                       |
| `grid`    | object  | `origin` and `spacing`: 3 `f64` each. Grid node `(i, j, k)` is at `origin + (i, j, k) × spacing`, on each axis.                               |
| `volume`  | object  | `first`: 3 integers, the grid node of volume node `(0, 0, 0)`. `size`: 3 integers, the nodes on each axis. All samples use it.                |
| `tBits`   | integer | Bits of the position on a crossed edge: 1 to 8 (6.5).                                                                                         |
| `table`   | object  | Key: a cell case (6.5), as a decimal string. Value: the local edges of its triangles, 3 for each triangle. One key for each case of the file. |

A sample reference is a chunk reference (3.1) with `vertexCount` (the crossed edges of the sample) and `triangleCount` (the triangles of the source sample). Volume node `(x, y, z)` has the index `x + y × size[0] + z × size[0] × size[1]`.

**Check**: demo (`demo-nonparticle.abc`: volume 240 × 145 × 264 nodes, spacing 0.010824968 on each axis, 252 cell cases; `demo-smooth.abc`: 233 × 145 × 264 nodes, the same spacing, 252 cell cases).

### 3.12 Set track

| Member  | Type  | Description                                              |
| ------- | ----- | -------------------------------------------------------- |
| `width` | `f32` | The width of all points of all samples. Required.        |
| `step`  | `f32` | The size of a cell of the position grid (6.6). Required. |

A sample reference is a chunk reference (3.1) with `vertexCount` (the points of the sample) and `origin` (3 `f32`: the corner of the position grid of the sample).

**Check**: demo (`demo.abc`, `Liquid`: width 0.05 in all points of all frames, step 0.0015625).

---

## 4. Chunks

### 4.1 Compression

Each chunk is compressed alone:

- `"deflate"`: one zlib stream (RFC 1950) with the deflate method (RFC 1951).
- `"brotli"`: one brotli stream (RFC 7932).

Sections 4.2 to 4.6 describe the bytes after decompression. Appendix B gives the size of each chunk after decompression.

**Check**: demo (the chunks of frames 124 and 249 of `demo.abc`: brotli quality 11 is 19 % to 25 % smaller than deflate level 6, and zstd level 19 is 6 % to 11 % smaller; brotli takes 54 to 113 times as long as deflate to compress, and 1 to 3 times as long to decompress; deflate level 9 is within 0.05 % of level 6 on frames 49, 99, 149, 199 and 249); local (`test-anim.abc`: brotli is 17 % smaller than deflate). The surface and set chunks (4.5, 4.6) are arithmetic-coded already: deflate makes them 0.06 % larger in `demo-nonparticle.abc` and `demo-smooth.abc`, 1.5 % larger for `swarm` in `test-anim.abc`, and 62 % larger for the 3 samples of 2 to 4 points in `flag.abc`.

### 4.2 Matrix chunk

`numSamples × 16` `f32` values. Sample `i` is the 16 values from value `16i`.

**Check**: local (`test-anim.abc`, `flag.abc`).

### 4.3 Geometry chunk

| Field    | Size                      | Content                                                                            |
| -------- | ------------------------- | ---------------------------------------------------------------------------------- |
| vertices | `vertexCount × stride`    | Vertex `v` at byte `v × stride`. Each attribute at byte `v × stride + offset`.     |
| indices  | `indexCount × 2` or `× 4` | `u16` if `vertexCount` ≤ 65536, else `u32`. Each index is less than `vertexCount`. |

The index buffer starts at a multiple of 4 bytes, because `stride` is a multiple of 4.

**Check**: local (`test-anim.abc`, `flag.abc`: `u16` indices); demo (a prototype run with index buffers: `u16` for frame 0, `u32` for frames 124 and 249 of `demo.abc`; the final files have no index buffer, 8.4).

### 4.4 Layer chunk

`width × height` texels. Texel `t` is in column `t % width` and row `floor(t / width)`, at byte `t × texelSize`. `texelSize` is 8 for `"n16x4"` (4 `i16`) and 16 for `"f32x4"` (4 `f32`). Section 6 gives the content of each texel.

**Check**: local (`test-anim.abc`).

### 4.5 Surface sample chunk

One arithmetic-coded stream (5.5), with new models for each chunk. It needs the signs of the sample before it; sample 0 uses all signs 0. A sign is 1 inside and 0 outside.

1. **Signs.** The volume is cut into blocks of 8 × 8 × 8 nodes (smaller at the high ends). The blocks are in index order of their first node (x changes fastest, then y, then z). For each block: a flag with the model `blocks[last]`, `last` being the flag of the block before (1 for the first block). Flag 1: each node of the block has the sign of the sample before. Flag 0: each node of the block, in node index order, is one bit with the model `nodes[c]`:

```
c = s(x − 1, y, z) | s(x, y − 1, z) << 1 | s(x, y, z − 1) << 2
  | p(x, y, z) << 3 | p(x + 1, y, z) << 4 | p(x, y + 1, z) << 5 | p(x, y, z + 1) << 6
```

`s` is the sign in this sample, `p` the sign in the sample before. A node outside the volume has the sign 0.

2. **Edge positions.** The crossed edges are the edges `(node, axis)` from a node to the next node on `axis` (axis 0, 1, 2 in this order), in node index order, where the 2 nodes have different signs. For each crossed edge: a code of `tBits` bits, with the bit tree `t` (5.5).

Models: `blocks` 2, `nodes` 128, `t` 2^(tBits + 1), all with the start value of 5.5.

**Check**: demo (all 250 frames of the 2 surface tracks decode in order, and each sample gives `vertexCount` crossed edges).

### 4.6 Set sample chunk

One arithmetic-coded stream (5.5), with new models for each chunk. For each of the `vertexCount` points, a gap `g` (0 or more) is coded as `v = g + 1`:

1. the bit length `n` of `v` in unary: bit 1 with the model `lengths[i]` for `i = 1 … n − 1`, then bit 0 with `lengths[n]`;
2. the `n − 1` bits of `v` after its top bit, from the highest: bit `j` (0 for the first) with the model `bits[n × 9 + min(j, 8)]`.

Models: `lengths` 65, `bits` 64 × 9, with the start value of 5.5. The key of point `i` is the sum of the gaps of points 0 to `i` (6.6).

**Check**: demo (`demo.abc`, `Liquid`: all frames decode; frames 0, 25, …, 225, 249 give the same set of cells as the source, 0 points missing).

---

## 5. Value encoding

### 5.1 Formats

| Format  | Components | Type  | Size | Range (3.9)                                                        |
| ------- | ---------- | ----- | ---- | ------------------------------------------------------------------ |
| `f32`   | 1          | `f32` | 4    | none                                                               |
| `f32x2` | 2          | `f32` | 8    | none                                                               |
| `f32x3` | 3          | `f32` | 12   | none                                                               |
| `f32x4` | 4          | `f32` | 16   | none (layers only)                                                 |
| `n8x4`  | 4          | `i8`  | 4    | `normal` only, fixed: `center` 0, `extent` 1                       |
| `n16x2` | 2          | `i16` | 4    | `uv`, `width`                                                      |
| `n16x4` | 4          | `i16` | 8    | `position`, layer `delta`; `normal`: fixed, `center` 0, `extent` 1 |

The value uses the first components: 3 for `position` and `normal`, 2 for `uv`, 1 for `width`. The other components MUST be 0.

**Check**: demo (the length of each `N` value is 1 ± 1.8·10⁻⁷ in all frames, so the fixed range holds all normals).

### 5.2 Encoding

With `center` and `extent` of the component, and `m = 32767` (`n16`) or `m = 127` (`n8`):

```
code = 0                                                  if extent = 0
code = clamp(round((x − center) × m / extent), −m, m)    in all other cases
```

The code `−m − 1` MUST NOT be used. A writer SHOULD make each range from the values of the geometry, or of the layer:

```
center = f32((min + max) / 2)
extent = the smallest f32 value with center − extent ≤ min and center + extent ≥ max
```

An `f32` value is the `f32` value of the source value.

**Check**: demo, `demo.abc`, all frames (`n16` positions: error at most 0.5 step; the steps are from 4.9·10⁻⁷ to 4.3·10⁻⁵, the errors at most 2.2·10⁻⁵; 22 217 of 36 051 236 triangles get zero area, 0.06 %, at most 273 in one frame, against 130 in the source; `n16` normals: at most 0.0015° from `N`; `n8` normals: at most 0.39° from `N`, and the mesh chunks are 22 % smaller, 421 725 591 against 542 867 712 bytes; `demo-nonparticle.abc` gives the same values, with 22 221 zero-area triangles); local (prototype reader: all values within 0.5 step).

### 5.3 Decoding

```
x = center + max(code / m, −1) × extent
```

**Check**: demo and local (prototype reader).

### 5.4 Delta positions

With `positions` `"delta"` (3.6), the 3 `n16` position values of vertex `v` are `d(v) = code(v) − code(v − 1)`, with `code(−1) = 0`, kept to 16 bits (two's complement wrap). The loader gets `code(v) = code(v − 1) + d(v)`, kept to 16 bits, then decodes it (5.3). The writer SHOULD put the vertices in the order of a Morton curve over the box of the sample (8.5).

**Check**: local (`test-anim.abc`, `spray`: 14 368 bytes; `test-render.abc`, `points`); demo (`demo.abc`, `Liquid` with this form and not 6.6: 45 651 651 bytes, against 52 846 464 bytes with codes, −13.6 %).

### 5.5 Arithmetic coding

A binary arithmetic coder with a 32-bit range. A model is a `u16` `p`: the chance of bit 1, × 65536. Each model starts at 32768.

Encoder: `low = 0`, `high = 2^32 − 1`. To code `bit` with model `p`:

```
middle = low + floor((high − low) × p / 65536)
bit = 1: high = middle        bit = 0: low = middle + 1
p = bit ? p + ((65536 − p) >> 5) : p − (p >> 5), then clamp(p, 32, 65504)
while the top bytes of low and high are equal:
  output the top byte of high
  low = (low << 8) mod 2^32,  high = ((high << 8) | 255) mod 2^32
```

At the end, the encoder outputs the 4 bytes of `low`, top byte first.

Decoder: `value` is the first 4 bytes, top byte first. A byte after the end of the stream is 0. To decode with model `p`: the same `middle`, `bit = value ≤ middle ? 1 : 0`, the same changes of `low`, `high` and `p`, and in the loop also `value = ((value << 8) | next byte) mod 2^32`.

The product `(high − low) × p` is less than 2^48, so it is exact in `f64`.

A bit tree of `n` bits with the models `m`: `node = 1`; for each bit from the highest, code it with `m[node]`, then `node = 2 × node + bit`. The value is `node − 2^n`.

**Check**: demo and local (the decoders of 0.2 give the same signs, edge codes and point cells as the writer, in all decoded samples).

---

## 6. Samples rebuilt by the loader

### 6.1 Texels

A `"vertex"` track stores sample `i` as layer `i`. With `s = texelStride`, the texels of vertex `v` of `base` are:

| Texel       | Components 0, 1, 2        | Component 3 |
| ----------- | ------------------------- | ----------- |
| `v × s`     | Position delta            | 0           |
| `v × s + 1` | Normal (only if `s` is 2) | 0           |

The texels from `vertexCount × s` to the end of the layer MUST be 0.

**Check**: local (`test-anim.abc`).

### 6.2 Positions

```
position(i, v) = basePosition(v) + delta(i, v)
```

- `basePosition(v)`: the decoded `position` of vertex `v` of `base` (5.3).
- `delta(i, v)`: texel `v × s` of layer `i`: the `f32` values (`"f32x4"`), or the codes decoded with the `delta` range of the layer reference (`"n16x4"`).

The writer MUST calculate `delta = sourcePosition − basePosition` in `f64`, with the decoded `basePosition`. Thus the error of `base` does not add to the error of the samples.

The writer SHOULD make each position value of `base` the middle of the range of that value over all samples: `(min + max) / 2`. Then each delta is at most half of the motion of its value, and the `n16` step of a layer is not more than the step of the same sample stored in full.

The bounding box of sample `i` is in the box of the `position` range of `base` plus the box of the `delta` range of layer `i`.

**Check**: local (`test-anim.abc`, `n16`, the largest step of all layers of each track: with the middle as `base`, from 9.1·10⁻¹³ to 3.75·10⁻⁵, and never more than the step of the full samples; with sample 0 as `base`, up to 7.3·10⁻⁵, 1.9 times the step of the full samples for the points track; the layers are 2 % to 5 % larger with the middle as `base`; all positions within 0.5 step).

### 6.3 Normals

- `s` = 2: the normal of vertex `v` in sample `i` is texel `v × s + 1` of layer `i`. It is not a delta. The `normal` attribute of `base` is not used. With `"n16x4"`, its range is fixed: `center` 0, `extent` 1.
- `s` = 1: the normal of vertex `v` is the `normal` attribute of `base`, in all samples.

The writer MUST use `s` = 2 if the normals are not the same in all samples. Points use `s` = 1.

**Check**: local (`test-anim.abc`: animated `N` (`wave`, `twist`), calculated normals of an animated mesh (`blob`), and a constant `N` of an animated mesh (`slide`, `s` = 1)).

### 6.4 Blending

For a time between samples `i` and `j`, with `alpha` from [ABC] 4.2:

```
position = position(i, v) + (position(j, v) − position(i, v)) × alpha
normal   = normalize(normal(i, v) + (normal(j, v) − normal(i, v)) × alpha)
```

`basePosition` is the same in both samples, so a reader can blend only the deltas.

**Check**: [ABC] 4.2 (floor and ceil samples, `alpha`).

### 6.5 Grid surfaces

The loader makes the mesh of a `"surface"` sample from its signs and edge codes (4.5).

- **Vertices.** Vertex `i` is crossed edge `i`. On the edge axis, its grid coordinate is the node coordinate plus `(code + 0.5) / 2^tBits`. Its position is `origin + (first + local) × spacing` on each axis (3.11).
- **Cells.** Cell `c` has its lowest node at volume node `c`, and corner `k` at `c + (k & 1, k >> 1 & 1, k >> 2 & 1)`. Its case is the number with bit `k` equal to the sign of corner `k`.
- **Local edges.** Edge `4a + u + 2v` of a cell is on axis `a`, at offset `u` and `v` on the 2 other axes, in increasing axis order: x edges are 0 to 3, y edges 4 to 7, z edges 8 to 11.
- **Triangles.** Each cell with a crossed edge gives the triangles of `table[case]`. Each local edge gives the vertex of that crossed edge. A cell case that is not in `table` makes the file invalid.

The triangles keep the clockwise order of the source faces (8.4). The loader MAY put the triangles in any order.

A vertex is at most `spacing / 2^(tBits + 1)` from its source point on the edge axis, and at most `spacing / 1000` on each other axis: the writer puts coordinates closer than that onto the grid planes (8.4). A source point on a node can also be `spacing / 1000` off on the edge axis.

**Check**: demo (`demo-nonparticle.abc`, `tBits` 3, spacing 10.82 mm, bound 0.6766 mm: frames 125 and 249: points on an edge at most 0.6766 mm on the edge axis, points on a node at most 0.6861 mm, at most 0.0107 mm on the other axes; frames 0, 25, …, 225, 249 of `demo-nonparticle.abc` and `demo-smooth.abc`: 99.946 % and 99.944 % of the source triangles are rebuilt with the same points; the other triangles are in cells around source points on a node (8.4)).

### 6.6 Point sets

The key of a point is its cell `(i, j, k)` on the grid of `step` from `origin` (3.12), with bit `b` of `i`, `j`, `k` at bit `3b`, `3b + 1`, `3b + 2` of the key (`b` < 17). The keys of a sample increase. The position of the point is `origin + (cell + 0.5) × step` on each axis, and its width is `width`.

On each axis, a point is at most `step / 2` from the source point.

**Check**: demo (`demo.abc`, `Liquid`: at most 0.78 mm on each axis, step 1.5625 mm; 10.08 bits for each point on frames 0, 10, …, 240).

### 6.7 Normals made by the loader

- `"flat"`: each triangle `(a, b, c)` has the normal `normalize((c − a) × (b − a))` at its 3 corners.
- `"smooth"`: each vertex has the normalized sum of `(c − a) × (b − a)` of all triangles that use it (8.4).

**Check**: [ABC] 3.2 (the faces are clockwise when seen from the side of `N`); demo (8.4).

---

## 7. Chunk order

The data section contains all chunks in this order, without gaps. The first offset is 0, and each next offset is the end of the chunk before it.

1. Matrix chunks, in node order.
2. Geometry chunks of `"static"` tracks and `base` chunks of `"vertex"` tracks, in node order.
3. Sample chunks (geometries of `"swap"` tracks and layers of `"vertex"` tracks), in the order of the time of the sample (3.3). Chunks with the same time are in node order.

Thus:

- Parts 1 and 2 are first. They contain all matrices and all data that does not change over time.
- The sample chunks of one time (one frame) are one contiguous byte range.
- A reader can show time `t` when it has the bytes up to the end of the last sample chunk with a time not more than `t`. To blend to the next sample, it also needs the next frame.
- A `"surface"` sample needs the signs of the sample before it (4.5). Thus a reader decodes the samples of a surface track in order, from sample 0.

**Check**: demo (prototype reader: offsets are contiguous, the parts are in order, the times do not decrease; the first frame of the converted `demo.abc` is in its first 173 574 bytes, section 11); local.

---

## 8. Conversion from `.abc`

### 8.1 Nodes

- One node for each object, except `/`. The children of `/` have the parent `-1`.
- `name` and `path` are the object name and the full name.
- `"mesh"`: `AbcGeom_PolyMesh_v1`. `"points"`: `AbcGeom_Points_v1`. `"group"`: `AbcGeom_Xform_v3` and all other objects ([ABC] section 5). The children of all objects are kept.
- The writer MAY omit a group with no mesh or points below it.
- In `"world"` space, the writer MAY omit any group. Its children then get the parent of the group. In `"local"` space, only groups with no nodes below them MAY be omitted.

**Check**: [ABC] 3.1, section 5 (the children of skipped objects are read).

### 8.2 Matrices

The local matrix of an Xform sample is the matrix of [ABC] 3.4, as `f32` values. The local matrix of other objects is the identity matrix.

- `"local"`: the matrix is the local matrix. If `.inherits` of the sample is `false`, the writer stores `local × inverse(world(parent))`, so that `world(n) = local`. If `world(parent)` has no inverse, the writer stores `local`.
- `"world"`: the matrix is the product of the local matrices of the node and its parents, with the `.inherits` rule of [ABC] 3.4, at each time of the track. The track SHOULD use the time sampling with the most samples of the node and its animated parents.

A track with all samples equal SHOULD have 1 sample. A track with only identity matrices SHOULD be omitted.

**Check**: [ABC] 3.4; demo (`/Cube`: omitted); local (`test-anim.abc`: translate, rotate and matrix ops, with shear; the `"world"` and `"local"` files give equal world matrices).

### 8.3 Time samplings

- Uniform ([ABC] 4.1): `"uniform"`, `start` = `storedTimes[0]`, `step` = `timePerCycle`.
- Cyclic and acyclic: `"acyclic"`, with the time of each sample that the tracks use.
- Each time sampling SHOULD be stored once. A time sampling that no track uses SHOULD NOT be stored.

**Check**: [ABC] 4.1; local (`test-anim.abc`: 474 sample times of uniform, cyclic and acyclic tracks; all are equal to the `/alembic` sample times).

### 8.4 PolyMesh

For each sample:

1. **Vertices.** Each face corner has a point (`.faceIndices`) and its `N` and `uv` values, with the scope and indices of [ABC] 3.3. Face corners with the same point, `N` value and `uv` value SHOULD be one vertex. In the `"vertex"` mode, two face corners MUST be one vertex only if they are the same in all samples.
2. **No index buffer.** If no vertex is used by two face corners, the writer SHOULD store the vertices in triangle order, with `indexCount` 0.
3. **Triangles.** A face with `n` corners gives `n − 2` triangles. A face with less than 3 corners gives none. The corners of each triangle keep the order of the face: clockwise when seen from the side that `N` points to ([ABC] 3.2).
4. **Normals.** If the sample has no `N`, the writer calculates the normal of each vertex: the normalized sum of `(c − a) × (b − a)` over all triangles `(a, b, c)` that use the vertex.
5. **uv.** `uv` is stored without change.

Normals of the track:

- `"flat"`: all corners of a face have the same `N`, within 1° of the face normal `(c − a) × (b − a)` (Newell sum for more corners), for at least 99.9 % of all faces of the track.
- `"smooth"`: the mesh has no `N`, or `N` of each corner is within 1° of the normalized sum of the face normals at its point, for at least 99.9 % of all corners of the track.
- Else the normals are stored (`normal` attribute, no `normals` member).

Mode, the first that fits:

- `"static"`: the schema and its `N` and `uv` do not change.
- `"surface"`: the normals are `"flat"` or `"smooth"`, the mesh has no `uv`, all faces have 3 corners, and there is one grid (`spacing`, `origin`) for all samples where:

  - each point has at least 2 coordinates on grid planes (closer than `spacing / 1000`), so it is on a grid edge or a grid node;
  - the signs of the nodes follow from the points: nodes joined by edges without a point have one sign, an edge with a point has 2 signs, the volume margin is outside;
  - each edge with a sign change has one point on it or on one of its nodes, and each point on an edge is on an edge with a sign change;
  - each triangle whose points are on edges is in one cell, and all cells with the same case have the same triangles in all samples;
  - each case of a cell around a point on a node is in the table of the other cells.

  The table and the edge codes come from these points: `code = min(floor(t × 2^tBits), 2^tBits − 1)`, with `t` the position of the point on its edge (0 or 1 for a point on a node).

- `"vertex"`: the point count, `.faceIndices`, `.faceCounts`, the `uv` values and indices, and the `N` indices are the same in all samples. Only `P` and `N` values change.
- `"swap"`: all other cases.

**Check**: [ABC] 3.2 (all demo faces have 3 corners, `N` is `fvr` and not indexed, the faces are clockwise from the side of `N`, and `N` is opposite on 3 faces), 3.3; demo (all 36 051 236 faces have the same `N` at their 3 corners, and only 2 points have one `N`; thus 108 153 222 of 108 153 708 face corners are separate vertices; with merged vertices and an index buffer the mesh chunks are 822 554 437 bytes, without an index buffer 542 867 712 bytes, 34 % less; in frame 249, `N` is up to 9.5° from the normal of its face, so `N` is stored and not calculated); local (`test-anim.abc`: in all meshes without `N` (`blob`, `box`, `sheared_box`, `disc`, `grow`), each triangle with a non-zero area has its calculated normals on the side of `(c − a) × (b − a)`; `twist` has an `N` that is opposite to that side on all its faces in the file, and it is stored without change; `flag.abc`: the indexed face-varying `uv` gives 6 vertices for 8 face corners). Normals: demo (`demo-nonparticle.abc`: 4 817 of 36 051 236 faces are more than 1° off, 0.013 %, so `"flat"`; frame 0 alone is over 0.1 %; `demo-smooth.abc` has no `N`: `"smooth"`; `demo.abc` with the mesh in `"swap"` and `"flat"` normals: 226 133 470 bytes, against 546 144 486 bytes with stored normals); local (stored: analytic `N` of a low sphere, a constant `N` and the `twist` `N`; `"flat"`: cubes, n-gons; `"smooth"`: meshes without `N`). Surface: demo (all points of all frames of `demo-nonparticle.abc` and `demo-smooth.abc` are within `spacing / 1000` of 2 planes; 99.84 % to 99.94 % of the triangles of frames 124, 125, 200, 201, 248 and 249 are in one cell; `demo-nonparticle.abc`: 252 cases, and 205 cases of cells around points on nodes, all in the table; 771 of the 794 090 points of frames 0, 25, …, 225, 249 are on a node, 0.1 %); local (no test mesh is a grid surface: all keep their earlier mode).

### 8.5 Points

For each sample, vertex `v` is point `v`. `position` is `P`. With `.widths`, `width` is the width of each point (scope `constant`: the same width for all points).

The Mode, the first that fits:

- `"set"` (animated points): all points of all samples have one width. `step` = width / 32 (a writer option). The position grid of a sample starts at the smallest position of the sample, as `f32` on each axis.
- `"vertex"`: the point count and `.pointIds` are the same in all samples.
- `"swap"`: all other animated cases. With `n16` positions the vertices SHOULD be in Morton order with `positions` `"delta"` (5.4).

**Check**: [ABC] 3.5; demo (3.7; `demo.abc`, `Liquid`: `"set"` gives 10 483 170 bytes, against 45 651 651 bytes with delta positions and 52 846 464 bytes with codes; the `.pointIds` are `0 … n − 1`, so the order has no meaning, 3.7); local (`test-anim.abc`: `swarm` is `"set"`, `spray` is `"swap"`).

### 8.6 Data not stored

Object and property metadata, `.userProperties`, `.arbGeomParams` (for example `Pref`), `.velocities`, `.pointIds`, `visible`, `.selfBnds`, `.childBnds`, and the schemas of [ABC] section 5. An extension MAY store them.

**Check**: [ABC] 6.1 (`.velocities` is a copy of `P` in `demo.abc`), 6.2, 6.3; demo (`Pref`: 216 231 528 bytes; `.pointIds`: 66 967 360 bytes, `0 … n − 1` in each frame; `.selfBnds` of `Cube_241`: 12 000 bytes).

---

## 9. Versions and extensions

- A reader MUST reject a version that it does not support.
- A change that a version 1 reader cannot read correctly, when it ignores unknown members, needs a new version.
- An extension has a name: a prefix in capital letters, `_`, and lowercase words, for example `WTL_face_sets`.
- An extension MAY add an `extensions` object to each header object, with the extension name as the key.
- An extension MAY add chunks. The header gives them with chunk references. The extension defines their place in the order of section 7.
- Each extension in the file MUST be in `extensionsUsed`. An extension without which the file cannot be read correctly MUST also be in `extensionsRequired`.
- A reader MUST reject a file with an unsupported name in `extensionsRequired`, and MUST ignore the other unsupported extensions.

**Check**: /wabc rule (the data of 8.6 and the schemas of [ABC] section 5 can be added later without a new version).

---

## 10. Reader validation

Before a reader allocates memory or reads a chunk, it MUST check:

- the magic, the version, `compression` and `extensionsRequired`
- `headerLength ≤ fileLength − 12`, and the header is valid JSON with the required members
- each node, parent and time sampling index is in its array, and each `parent` is less than the index of its node
- `offset + length` of each chunk is not more than the length of the data section
- the size of each chunk after decompression is equal to Appendix B (stop at that size)
- each index of an index buffer is less than `vertexCount`
- a `"surface"` sample gives `vertexCount` crossed edges, and each of its cell cases is in `table`
- each key of a `"set"` sample is less than 2^51 (cells less than 2^17 on each axis)

A reader SHOULD set limits for `vertexCount`, `indexCount`, `numSamples`, `width × height`, the volume node count of a surface track, and the decompressed size of a surface or set chunk (Appendix B).

**Check**: demo and local (the prototype reader does all these checks on all chunks).

---

## 11. Byte accounting

The CLI converted the 3 demo files with its default options: `"world"` space, deflate, `n16` formats, `tBits` 3, point precision 32. The decoders of 0.2 read every chunk back with the checks of section 10. All bytes are in exactly one range: the first 12 bytes, the header, or one chunk.

| Range                          | `demo.abc` (2 506 108 821 bytes) | `demo-nonparticle.abc` (2 305 723 951 bytes) | `demo-smooth.abc` (1 113 189 646 bytes) |
| ------------------------------ | -------------------------------- | -------------------------------------------- | --------------------------------------- |
| First 12 bytes                 | 12                               | 12                                           | 12                                      |
| Header                         | 58 398                           | 27 005                                       | 27 055                                  |
| `/Cube/Liquid` (`"set"`)       | 10 483 170                       |                                              |                                         |
| `/Cube/Cube_241` (`"surface"`) | 7 711 081                        | 7 711 081                                    | 8 699 256                               |
| **Total**                      | **18 252 661**                   | **7 738 098**                                | **8 726 323**                           |
| Share of the `.abc` file       | 0.73 %                           | 0.34 %                                       | 0.78 %                                  |
| Bytes to show frame 0          | 59 356                           | 27 579                                       | 27 631                                  |
| Mean frame                     | 72 777                           | 30 844                                       | 34 797                                  |
| Largest frame                  | 154 936                          | 63 406                                       | 54 915                                  |

No demo file has a matrix track or a static geometry: `/Cube` is a constant identity matrix (3.5), and all geometries change on each frame (3.7). Thus parts 1 and 2 are empty, and the frames follow the header.

**Check**: demo (CLI and decoders of 0.2, all 250 frames of the 3 files; the totals are equal to the file sizes).

---

## 12. References

- [ABC] `src/alembic/FORMAT.md`: the `.abc` file format.
- RFC 1950 (zlib), RFC 1951 (deflate), RFC 7932 (brotli), RFC 8259 (JSON), RFC 3629 (UTF-8), FIPS 180-4 (SHA-256), IEEE 754-2019 (`f32`, `f64`).

---

## Appendix A. Worked example

`flag.abc` (4 249 bytes) was made with libAlembic 1.8.12. All its animated properties use one uniform time sampling with 3 samples, at 1/24 s, 2/24 s and 3/24 s.

| Object      | Schema   | Samples | Content                                                                                      |
| ----------- | -------- | ------- | -------------------------------------------------------------------------------------------- |
| `/rig`      | Xform    | 3       | Translate op `(0, 0.1 × i, 0)` in sample `i`.                                                |
| `/rig/flag` | PolyMesh | 3       | 2 quads, 6 points, indexed face-varying `uv`, no `N`. Points 1 and 4 move on z by `0.1 × i`. |
| `/ground`   | PolyMesh | 1       | 1 quad, 4 points, `.faceIndices` `(0, 3, 2, 1)`, no `N`.                                     |
| `/sparks`   | Points   | 3       | 2, 3 and 4 points at `(0.2 × k, 1.5 + 0.1 × i, 0)`, `.pointIds` `0 … n − 1`, `.widths` 0.05. |

The CLI converted it with its default options (`"world"` space, `n16` formats, deflate, point precision 32): 2 359 bytes.

### A.1 First 12 bytes

```
57 41 42 43   magic "WABC"
01 00 00 00   version 1
1c 08 00 00   headerLength 2076
```

`dataStart = 12 + 2076 = 2088`. The data section has 271 bytes.

### A.2 Header

The file stores this JSON without spaces and line breaks:

```json
{
  "writer": "wabc 0.0.0",
  "compression": "deflate",
  "source": {
    "file": "flag.abc",
    "sha256": "0ded8cee120a639a6f6170b252e04f32b62536de14901041c50e22221c992f42"
  },
  "space": "world",
  "timeSamplings": [
    {
      "type": "uniform",
      "start": 0.041666666666666664,
      "step": 0.041666666666666664
    }
  ],
  "nodes": [
    {
      "name": "rig",
      "path": "/rig",
      "parent": -1,
      "type": "group",
      "matrix": {
        "numSamples": 3,
        "timeSampling": 0,
        "chunk": { "offset": 0, "length": 30 }
      }
    },
    {
      "name": "flag",
      "path": "/rig/flag",
      "parent": 0,
      "type": "mesh",
      "matrix": {
        "numSamples": 3,
        "timeSampling": 0,
        "chunk": { "offset": 30, "length": 30 }
      },
      "geometry": {
        "mode": "vertex",
        "numSamples": 3,
        "timeSampling": 0,
        "normals": "smooth",
        "layout": {
          "stride": 12,
          "attributes": [
            { "name": "position", "format": "n16x4", "offset": 0 },
            { "name": "uv", "format": "n16x2", "offset": 8 }
          ]
        },
        "base": {
          "offset": 60,
          "length": 53,
          "vertexCount": 6,
          "indexCount": 12,
          "quantization": {
            "position": {
              "center": [0.5, 0.5, 0.05000000074505806],
              "extent": [0.5, 0.5, 0.05000000074505806]
            },
            "uv": { "center": [0.5, 0.5], "extent": [0.5, 0.5] }
          }
        },
        "animation": { "format": "n16x4", "texelStride": 1, "width": 6, "height": 1 },
        "samples": [
          {
            "offset": 143,
            "length": 24,
            "delta": {
              "center": [0, 0, -0.05000000074505806],
              "extent": [0, 0, 0.05000000074505806]
            }
          },
          {
            "offset": 184,
            "length": 12,
            "delta": { "center": [0, 0, 0], "extent": [0, 0, 0] }
          },
          {
            "offset": 219,
            "length": 24,
            "delta": {
              "center": [0, 0, 0.05000000074505806],
              "extent": [0, 0, 0.05000000074505806]
            }
          }
        ]
      }
    },
    {
      "name": "ground",
      "path": "/ground",
      "parent": -1,
      "type": "mesh",
      "geometry": {
        "mode": "static",
        "numSamples": 1,
        "normals": "smooth",
        "layout": {
          "stride": 8,
          "attributes": [{ "name": "position", "format": "n16x4", "offset": 0 }]
        },
        "base": {
          "offset": 113,
          "length": 30,
          "vertexCount": 4,
          "indexCount": 6,
          "quantization": { "position": { "center": [0, 0, 0], "extent": [2, 0, 2] } }
        }
      }
    },
    {
      "name": "sparks",
      "path": "/sparks",
      "parent": -1,
      "type": "points",
      "geometry": {
        "mode": "set",
        "numSamples": 3,
        "timeSampling": 0,
        "width": 0.05000000074505806,
        "step": 0.0015625000232830644,
        "samples": [
          {
            "offset": 167,
            "length": 17,
            "vertexCount": 2,
            "origin": [0, 1.5, 0]
          },
          {
            "offset": 196,
            "length": 23,
            "vertexCount": 3,
            "origin": [0, 1.600000023841858, 0]
          },
          {
            "offset": 243,
            "length": 28,
            "vertexCount": 4,
            "origin": [0, 1.7000000476837158, 0]
          }
        ]
      }
    }
  ]
}
```

The conversion (section 8):

- `/rig/flag` is `"vertex"`: its point count, `.faceIndices`, `.faceCounts` and `uv` do not change (8.4). It has no `N`, so its normals are `"smooth"` and not stored, and `texelStride` is 1 (6.3). The indexed `uv` gives 6 vertices for 8 face corners. `base` is the middle of each position value (6.2): the z of points 1 and 4 in `base` is 0.1, and their z deltas in layers 0, 1 and 2 are −0.1, 0 and 0.1.
- `/rig/flag` has the matrices of `/rig`, because the space is `"world"` (3.5).
- `/ground` is `"static"`, with `"smooth"` normals: only positions are stored.
- `/sparks` is `"set"`: all points of all samples have the width 0.05 (8.5), so `step` is 0.05 / 32 = 0.0015625.
- `.selfBnds`, `.pointIds` and the metadata are not stored (8.6).

### A.3 Chunks

| Offset | Length | Size after decompression | Chunk                        | Appendix B        |
| ------ | ------ | ------------------------ | ---------------------------- | ----------------- |
| 0      | 30     | 192                      | `/rig` matrix                | `64 × 3`          |
| 30     | 30     | 192                      | `/rig/flag` matrix           | `64 × 3`          |
| 60     | 53     | 96                       | `/rig/flag` base geometry    | `6 × 12 + 12 × 2` |
| 113    | 30     | 44                       | `/ground` geometry           | `4 × 8 + 6 × 2`   |
| 143    | 24     | 48                       | `/rig/flag` layer 0 (1/24 s) | `6 × 1 × 8`       |
| 167    | 17     | 9                        | `/sparks` sample 0 (1/24 s)  | no fixed size     |
| 184    | 12     | 48                       | `/rig/flag` layer 1 (2/24 s) | `6 × 1 × 8`       |
| 196    | 23     | 14                       | `/sparks` sample 1 (2/24 s)  | no fixed size     |
| 219    | 24     | 48                       | `/rig/flag` layer 2 (3/24 s) | `6 × 1 × 8`       |
| 243    | 28     | 19                       | `/sparks` sample 2 (3/24 s)  | no fixed size     |

Parts 1 and 2 of section 7 end at byte 143. Then each frame is one byte range: 1/24 s is bytes 143 to 183, 2/24 s is bytes 184 to 218, and 3/24 s is bytes 219 to 270.

### A.4 `/rig` matrix, sample 1

Values 12 to 15 of sample 1 (bytes 112 to 127 of the chunk):

```
00 00 00 00   cd cc cc 3d   00 00 00 00   00 00 80 3f   →   0, 0.1, 0, 1
```

Value `4j + k` is Imath `m[j][k]` (0.1), so `m[3]` is `(0, 0.1, 0, 1)`: the translation `(0, 0.1, 0)` of the op.

### A.5 `/ground` geometry

The chunk after decompression (44 bytes):

```
00: 01 80 00 00 01 80 00 00   vertex 0
08: 01 80 00 00 ff 7f 00 00   vertex 1
10: ff 7f 00 00 ff 7f 00 00   vertex 2
18: ff 7f 00 00 01 80 00 00   vertex 3
20: 00 00 03 00 02 00 00 00 02 00 01 00   indices (u16)
```

Vertex 0 (5.3): codes `−32767, 0, −32767`, and 0 in component 3. With the range `center` `[0, 0, 0]`, `extent` `[2, 0, 2]`: `(−2, 0, −2)`.

The indices start at byte `4 × 8 = 32`: the triangles `(0, 3, 2)` and `(0, 2, 1)`. They are the fan of the face `(0, 3, 2, 1)` from corner 0, in the clockwise order of the face (8.4). The loader makes the smooth normals (6.7): for `(0, 3, 2)`, `(c − a) × (b − a) = (4, 0, 4) × (4, 0, 0) = (0, 16, 0)`, and `(0, 2, 1)` gives the same direction, so each vertex has the normal `(0, 1, 0)`.

### A.6 `/rig/flag` vertex 1, sample 2

Vertex 1 in `base` (bytes 12 to 23 of the base chunk):

```
01 80 ff 7f 01 80 00 00   position codes −32767, 32767, −32767   →   (0, 1, 0)
01 80 ff 7f               uv codes −32767, 32767                 →   (0, 1)
```

With the `position` range `center` `[0.5, 0.5, 0.05]`, `extent` `[0.5, 0.5, 0.05]`. Vertex 1 is point 3 of the mesh, `(0, 1, 0)`, which does not move.

Texel 1 of layer 2 (bytes 8 to 15 of the layer chunk, `texelStride` 1):

```
00 00 00 00 01 80 00 00   delta codes 0, 0, −32767
```

The `delta` range of layer 2 is `center` `[0, 0, 0.05]`, `extent` `[0, 0, 0.05]`. The delta is `(0, 0, 0.05 − 0.05) = (0, 0, 0)`, so the position is `(0, 1, 0)` (6.2). The loader calculates the normals of each sample from its positions (6.7).

### A.7 `/sparks`, sample 0

The source points are `(0, 1.5, 0)` and `(0.2, 1.5, 0)`. The `origin` is their smallest position, `[0, 1.5, 0]`. With `step` 0.0015625, their cells are `(0, 0, 0)` and `(128, 0, 0)` (6.6):

- Point 0: key 0, gap 0, `v` = 1: bit length 1, so one bit 0 with `lengths[1]` (4.6).
- Point 1: 128 is bit 7 of `i`, so the key is `2^(3 × 7) = 2 097 152`, the gap is 2 097 152, and `v` = 2 097 153: bit length 22, so 21 bits 1 with `lengths[1 … 21]`, a bit 0 with `lengths[22]`, then the 21 bits of `v` after its top bit.

The 9 bytes of the chunk after decompression are `80 00 03 df ff 57 bf b5 00`. The loader decodes them to the cell centres `(0.00078125, 1.50078125, 0.00078125)` and `(0.20078125, 1.50078125, 0.00078125)`: at most 0.00078125 = `step / 2` from the source points on each axis.

The `f32` values in the header, for example `0.05000000074505806`, are exact `f32` values (3.1).

## Appendix B. Inflated chunk sizes

| Chunk          | Size after decompression, in bytes                                  |
| -------------- | ------------------------------------------------------------------- |
| Matrix chunk   | `64 × numSamples`                                                   |
| Geometry chunk | `vertexCount × stride + indexCount × (vertexCount ≤ 65536 ? 2 : 4)` |
| Layer chunk    | `width × height × (format = "n16x4" ? 8 : 16)`                      |
| Surface chunk  | no fixed size: an arithmetic-coded stream (4.5)                     |
| Set chunk      | no fixed size: an arithmetic-coded stream (4.6)                     |
