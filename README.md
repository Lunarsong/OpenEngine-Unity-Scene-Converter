# unity-scene-convert

Converts a Unity demo scene (from an extracted `.unitypackage`, e.g. Synty packs)
into a GameEngine text `.scene` file. Scope: **static mesh placements +
materials (.mat → .material) + scene environment (fog/ambient → night mood)**.

## Usage

```
node convert.js --pkg <extracted-pkg-dir> \
                --scene <scene path suffix | unity guid> \
                --project <target-project-dir> \
                [--assetdb <file>] [--unity-project <unity-project-dir>] \
                [--out <output.scene>] [--local-shadows off|faithful] [--verbose]
```

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
  feature (-> `AmbientOcclusionEffect`), and shadow/HDR/MSAA facts (logged
  for the perf arc). `ShadowsMidtonesHighlights` overrides bake to a `.cube`
  LUT in `<project>/assets/` plus `CubeLutEffect` lines; the authored
  `lutAsset` path is ASSET-ROOT-relative (`<Scene>_smh_lut.cube`), which is
  what SceneIO resolves it against on load. See
  `Tools/ai/rendering/postfx-parity-round3-2026-07.html`.

The target project must already have the pack's FBX files imported; mesh
references are resolved by **filename stem, case-insensitive** (Unity
`SM_Env_Tree_03.fbx` -> any assetdb `Model` entry whose file stem is
`sm_env_tree_03`). Ambiguous stems pick the shortest path and warn. Unresolved
stems emit the entity with a `; UNRESOLVED ...` comment instead of a
MeshRenderer.

Example (ElvenRealm demo):

```
node convert.js --pkg .../elvenrealm-pkg --scene scenes/demo.unity \
                --project .../polygon-lod-project
```

## What it does

- Parses Unity YAML (`unityyaml.js`, stdlib-only; fileIDs kept as strings —
  they exceed 2^53) for the scene and every referenced `.prefab`, recursively.
- Expands `PrefabInstance` docs by cloning the source prefab's node tree and
  applying `m_Modification.m_Modifications` (TRS / name / active / renderer
  flags). Synty "variant" prefabs that wrap an FBX model prefab become a
  single mesh node.
- Mod targets that are Unity hash-computed fileIDs (nested prefab internals)
  are discriminated via the scene's *stripped* docs: the single unresolvable
  class-4 `m_CorrespondingSourceObject` fileID per instance is the instance
  root transform's computed id, so root TRS mods land exactly; other unknown
  targets are dropped and counted (`dropped deep ...` stats).
- Emits hierarchy with `[entity id parent]` + LOCAL `Transform` values —
  mirrors Unity's local TRS 1:1 (TransformHierarchySystem composes
  Transform × Parent into WorldTransform at runtime).
- Coordinates pass through **identity**: both engines are left-handed, Y-up,
  Z+ forward, quaternions serialized `(x, y, z, w)`. No unit conversion:
  the pack's FBX metas are uniformly `useFileScale: 1, globalScale: 1`, so
  both Unity and our ufbx-based importer honor the FBX file's own units.
- Unity builtin meshes map to engine primitives (Cube/Sphere/Capsule/Plane).

## Materials (Phase 2)

The FBX-embedded materials carry **dead** source-texture paths (e.g.
`U:/Dropbox/SyntyStudios/...`), so every FBX material renders textureless flat
base-color. The real shipped textures + cutout/blend flags + tints + emission
live in the `.mat` files. The converter parses them and emits engine
`StandardPBR` `.material` assets under `<project>/assets/Materials_Unity`,
bound per-submesh via `MeshRenderer.material`.

- Material slots come from the renderer's `m_Materials` (real MeshRenderers) or
  the variant-prefab's `m_Materials.Array.data[k]` instance overrides. Submesh
  `<base>_k` binds material slot `k`.
- Synty shader property names are read empirically (any shader family):
  `_Albedo_Map`/`_Base_Map`/`_MainTex` → `albedoMap`, `_Normal_Map`/`_Normals`
  → `normalMap`, `_Emission_Map` → `emissiveMap`. `_ALPHATEST_ON` + `_Cutoff`
  → `Mask` + `alphaCutoff`; `_SURFACE_TYPE_TRANSPARENT`/`_Surface`/alpha<1 →
  `Blend`; `_Cull 0` → doubleSided; emission (map or HDR color) →
  `emissive` + `emissionLuminance` (nits, 203 = scene-linear 1.0).
