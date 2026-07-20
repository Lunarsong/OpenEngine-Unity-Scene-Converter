# OpenEngine Unity Scene Converter

Converts a Unity scene (from an extracted `.unitypackage`, e.g. Synty packs)
into an OpenEngine/GameEngine text `.scene` file. Scope: **static mesh
placements + materials (`.mat` → `.material`) + lights (directional/point) +
scene environment (fog/ambient → day-night classification, physical light
units)**, with optional URP pipeline/post-processing state pulled from a real
Unity project.

Zero runtime dependencies — Node.js stdlib only.

## Install

```
npm install -g github:Lunarsong/OpenEngine-Unity-Scene-Converter
```

or from a clone:

```
git clone https://github.com/Lunarsong/OpenEngine-Unity-Scene-Converter.git
cd OpenEngine-Unity-Scene-Converter
npm link        # puts unity-scene-convert / unity-scene-validate on PATH
```

Requires Node.js >= 22.

## CLI usage

```
unity-scene-convert [<pkg-dir> [<project-dir>]] \
                    [--pkg <extracted-pkg-dir>] \
                    [--scene <scene path suffix | unity guid>] \
                    [--project <target-project-dir>] \
                    [--assetdb <file>] [--unity-project <unity-project-dir>] \
                    [--out <output.scene>] [--local-shadows off|faithful] \
                    [--no-copy-textures] [--png] [--texc <TextureCompiler.exe>] \
                    [--verbose]
```

- The first positional argument maps to `--pkg`, the second to `--project`
  (explicit flags win). When `--scene` is omitted and the package contains
  exactly one `.unity` scene, it is auto-picked.
- `--pkg` — directory produced by `tar -xzf pack.unitypackage` (entries are
  `<guid>/pathname` + `<guid>/asset`).
- `--scene` — e.g. `scenes/demo.unity` (case-insensitive path suffix) or the
  asset guid.
- `--project` — target engine project dir. Uses
  `<project>/AssetDatabase.assetdb` for mesh resolution (override with
  `--assetdb`) and defaults output to `<project>/assets/<Scene>_unity.scene`.
