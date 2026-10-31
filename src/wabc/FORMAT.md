# `.wabc` file format

This document defines `.wabc`, an optimised copy of the scene of one `.abc` file. It describes, byte by byte, what is stored where, and why. Each optimisation comes from the `.abc` research in `../alembic/FORMAT.md` (called [ABC] below), or from a measurement on the demo files of [ABC].

## Contents

0. [Conventions and checks](#0-conventions-and-checks)
1. [What is optimised](#1-what-is-optimised)
2. [File layout](#2-file-layout)
3. [Header](#3-header)
4. [Chunks](#4-chunks)
5. [Value encoding](#5-value-encoding)
6. [Animated samples](#6-animated-samples)
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
- **demo**: measured on all 250 frames of `demo.abc` and `demo-nonparticle.abc`. The measurement scripts are research scripts, not in the repository. A prototype writer and a prototype reader, made from this document only, converted both files and read every chunk back (section 11). Where a number is from some frames only, the Check line names the frames.
- **local**: measured on test files made with libAlembic 1.8.12. `test-anim.abc`: animated and static meshes and points, with and without `N`, uniform, cyclic and acyclic time samplings, animated and sheared Xforms. `flag.abc`: Appendix A.
- **/wabc rule**: a decision of this project. The Check line gives the measured reason.

---

## 1. What is optimised

The sample values of `demo-nonparticle.abc` are 2 305 664 067 of its 2 305 723 951 bytes ([ABC] 7.1). By property, before shared blocks are removed:

| Property ([ABC] 3.2)  | Bytes, 250 frames | Share | In `.wabc`                                                         |
| --------------------- | ----------------- | ----- | ------------------------------------------------------------------ |
| `N` (`fvr`, `f32[3]`) | 1 297 844 496     | 56 %  | One normal for each vertex, 16-bit or 8-bit (5.1)                  |
| `.faceIndices`        | 432 614 832       | 19 %  | Not stored: one vertex for each face corner, no index buffer (8.4) |
| `P`                   | 216 231 528       | 9 %   | One position for each vertex, 16-bit (5.1)                         |
| `Pref`                | 216 231 528       | 9 %   | Not stored (8.6)                                                   |
| `.faceCounts`         | 144 204 944       | 6 %   | Not stored: all faces have 3 corners (8.4)                         |
| `.selfBnds`           | 12 000            | 0 %   | Not stored: the `position` range is the bounds (3.9)               |

The optimisations, and the step of an `.abc` reader that each one removes:

| `.abc` ([ABC])                                                                                           | `.wabc`                                                                                          | Section  |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------- |
| Ogawa groups, object headers and property headers are walked to find the data (1, 2).                    | One JSON header gives all objects, and the position and length of each chunk.                    | 2, 3     |
| Objects are a tree of compounds (2.5).                                                                   | One flat list of nodes. Each node has the index of its parent.                                   | 3.4      |
| An Xform stores ops and channel values. `.inherits` can change for each sample (3.4).                    | One evaluated matrix for each sample: world, or local with `.inherits` applied.                  | 3.5, 8.2 |
| Faces can have any number of corners (3.2).                                                              | Triangles.                                                                                       | 8.4      |
| `N` and `uv` have a scope and can have indices (3.3).                                                    | One value of each attribute for each vertex.                                                     | 8.4      |
| `P`, `N` and `uv` are separate `f32` arrays (3.2, 3.3).                                                  | One interleaved vertex buffer, with 16-bit or 8-bit values relative to the bounds.               | 4.3, 5   |
| A homogeneous mesh stores all `P` (and `N`) values again for each sample (3.2).                          | One base geometry, and for each sample only position deltas (and normals), in one texture layer. | 6        |
| A heterogeneous mesh, and points whose count changes, store full samples (3.2, 3.5).                     | One full geometry for each sample.                                                               | 3.7      |
| Uniform, cyclic and acyclic time samplings (4.1).                                                        | Uniform and acyclic time samplings.                                                              | 3.3, 8.3 |
| The samples of a property can be anywhere in the file, and blocks are shared (1.5).                      | The sample chunks are in time order. A reader can show frame 0 from the first bytes.             | 7        |
| A data block is a size and raw bytes (1.4). The sample bytes are the array values, not compressed (7.1). | Each chunk is compressed alone, with deflate or brotli.                                          | 4.1      |

The header identifies the source `.abc` file with the SHA-256 digest of all its bytes.

Result: `demo.abc` (2 506 108 821 bytes) becomes 599 125 526 bytes with 16-bit normals, and 477 090 340 bytes with 8-bit normals (section 11).

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

**Check**: /wabc rule (the header gives the byte range of each chunk, so a reader reads only the chunks that it needs; the JSON header of the converted `demo.abc` is 134 564 bytes, 0.02 % of the file, section 11); demo and local (prototype reader).

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

| Member         | Type               | Required               | Description                                                                                                                |
| -------------- | ------------------ | ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `mode`         | string             | yes                    | `"static"`, `"vertex"` or `"swap"` (3.7).                                                                                  |
| `numSamples`   | integer            | yes                    | 1 for `"static"`. 1 or more for the other modes.                                                                           |
| `timeSampling` | integer            | `"vertex"`, `"swap"`   | Index in `timeSamplings`.                                                                                                  |
| `layout`       | object             | yes                    | Vertex layout of all geometries of the track (3.8).                                                                        |
| `base`         | geometry reference | `"static"`, `"vertex"` | The geometry (`"static"`), or the base geometry (`"vertex"`, section 6).                                                   |
| `animation`    | object             | `"vertex"`             | Layer layout (3.10).                                                                                                       |
| `samples`      | array              | `"vertex"`, `"swap"`   | One item for each sample, in sample order: layer references (3.10) for `"vertex"`, geometry references (3.9) for `"swap"`. |

**Check**: demo and local (prototype writer and reader).

### 3.7 Geometry modes

| Mode       | From `.abc`                                                                                                  | Data                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `"static"` | A PolyMesh or Points schema that does not change.                                                            | One geometry.                                                                                            |
| `"vertex"` | A homogeneous PolyMesh ([ABC] 3.2), or Points with the same count and `.pointIds` in all samples (8.4, 8.5). | One base geometry, and one layer for each sample with position deltas, and MAY have normals (section 6). |
| `"swap"`   | A heterogeneous PolyMesh, or Points whose count or ids change.                                               | One full geometry for each sample. The vertex and index counts can change in each sample.                |

A reader MAY blend two samples of a `"vertex"` track (6.4). A reader MUST NOT blend two samples of a `"swap"` track: their vertices do not match.

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

A mesh MUST have `position` and `normal`. Points MUST have `position`. A writer MAY add attributes whose name starts with `_`. A reader MAY ignore them.

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

---

## 4. Chunks

### 4.1 Compression

Each chunk is compressed alone:

- `"deflate"`: one zlib stream (RFC 1950) with the deflate method (RFC 1951).
- `"brotli"`: one brotli stream (RFC 7932).

Sections 4.2 to 4.4 describe the bytes after decompression. Appendix B gives the size of each chunk after decompression.

**Check**: demo (the chunks of frames 124 and 249 of `demo.abc`: brotli quality 11 is 19 % to 25 % smaller than deflate level 6, and zstd level 19 is 6 % to 11 % smaller; brotli takes 54 to 113 times as long as deflate to compress, and 1 to 3 times as long to decompress; deflate level 9 is within 0.05 % of level 6 on frames 49, 99, 149, 199 and 249); local (`test-anim.abc`: brotli is 17 % smaller than deflate).

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

---

## 6. Animated samples

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

Mode:

- `"static"`: the schema and its `N` and `uv` do not change.
- `"vertex"`: the point count, `.faceIndices`, `.faceCounts`, the `uv` values and indices, and the `N` indices are the same in all samples. Only `P` and `N` values change.
- `"swap"`: all other cases.

**Check**: [ABC] 3.2 (all demo faces have 3 corners, `N` is `fvr` and not indexed, the faces are clockwise from the side of `N`, and `N` is opposite on 3 faces), 3.3; demo (all 36 051 236 faces have the same `N` at their 3 corners, and only 2 points have one `N`; thus 108 153 222 of 108 153 708 face corners are separate vertices; with merged vertices and an index buffer the mesh chunks are 822 554 437 bytes, without an index buffer 542 867 712 bytes, 34 % less; in frame 249, `N` is up to 9.5° from the normal of its face, so `N` is stored and not calculated); local (`test-anim.abc`: in all meshes without `N` (`blob`, `box`, `sheared_box`, `disc`, `grow`), each triangle with a non-zero area has its calculated normals on the side of `(c − a) × (b − a)`; `twist` has an `N` that is opposite to that side on all its faces in the file, and it is stored without change; `flag.abc`: the indexed face-varying `uv` gives 6 vertices for 8 face corners).

### 8.5 Points

For each sample, vertex `v` is point `v`. `position` is `P`. With `.widths`, `width` is the width of each point (scope `constant`: the same width for all points).

The `"vertex"` mode only if the point count and `.pointIds` are the same in all samples. `"swap"` in all other animated cases.

**Check**: [ABC] 3.5; demo (3.7); local (`test-anim.abc`: `swarm` is `"vertex"`, `spray` is `"swap"`).

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

A reader SHOULD set limits for `vertexCount`, `indexCount`, `numSamples` and `width × height`.

**Check**: demo and local (the prototype reader does all these checks on all chunks).

---

## 11. Byte accounting

The prototype writer converted both demo files: `"world"` space, deflate level 6, `n16x4` positions, and `n16x4` or `n8x4` normals. The prototype reader read every chunk back with the checks of section 10: offsets contiguous, chunk order of section 7, sizes of Appendix B. All bytes are in exactly one range: the first 12 bytes, the header, or one chunk.

### 11.1 `demo.abc` (2 506 108 821 bytes)

| Range                                       | Chunks | `n16x4` normals | `n8x4` normals  | After decompression (`n16x4` / `n8x4`) |
| ------------------------------------------- | ------ | --------------- | --------------- | -------------------------------------- |
| First 12 bytes                              |        | 12              | 12              |                                        |
| Header                                      |        | 134 564         | 134 523         |                                        |
| Parts 1 and 2 (matrices, static geometries) | 0      | 0               | 0               |                                        |
| `/Cube/Liquid` (`"swap"`, stride 12)        | 250    | 52 846 464      | 52 846 464      | 100 451 040                            |
| `/Cube/Cube_241` (`"swap"`, stride 16 / 12) | 250    | 546 144 486     | 424 109 341     | 1 730 459 328 / 1 297 844 496          |
| **Total**                                   | 500    | **599 125 526** | **477 090 340** |                                        |
| Share of the `.abc` file                    |        | 23.9 %          | 19.0 %          |                                        |

| Frames (one sample chunk of each node)                  | `n16x4` normals | `n8x4` normals |
| ------------------------------------------------------- | --------------- | -------------- |
| Bytes to show frame 0 (first 12 bytes, header, frame 0) | 173 574         | 163 973        |
| Mean frame                                              | 2 395 964       | 1 907 823      |
| Largest frame                                           | 4 463 948       | 3 581 610      |

### 11.2 `demo-nonparticle.abc` (2 305 723 951 bytes)

| Range                       | Chunks | `n16x4` normals | `n8x4` normals  |
| --------------------------- | ------ | --------------- | --------------- |
| First 12 bytes              |        | 12              | 12              |
| Header                      |        | 60 992          | 60 964          |
| `/Cube/Cube_241` (`"swap"`) | 250    | 546 144 321     | 424 109 428     |
| **Total**                   | 250    | **546 205 325** | **424 170 404** |
| Share of the `.abc` file    |        | 23.7 %          | 18.4 %          |
| Bytes to show frame 0       |        | 98 338          | 88 750          |
| Mean frame                  |        | 2 184 577       | 1 696 438       |
| Largest frame               |        | 4 017 317       | 3 134 980       |

Neither demo file has a matrix track or a static geometry: `/Cube` is a constant identity matrix (3.5), and both geometries change on each frame (3.7). Thus parts 1 and 2 are empty, and the frames follow the header.

**Check**: demo (prototype writer and reader, all 250 frames of both files; the totals are equal to the file sizes).

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
| `/ground`   | PolyMesh | 1       | 1 quad, 4 points, `.faceIndices` `(0, 3, 2, 1)`.                                             |
| `/sparks`   | Points   | 3       | 2, 3 and 4 points, `.pointIds` `0 … n − 1`, `.widths` 0.05.                                  |

The prototype writer converted it with `"world"` space, `n16` formats and deflate: 3 007 bytes.

### A.1 First 12 bytes

```
57 41 42 43   magic "WABC"
01 00 00 00   version 1
68 0a 00 00   headerLength 2664
```

`dataStart = 12 + 2664 = 2676`. The data section has 331 bytes.

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
        "layout": {
          "stride": 20,
          "attributes": [
            { "name": "position", "format": "n16x4", "offset": 0 },
            { "name": "normal", "format": "n16x4", "offset": 8 },
            { "name": "uv", "format": "n16x2", "offset": 16 }
          ]
        },
        "base": {
          "offset": 60,
          "length": 60,
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
        "animation": { "format": "n16x4", "texelStride": 2, "width": 12, "height": 1 },
        "samples": [
          {
            "offset": 161,
            "length": 24,
            "delta": {
              "center": [0, 0, -0.05000000074505806],
              "extent": [0, 0, 0.05000000074505806]
            }
          },
          {
            "offset": 201,
            "length": 40,
            "delta": { "center": [0, 0, 0], "extent": [0, 0, 0] }
          },
          {
            "offset": 257,
            "length": 50,
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
        "layout": {
          "stride": 16,
          "attributes": [
            { "name": "position", "format": "n16x4", "offset": 0 },
            { "name": "normal", "format": "n16x4", "offset": 8 }
          ]
        },
        "base": {
          "offset": 120,
          "length": 41,
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
        "mode": "swap",
        "numSamples": 3,
        "timeSampling": 0,
        "layout": {
          "stride": 12,
          "attributes": [
            { "name": "position", "format": "n16x4", "offset": 0 },
            { "name": "width", "format": "n16x2", "offset": 8 }
          ]
        },
        "samples": [
          {
            "offset": 185,
            "length": 16,
            "vertexCount": 2,
            "indexCount": 0,
            "quantization": {
              "position": {
                "center": [0.10000000149011612, 1.5, 0],
                "extent": [0.10000000149011612, 0, 0]
              },
              "width": { "center": [0.05000000074505806], "extent": [0] }
            }
          },
          {
            "offset": 241,
            "length": 16,
            "vertexCount": 3,
            "indexCount": 0,
            "quantization": {
              "position": {
                "center": [0.20000000298023224, 1.600000023841858, 0],
                "extent": [0.20000000298023224, 0, 0]
              },
              "width": { "center": [0.05000000074505806], "extent": [0] }
            }
          },
          {
            "offset": 307,
            "length": 24,
            "vertexCount": 4,
            "indexCount": 0,
            "quantization": {
              "position": {
                "center": [0.30000001192092896, 1.7000000476837158, 0],
                "extent": [0.30000001192092896, 0, 0]
              },
              "width": { "center": [0.05000000074505806], "extent": [0] }
            }
          }
        ]
      }
    }
  ]
}
```

The conversion (section 8):

- `/rig/flag` is `"vertex"`: its point count, `.faceIndices`, `.faceCounts` and `uv` do not change (8.4). It has no `N`, so the normals are calculated for each sample. They change with `P`, so `texelStride` is 2 (6.3). The indexed `uv` gives 6 vertices for 8 face corners. `base` is the middle of each position value (6.2), so the z of points 1 and 4 in `base` is 0.1, and their z deltas in layers 0, 1 and 2 are −0.1, 0 and 0.1.
- `/rig/flag` has the matrices of `/rig`, because the space is `"world"` (3.5).
- `/ground` is `"static"`. Its normals are calculated.
- `/sparks` is `"swap"`: its point count changes (8.5). All widths are 0.05: the `width` range has `extent` 0, and all codes are 0 (5.2).
- `.selfBnds`, `.pointIds` and the metadata are not stored (8.6).

### A.3 Chunks

| Offset | Length | Size after decompression | Chunk                        | Appendix B        |
| ------ | ------ | ------------------------ | ---------------------------- | ----------------- |
| 0      | 30     | 192                      | `/rig` matrix                | `64 × 3`          |
| 30     | 30     | 192                      | `/rig/flag` matrix           | `64 × 3`          |
| 60     | 60     | 144                      | `/rig/flag` base             | `6 × 20 + 12 × 2` |
| 120    | 41     | 76                       | `/ground` geometry           | `4 × 16 + 6 × 2`  |
| 161    | 24     | 96                       | `/rig/flag` layer 0 (1/24 s) | `12 × 1 × 8`      |
| 185    | 16     | 24                       | `/sparks` sample 0 (1/24 s)  | `2 × 12`          |
| 201    | 40     | 96                       | `/rig/flag` layer 1 (2/24 s) | `12 × 1 × 8`      |
| 241    | 16     | 36                       | `/sparks` sample 1 (2/24 s)  | `3 × 12`          |
| 257    | 50     | 96                       | `/rig/flag` layer 2 (3/24 s) | `12 × 1 × 8`      |
| 307    | 24     | 48                       | `/sparks` sample 2 (3/24 s)  | `4 × 12`          |

Parts 1 and 2 (section 7) end at byte 161. Then each frame is one byte range: 1/24 s is bytes 161 to 200, 2/24 s is bytes 201 to 256, and 3/24 s is bytes 257 to 330.

### A.4 `/rig` matrix, sample 1

Values 12 to 15 of sample 1 (bytes 112 to 127 of the chunk):

```
00 00 00 00   cd cc cc 3d   00 00 00 00   00 00 80 3f   →   0, 0.1, 0, 1
```

Value `4j + k` is Imath `m[j][k]` (0.1), so `m[3]` is `(0, 0.1, 0, 1)`: the translation `(0, 0.1, 0)` of the op.

### A.5 `/ground` geometry

The chunk after decompression (76 bytes):

```
00: 01 80 00 00 01 80 00 00  00 00 ff 7f 00 00 00 00   vertex 0
10: 01 80 00 00 ff 7f 00 00  00 00 ff 7f 00 00 00 00   vertex 1
20: ff 7f 00 00 ff 7f 00 00  00 00 ff 7f 00 00 00 00   vertex 2
30: ff 7f 00 00 01 80 00 00  00 00 ff 7f 00 00 00 00   vertex 3
40: 00 00 03 00 02 00 00 00  02 00 01 00               indices (u16)
```

Vertex 0 (5.3):

- `position`, bytes 0 to 7: codes `−32767, 0, −32767`, and 0 in component 3. With `center` `[0, 0, 0]` and `extent` `[2, 0, 2]`: `(−2, 0, −2)`.
- `normal`, bytes 8 to 15: codes `0, 32767, 0`. With the fixed range: `(0, 1, 0)`.

The indices start at byte `4 × 16 = 64`: the triangles `(0, 3, 2)` and `(0, 2, 1)`. They are the fan of the face `(0, 3, 2, 1)` from corner 0, in the clockwise order of the face (8.4). For `(0, 3, 2)`: `(c − a) × (b − a) = (4, 0, 4) × (4, 0, 0) = (0, 16, 0)`, the side of the calculated normal `(0, 1, 0)`.

### A.6 `/rig/flag` vertex 1, sample 2

Vertex 1 in `base` (bytes 20 to 39 of the base chunk):

```
01 80 ff 7f 01 80 00 00   position codes −32767, 32767, −32767   →   (0, 1, 0)
00 00 00 00 ff 7f 00 00   normal codes 0, 0, 32767               →   (0, 0, 1)
01 80 ff 7f               uv codes −32767, 32767                 →   (0, 1)
```

The `position` range of `base` is `center` `[0.5, 0.5, 0.05]`, `extent` `[0.5, 0.5, 0.05]`. Vertex 1 is point 3 of the mesh, `(0, 1, 0)`, which does not move.

Texels 2 and 3 of layer 2 (bytes 16 to 31 of the layer chunk) are vertex 1 (`texelStride` 2):

```
00 00 00 00 01 80 00 00   delta codes 0, 0, −32767
77 d0 00 00 d7 76 00 00   normal codes −12169, 0, 30423
```

The `delta` range of layer 2 is `center` `[0, 0, 0.05]`, `extent` `[0, 0, 0.05]`. The delta is `(0, 0, 0.05 − 0.05) = (0, 0, 0)`, so the position is `(0, 1, 0)` (6.2). The normal is `(−12169, 0, 30423) / 32767 = (−0.371, 0, 0.928)`: the normal of the face `(0, 3, 4, 1)` of sample 2, `(−0.2, 0, 0.5)` normalized, because points 1 and 4 are at z = 0.2 (6.3).

The `f32` values in the header, for example `0.05000000074505806`, are exact `f32` values (3.1).

## Appendix B. Inflated chunk sizes

| Chunk          | Size after decompression, in bytes                                  |
| -------------- | ------------------------------------------------------------------- |
| Matrix chunk   | `64 × numSamples`                                                   |
| Geometry chunk | `vertexCount × stride + indexCount × (vertexCount ≤ 65536 ? 2 : 4)` |
| Layer chunk    | `width × height × (format = "n16x4" ? 8 : 16)`                      |
