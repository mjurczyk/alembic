# `.abc` file format

This document defines the `.abc` file format that `/alembic` reads. It describes, byte by byte, what is stored where, and how.

It is not a port of the C++ Alembic library. It describes only the bytes on disk, and the minimum rules a reader needs to turn them into JS data.

## Contents

0. [Conventions and checks](#0-conventions-and-checks)
1. [Ogawa container](#1-ogawa-container)
2. [Abc layer](#2-abc-layer)
3. [AbcGeom schemas](#3-abcgeom-schemas)
4. [Time sampling](#4-time-sampling)
5. [Out of scope](#5-out-of-scope)
6. [Writer quirks found in the demo files](#6-writer-quirks-found-in-the-demo-files)
7. [Byte accounting](#7-byte-accounting)
8. [Sources](#8-sources)

### Demo files

All hex dumps come from these two files, in the repository root (they are not in git, see `.gitignore`):

| File                   | Size (bytes)  | Writer                       | Objects                                                    |
| ---------------------- | ------------- | ---------------------------- | ---------------------------------------------------------- |
| `demo-nonparticle.abc` | 2 305 723 951 | Blender 5.0.0, Alembic 1.8.3 | `/Cube` (Xform) → `Cube_241` (PolyMesh)                    |
| `demo.abc`             | 2 506 108 821 | Blender 5.0.0, Alembic 1.8.3 | `/Cube` (Xform) → `Liquid` (Points), `Cube_241` (PolyMesh) |

Both files have 250 samples per animated property at 1/24 s steps. The mesh changes topology on every frame. The `Cube_241` mesh has the same topology in both files: on all 250 frames, the `.faceIndices` and `.faceCounts` keys are equal. The values are not all equal: `P` differs by at most 2.4e-7 and `N` by at most 0.321 (77 of 250 frames differ), and `meshtype` is `0` in `demo-nonparticle.abc` and `1` in `demo.abc`.

Unless a dump says otherwise, offsets are from `demo-nonparticle.abc`.

---

## 0. Conventions and checks

### 0.1 Conventions

- All integers and floats are **little-endian**.
- Data is **not aligned**. A `float32` array can start at an odd offset (for example `P` values at `0x3e9b`). Read with `DataView`, or copy a block before you make a typed array.
- All offsets are **absolute** byte positions from the start of the file.
- Offsets are 63-bit. Both demo files are larger than 2³¹ bytes, and their offsets go above `0x7fffffff`. Read offsets as `BigInt` and convert to `Number`. `Number` is exact up to `Number.MAX_SAFE_INTEGER` = 2⁵³ − 1.
- Strings in headers have a **length prefix**. They have no NUL terminator.
- `u8`, `u16`, `u32`, `u64`, `i32`, `f64`: unsigned / signed integer and float widths.
- `hint` integer: a `u8`, `u16` or `u32`. The property header _size hint_ selects the width (see [2.7](#27-property-headers)).
- In hex dumps, `→` marks the decoded value.

### 0.2 How each statement is checked

Each subsection ends with a **Check** line. It gives the evidence for the statements in that subsection:

- **src** `file:line`: Alembic C++ source, version 1.8.12, commit `2d54c7c2c3ba4dd9f30215c9663f0ea1aa8fd2a5`, path under `lib/Alembic/`.
- **demo**: the walker script read both demo files with the rules in this document and tested the statement on all samples (all 250 frames), unless the line gives a smaller set.
- **ext**: a quote from an external page, URL in [section 8](#8-sources).
- **/alembic rule**: a decision of this project. It is not a statement about other readers or writers.

---

## 1. Ogawa container

Ogawa is a small binary tree format. The file has a 16-byte header, and then a tree of **groups** and **data blocks**. A group is a list of child offsets. A data block is a byte string. The Abc layer ([section 2](#2-abc-layer)) gives meaning to the tree.

### 1.1 File header (16 bytes, offset 0)

| Offset | Size | Type    | Field             | Value in demo  |
| ------ | ---- | ------- | ----------------- | -------------- |
| `0x00` | 5    | `u8[5]` | magic             | `"Ogawa"`      |
| `0x05` | 1    | `u8`    | frozen flag       | `0xff`         |
| `0x06` | 2    | `u8[2]` | format version    | `{0x00, 0x01}` |
| `0x08` | 8    | `u64`   | root group offset | `0x896e8df7`   |

```
00000000: 4f 67 61 77 61                    → magic "Ogawa"
00000005: ff                                → frozen (file was closed)
00000006: 00 01                             → version {0, 1}
00000008: f7 8d 6e 89 00 00 00 00           → root group @ 0x896e8df7
```

- The writer writes the header with frozen flag `0x00` and root offset `0`. It writes the root offset when the root group is complete, and it writes `0xff` to the frozen flag when it closes the file. Thus, if the flag is `0x00`, the root offset can still be `0`.
- The C++ reader rejects a file with magic other than `"Ogawa"`, and the Abc layer rejects a file with frozen flag other than `0xff`. It reads the version but does not reject other values.

Reader rules:

- Reject the file if bytes 0–4 are not `"Ogawa"`.
- Reject the file if the frozen flag is not `0xff`.
- Reject the file if the version is not `{0, 1}` (**/alembic rule**).

**Check**: src `Ogawa/OStream.cpp:178-184` (header bytes), `Ogawa/OGroup.cpp:255-264` (root offset at byte 8), `Ogawa/OStream.cpp:148-152` (frozen byte), `Ogawa/IStreams.cpp:692-701`, `AbcCoreOgawa/ArImpl.cpp:58`; demo (both headers).

### 1.2 Child references

A group stores its children as `u64` words:

```
bit 63       : 1 = child is a data block, 0 = child is a group
bits 0..62   : absolute offset of the child
```

Two special words have offset 0:

| Word                 | Meaning                                                  |
| -------------------- | -------------------------------------------------------- |
| `0x0000000000000000` | empty group (zero children). Nothing is written on disk. |
| `0x8000000000000000` | empty data (zero bytes). Nothing is written on disk.     |

In the demo files, the only empty data children are array dimensions ([2.10](#210-array-property-samples)): 1 250 in `demo-nonparticle.abc` and 2 250 in `demo.abc`.

**Check**: src `Ogawa/OGroup.cpp:108,131,152-156,185,194,208,219,227,240-243`; demo.

### 1.3 Group

```
u64        numChildren
u64[n]     children          (child references, see 1.2)
```

Size on disk: `8 + 8 × numChildren` bytes. Example, the root group:

```
896e8df7: 06 00 00 00 00 00 00 00           → 6 children
896e8dff: 10 00 00 00 00 00 00 80           → [0] data  @ 0x10
896e8e07: 1c 00 00 00 00 00 00 80           → [1] data  @ 0x1c
896e8e0f: 9f 8a 6e 89 00 00 00 00           → [2] group @ 0x896e8a9f
896e8e17: bf 8a 6e 89 00 00 00 80           → [3] data  @ 0x896e8abf
896e8e1f: c6 8b 6e 89 00 00 00 80           → [4] data  @ 0x896e8bc6
896e8e27: fe 8b 6e 89 00 00 00 80           → [5] data  @ 0x896e8bfe
896e8e2f: (end of file)
```

**Check**: src `Ogawa/OGroup.cpp:248-251`; demo.

### 1.4 Data block

```
u64        size
u8[size]   bytes
```

Size on disk: `8 + size` bytes. Example, root child `[1]`:

```
0000001c: 04 00 00 00 00 00 00 00           → size 4
00000024: 33 2a 00 00                       → i32 10803
```

**Check**: src `Ogawa/OGroup.cpp:116-117,161-168`; demo.

### 1.5 Sharing and order on disk

- **Many references can point to one block.** The writer stores each unique sample once. Later equal samples point to the first block ([2.11](#211-sample-keys-and-de-duplication)). A reader must not assume that one block has one parent.
- **The writer appends each block when it is complete.** Data blocks are appended when a sample is written. A group is appended when it is complete ("frozen"). If its parent group is already on disk, the writer goes back and writes the new offset into the parent's child table. Thus the format does **not** guarantee that children come before parents.
- In both demo files, every child is before its parent (0 exceptions in 23 and 31 groups), and the root group is the last structure in the file.
- Layout of `demo-nonparticle.abc`:

  | Range                     | Content                                                                    |
  | ------------------------- | -------------------------------------------------------------------------- |
  | `0x00000000`–`0x00000010` | file header                                                                |
  | `0x00000010`–`0x00000028` | root data `[0]` and `[1]` (versions)                                       |
  | `0x00000028`–`0x896e3163` | sample data blocks, frame after frame, plus one group at `0x10b` (see 7.1) |
  | `0x896e3163`–`0x896e8abf` | property groups, header blocks and object groups                           |
  | `0x896e8abf`–`0x896e8df7` | archive metadata, time samplings, indexed metadata                         |
  | `0x896e8df7`–`0x896e8e2f` | root group (ends at end of file)                                           |

- Structure is not only at the end of the file: the first group is at `0x10b` in `demo-nonparticle.abc` and at `0x17ea` in `demo.abc`. A reader must follow offsets from the root.

**Check**: src `Ogawa/OGroup.cpp:231-271` (freeze appends at end, patches a frozen parent), `AbcCoreOgawa/WriteUtil.cpp:195-199,286` (shared blocks); demo (child offset < parent offset for all groups; first group offsets; all sample blocks of frame `f` are before all sample blocks of frame `f + 1`, 0 exceptions).

### 1.6 Safety

A malformed file can have child offsets that make a cycle, or that point outside the file. The reader must check `offset + size ≤ fileSize` for each group and data block, and must track visited groups or limit the tree depth (**/alembic rule**).

**Check**: a child reference is any 63-bit value (1.2), so nothing in the format prevents these cases.

---

## 2. Abc layer

The Abc layer maps the Ogawa tree to an **archive** of **objects**. Each object has a top **compound property** that holds **scalar**, **array** and nested **compound** properties. Each scalar or array property has a list of **samples**.

### 2.1 Archive root group

| Child | Kind  | Content                                 | Section                           |
| ----- | ----- | --------------------------------------- | --------------------------------- |
| `[0]` | data  | archive (Ogawa-Abc) file version, `i32` | [2.2](#22-version-blocks)         |
| `[1]` | data  | Alembic library version, `i32`          | [2.2](#22-version-blocks)         |
| `[2]` | group | top object `/`                          | [2.5](#25-object-group)           |
| `[3]` | data  | archive metadata string                 | [2.3](#23-metadata-strings)       |
| `[4]` | data  | time samplings                          | [4](#4-time-sampling)             |
| `[5]` | data  | indexed metadata table                  | [2.4](#24-indexed-metadata-table) |

The C++ reader requires more than 5 children with these kinds, and does not read children after `[5]`.

**Check**: src `AbcCoreOgawa/AwImpl.cpp:94-105,239-251`, `AbcCoreOgawa/ArImpl.cpp:80-92`; demo (both files have exactly 6).

### 2.2 Version blocks

```
00000010: 04 00 00 00 00 00 00 00           → size 4
00000018: 00 00 00 00                       → archive version 0
0000001c: 04 00 00 00 00 00 00 00           → size 4
00000024: 33 2a 00 00                       → library version 10803 (Alembic 1.8.3)
```

- Archive version: the C++ reader accepts only `0`. Reject other values.
- Library version: `major × 10000 + minor × 100 + patch` (`10803` = 1.8.3). The C++ reader requires `≥ 9999`.

**Check**: src `AbcCoreOgawa/Foundation.h:57` (`ALEMBIC_OGAWA_FILE_VERSION 0`), `AbcCoreOgawa/ArImpl.cpp:95-112`, `Util/Config.h.in:42`; demo.

### 2.3 Metadata strings

All metadata uses one text form:

```
key=value;key=value;...
```

- `;` separates pairs, `=` separates key and value. The C++ code keeps pairs in a `std::map`, so the order of pairs has no meaning.
- An empty string means "no metadata".

**Archive metadata** (root child `[3]`) is a plain string in a data block. It is not in the indexed table. Example (255 bytes):

```
896e8abf: ff 00 00 00 00 00 00 00           → size 255
896e8ac7: 46 72 61 6d 65 73 50 65 72 54 69 6d 65 55 6e 69 74 3d ...
          → "FramesPerTimeUnit=24.000000;_ai_AlembicVersion=Alembic 1.8.3 (built Apr 25 2025 12:39:20);
             _ai_Application=Blender;_ai_DateWritten=Sat Oct 31 23:25:06 2026;
             _ai_Description=/Users/jan/Desktop/eroded-desert-rock/source/rock3/demo.blend;blender_version=v5.0.0"
```

- `_ai_AlembicVersion` is set by the Alembic writer. `CreateArchiveWithInfo` sets `_ai_Application` and `_ai_Description` (and `_ai_DCC_FPS`) from values the application gives, and sets `_ai_DateWritten` from the clock (`ctime`).
- `FramesPerTimeUnit` and `blender_version` are not in the Alembic source. The writing application added them.

**Check**: src `Util/TokenMap.h:68`, `AbcCoreAbstract/MetaData.h:126,134`, `AbcCoreOgawa/AwImpl.cpp:103,238-239`, `Abc/ArchiveInfo.h:58-61,178-218`; grep of the full source for `FramesPerTimeUnit` (0 results); demo.

### 2.4 Indexed metadata table

Root child `[5]`. Object and property headers point into this table with a 1-byte index, so a short metadata string is stored only once.

```
repeat until end of block:
  u8         length          (< 256)
  u8[length] metadata string
```

- Index `0` is the empty string. It is **not** stored. The first stored string is index `1`.
- Index `255` (`0xff`) means "metadata is stored inline, after the header". It is never in the table.
- Strings of 256 bytes or more, and strings after the first 254, are stored inline.
- If the table is empty, child `[5]` is empty data.
- Strings are stored in the order in which the writer first used them.

```
896e8bfe: f1 01 00 00 00 00 00 00           → size 497
896e8c06: 5f                                → [1] length 95
896e8c07: 61 72 72 61 79 45 78 74 ...       → "arrayExtent=1;geoScope=vtx;interpretation=vector;isGeomParam=true;podExtent=3;podName=float32_t"
896e8c66: 12                                → [2] length 18
896e8c67: 69 6e 74 65 72 70 72 65 ...       → "interpretation=box"
896e8c79: 21                                → [3] length 33
896e8c7a: 67 65 6f 53 63 6f 70 65 ...       → "geoScope=vtx;interpretation=point"
          ...                               → [4]..[8], see below
```

Full table of `demo-nonparticle.abc`:

| Index | String                                                                                                   |
| ----- | -------------------------------------------------------------------------------------------------------- |
| 0     | _(empty, not stored)_                                                                                    |
| 1     | `arrayExtent=1;geoScope=vtx;interpretation=vector;isGeomParam=true;podExtent=3;podName=float32_t`        |
| 2     | `interpretation=box`                                                                                     |
| 3     | `geoScope=vtx;interpretation=point`                                                                      |
| 4     | `arrayExtent=1;geoScope=fvr;interpretation=normal;isGeomParam=true;podExtent=3;podName=float32_t`        |
| 5     | `schema=AbcGeom_PolyMesh_v1;schemaBaseType=AbcGeom_GeomBase_v1`                                          |
| 6     | `schema=AbcGeom_PolyMesh_v1;schemaBaseType=AbcGeom_GeomBase_v1;schemaObjTitle=AbcGeom_PolyMesh_v1:.geom` |
| 7     | `schema=AbcGeom_Xform_v3`                                                                                |
| 8     | `schema=AbcGeom_Xform_v3;schemaObjTitle=AbcGeom_Xform_v3:.xform`                                         |

**Check**: src `AbcCoreOgawa/MetaDataMap.cpp:44-107`; demo.

### 2.5 Object group

| Child         | Kind  | Content                                                                 |
| ------------- | ----- | ----------------------------------------------------------------------- |
| `[0]`         | group | the object's top compound property ([2.6](#26-compound-property-group)) |
| `[1]`…`[n-2]` | group | child objects, in the same order as the child headers                   |
| `[n-1]`       | data  | child object headers + 32 hash bytes ([2.5.1](#251-object-headers))     |

The top object `/` (root child `[2]`) has no header of its own. The C++ reader names it `ABC`, with full name `/`. All other objects get their names from the header block of their parent.

```
896e8a9f: 03 00 00 00 00 00 00 00           → object "/": 3 children
896e8aa7: 87 8a 6e 89 00 00 00 00           → [0] group @ 0x896e8a87  top compound of "/"
896e8aaf: 0d 8a 6e 89 00 00 00 00           → [1] group @ 0x896e8a0d  object "/Cube"
896e8ab7: 3d 8a 6e 89 00 00 00 80           → [2] data  @ 0x896e8a3d  headers of children of "/"
```

The header block always has at least the 32 hash bytes, so it is always written. A leaf object (no children) has 2 children:

```
896e897f: 02 00 00 00 00 00 00 00           → object "/Cube/Cube_241": 2 children
896e8987: 67 89 6e 89 00 00 00 00           → [0] group @ 0x896e8967  top compound
896e898f: 2d 89 6e 89 00 00 00 80           → [1] data  @ 0x896e892d  (32 bytes: hashes only)
```

**Check**: src `AbcCoreOgawa/OwData.cpp:55,163,176-223`, `AbcCoreOgawa/OrData.cpp:56-80`, `AbcCoreOgawa/ArImpl.cpp:114-127`; demo.

#### 2.5.1 Object headers

```
repeat for each child object:
  u32           nameLength          (> 0)
  u8[n]         name
  u8            metadataIndex       (into 2.4; 0xff = inline)
  if metadataIndex == 0xff:
    u32         metadataLength
    u8[m]       metadata string
u8[16]          data hash           (SpookyHash V2, of the object's properties)
u8[16]          children hash       (SpookyHash V2, of the child objects)
```

The number of children is not stored. The C++ reader removes the last 32 bytes, then reads headers until the end.

```
896e8a3d: 29 00 00 00 00 00 00 00           → size 41
896e8a45: 04 00 00 00                       → name length 4
896e8a49: 43 75 62 65                       → "Cube"
896e8a4d: 08                                → metadata [8] "schema=AbcGeom_Xform_v3;schemaObjTitle=AbcGeom_Xform_v3:.xform"
896e8a4e: a7 86 87 53 cd eb 56 c1 ba e4 67 99 68 40 1e dd   → data hash
896e8a5e: ba b4 63 f3 1b 53 44 63 26 23 46 9b 8c b0 21 4d   → children hash
```

```
896e8997: 2d 00 00 00 00 00 00 00           → size 45 (headers of children of "/Cube")
896e899f: 08 00 00 00                       → name length 8
896e89a3: 43 75 62 65 5f 32 34 31           → "Cube_241"
896e89ab: 06                                → metadata [6] (PolyMesh, see 2.4)
896e89ac: (32 hash bytes)
```

- The C++ API gives the hashes to applications (`getPropertiesHash`, `getChildrenHash`). `/alembic` skips them (**/alembic rule**).
- The `schema` metadata key gives the object type. `schemaObjTitle` is `<schema>:<default schema compound name>`, for example `AbcGeom_Xform_v3:.xform`.

**Check**: src `AbcCoreOgawa/WriteUtil.cpp:484-510`, `AbcCoreOgawa/OwData.cpp:186-214`, `AbcCoreOgawa/ReadUtil.cpp:1564-1620`, `Util/SpookyV2.h`, `AbcCoreAbstract/ObjectReader.h:160,164`, `Abc/OSchemaObject.h:68-72`; demo.

### 2.6 Compound property group

| Child         | Kind  | Content                                        |
| ------------- | ----- | ---------------------------------------------- |
| `[0]`…`[n-2]` | group | one group per property, in header order        |
| `[n-1]`       | data  | property headers ([2.7](#27-property-headers)) |

A compound with no properties writes no header block. Then its group has no children and is stored as an **empty group** (word `0`).

```
896e88e5: 08 00 00 00 00 00 00 00           → compound ".geom" of Cube_241: 8 children
896e88ed: 99 80 6e 89 00 00 00 00           → [0] group  .selfBnds
896e88f5: c3 70 6e 89 00 00 00 00           → [1] group  P
896e88fd: 1b 61 6e 89 00 00 00 00           → [2] group  .faceIndices
896e8905: 73 51 6e 89 00 00 00 00           → [3] group  .faceCounts
896e890d: 81 80 6e 89 00 00 00 00           → [4] group  .userProperties   (compound)
896e8915: 5b 51 6e 89 00 00 00 00           → [5] group  .arbGeomParams    (compound)
896e891d: a1 41 6e 89 00 00 00 00           → [6] group  N
896e8925: 71 88 6e 89 00 00 00 80           → [7] data   property headers (108 bytes)
```

**Check**: src `AbcCoreOgawa/CpwData.cpp:141,183,210,223-244`, `Ogawa/OGroup.cpp:240-243`; demo.

### 2.7 Property headers

The header block of a compound is a list of property headers, one after the other, with no count. Read until the end of the block. Each header:

```
u32            info                         (bit fields, below)
if property is not compound:
  hint         numSamples
  if info & 0x0200:
    hint       firstChangedIndex
    hint       lastChangedIndex
  if info & 0x0100:
    hint       timeSamplingIndex            (else 0)
hint           nameLength                   (> 0)
u8[n]          name
if metadataIndex == 0xff:
  hint         metadataLength
  u8[m]        metadata string
```

`hint` is a `u8`, `u16` or `u32`. The size hint in `info` selects the width, separately for each header.

#### `info` bit fields

| Bits  | Mask         | Field                   | Meaning                                                                                                                                    |
| ----- | ------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 0–1   | `0x00000003` | property type           | `0` compound, `1` scalar, `2` array, `3` array that is _scalar-like_ (each sample has exactly 1 element)                                   |
| 2–3   | `0x0000000c` | size hint               | width of `hint` fields: `0` = `u8`, `1` = `u16`, `2` = `u32`                                                                               |
| 4–7   | `0x000000f0` | POD type                | data type, see [2.12](#212-data-types)                                                                                                     |
| 8     | `0x00000100` | has time sampling index | `timeSamplingIndex` is stored. If clear, the index is `0`                                                                                  |
| 9     | `0x00000200` | has first/last changed  | `firstChangedIndex` and `lastChangedIndex` are stored                                                                                      |
| 10    | `0x00000400` | homogeneous             | intended meaning: all samples have the same element count. **Do not use**, see [6.4](#64-the-homogeneous-flag-does-not-mean-constant-size) |
| 11    | `0x00000800` | constant                | `firstChangedIndex = lastChangedIndex = 0`                                                                                                 |
| 12–19 | `0x000ff000` | extent                  | number of POD values per element (`3` for `P`, `16` for an Xform `.vals` matrix)                                                           |
| 20–27 | `0x0ff00000` | metadata index          | index into [2.4](#24-indexed-metadata-table). `0xff` = inline after the name                                                               |
| 28–31 | `0xf0000000` | (not used)              | the writer never sets these bits                                                                                                           |

- For a **compound**, the writer sets only the type (`0`), the size hint and the metadata index.
- If bits 9 and 11 are both clear: `firstChangedIndex = 1` and `lastChangedIndex = numSamples − 1`.
- The writer selects the size hint from the largest of: name length, metadata length, `numSamples`, `timeSamplingIndex`. `≤ 255` → `u8`, `256…65535` → `u16`, else `u32`.
- Type `3` does not occur in the demo files.
- The C++ reader rejects POD values above 13 and `nameLength` 0.

In the demo files, all 16 headers of `demo-nonparticle.abc` and all 22 headers of `demo.abc` have bits 28–31 clear, and all compound headers use only the bits listed for compounds.

#### Example: header block of `.geom` (108 bytes)

```
896e8871: 6c 00 00 00 00 00 00 00           → size 108

896e8879: b1 65 20 00                       → info 0x002065b1
                                               type 1 scalar, hint u8, POD 0xb float64,
                                               has ts index, 0x400, extent 6, metadata [2]
896e887d: fa                                → numSamples 250
896e887e: 01                                → timeSamplingIndex 1
896e887f: 09                                → name length 9
896e8880: 2e 73 65 6c 66 42 6e 64 73        → ".selfBnds"

896e8889: a2 31 30 00                       → info 0x003031a2
                                               type 2 array, POD 0xa float32, has ts index,
                                               extent 3, metadata [3]
896e888d: fa 01                             → numSamples 250, timeSamplingIndex 1
896e888f: 01 50                             → name "P"

896e8891: 62 15 00 00                       → info 0x00001562: array, POD 6 int32, has ts index,
                                               0x400, extent 1, metadata [0]
896e8895: fa 01 0c                          → 250 samples, ts 1, name length 12
896e8898: 2e 66 61 63 65 49 6e 64 69 63 65 73   → ".faceIndices"

896e88a4: 62 15 00 00 fa 01 0b              → same layout
896e88ab: 2e 66 61 63 65 43 6f 75 6e 74 73  → ".faceCounts"

896e88b6: 00 00 00 00                       → info 0: compound, metadata [0]
896e88ba: 0f                                → name length 15
896e88bb: 2e 75 73 65 72 50 72 6f 70 65 72 74 69 65 73   → ".userProperties"

896e88ca: 00 00 00 00 0e                    → compound, name length 14
896e88cf: 2e 61 72 62 47 65 6f 6d 50 61 72 61 6d 73      → ".arbGeomParams"

896e88dd: a2 31 40 00                       → info 0x004031a2: array float32[3], ts, metadata [4]
896e88e1: fa 01 01 4e                       → 250 samples, ts 1, name "N"
```

#### Example: constant scalars in `.xform` (38 bytes)

```
896e319b: 01 1d 00 00                       → info 0x00001d01: scalar, POD 0 bool, has ts,
                                               0x400, constant, extent 1
896e319f: 01 01 09                          → numSamples 1, ts 1, name length 9
896e31a2: 2e 69 6e 68 65 72 69 74 73        → ".inherits"
896e31ab: 11 1c 00 00                       → info 0x00001c11: scalar, POD 1 uint8, no ts index,
                                               0x400, constant, extent 1
896e31af: 01 04                             → numSamples 1, name length 4 (ts index = 0)
896e31b1: 2e 6f 70 73                       → ".ops"
896e31b5: b1 0d 01 00                       → info 0x00010db1: scalar float64, has ts,
                                               0x400, constant, extent 16
896e31b9: 01 01 05                          → numSamples 1, ts 1, name length 5
896e31bc: 2e 76 61 6c 73                    → ".vals"
```

#### Example: a constant property with many samples

`numSamples` can be large while only one sample is stored:

```
896e8a76: b1 6d 20 00                       → info 0x00206db1: scalar float64[6], has ts,
                                               0x400, constant (0x800), metadata [2]
896e8a7a: fa 01 0a                          → numSamples 250, ts 1, name length 10
896e8a7d: 2e 63 68 69 6c 64 42 6e 64 73     → ".childBnds"
```

**Check**: src `AbcCoreOgawa/WriteUtil.cpp:290-465`, `AbcCoreOgawa/ReadUtil.cpp:1740-1860`, `AbcCoreOgawa/ApwImpl.cpp:192-196` (scalar-like); demo (all headers decode with no bytes left; bit checks).

### 2.8 Sample index mapping

The writer does not store repeats of sample 0 before the first change, and does not store repeats of the last changed sample after the last change. Map a sample index `i` (`0 ≤ i < numSamples`) to a stored position `k`:

```js
function storedIndex(i, first, last) {
  if (i < first) return 0; // before the first change: sample 0
  if (first === 0 && last === 0) return 0; // constant property
  if (i >= last) return last - first + 1; // after the last change: last stored sample
  return i - first + 1;
}
```

Number of stored samples:

| Case                      | Stored samples     |
| ------------------------- | ------------------ |
| `numSamples == 0`         | 0                  |
| `first == 0 && last == 0` | 1                  |
| else                      | `last − first + 2` |

Repeats between `first` and `last` **are** stored, as references to the block of the earlier sample.

**Check**: src `AbcCoreOgawa/Foundation.h:123-147`, `AbcCoreOgawa/ApwImpl.cpp:160-212`; demo (the stored sample count of all 16 and 22 properties is equal to this table).

### 2.9 Scalar property samples

A scalar property group has one data child for each stored sample:

```
group:
  data[k]      sample k:  u8[16] key, then the value
```

The value is `extent` POD values (for `float64[6]`: 48 bytes). For strings, see [2.12](#212-data-types).

```
896e3173: 01 00 00 00 00 00 00 00           → .vals group: 1 child
896e317b: 41 00 00 00 00 00 00 80           → data @ 0x41

00000041: 90 00 00 00 00 00 00 00           → size 144 = 16 key + 16 × f64
00000049: 09 05 38 70 b0 b9 83 66 16 15 1d 2f e8 c2 3d b9   → key
00000059: 00 00 00 00 00 00 f0 3f           → 1.0
00000061: 00 00 00 00 00 00 00 00 ...       → 0.0 ... (identity 4×4 matrix)
```

**Check**: src `AbcCoreOgawa/SpwImpl.cpp:150-190`, `AbcCoreOgawa/WriteUtil.cpp:183-270`; demo.

### 2.10 Array property samples

An array property group has **two** children for each stored sample:

```
group:
  data[2k]     sample k data:        u8[16] key, then the element values
  data[2k+1]   sample k dimensions:  u64[rank], or empty data
```

- Element count of a sample:
  - If the dimensions child is **empty**: rank 1, and `count = (dataSize − 16) / (podSize × extent)`.
  - Else: the dimensions block is `rank` `u64` values. `count` is their product.
- The writer writes empty dimensions for all arrays of rank ≤ 1, except `string` and `wstring` arrays. String arrays always have a dimensions block.
- A sample with zero elements: the writer writes a 16-byte block (key, no values). The C++ reader also accepts empty data (size 0) as a sample with no key and no values. A reader must accept both. The demo files have no zero-element samples (the smallest sample block is 17 bytes).

```
896e5173: f4 01 00 00 00 00 00 00           → .faceCounts group: 500 children (250 samples × 2)
896e517b: 73 f6 00 00 00 00 00 80           → [0] data @ 0xf673     sample 0 data
896e5183: 00 00 00 00 00 00 00 80           → [1] empty data        sample 0 dims (rank 1)
896e518b: 8b bc 03 00 00 00 00 80           → [2] data @ 0x3bc8b    sample 1 data
896e5193: 00 00 00 00 00 00 00 80           → [3] empty data
          ...

0000f673: e0 28 00 00 00 00 00 00           → size 10464 → (10464 − 16) / 4 = 2612 faces
0000f67b: a1 7c 1e 6e 16 13 04 38 b6 22 c7 8d 5d 1f d7 3f   → key
0000f68b: 03 00 00 00 03 00 00 00 03 00 00 00 ...           → 3, 3, 3, ...
```

**Check**: src `AbcCoreOgawa/WriteUtil.cpp:160-178,262-266`, `Ogawa/OGroup.cpp:146-157`, `AbcCoreOgawa/ReadUtil.cpp:1352-1366`, `AbcCoreOgawa/AprImpl.cpp:105`; demo.

### 2.11 Sample keys and de-duplication

The first 16 bytes of each non-empty sample block are the **key**: **MurmurHash3_x64_128** with seed 0, of the value bytes after the key.

- For `string`, the hash input is the strings with a `0x00` after each string. These are the same bytes as on disk. For `wstring`, it is the `int32` units with a `0` unit after each string, also the same bytes as on disk.
- All sample blocks of both demo files were checked with `MurmurHash3_x64_128` from the installed Alembic library (`libAlembic` 1.8.12): 1 503 of 1 503 and 2 250 of 2 250 keys match.
- The article by Ginger Bill ([section 8](#8-sources)) says the key is "a 16-byte (128 bit) SpookyHash". That is not correct. SpookyHash V2 is used for the 32 hash bytes in object headers ([2.5.1](#251-object-headers)) and for property hashes, not for sample keys.

The writer keeps one map of keys for the whole archive. A key in the map is: byte count, POD type, and digest. For all POD types except `string` and `wstring`, the writer sets the POD type to `int8` before it looks in the map. If the key is in the map, the writer does not write the data again: it adds a reference to the first block. This works across properties, objects and POD types.

Example: `.inherits` of `/Cube` (`bool` `1`) and `visible` of `/Cube` (`int8` `1`) have the same byte. Both groups point to one block:

```
896e3163: 01 00 00 00 00 00 00 00 28 00 00 00 00 00 00 80   → .inherits: 1 child, data @ 0x28
896e31e9: 01 00 00 00 00 00 00 00 28 00 00 00 00 00 00 80   → visible:   1 child, data @ 0x28

00000028: 11 00 00 00 00 00 00 00           → size 17
00000030: 16 fe 74 83 90 5c ce 7a 85 67 0e 43 e4 67 88 77   → key
00000040: 01                                → value 1
```

`/alembic` does not check keys (**/alembic rule**). It skips the 16 bytes.

**Check**: src `AbcCoreAbstract/ArraySample.cpp:45-130`, `Util/Murmur3.cpp`, `AbcCoreAbstract/ArraySampleKey.h:60-66`, `AbcCoreOgawa/ApwImpl.cpp:144-158`, `AbcCoreOgawa/SpwImpl.cpp:150-154`, `AbcCoreOgawa/WriteUtil.cpp:183-205`, `AbcCoreOgawa/WrittenSampleMap.h:101-122`, `AbcCoreOgawa/OwData.cpp:186-214`; demo (key check with `libAlembic`); ext (article quote).

### 2.12 Data types

The POD type is bits 4–7 of `info`:

| Value | POD       | Bytes | JS read                 |
| ----- | --------- | ----- | ----------------------- |
| 0     | `bool`    | 1     | `getUint8() !== 0`      |
| 1     | `uint8`   | 1     | `getUint8`              |
| 2     | `int8`    | 1     | `getInt8`               |
| 3     | `uint16`  | 2     | `getUint16(o, true)`    |
| 4     | `int16`   | 2     | `getInt16(o, true)`     |
| 5     | `uint32`  | 4     | `getUint32(o, true)`    |
| 6     | `int32`   | 4     | `getInt32(o, true)`     |
| 7     | `uint64`  | 8     | `getBigUint64(o, true)` |
| 8     | `int64`   | 8     | `getBigInt64(o, true)`  |
| 9     | `float16` | 2     | decode in code (below)  |
| 10    | `float32` | 4     | `getFloat32(o, true)`   |
| 11    | `float64` | 8     | `getFloat64(o, true)`   |
| 12    | `string`  | var   | see below               |
| 13    | `wstring` | var   | see below               |

- Values 14 and 15 are not valid. The C++ reader rejects them.
- **Extent**: one element is `extent` POD values, one after the other. `P` is `float32` with extent 3: `x y z x y z ...`.
- **float16**: Alembic's `float16_t` is the Imath `half` type: IEEE 754 binary16, 1 sign bit, 5 exponent bits, 10 mantissa bits. Node 20.9 has no `DataView.prototype.getFloat16`, so decode in code. The demo files have no `float16` data.
- **string**: each string is its bytes followed by `0x00`. Split on `0x00`. The writer rejects strings that contain `0x00`. The format does not store an encoding. `/alembic` decodes the bytes as UTF-8 (**/alembic rule**). The demo files have no string data.
- **wstring**: each string is one `int32` per `wchar_t` of the writer, followed by a `0` unit. The demo files have no wstring data.
- **Bounds** (`.selfBnds`, `.childBnds`): `float64` extent 6, metadata `interpretation=box`, values `minX minY minZ maxX maxY maxZ`. In both files, each `Cube_241/.geom/.selfBnds` sample contains all points of the `P` sample of the same frame (250 of 250). An empty box has min `+DBL_MAX` and max `−DBL_MAX`:

  ```
  00028f0b: 40 00 00 00 00 00 00 00           → size 64
  00028f13: 31 04 88 ee 1c 82 f5 93 c7 ce fe b3 87 58 3d bb   → key
  00028f23: ff ff ff ff ff ff ef 7f (× 3)     → min = +1.7976931348623157e308
  00028f3b: ff ff ff ff ff ff ef ff (× 3)     → max = −1.7976931348623157e308   (empty box)
  ```

- The `interpretation` values defined in the Alembic source are `point`, `vector`, `normal`, `box`, `matrix`, `rgb`, `rgba`, `quat`. They do not change the bytes.

**Check**: src `Util/PlainOldDataType.h:159,189-222,254-267`, Imath 3.2.2 `half.h:18-20`, `AbcCoreOgawa/ReadUtil.cpp:1766-1787`, `AbcCoreOgawa/WriteUtil.cpp:213-258`, `Abc/TypedPropertyTraits.h`; ext/local: `node -e` on Node v20.9.0 (`typeof DataView.prototype.getFloat16` is `undefined`; `Number.MAX_SAFE_INTEGER === 2**53 - 1`); demo.

---

## 3. AbcGeom schemas

A schema is a set of named properties in one compound property of an object. In the PolyMesh, Points, Xform and GeomParam source, property names start with `.`, except `P`, `N`, `uv`, `visible` and `isNotConstantIdentity`.

### 3.1 Parts common to all schemas

- In the demo files, the metadata of each object except `/` has `schema=<name>` and `schemaObjTitle=<name>:<compound>` ([2.5.1](#251-object-headers)).
- The schema compound is in the object's top compound. Its metadata has `schema=<name>`, and for geometry also `schemaBaseType=AbcGeom_GeomBase_v1`.
- Parts of a schema compound:

| Name              | Kind     | Type         | Content                                                    |
| ----------------- | -------- | ------------ | ---------------------------------------------------------- |
| `.selfBnds`       | scalar   | `float64[6]` | bounds of this object's geometry ([2.12](#212-data-types)) |
| `.childBnds`      | scalar   | `float64[6]` | bounds of the children                                     |
| `.arbGeomParams`  | compound |              | extra geometry parameters ([3.3](#33-geometry-parameters)) |
| `.userProperties` | compound |              | user data (in the demo: `meshtype`, `bool`)                |

- `visible`: an `int8` scalar in the object's **top** compound (not in the schema compound). `-1` deferred, `0` hidden, `1` visible. If there is no `visible` property, the C++ reader returns "deferred".

Tree of `demo-nonparticle.abc`:

```
/                               top compound: .childBnds (constant, empty box)
└─ Cube          Xform_v3       top compound: .xform, visible
   │                            .xform: .inherits, .ops, .vals
   └─ Cube_241   PolyMesh_v1    top compound: .geom
                                .geom: .selfBnds, P, .faceIndices, .faceCounts,
                                       .userProperties { meshtype },
                                       .arbGeomParams  { Pref },
                                       N
```

`demo.abc` has `/Cube/Liquid` (Points_v1) as the first child of `/Cube`, and `Cube_241` as the second.

**Check**: src `AbcGeom/OPolyMesh.cpp`, `AbcGeom/OPoints.cpp`, `AbcGeom/OXform.cpp`, `AbcGeom/OGeomParam.h` (all quoted names), `AbcGeom/OGeomBase.h:167-209`, `AbcGeom/IGeomBase.h:118-124`, `AbcGeom/Visibility.h:60-78`, `AbcGeom/Visibility.cpp:86-100`, `AbcGeom/OXform.cpp:359-401`; demo; `abcls -r -l -t` (1.8.12) output for both files.

### 3.2 PolyMesh (`AbcGeom_PolyMesh_v1`, compound `.geom`)

| Name                                | Kind      | Type         | C++ reader       | Content                                     |
| ----------------------------------- | --------- | ------------ | ---------------- | ------------------------------------------- |
| `P`                                 | array     | `float32[3]` | always reads     | vertex positions                            |
| `.faceIndices`                      | array     | `int32[1]`   | always reads     | vertex index for each face corner           |
| `.faceCounts`                       | array     | `int32[1]`   | always reads     | corner count for each face                  |
| `.selfBnds`                         | scalar    | `float64[6]` | always reads     | bounds                                      |
| `N`                                 | GeomParam | `float32[3]` | reads if present | normals                                     |
| `uv`                                | GeomParam | `float32[2]` | reads if present | texture coordinates (not in the demo files) |
| `.velocities`                       | array     | `float32[3]` | reads if present | velocity per vertex (not in the demo files) |
| `.arbGeomParams`, `.userProperties` | compound  |              | reads if present |                                             |

"Always reads" means the C++ reader opens the property without first checking that it exists. "Reads if present" means it checks with `getPropertyHeader` first.

Rules:

- Face `f` uses `.faceCounts[f]` corners. The corners of face `f` start at the sum of all counts before `f`. Thus `sum(.faceCounts) == length(.faceIndices)`.
- Each value in `.faceIndices` is an index into `P`: `0 ≤ value < length(P)`.
- The format allows any corner count per face. The demo mesh has only triangles (36 051 236 faces over 250 frames, all with 3 corners). `/alembic` must triangulate faces with more than 3 corners (**/alembic rule**).
- **Winding.** In both files, over all 250 frames, the stored normal `N` of the first corner is opposite to the counter-clockwise normal `(P[b] − P[a]) × (P[c] − P[a])` for 36 051 094 faces. It agrees for 3 faces. The cross product is 0 for 139 faces. Thus the demo faces are clockwise. three.js uses counter-clockwise front faces (`gl.frontFace(gl.CCW)` by default, and the OpenGL ES default is `GL_CCW`). `/alembic` must reverse the corner order of each face for three.js (**/alembic rule**).
- **Topology can change on each frame.** Then `P`, `.faceIndices` and `.faceCounts` all change size. The file does not store a topology type. Compare sample sizes (do not use the `0x400` flag, see [6.4](#64-the-homogeneous-flag-does-not-mean-constant-size)).

Checked in both files (the counts are equal in both files):

| Frame | Points  | Faces   | `.faceIndices` | `sum(.faceCounts)` | max index | `N` values |
| ----- | ------- | ------- | -------------- | ------------------ | --------- | ---------- |
| 0     | 1 308   | 2 612   | 7 836          | 7 836              | 1 307     | 7 836      |
| 1     | 1 606   | 3 208   | 9 624          | 9 624              | 1 605     | 9 624      |
| 124   | 85 998  | 172 088 | 516 264        | 516 264            | 85 997    | 516 264    |
| 249   | 120 598 | 241 800 | 725 400        | 725 400            | 120 597   | 725 400    |

For all 250 frames: `sum(.faceCounts) == length(.faceIndices)`, `0 ≤ index < length(P)`, `length(N) == length(.faceIndices)`, `length(Pref) == length(P)`.

`P` sample 0:

```
00003e83: 60 3d 00 00 00 00 00 00           → size 15712 → (15712 − 16) / 12 = 1308 points
00003e8b: (16 key bytes)
00003e9b: ...                               → (−0.19428, 1.02343, 0.36620), (−0.19454, 1.02343, 0.36446), ...
```

`.faceIndices` sample 0:

```
00007beb: 80 7a 00 00 00 00 00 00           → size 31360 → 7836 indices
00007bf3: 10 75 f8 3f c4 8b 81 f2 25 fa 80 1b 10 3e a3 ef   → key
00007c03: 01 00 00 00 00 00 00 00 02 00 00 00   → face 0 = (1, 0, 2)
00007c0f: 03 00 00 00 02 00 00 00 00 00 00 00   → face 1 = (3, 2, 0)
```

**Check**: src `AbcGeom/IPolyMesh.cpp:83-106`, `AbcGeom/OPolyMesh.cpp:229-275`; demo (all frames, both files); ext (three.js `WebGLState.js`, Khronos `glFrontFace`).

### 3.3 Geometry parameters

A geometry parameter ("GeomParam") is a value for each item of one scope of the geometry. There are two forms on disk.

**Not indexed**: one array property with the parameter name. Its metadata has `isGeomParam=true`.

```
N : array float32[3]
    metadata: arrayExtent=1;geoScope=fvr;interpretation=normal;isGeomParam=true;podExtent=3;podName=float32_t
```

**Indexed**: one compound property with the parameter name and the same metadata. It holds:

| Name       | Kind  | Type           | Content                                           |
| ---------- | ----- | -------------- | ------------------------------------------------- |
| `.vals`    | array | the value type | values (same metadata as the compound)            |
| `.indices` | array | `uint32[1]`    | one index into `.vals` for each item of the scope |

To expand: `value[j] = .vals[.indices[j]]`. The demo files have only not-indexed parameters.

Metadata keys:

| Key              | Meaning                                               |
| ---------------- | ----------------------------------------------------- |
| `geoScope`       | which items have a value, below                       |
| `isGeomParam`    | `true`                                                |
| `podName`        | POD name of one value, for example `float32_t`        |
| `podExtent`      | extent of one value                                   |
| `arrayExtent`    | values per item (`1` in all demo geometry parameters) |
| `interpretation` | as in [2.12](#212-data-types)                         |

`geoScope` for a PolyMesh ("PointsPolygons" in the Alembic table):

| Value           | Scope        | Number of values                         |
| --------------- | ------------ | ---------------------------------------- |
| `con` or no key | constant     | 1                                        |
| `uni`           | uniform      | one per face                             |
| `var`           | varying      | one per vertex                           |
| `vtx`           | vertex       | one per vertex                           |
| `fvr`           | face-varying | one per face corner (`sum(.faceCounts)`) |

In both files, `N` is `fvr` and `Pref` (in `.arbGeomParams`) is `vtx`, and their lengths match this table on all 250 frames ([3.2](#32-polymesh-abcgeom_polymesh_v1-compound-geom)).

**Check**: src `AbcGeom/OGeomParam.h:186-240`, `AbcGeom/IGeomParam.h:161,251-253`, `AbcGeom/GeometryScope.h:60-104`, `AbcGeom/GeometryScope.h:117-134`; demo.

### 3.4 Xform (`AbcGeom_Xform_v3`, compound `.xform`)

| Name                    | Kind   | Type                   | C++ reader                                                                                    |
| ----------------------- | ------ | ---------------------- | --------------------------------------------------------------------------------------------- |
| `.ops`                  | scalar | `uint8[numOps]`        | reads sample 0 only. If missing, no ops                                                       |
| `.vals`                 | scalar | `float64[numChannels]` | all channel values, in op order. The writer uses an array `float64[1]` if `numChannels > 256` |
| `.inherits`             | scalar | `bool`                 | can have many samples. If missing or empty: `true`                                            |
| `.animChans`            | array  | `uint32[1]`            | indices of animated channels. Reads the last sample                                           |
| `isNotConstantIdentity` | scalar | `bool`                 | if the property exists, the transform is not constant identity                                |

- `.inherits` = `false` means: do not multiply with the parent transform ("ignore the parent").
- If `.ops` is missing, the op list is empty and the matrix is identity.

Op byte: `type << 4 | hint`.

| Type | Op        | Channels | Values                           |
| ---- | --------- | -------- | -------------------------------- |
| 0    | scale     | 3        | x y z                            |
| 1    | translate | 3        | x y z                            |
| 2    | rotate    | 4        | axis x y z, angle in **degrees** |
| 3    | matrix    | 16       | 4×4 matrix                       |
| 4    | rotate X  | 1        | angle in degrees                 |
| 5    | rotate Y  | 1        | angle in degrees                 |
| 6    | rotate Z  | 1        | angle in degrees                 |

The hint is a label for applications (for example, translate hints `1`–`4` are scale / rotate pivot points). `XformSample::getMatrix` does not use it.

**Matrix.** `XformSample::getMatrix` starts with identity, and for each op `i` in order does `ret = M(op i) * ret`, with Imath row-vector matrices. In three.js (column vector) terms this is `M = M(op 0) × M(op 1) × … × M(op n−1)`: the **last** op is applied first to a point. For the op list `translate, rotate, scale` this gives `T × R × S`.

A matrix op stores `m.x[j][k]` at channel `4j + k`, so its translation is in channels 12, 13, 14. three.js `Matrix4.elements` is column-major, `fromArray` copies the array into `elements` without change, and `setPosition` writes the translation to `elements[12..14]`. Thus the 16 channels of a matrix op go directly into `Matrix4.fromArray`.

**Animated vs static.** If `.vals` and `.inherits` are both constant (bit `0x800`), the transform is static. Else read the samples of each frame.

`/Cube` in the demo is a static identity matrix:

```
000000d9: 11 00 00 00 00 00 00 00           → .ops sample: size 17
000000e1: 80 a3 46 d5 be de c9 2a 09 5e 87 3c e5 e9 8d 3a   → key
000000f1: 30                                → op 0x30: type 3 (matrix), hint 0
00000041: 90 00 00 00 00 00 00 00           → .vals sample: size 144
00000059: 1.0 0 0 0  0 1.0 0 0  0 0 1.0 0  0 0 0 1.0      → identity (see 2.9)
```

**Check**: src `AbcGeom/OXform.cpp:40,55-80,145-215,274-279`, `AbcGeom/IXform.cpp:55-140,325-340`, `AbcGeom/XformOp.cpp:55-80,85,277-279`, `AbcGeom/XformOp.h:51-111`, `AbcGeom/XformSample.cpp:550-613`, `AbcGeom/XformSample.h:84-87`; Imath 3.2.2 `ImathMatrix.h:1339` (`r = v * m`), `ImathMatrix.h:4828-4845` (`setTranslation` writes `x[3][0..2]`); ext (three.js `Matrix4.js`); demo.

### 3.5 Points (`AbcGeom_Points_v1`, compound `.geom`)

From `/Cube/Liquid` in `demo.abc`:

| Name          | Kind      | Type         | C++ reader       | Metadata in demo                             |
| ------------- | --------- | ------------ | ---------------- | -------------------------------------------- |
| `P`           | array     | `float32[3]` | always reads     | `geoScope=var;interpretation=point`          |
| `.pointIds`   | array     | `uint64[1]`  | always reads     | `geoScope=var`                               |
| `.selfBnds`   | scalar    | `float64[6]` | always reads     | `interpretation=box`                         |
| `.velocities` | array     | `float32[3]` | reads if present | `interpretation=vector`                      |
| `.widths`     | GeomParam | `float32[1]` | reads if present | `geoScope=vtx;isGeomParam=true` (+ pod keys) |

Data in `demo.abc` (all 250 frames):

- The point count changes: 239 points in frame 0, 69 344 at most.
- `P`, `.pointIds`, `.velocities` and `.widths` have the same length in each frame.
- `.pointIds` is `0, 1, …, n−1` in every frame. Thus in this file the IDs do not follow one particle from frame to frame.
- All `.widths` values are `0.05` (`float32`).
- `.velocities` is a copy of `P`, and `.selfBnds` is the mesh bounds (see [6.1](#61-velocities-of-points-is-a-copy-of-p), [6.5](#65-selfbnds-of-points-is-the-mesh-bounds)).

```
Liquid .geom header block (72 bytes):
b1 65 10 00  fa 01  09 ".selfBnds"       → scalar float64[6], ts 1, metadata [1] interpretation=box
a2 31 20 00  fa 01  01 "P"               → array float32[3], metadata [2] geoScope=var;interpretation=point
72 15 30 00  fa 01  09 ".pointIds"       → array uint64[1] (POD 7), metadata [3] geoScope=var
a2 31 40 00  fa 01  0b ".velocities"     → array float32[3], metadata [4] interpretation=vector
a2 15 50 00  fa 01  07 ".widths"         → array float32[1], metadata [5]
```

**Check**: src `AbcGeom/IPoints.cpp:56-71`, `AbcGeom/IGeomBase.h:118`, `AbcGeom/OPoints.cpp:113-179`; demo.

---

## 4. Time sampling

Root child `[4]` holds all time samplings of the archive, one after the other:

```
repeat until end of block:
  u32        maxSample        largest sample count of the properties that use this sampling
  f64        timePerCycle
  u32        numStoredTimes   (≥ 1)
  f64[n]     storedTimes
```

- For `maxSample`, a constant property counts as 1 sample.
- Index `0` is always the default sampling: uniform, `timePerCycle` 1.0, stored time 0.0. A property uses it when bit `0x100` of its header is clear.

```
896e8bc6: 30 00 00 00 00 00 00 00           → size 48
896e8bce: fa 00 00 00                       → [0] maxSample 250
896e8bd2: 00 00 00 00 00 00 f0 3f           →     timePerCycle 1.0
896e8bda: 01 00 00 00                       →     1 stored time
896e8bde: 00 00 00 00 00 00 00 00           →     0.0
896e8be6: fa 00 00 00                       → [1] maxSample 250
896e8bea: 55 55 55 55 55 55 a5 3f           →     timePerCycle 0.041666… (1/24)
896e8bf2: 01 00 00 00                       →     1 stored time
896e8bf6: 55 55 55 55 55 55 a5 3f           →     0.041666…
```

In the demo, `maxSample` of sampling `[0]` is 250 because of `Pref` ([6.2](#62-pref-uses-time-sampling-0)).

**Check**: src `AbcCoreOgawa/WriteUtil.cpp:513-537`, `AbcCoreOgawa/ReadUtil.cpp:1491-1550`, `AbcCoreOgawa/AwImpl.cpp:56-58,242-250`, `AbcCoreOgawa/ApwImpl.cpp:68-86`, `AbcCoreOgawa/SpwImpl.cpp:65-84`, `AbcCoreAbstract/TimeSampling.cpp:110-115`; demo.

### 4.1 Sampling types

`ACYCLIC = Number.MAX_VALUE / 32` (`f64` bytes `0x7f9fffffffffffff`, `5.6177910464447366e306`).

| Type    | Rule                                                | Time of sample `i`                         |
| ------- | --------------------------------------------------- | ------------------------------------------ |
| uniform | `numStoredTimes == 1` and `timePerCycle != ACYCLIC` | `t[0] + i × timePerCycle`                  |
| cyclic  | `numStoredTimes > 1` and `timePerCycle != ACYCLIC`  | `t[i mod n] + floor(i / n) × timePerCycle` |
| acyclic | `timePerCycle == ACYCLIC`                           | `t[i]`, `i < n`                            |

- The writer writes `timePerCycle` as raw `f64` bytes, and the C++ reader compares it with `ACYCLIC` with `!=`. Compare exactly.
- Uniform and cyclic samplings have no end. The number of samples comes from each property (`numSamples`).
- Archive time range (C++ `GetArchiveStartAndEndTime`): from the samplings with index ≠ 0 and `maxSample > 1`, the range is `[min time(0), max time(maxSample − 1)]`. If there are none, it uses the samplings with index ≠ 0 and `maxSample == 1`. If there are none, it uses sampling 0 (if its `maxSample > 0`).
- Both demo files: sampling `[1]` is uniform, `t[0]` = 1/24, step 1/24, `maxSample` 250. Thus the range is 1/24 s … 250/24 s (0.0417 s … 10.4167 s).

**Check**: src `AbcCoreAbstract/TimeSamplingType.cpp:51,64-67`, `AbcCoreAbstract/TimeSampling.cpp:133-155`, `AbcCoreOgawa/ReadUtil.cpp:1540-1543`, `Abc/ArchiveInfo.cpp:92-150`; local `python3` (`struct.pack('>d', sys.float_info.max / 32)`); demo.

### 4.2 Time to sample index

The C++ `getFloorIndex` clamps a time before `time(0)` to index 0, and a time after `time(numSamples − 1)` to the last index. `/alembic` uses (**/alembic rule**):

- uniform: `i = clamp((t − t[0]) / timePerCycle, 0, numSamples − 1)`, `floor(i)` and `floor(i) + 1` with the fraction to blend;
- acyclic: binary search in `storedTimes`;
- then [2.8](#28-sample-index-mapping) to find the stored sample.
- Blend two samples only if they have the same element count.

**Check**: src `AbcCoreAbstract/TimeSampling.cpp:158-180`.

---

## 5. Out of scope

`/alembic` does not read these (**/alembic rule**). It gives a clear error, or skips them.

| Item                                         | Detection                                                         | Action                              |
| -------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------- |
| HDF5 archives                                | first 8 bytes are `89 48 44 46 0d 0a 1a 0a` (`\x89HDF\r\n\x1a\n`) | reject with an HDF5 message         |
| Other non-Ogawa files                        | magic is not `"Ogawa"`                                            | reject                              |
| Not-closed Ogawa file                        | frozen flag `0x00`                                                | reject                              |
| SubD                                         | object `schema=AbcGeom_SubD_v1`                                   | skip the object                     |
| NURBS                                        | object `schema=AbcGeom_NuPatch_v2`                                | skip                                |
| Curves                                       | object `schema=AbcGeom_Curve_v2`                                  | skip                                |
| Camera                                       | object `schema=AbcGeom_Camera_v1`                                 | skip                                |
| Lights                                       | object `schema=AbcGeom_Light_v1`                                  | skip                                |
| FaceSets (child objects of a PolyMesh)       | object `schema=AbcGeom_FaceSet_v1`                                | skip                                |
| Materials                                    | object `schema=AbcMaterial_Material_v1`                           | skip                                |
| Collections                                  | object `schema=AbcCollection_Collections_v1`                      | skip                                |
| Layered archives (several files read as one) | object or property metadata `prune=1` or `replace=1`              | ignore the keys, read one file only |

- The C++ factory tries Ogawa first, then HDF5. HDF5 2.2.0 writes the 8 bytes above at offset 0 of a new file (checked with a test file made with `H5Fcreate`). Alembic HDF5 files were not tested.
- When `/alembic` skips an object, it still walks the object's children.

**Check**: src `AbcCoreFactory/IFactory.cpp:66-81`, `AbcGeom/SchemaInfoDeclarations.h`, `AbcMaterial/`, `AbcCollection/`, `AbcCoreLayer/Util.cpp:43-70`, `AbcCoreLayer/OrImpl.cpp:264-267`, `AbcCoreLayer/CprImpl.cpp:215-218`, `AbcGeom/OPolyMesh.cpp:443-451`; local (HDF5 test file, `xxd`); demo (no `prune` / `replace` keys, no inline metadata).

---

## 6. Writer quirks found in the demo files

These are true for the demo files (Blender 5.0.0, Alembic 1.8.3). `/alembic` must work with them.

### 6.1 `.velocities` of Points is a copy of `P`

In `demo.abc`, all 250 `.velocities` samples of `/Cube/Liquid` point to the **same blocks** as the `P` samples of the same frame. The values are positions, not velocities.

**Check**: demo (250 of 250 equal offsets).

### 6.2 `Pref` uses time sampling 0

`Pref` in `.arbGeomParams` has 250 different samples, but its header has no time sampling index. Thus it uses sampling `0` (times 0 s, 1 s, 2 s, …). Its sample `i` has the same length as sample `i` of `P` on all 250 frames. Match `Pref` to `P` by sample index, not by time.

**Check**: demo.

### 6.3 `.childBnds` of `/` is an empty box

The top object has a constant `.childBnds` with the empty box (min `+DBL_MAX`, max `−DBL_MAX`). Use the `.selfBnds` of the meshes for bounds.

**Check**: demo (dump in [2.12](#212-data-types)).

### 6.4 The homogeneous flag does not mean "constant size"

The writer replaces its "previous sample" record with the new sample, and then compares the new element count with the element count × extent of that **same** record. Thus:

- arrays with extent 1 (`.faceIndices`, `.faceCounts`, `.pointIds`, `.widths`) always have `0x400` set, but their size changes on each frame;
- arrays with extent > 1 (`P`, `N`, `Pref`, `.velocities`) never have `0x400` set.

Find constant element counts by comparing sample sizes.

**Check**: src `AbcCoreOgawa/ApwImpl.cpp:185-203`, `AbcCoreOgawa/WriteUtil.cpp:268-269`, `AbcCoreOgawa/WrittenSampleMap.h:67-72`; demo (all 5 and 9 array properties).

### 6.5 `.selfBnds` of Points is the mesh bounds

In `demo.abc`, all 250 `.selfBnds` samples of `/Cube/Liquid` point to the same blocks as the `.selfBnds` samples of `/Cube/Cube_241`. In 172 of 250 frames, some points of `Liquid` are outside these bounds. Do not use them as the bounds of the points: compute bounds from `P`.

**Check**: demo (250 of 250 equal offsets; 172 of 250 frames fail the "contains all `P`" test).

### 6.6 Shared blocks

Blocks are shared across properties and POD types ([2.11](#211-sample-keys-and-de-duplication)): `visible` shares its block with `.inherits`; 2 `.faceCounts` samples share earlier blocks; `demo.abc` has 506 shared references in total. A cache of decoded data with the block offset as key must also include the POD type and extent in the key, because the same bytes can have two types.

**Check**: demo.

---

## 7. Byte accounting

The walker script read each file with the rules in this document. It gave each byte range to the structure that owns it, and counted shared blocks once. Result for both files: **every byte is in exactly one range. There are no gaps and no overlaps.**

### 7.1 `demo-nonparticle.abc` (2 305 723 951 bytes)

| Structure                                            | Count                      | Bytes             |
| ---------------------------------------------------- | -------------------------- | ----------------- |
| Ogawa file header                                    | 1                          | 16                |
| Ogawa group: `numChildren` fields                    | 23 groups                  | 184               |
| Ogawa group: child tables                            | 2 793 references           | 22 344            |
| Ogawa data: `size` fields                            | 1 518 blocks               | 12 144            |
| Abc archive version (`[0]`)                          | 1                          | 4                 |
| Abc library version (`[1]`)                          | 1                          | 4                 |
| Abc archive metadata (`[3]`)                         | 1                          | 255               |
| Abc time samplings (`[4]`)                           | 2 samplings                | 48                |
| Abc indexed metadata (`[5]`)                         | 8 strings                  | 497               |
| Abc object header blocks (22 header + 96 hash bytes) | 3 objects                  | 118               |
| Abc property header blocks                           | 7 compounds, 16 properties | 222               |
| Sample keys                                          | 1 503 unique samples       | 24 048            |
| Sample values                                        | 1 503 unique samples       | 2 305 664 067     |
| **Total**                                            |                            | **2 305 723 951** |

Cross checks:

- 23 groups = 1 root + 3 objects + 7 compounds + 12 scalar / array properties.
- 16 property headers = 4 compounds (`.xform`, `.geom`, `.userProperties`, `.arbGeomParams`) + 7 scalars + 5 arrays.
- 1 518 data blocks = 5 archive blocks + 3 object header blocks + 7 property header blocks + 1 503 sample blocks.
- 2 793 references = 6 (root) + 8 (objects) + 23 (compounds) + 2 756 (properties: 6 single-sample scalars × 1, `.selfBnds` 250, 5 arrays × 500).
- 1 250 of the references are empty data (array dimensions).

| Property                                  | `numSamples` | stored | unique blocks          |
| ----------------------------------------- | ------------ | ------ | ---------------------- |
| `/.childBnds`                             | 250          | 1      | 1                      |
| `/Cube/.xform/.inherits`                  | 1            | 1      | 1                      |
| `/Cube/.xform/.ops`                       | 1            | 1      | 1                      |
| `/Cube/.xform/.vals`                      | 1            | 1      | 1                      |
| `/Cube/visible`                           | 1            | 1      | 0 (shares `.inherits`) |
| `Cube_241/.geom/.selfBnds`                | 250          | 250    | 250                    |
| `Cube_241/.geom/P`                        | 250          | 250    | 250                    |
| `Cube_241/.geom/.faceIndices`             | 250          | 250    | 250                    |
| `Cube_241/.geom/.faceCounts`              | 250          | 250    | 248                    |
| `Cube_241/.geom/.userProperties/meshtype` | 1            | 1      | 1                      |
| `Cube_241/.geom/.arbGeomParams/Pref`      | 250          | 250    | 250                    |
| `Cube_241/.geom/N`                        | 250          | 250    | 250                    |
| **Total**                                 |              |        | **1 503**              |

Map of all bytes outside sample blocks. Sizes include the 8-byte `size` / `numChildren` prefix.

| Offset range              | Bytes | Owner                                             |
| ------------------------- | ----- | ------------------------------------------------- |
| `0x00000000`–`0x00000010` | 16    | file header                                       |
| `0x00000010`–`0x0000001c` | 12    | root `[0]` archive version (data)                 |
| `0x0000001c`–`0x00000028` | 12    | root `[1]` library version (data)                 |
| `0x00000028`–`0x0000010b` | 227   | samples: `.inherits`, `.vals`, `.ops`, `meshtype` |
| `0x0000010b`–`0x0000011b` | 16    | group `meshtype`                                  |
| `0x0000011b`–`0x896e3163` | —     | sample blocks, frame 0 to frame 249               |
| `0x896e3163`–`0x896e3193` | 48    | groups `.inherits`, `.vals`, `.ops`               |
| `0x896e3193`–`0x896e31c1` | 46    | `.xform` property headers (data)                  |
| `0x896e31c1`–`0x896e31e9` | 40    | group `.xform`                                    |
| `0x896e31e9`–`0x896e31f9` | 16    | group `visible`                                   |
| `0x896e31f9`–`0x896e41a1` | 4 008 | group `Pref` (500 references)                     |
| `0x896e41a1`–`0x896e5149` | 4 008 | group `N`                                         |
| `0x896e5149`–`0x896e515b` | 18    | `.arbGeomParams` property headers                 |
| `0x896e515b`–`0x896e5173` | 24    | group `.arbGeomParams`                            |
| `0x896e5173`–`0x896e611b` | 4 008 | group `.faceCounts`                               |
| `0x896e611b`–`0x896e70c3` | 4 008 | group `.faceIndices`                              |
| `0x896e70c3`–`0x896e806b` | 4 008 | group `P`                                         |
| `0x896e806b`–`0x896e8081` | 22    | `.userProperties` property headers                |
| `0x896e8081`–`0x896e8099` | 24    | group `.userProperties`                           |
| `0x896e8099`–`0x896e8871` | 2 008 | group `.selfBnds` (250 references)                |
| `0x896e8871`–`0x896e88e5` | 116   | `.geom` property headers                          |
| `0x896e88e5`–`0x896e892d` | 72    | group `.geom`                                     |
| `0x896e892d`–`0x896e8955` | 40    | `Cube_241` object headers (hashes only)           |
| `0x896e8955`–`0x896e8967` | 18    | `Cube_241` top compound property headers          |
| `0x896e8967`–`0x896e897f` | 24    | group `Cube_241` top compound                     |
| `0x896e897f`–`0x896e8997` | 24    | group object `Cube_241`                           |
| `0x896e8997`–`0x896e89cc` | 53    | `/Cube` object headers                            |
| `0x896e89cc`–`0x896e89ed` | 33    | `/Cube` top compound property headers             |
| `0x896e89ed`–`0x896e8a0d` | 32    | group `/Cube` top compound                        |
| `0x896e8a0d`–`0x896e8a2d` | 32    | group object `/Cube`                              |
| `0x896e8a2d`–`0x896e8a3d` | 16    | group `.childBnds`                                |
| `0x896e8a3d`–`0x896e8a6e` | 49    | `/` object headers                                |
| `0x896e8a6e`–`0x896e8a87` | 25    | `/` top compound property headers                 |
| `0x896e8a87`–`0x896e8a9f` | 24    | group `/` top compound                            |
| `0x896e8a9f`–`0x896e8abf` | 32    | group object `/`                                  |
| `0x896e8abf`–`0x896e8bc6` | 263   | root `[3]` archive metadata (data)                |
| `0x896e8bc6`–`0x896e8bfe` | 56    | root `[4]` time samplings (data)                  |
| `0x896e8bfe`–`0x896e8df7` | 505   | root `[5]` indexed metadata (data)                |
| `0x896e8df7`–`0x896e8e2f` | 56    | root group                                        |

### 7.2 `demo.abc` (2 506 108 821 bytes)

| Structure                  | Bytes                         |
| -------------------------- | ----------------------------- |
| Ogawa file header          | 16                            |
| Ogawa group `numChildren`  | 248 (31 groups)               |
| Ogawa group child tables   | 40 432 (5 054 references)     |
| Ogawa data `size` fields   | 18 144 (2 268 blocks)         |
| Abc archive versions       | 8                             |
| Abc archive metadata       | 255                           |
| Abc time samplings         | 48                            |
| Abc indexed metadata       | 799 (14 strings)              |
| Abc object header blocks   | 161                           |
| Abc property header blocks | 304 (22 properties)           |
| Sample keys                | 36 000 (2 250 unique samples) |
| Sample values              | 2 506 012 406                 |
| **Total**                  | **2 506 108 821**             |

**Check**: demo (walker range list; sums are equal to the file sizes).

---

## 8. Sources

- Alembic C++ library 1.8.12, <https://github.com/alembic/alembic>, commit `2d54c7c2c3ba4dd9f30215c9663f0ea1aa8fd2a5`. All **src** references use this commit.
- Installed Alembic 1.8.12 (Homebrew): `abcls -r -l -t` output (object tree, schemas, time samplings) matches this document; `libAlembic` `MurmurHash3_x64_128` used for the key check in [2.11](#211-sample-keys-and-de-duplication).
- Ginger Bill, "Reverse Engineering Alembic" (2022), <https://www.gingerbill.org/article/2022/07/11/reverse-engineering-alembic/>. A good overview of the Ogawa and Abc layers. Two parts do not agree with the C++ source and the demo data:
  - It says the sample key "is represented as a 16-byte (128 bit) SpookyHash". The key is MurmurHash3 ([2.11](#211-sample-keys-and-de-duplication)).
  - Its `Property_Header` pseudo-code puts `next_sample_index`, `first_changed_index`, `last_changed_index` and `time_sampling_index` under `when Compound`. The C++ writer and reader store these fields only for scalar and array properties ([2.7](#27-property-headers)).
- three.js `src/math/Matrix4.js` (dev branch), <https://raw.githubusercontent.com/mrdoob/three.js/dev/src/math/Matrix4.js>: "internally they are stored in the … elements array in column-major order"; `fromArray` copies `array[i + offset]` to `elements[i]`; `setPosition` writes `te[12]`, `te[13]`, `te[14]`.
- three.js `src/renderers/webgl/WebGLState.js` (dev branch), <https://raw.githubusercontent.com/mrdoob/three.js/dev/src/renderers/webgl/WebGLState.js>: `reset()` calls `gl.frontFace( gl.CCW )`.
- Khronos, OpenGL ES 2.0 `glFrontFace`, <https://registry.khronos.org/OpenGL-Refpages/es2.0/xhtml/glFrontFace.xml>: "The initial value is GL_CCW."
- HDF5 2.2.0 (Homebrew): test file made with `H5Fcreate`, first 8 bytes read with `xxd`.
- The demo files, read by the walker script with the rules above ([section 7](#7-byte-accounting)).