- Textures resolve Unity-guid → pack pathname stem → project assetdb (exact
  then normalized-alnum stem, since Unity's importer collapses separators:
  `Wood_Floor_Boards` → `WoodFloorBoards`). Textures the project never imported
  (normal/emissive maps, alt swatches) are **copied** into
  `<project>/assets/Textures_Unity` and referenced by path (`--no-copy-textures`
  to disable); the editor imports them on next scan and the material texture
  ref re-derives the guid from the path.

## Environment (Phase 2)

Parses the scene's `RenderSettings` (fog color/mode/range, ambient sky/equator/
ground, skybox). Classifies day vs night (fog on + dim ambient) and, for night:

- Maps the directional light at a **moonlight** scale (~2000 lux/unit) instead
  of the daylight ~100k lux/unit — Unity authors night moonlight as a
  dimensionless ~1.5, which at the daylight scale renders as a blown-out day.
- Trims the `SkyEnvironment` IBL fill / sky exposure toward a night balance so
  the moonlit surfaces read as night and the emissive windows/lanterns carry
  the scene.

**Gaps (honest):** the engine uses a physical procedural atmosphere and cannot
reproduce Unity's custom aurora/star skybox cubemap; the sun-direction sky
region blows out under auto-exposure (ground/horizontal views read as a proper
starry purple night; looking straight at the sun blows out). Ambient is
sky-IBL-only (#433), so Unity's tri-color gradient ambient is approximated.
Fog values are parsed but not emitted as a `HeightFogEffect` (that component is
sky/sun-tracking; a faithful color mapping needs separate validation).

## Known geometry mirror (Slice C — diagnosed, not fixed here)

Imported FBX geometry is **Z-mirrored** vs Unity: the engine's FBX loader bakes
`diag(-1,1,-1)` (negate X *and* Z) for a +Z-front RH source, where Unity bakes
negate-X only — the two differ by a Z-flip, so chiral/asymmetric props (e.g. the
planetarium telescope) face mirror-wrong while symmetric buildings look fine.
Transforms are clean (verbatim Unity positions/rotations; the telescope's 24.7°
yaw round-trips exactly), and the world convention is de-facto **+X = right**
(empirically confirmed), so this is purely the mesh-axis bake, **not** the
converter. The precise fix is loader-side (`MakeFbxAxisConversion` target row2
`-1 → +1`) and engine-wide (all FBX content), so it is left to a deliberate,
gated follow-up — the converter emits no compensation (which would double-apply
once the loader is fixed).

## Limitations (all counted in stats)

- Skinned meshes, characters (non-`SM_*` FBX), cameras, particles,
  colliders, MonoBehaviours, terrain: skipped. Lights: directional + point
  converted; spot/area skipped.
- Additional-light (point/spot) shadows: `--local-shadows` picks the policy.
  `faithful` (default) emits the source light's shadow flag plus a
  `Light.shadowResolutionTier` (engine 1/2/3 = Low/Medium/High) mapped from
  the light's URP `UniversalAdditionalLightData` tier — the engine's punctual
  shadow atlas (tiers + culling + multi-light slots) now prices these like
  Unity's additional-light atlas does, and real projects (unlike raw Synty
  packs) ship RP assets that render them. `off` restores the legacy blanket
  suppression for scenes whose source pipeline really never rendered local
  shadows (one flagged light once cost ElvenRealm 10 ms CPU/frame as a
  dedicated 6× 2048² cube pass). The directional sun's shadow flag passes
  through unchanged in both modes.
- Multi-submesh FBX split into `<base>_0.._N-1` sibling entities (one per
  material slot), each binding its own `.material`.
- Deep overrides inside multi-node prefab instances whose targets have no
  stripped doc (`dropped deep TRS/prop overrides`): the node keeps its
  prefab-default value. `m_IsActive=0` drops are reported separately since
  they would leave meshes visible that Unity hides.
- LODGroups: ignored (the ElvenRealm pack ships no LOD meshes; everything is
  LOD0).
- Counters for prefab-*internal* skipped content (e.g. lights inside a
  prefab) count once per unique prefab, not per instance.

## Engine scene format reference

See `Engine/Source/Scene/SceneIO.cpp` (parser) and
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