- `--unity-project` — optional path to a REAL Unity project dir (containing
  `ProjectSettings/` + `Assets/`). A `.unitypackage` never ships URP pipeline
  assets or quality settings; this flag resolves the active render pipeline
  asset (QualitySettings current level, GraphicsSettings fallback) and pulls
  in what the pack can't: the RP asset's quality-level volume profile
  (layered UNDER the scene's global volume, URP-style), the renderer's SSAO
  feature (→ `AmbientOcclusionEffect`), and shadow/HDR/MSAA facts (logged).
  `ShadowsMidtonesHighlights` overrides bake to a `.cube` LUT in
  `<project>/assets/` plus `CubeLutEffect` lines; the authored `lutAsset`
  path is asset-root-relative (`<Scene>_smh_lut.cube`), which is what the
  engine's SceneIO resolves it against on load.
- `--local-shadows` — additional-light (point/spot) shadow policy, see
  [Limitations](#limitations-all-counted-in-stats).
- `--no-copy-textures` / `--png` / `--texc` — texture handling, see
  [Textures](#textures).

The target project must already have the pack's FBX files imported; mesh
references are resolved by **filename stem, case-insensitive** (Unity
`SM_Env_Tree_03.fbx` → any assetdb `Model` entry whose file stem is
`sm_env_tree_03`). Ambiguous stems pick the shortest path and warn. Unresolved
stems emit the entity with a `; UNRESOLVED ...` comment instead of a
MeshRenderer.

Example (a Synty demo pack):

```
unity-scene-convert ./elvenrealm-pkg ./polygon-lod-project --scene scenes/demo.unity
```

### Validation

```
unity-scene-validate <output.scene> <source.unity>
```

Structural checks per the engine's SceneIO rules (unique ids, parents defined
before use, tuple shapes, quaternion norm, well-formed asset refs) plus a
cross-check of uniquely-named prefab instances against the Unity source
(position/rotation/scale within tolerance). Exits non-zero on any error.

## Programmatic usage

The package is CommonJS; the CLI entry and the material-mapping/transform
primitives are exported:

```js
const conv = require('openengine-unity-scene-converter');

// Full conversion (same behavior as the CLI):
conv.main([process.execPath, 'convert', '--pkg', pkgDir, '--scene', 'demo.unity',
           '--project', projectDir]);

// Transform-convention primitives (see below):
conv.conj(q); conv.qMul(a, b); conv.qRotate(q, v);
conv.emitObjectQuat(qUnity);        // what gets written for an object rotation
conv.emitDirectionalQuat(worldRot); // what gets written for a directional light
conv.composeWorldTRS(chain);        // parent-chain TRS composition
conv.TRANSFORM_CONVENTION_VERSION;  // 'conj-v2 (R(conj(q)) engine)'

// Material mapping (unit-testable without running a conversion):
conv.parseUnityMat(text); conv.classifyMaterial(ctx, info);
conv.buildMaterialDoc(ctx, info, name);
conv.buildTriplanarDoc(ctx, info, name);
conv.buildWaterDoc(ctx, info, name); conv.buildFallsDoc(ctx, info, name);
```

## Conventions the converter guarantees

These are locked by golden regression tests (`npm test`); a stale or forked
copy that regresses any of them fails loudly.

### Quaternion convention (conj-v2)

The engine renders `R(conj(q_stored))` (its `Transform::FromTRS` builds the
transpose of the standard quaternion→matrix basis). The converter therefore
emits the **conjugate** of every Unity quaternion so
`FromTRS(conj(q)) == R(q)`: rendered orientation AND the conj-dependent
parent-offset composition both match Unity exactly. Every run prints a
`transform-convention: conj-v2 (R(conj(q)) engine)` banner to stderr so any
regeneration log proves which converter ran.

The guard tests cover: object rotations (conjugation to 6 dp), the recorded
directional-light ground truths, parented composition round-trips (with a
negative control for the raw/non-conjugated bug class), negative-scale
(mirror) preservation, and an end-to-end CLI run over a synthetic fixture.

### Coordinate mapping

Identity pass-through: both engines are left-handed, Y-up, Z+ forward,
quaternions serialized `(x, y, z, w)`. No unit conversion (Synty pack FBX
metas are uniformly `useFileScale: 1, globalScale: 1`, so both Unity and the
engine's ufbx-based importer honor the FBX file's own units). Hierarchy is
emitted with `[entity id parent]` + LOCAL `Transform` values, mirroring
Unity's local TRS 1:1. Negative scale (mirroring) is preserved verbatim.

### Light units

The engine uses physical light units (directional lights in Lux, punctual
lights in Candela) with sky/exposure anchored around a ~100k-lux sun. Unity
URP with physical units OFF (every Synty pack) authors dimensionless
intensities, so the converter anchors Unity intensity 1.0 to a per-scene
reference illuminance:

- **Day** scenes: ~100,000 lux/unit (full daylight).
- **Night** scenes (fog on + dim ambient sky): ~2,000 lux/unit (stylized
  moonlight) — night moonlight is authored ~1.5 dimensionless, which at the
  daylight scale would render as a blown-out day.
- **Emission**: `1.0` is scene-linear paperwhite = **203 nits** (the shared
  anchor for material `emissionLuminance` and the water shaders' emission
  scale).
- **Ambient**: night scenes emit an `AmbientLight` floor (~60 nits) matched
  in-engine against the Unity reference; a day-latent guard skips it for day
  scenes, where it would be imperceptible.

## What it does

- Parses Unity YAML (`src/unityyaml.js`, stdlib-only; fileIDs kept as strings
  — they exceed 2^53) for the scene and every referenced `.prefab`,
  recursively.
- Expands `PrefabInstance` docs by cloning the source prefab's node tree and
  applying `m_Modification.m_Modifications` (TRS / name / active / renderer
  flags). Synty "variant" prefabs that wrap an FBX model prefab become a
  single mesh node.
- Mod targets that are Unity hash-computed fileIDs (nested prefab internals)
  are discriminated via the scene's *stripped* docs: the single unresolvable
  class-4 `m_CorrespondingSourceObject` fileID per instance is the instance
  root transform's computed id, so root TRS mods land exactly; other unknown
  targets are dropped and counted (`dropped deep ...` stats).
- Unity builtin meshes map to engine primitives (Cube/Sphere/Capsule/Plane).

### Materials

Unity FBX-embedded materials carry dead source-texture paths, so the real
shipped textures + cutout/blend flags + tints + emission are read from the
`.mat` files. The converter parses them and emits engine `StandardPBR`
`.material` assets under `<project>/assets/Materials_Unity`, bound per-submesh
via `MeshRenderer.material`.

- Material slots come from the renderer's `m_Materials` (real MeshRenderers)
  or the variant-prefab's `m_Materials.Array.data[k]` instance overrides.
  Submesh `<base>_k` binds material slot `k`.
- Synty shader property names are read empirically (any shader family):
  `_Albedo_Map`/`_Base_Map`/`_MainTex` → `albedoMap`, `_Normal_Map`/`_Normals`
  → `normalMap`, `_Emission_Map` → `emissiveMap`. `_ALPHATEST_ON` + `_Cutoff`
  → `Mask` + `alphaCutoff`; `_SURFACE_TYPE_TRANSPARENT`/`_Surface`/alpha<1 →
  `Blend`; `_Cull 0` → doubleSided; emission (map or HDR color) →
  `emissive` + `emissionLuminance` (nits, 203 = scene-linear 1.0).
- Water families: Synty's Waterfall FLOW/FALLS shader graphs map to bundled
  project-side surface shaders (see [Surface shaders](#surface-shaders)) with
  the graph constants decoded (panner speeds and their FBX V-flip sign
  correction, fresnel rim cap semantics, premultiplied falls blend).
- Un-mappable custom shaders are counted and left at the FBX default (never
  smeared with wrong guesses); every unique `.mat` is reported per shader
  family in the stats.

### Textures

Textures resolve Unity-guid → pack pathname stem → project assetdb (exact
then normalized-alnum stem, since Unity's importer collapses separators:
`Wood_Floor_Boards` → `WoodFloorBoards`). Textures the project never imported
(normal/emissive maps, alt swatches) are **copied** into
`<project>/assets/Textures_Unity` and referenced by path
(`--no-copy-textures` to disable). By default copied textures are encoded to
UASTC KTX2 (block-compressed, pre-mipped) via the engine's
`TextureCompiler.exe` — located via `--texc`, the `GE_TEXC` env var, or
engine build trees under the current working directory; `--png` (or no
encoder found) falls back to raw image copies.

### Environment

Parses the scene's `RenderSettings` (fog color/mode/range, ambient sky/
equator/ground, skybox). Classifies day vs night (fog on + dim ambient) and
maps lights/ambient/sky trim accordingly (see
[Light units](#light-units)).

**Gaps (honest):** the engine uses a physical procedural atmosphere and cannot
reproduce a custom aurora/star skybox cubemap; the sun-direction sky region
blows out under auto-exposure. Ambient is sky-IBL-only, so Unity's tri-color
gradient ambient is approximated. Fog values are parsed but not emitted as a
`HeightFogEffect`.

## Surface shaders

Two project-side GLSL surface shaders ship with the package under `shaders/`
(`water_stylized.glsl`, `waterfall_fx.glsl`). When a converted material needs
one, it is copied next to the generated materials
(`<project>/assets/Materials_Unity/`) so `surfaceShader: "<name>.glsl"`
resolves material-dir-local. They land in your project as editable content —
you own the copies and can extend them.

Existing copies are not overwritten on re-conversion.

## Limitations (all counted in stats)

- Skinned meshes, characters (non-`SM_*` FBX), cameras, particles, colliders,
  MonoBehaviours, terrain: skipped. Lights: directional + point converted;
  spot/area skipped.
- Additional-light (point/spot) shadows: `--local-shadows` picks the policy.
  `faithful` (default) emits the source light's shadow flag plus a
  `Light.shadowResolutionTier` (engine 1/2/3 = Low/Medium/High) mapped from
  the light's URP `UniversalAdditionalLightData` tier. `off` restores a
  blanket suppression for scenes whose source pipeline never rendered local
  shadows (raw asset packs without an RP asset — one flagged light can
  otherwise cost ~10 ms CPU/frame as a dedicated 6× 2048² cube pass). The
  directional sun's shadow flag passes through unchanged in both modes.
- Multi-submesh FBX split into `<base>_0..N-1` sibling entities (one per
  material slot), each binding its own `.material`.
- Deep overrides inside multi-node prefab instances whose targets have no
  stripped doc (`dropped deep TRS/prop overrides`): the node keeps its
  prefab-default value. `m_IsActive=0` drops are reported separately since
  they would leave meshes visible that Unity hides.
- LODGroups: ignored (all placements emit LOD0).
- Counters for prefab-*internal* skipped content (e.g. lights inside a
  prefab) count once per unique prefab, not per instance.

## Known geometry mirror (engine-side, not the converter)

Engine-imported FBX geometry is Z-mirrored vs Unity: the engine's FBX loader
bakes `diag(-1,1,-1)` (negate X *and* Z) for a +Z-front RH source, where Unity
bakes negate-X only — so chiral/asymmetric props face mirror-wrong while
symmetric buildings look fine. Transforms are clean (verbatim Unity
positions/rotations round-trip exactly). The fix is loader-side and
engine-wide; the converter deliberately emits **no compensation** (which would
double-apply once the loader is fixed).

## Engine scene format reference

See the engine's `Engine/Source/Scene/SceneIO.cpp` (parser) and
`Engine/Source/Scene/BuiltInSceneSchemas.cpp` (component property names).
Emitted subset:

```
[scene name="Demo" version=1]
[entity id="e_1" parent="e_0"]
Name.value = "SM_Env_Tree_03 (77)"
Transform.position = (98.54, -87.256, 15.582)
Transform.rotation = (0, 0, 0, 1)          ; quaternion x,y,z,w
Transform.scale = (0.91237, 1.1877, 0.91237)
MeshRenderer.meshAsset = [path="fbx/environment/sm_env_tree_03.fbx" guid="bdd66329-..."]
MeshRenderer.renderLayerMask = 1
MeshRenderer.castShadows = true
MeshRenderer.receiveShadows = true
```

## Development

```
npm test    # golden guard tests (transform convention)
```

Tests build synthetic Unity fixtures at runtime — the repository contains no
Unity Editor content and no licensed asset-pack content, and contributions
must keep it that way.

**Phase 2 (planned):** the GameEngine repo currently carries its own copy of
this converter (`Tools/ai/unity-scene-convert/`); a follow-up switches the
engine to consume this package and deletes the in-repo copy. Until then this
repo is the upstream — fixes land here first and are mirrored there.

## License

MIT — see [LICENSE](LICENSE).
