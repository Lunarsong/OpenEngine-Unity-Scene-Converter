# Unity LOD source records

The JavaScript library's `buildFileStructure` result now contains `lodGroups`. The managed converter retains the same records internally. The CLI's per-scene JSON summary includes their resolved projection, also available from JavaScript as `summarizeLodGroups(structure)`.

These records describe Unity authoring. They do not create engine renderer-group LOD selection, normalize screen-relative thresholds into mesh distances, reverse raw FBX children, or convert impostors. Existing emission of ordinary renderer placements continues; converting a prefab with several ordinary levels can therefore emit several levels together. It is not a ready-to-use distance LOD setup.

Each group retains:

- `source`: the defining prefab GUID and component fileID; fileIDs remain strings, including values beyond JavaScript's exact integer range.
- `ownerNodeId`: the resolved owner in the existing node map; `instancePath` distinguishes repeated nested prefab instances, from outermost to innermost.
- `enabled`, `localReferencePoint`, `size`, `fadeMode`, `animateCrossFading` and `lastLodIsBillboard` from the source component.
- Ordered `levels`, each with `screenRelativeHeight`, `fadeTransitionWidth`, and ordered `renderers`. Each member retains its scoped source reference as written in the defining file and the resolved node ID. Stripped references use the existing explicit or authenticated nested alias maps.
- `unsupportedOverrides`: unapplied properties targeting this group. Original field values remain inspectable, but `effectiveSourceKnown` in the projected report is false when this list is nonempty.

The projected renderer record reads `meshRef`, `materialRefs`, name, active state and renderer enablement from the final resolved node, after supported mesh/material overrides. It does not keep a second mutable copy of those bindings in the group. Material references preserve both GUID and fileID in slot order. `node.matGuids` remains a derived, read-only compatibility view for existing JavaScript consumers; its returned array cannot mutate the authoritative `materialRefs`. The managed `MatGuids` view follows the same contract.

`effectiveSourceKnown` concerns the recorded group values and the graph edits handled by this resolver. It does not certify full renderer or shader fidelity. In particular, skinned members remain explicitly unsupported; the converter does not recover their mesh/material bindings. `runtimeSelectionSupported` is always false.

Local embedded Mesh and Material references retain their owning prefab GUID, fileID and an `embedded` marker; a Mesh also records its serialized version. Their renderers are omitted with `renderer.embeddedSource` diagnostics. This permits inspection of the other levels when a nested source embeds an unsupported Mesh v11 impostor. It does not invoke the standalone Mesh v10 decoder on that data, synthesize substitute geometry/materials, or claim support based on a filename or `lastLodIsBillboard` flag.

The existing YAML parser remains the sole parser. The cached source index projects embedded Mesh and Texture2D documents to identity/version metadata, so it does not retain their vertex or image payloads after parsing.

Admission is explicit:

- Nonfinite/missing group numbers, dangling or wrongly typed members, foreign group targets and ambiguous cross-class aliases fail resolution before the structure is cached.
- Supported material-array edits retain exact scoped slots, including null assignments and array shrinking, even if the renderer's mesh is cleared.
- Group property overrides are retained as unsupported rather than applied to an unrelated renderer or silently treated as effective values.
- The resolver does not implement Unity prefab structural additions/removals. A nonempty added/removed component or GameObject operation, including one inherited through a nested member, rejects a structure containing LOD records. This conservative boundary avoids presenting stale membership as effective source authoring. It does not introduce general prefab structural editing.

Synthetic tests cover reordered source documents, exact large IDs, material permutations, repeated clones and aliases, null meshes, unsupported embedded sources, invalid values, identity collisions and structural-operation refusal. The JavaScript and managed CLI parity fixture compares the source-record JSON and emitted output trees. Licensed asset data is kept outside the repository; the separate Farmlands verification compares seven original prefabs, their 21 ordinary levels and 42 ordinary material slots, plus six explicitly unsupported embedded members. This is source-binding evidence, without native distance selection, impostor rendering or game adoption claims.
