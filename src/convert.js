#!/usr/bin/env node
'use strict';
// Unity demo scene -> GameEngine .scene converter (v1: static meshes only).
//
// Input:  an extracted .unitypackage dir (<guid>/pathname + <guid>/asset),
//         a .unity scene inside it, and a target project dir containing an
//         AssetDatabase.assetdb whose imported FBX files correspond (by
//         filename stem, case-insensitive) to the package's FBX assets.
// Output: a GameEngine text .scene (see Engine/Source/Scene/SceneIO.cpp)
//         with one entity per static mesh placement, hierarchy preserved
//         via [entity ... parent="..."] and LOCAL transforms (identity
//         coordinate pass-through: both engines are LH, Y-up, Z+ forward,
//         quaternions (x,y,z,w); FBX metas all use useFileScale=1
//         globalScale=1 so no unit conversion is applied).
//
// Skipped in v1 (counted, logged): skinned meshes / characters, lights,
// cameras, particles, colliders, MonoBehaviours, inactive subtrees,
// material overrides. Multi-submesh FBX render submesh 0 only (meshId
// omitted) — see README.
//
// Usage:
//   unity-scene-convert --pkg <extracted-pkg-dir> --scene <scene path suffix|guid>
//                       --project <target-project-dir> [--assetdb <file>]
//                       [--unity-project <unity-project-dir>]
//                       [--out <output.scene>] [--grade-lut] [--verbose]
// (or: node src/convert.js <same flags>)
//
// --grade-lut: bake Unity ShadowsMidtonesHighlights to a .cube LUT (legacy
//   tonemap-coupled path) instead of the default native ColorGradeEffect
//   three-way bands. Kept for one release of A/B comparison; native is preferred.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseUnityYaml } = require('./unityyaml');
const skybox = require('./skybox');

// ---------------------------------------------------------------- CLI ------
function parseArgs(argv) {
    const a = {};
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--verbose') { a.verbose = true; continue; }
        if (k === '--no-copy-textures') { a['no-copy-textures'] = true; continue; }
        if (k === '--png') { a.png = true; continue; }
        if (k === '--grade-lut') { a['grade-lut'] = true; continue; }
        if (!k.startsWith('--')) fail(`Unknown arg: ${k}`);
        a[k.slice(2)] = argv[++i];
    }
    return a;
}
function fail(msg) { console.error('ERROR: ' + msg); process.exit(1); }

// ------------------------------------------------- package index -----------
function buildPackageIndex(pkgDir) {
    const byGuid = new Map();   // unityGuid -> { assetPath, dir }
    for (const entry of fs.readdirSync(pkgDir)) {
        const dir = path.join(pkgDir, entry);
        const pn = path.join(dir, 'pathname');
        if (!fs.existsSync(pn)) continue;
        const assetPath = fs.readFileSync(pn, 'utf8').split('\n')[0].trim();
        byGuid.set(entry.toLowerCase(), { assetPath, dir });
    }
    return byGuid;
}

// --------------------------------------------------- assetdb ---------------
// JSONL journal: upserts {guid,path,type}, deletes {guid,deleted:true},
// redirects {redirect_from, redirect_to}. Last write wins.
function loadAssetDb(file) {
    const byGuid = new Map();
    const redirects = new Map();
    for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }
        if (rec.format) continue;
        if (rec.redirect_from !== undefined) {
            if (rec.redirect_to) redirects.set(rec.redirect_from, rec.redirect_to);
            else redirects.delete(rec.redirect_from);
            continue;
        }
        if (!rec.guid) continue;
        if (rec.deleted) { byGuid.delete(rec.guid); continue; }
        byGuid.set(rec.guid, { path: rec.path || '', type: rec.type || 'Unknown' });
    }
    const resolveGuid = (g) => {
        const seen = new Set();
        while (redirects.has(g) && !seen.has(g)) { seen.add(g); g = redirects.get(g); }
        return g;
    };
    // Model index: filename stem (lowercase, no ext) -> [{guid, path}].
    // Texture index: same shape, for image assets — material texture refs are
    // resolved Unity-tex-guid -> pkg pathname stem -> engine asset, exactly
    // like meshes (the pack's textures are already imported into the project).
    const modelExts = new Set(['.fbx', '.gltf', '.glb', '.obj']);
    const texExts = new Set(['.tga', '.png', '.jpg', '.jpeg', '.tif', '.tiff', '.psd', '.exr', '.bmp']);
    const byStem = new Map();
    const texByStem = new Map();
    const texByNormStem = new Map(); // normalized stem (alnum only) -> candidates
    for (const [guid, rec] of byGuid) {
        const ext = path.extname(rec.path).toLowerCase();
        const stem = path.basename(rec.path, path.extname(rec.path)).toLowerCase();
        if (modelExts.has(ext)) {
            if (!byStem.has(stem)) byStem.set(stem, []);
            byStem.get(stem).push({ guid: resolveGuid(guid), path: rec.path });
        } else if (texExts.has(ext)) {
            const entry = { guid: resolveGuid(guid), path: rec.path };
            if (!texByStem.has(stem)) texByStem.set(stem, []);
            texByStem.get(stem).push(entry);
            // The project's imported texture filenames don't always match the
            // pack's (Unity's importer collapses separators: Wood_Floor_Boards ->
            // WoodFloorBoards). A normalized (alphanumeric-only) index recovers
            // these; exact match is tried first so it only kicks in on a miss.
            const norm = stem.replace(/[^a-z0-9]/g, '');
            if (!texByNormStem.has(norm)) texByNormStem.set(norm, []);
            texByNormStem.get(norm).push(entry);
        }
    }
    return { byGuid, byStem, texByStem, texByNormStem, resolveGuid };
}

// --------------------------------------------- unity file structures -------
const WANTED = new Set(['1', '4', '23', '33', '137', '1001', '108', '20', '205', '198', '199', '64', '65', '114', '82', '104']);
const BUILTIN_MESHES = { '10202': 'Cube', '10207': 'Sphere', '10208': 'Capsule', '10209': 'Plane' };
// Unity ships default meshes in two builtin bundles; their guids are fixed.
const BUILTIN_GUIDS = new Set(['0000000000000000e000000000000000', '0000000000000000f000000000000000']);

const stats = {
    prefabInstancesExpanded: 0,
    directMeshFilters: 0,
    skippedSkinned: 0,
    skippedNonStaticFbx: 0,
    skippedInactive: 0,
    convertedLights: 0,
    skippedLights: 0,
    skippedCameras: 0,
    skippedParticles: 0,
    skippedBuiltinUnsupported: 0,
    lodGroups: 0,
    fbxSubPartNodes: 0,
    modTargetFallbacks: 0,
    modTargetConflicts: 0,
    materialOverridesBound: 0,
    droppedMaterialOverrides: 0,
    droppedDeepTrsOverrides: 0,
    droppedDeepPropOverrides: 0,
    droppedDeepActiveDisables: 0,
    unresolvedPrefabSources: 0,
    unresolvedFatherLinks: 0,
};
const warnings = [];
function warn(msg, verbose) {
    warnings.push(msg);
    if (verbose) console.error('WARN: ' + msg);
}

// Recognized-but-dropped Unity settings: things the converter understood in the
// source but did NOT carry into the engine scene (a Unity volume grade with no
// engine mapping, a sub-setting of a partially-translated component, ...). These
// are collected separately from generic warnings so the final report can print
// an honest "what didn't carry over" summary UNCONDITIONALLY — silently dropping
// authored intent is the converter's worst failure mode. `kind` groups the line
// in the report; `detail` is the human-readable specifics.
const droppedSettings = [];
function noteDropped(kind, detail, verbose) {
    droppedSettings.push({ kind, detail });
    if (verbose) console.error(`DROP: ${kind}: ${detail}`);
}

let nodeCounter = 0;
function makeNode(name) {
    return {
        id: 'n' + (++nodeCounter),
        name: name || '',
        active: true,
        pos: [0, 0, 0], rot: [0, 0, 0, 1], scale: [1, 1, 1],
        fatherAnchor: '0',    // anchor within owning file; resolved to .father later
        father: null,         // node id
        children: [],
        meshFbxGuid: null,    // unity guid of the FBX providing the mesh
        meshPrimitive: null,  // engine primitive name for Unity builtin meshes
        matCount: 1,          // material-part count; >1 => FBX loader split the mesh
                              // into <base>_0.._N-1 submeshes (one per material)
        matGuids: [],         // unity material guid per submesh slot (index == part)
        castShadows: true, receiveShadows: true, rendererEnabled: true,
        skinned: false, nonStaticFbx: false,
        light: null,          // {type:'directional'|'point', color, intensity, range, shadows, enabled}
        urpShadowTier: null,  // UniversalAdditionalLightData tier (0/1/2 = low/med/high), if present
        order: 0,
    };
}

function cloneNode(n) {
    const c = { ...n, pos: [...n.pos], rot: [...n.rot], scale: [...n.scale], matGuids: [...n.matGuids], children: [] };
    c.id = 'n' + (++nodeCounter);
    return c;
}

const asNum = (v, dflt) => {
    const f = parseFloat(v);
    return Number.isFinite(f) ? f : dflt;
};
const truthy01 = (v) => !(v === '0' || v === 0 || v === '' || v === undefined || v === null);

function readTRS(node, t) {
    const p = t.m_LocalPosition || {}, r = t.m_LocalRotation || {}, s = t.m_LocalScale || {};
    node.pos = [asNum(p.x, 0), asNum(p.y, 0), asNum(p.z, 0)];
    node.rot = [asNum(r.x, 0), asNum(r.y, 0), asNum(r.z, 0), asNum(r.w, 1)];
    node.scale = [asNum(s.x, 1), asNum(s.y, 1), asNum(s.z, 1)];
}

// Parse Unity RenderSettings (fog + ambient + skybox) into a plain struct and
// classify the scene as day/night. Skybox handling: a builtin Skybox/Cubemap
// material now converts FAITHFULLY (resolveSceneSkybox: DDS cubemap -> equirect
// HDRI on Components::Skybox); anything else still translates the MOOD only
// (fog colour/range + a moonlight-scaled sun for night scenes), because the
// engine's alternatives are the procedural atmosphere or an equirect HDRI.
function parseRenderSettings(d) {
    const col = (c) => c ? [asNum(c.r, 0), asNum(c.g, 0), asNum(c.b, 0)] : null;
    const sky = col(d.m_AmbientSkyColor);
    const lum = (c) => c ? 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] : 1.0;
    const fogEnabled = truthy01(d.m_Fog);
    return {
        fogEnabled,
        fogColor: col(d.m_FogColor),
        fogMode: parseInt(d.m_FogMode || '1', 10),   // 1=Linear 2=Exp 3=ExpSquared
        fogStart: asNum(d.m_LinearFogStart, 0),
        fogEnd: asNum(d.m_LinearFogEnd, 300),
        fogDensity: asNum(d.m_FogDensity, 0.01),
        ambientMode: parseInt(d.m_AmbientMode || '0', 10),   // 0=Skybox 1=Trilight/Gradient 3=Flat 4=Custom
        ambientSky: sky,
        ambientEquator: col(d.m_AmbientEquatorColor),
        ambientGround: col(d.m_AmbientGroundColor),
        skyboxGuid: (d.m_SkyboxMaterial && d.m_SkyboxMaterial.guid)
            ? String(d.m_SkyboxMaterial.guid).toLowerCase() : null,
        // Night = Unity fog on + a dim ambient sky (the Synty demo night scenes
        // have deep purple ambient, luminance ~0.45; daytime sits near mid-grey).
        // This flag now also selects the punctual light anchor (moon 2k vs daylight
        // 100k lux/unit — a 50x swing; see the light emitter), not only the night
        // exposure bias, so it must survive any future deprecation of the exposure
        // consumers below.
        isNight: fogEnabled && lum(sky) < 0.6,
    };
}

// UnityEngine.Rendering.Volume's stable script GUID (URP/core RP package).
const kUrpVolumeScriptGuid = '172515602e62fb746b5d573b38a5fe58';

// Parse a URP VolumeProfile asset (YAML: one MonoBehaviour per override, its
// m_Name is the override type — "Bloom", "ColorAdjustments", ...). Returns
// { Bloom: { active, threshold, intensity, ... }, ... } keeping ONLY fields
// with m_OverrideState: 1 (un-overridden fields fall back to URP defaults,
// which the emitter must supply where they matter).
function parseVolumeProfile(text) {
    const overrides = {};
    for (const doc of text.split(/^--- !u!/m).slice(1)) {
        const name = (doc.match(/m_Name:\s*([A-Za-z]\w*)\s*$/m) || [])[1];
        if (!name || /Profile/.test(name)) continue;
        const fields = { active: !/active:\s*0\s*$/m.test(doc) };
        const re = /^\s{2}(\w+):\s*\n\s*m_OverrideState:\s*(\d)\s*\n\s*m_Value:\s*([^\n]+)/gm;
        let m;
        while ((m = re.exec(doc))) {
            if (m[2] !== '1') continue;
            const raw = m[3].trim();
            const rgb = raw.match(/\{r:\s*([-\d.eE]+),\s*g:\s*([-\d.eE]+),\s*b:\s*([-\d.eE]+)(?:,\s*a:\s*([-\d.eE]+))?/);
            const xyz = raw.match(/\{x:\s*([-\d.eE]+),\s*y:\s*([-\d.eE]+),\s*z:\s*([-\d.eE]+)(?:,\s*w:\s*([-\d.eE]+))?/);
            if (rgb) fields[m[1]] = [+rgb[1], +rgb[2], +rgb[3]];
            else if (xyz) fields[m[1]] = xyz[4] !== undefined
                ? [+xyz[1], +xyz[2], +xyz[3], +xyz[4]] : [+xyz[1], +xyz[2], +xyz[3]];
            else if (/^[-\d.eE]+$/.test(raw)) fields[m[1]] = parseFloat(raw);
            else fields[m[1]] = raw; // texture refs etc. — kept for warnings only
        }
        overrides[name] = fields;
    }
    return overrides;
}

// Flatten URP's volume-stack semantics for two parsed profiles: `over` (the
// scene's global volume) applies on top of `base` (the RP asset's
// quality-level profile — Unity 6 `m_VolumeProfile`). Per component, only
// ACTIVE components apply, and only their overrideState=1 fields
// (parseVolumeProfile already filters to those); everything else falls
// through to the layer below / URP defaults. An `active: 0` component in a
// layer applies nothing but does NOT block lower layers. The URP global
// default profile (lowest layer) stamps every field at neutral defaults, so
// it is equivalent to the emitter's built-in default assumptions and is not
// parsed.
function layerVolumeOverrides(base, over) {
    const merged = {};
    for (const n of new Set([...Object.keys(base || {}), ...Object.keys(over || {})])) {
        const b = base && base[n], o = over && over[n];
        const fields = {};
        if (b && b.active) Object.assign(fields, b);
        if (o && o.active) Object.assign(fields, o);
        fields.active = !!((b && b.active) || (o && o.active));
        merged[n] = fields;
    }
    return merged;
}

// --unity-project: pull the pipeline-level post state a .unitypackage never
// ships. From a real Unity project dir, resolve the ACTIVE URP render
// pipeline asset (QualitySettings current level -> customRenderPipeline,
// GraphicsSettings fallback), then read:
//   - the RP asset's quality-level volume profile (the layer UNDER scene
//     volumes — the demo project hangs Tonemapping(Neutral)/Bloom-HQ/Vignette
//     here, not in the scene),
//   - the renderer's ScreenSpaceAmbientOcclusion feature settings,
//   - shadow/HDR/MSAA facts (logged for the perf arc).
function loadUnityProjectPipeline(projDir, verbose) {
    const readIf = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
    const qs = readIf(path.join(projDir, 'ProjectSettings', 'QualitySettings.asset'));
    const gs = readIf(path.join(projDir, 'ProjectSettings', 'GraphicsSettings.asset'));
    const guidRe = g => new RegExp(g + ':\\s*\\{fileID:\\s*\\d+,\\s*guid:\\s*([0-9a-f]{32})');

    let rpGuid = null;
    if (qs) {
        const cur = +((qs.match(/m_CurrentQuality:\s*(\d+)/) || [])[1] || 0);
        const perLevel = [...qs.matchAll(/customRenderPipeline:\s*\{fileID:\s*\d+,\s*guid:\s*([0-9a-f]{32})/g)];
        if (perLevel[cur]) rpGuid = perLevel[cur][1];
    }
    if (!rpGuid && gs) rpGuid = (gs.match(guidRe('m_CustomRenderPipeline')) || [])[1] || null;
    if (!rpGuid) { warn(`--unity-project: no active render pipeline asset found under ${projDir}`, verbose); return null; }

    // guid -> file index over Assets/**/*.asset.meta (settings assets only —
    // meshes/textures are not resolved through this path).
    const guidToFile = new Map();
    (function walk(dir) {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith('.asset.meta')) {
                const g = ((readIf(p) || '').match(/^guid:\s*([0-9a-f]{32})/m) || [])[1];
                if (g) guidToFile.set(g, p.slice(0, -'.meta'.length));
            }
        }
    })(path.join(projDir, 'Assets'));

    const rpFile = guidToFile.get(rpGuid);
    const rpText = rpFile ? readIf(rpFile) : null;
    if (!rpText) { warn(`--unity-project: RP asset ${rpGuid} not found under Assets/`, verbose); return null; }

    const num = re => { const m = rpText.match(re); return m ? +m[1] : null; };
    const rpFacts = {
        assetPath: path.relative(projDir, rpFile).replace(/\\/g, '/'),
        supportsHdr: num(/m_SupportsHDR:\s*(\d+)/),
        msaa: num(/m_MSAA:\s*(\d+)/),
        renderScale: num(/m_RenderScale:\s*([\d.]+)/),
        shadowDistance: num(/m_ShadowDistance:\s*([\d.]+)/),
        cascadeCount: num(/m_ShadowCascadeCount:\s*(\d+)/),
        mainShadowRes: num(/m_MainLightShadowmapResolution:\s*(\d+)/),
        additionalShadowsSupported: num(/m_AdditionalLightShadowsSupported:\s*(\d+)/),
        additionalShadowAtlas: num(/m_AdditionalLightsShadowmapResolution:\s*(\d+)/),
        softShadows: num(/m_SoftShadowsSupported:\s*(\d+)/),
        softShadowQuality: num(/m_SoftShadowQuality:\s*(\d+)/),
    };

    let rpVolumeOverrides = null;
    const volGuid = (rpText.match(guidRe('m_VolumeProfile')) || [])[1];
    const volFile = volGuid && guidToFile.get(volGuid);
    if (volFile) {
        rpVolumeOverrides = parseVolumeProfile(readIf(volFile) || '');
        if (verbose) console.error(`pipeline volume profile: ${path.basename(volFile)} -> `
            + Object.keys(rpVolumeOverrides).join(', '));
    }

    // Renderer data -> SSAO feature. The script guid is URP's stable id for
    // the ScreenSpaceAmbientOcclusion renderer feature.
    let ssao = null, renderingMode = null;
    const rdGuid = (rpText.match(/m_RendererDataList:\s*\r?\n\s*-\s*\{fileID:\s*\d+,\s*guid:\s*([0-9a-f]{32})/) || [])[1];
    const rdFile = rdGuid && guidToFile.get(rdGuid);
    if (rdFile) {
        const rd = readIf(rdFile) || '';
        renderingMode = +((rd.match(/m_RenderingMode:\s*(\d+)/) || [])[1] || 0);
        const kSsaoScriptGuid = 'f62c9c65cf3354c93be831c8bc075510';
        const feat = rd.split(/^--- /m).find(b => b.includes(kSsaoScriptGuid));
        if (feat) {
            const fnum = re => { const m = feat.match(re); return m ? +m[1] : null; };
            ssao = {
                enabled: fnum(/m_Active:\s*(\d+)/) === 1,
                intensity: fnum(/\n\s*Intensity:\s*([\d.eE+-]+)/),
                radius: fnum(/\n\s*Radius:\s*([\d.eE+-]+)/),
                directLightingStrength: fnum(/\n\s*DirectLightingStrength:\s*([\d.eE+-]+)/),
            };
        }
    }

    console.error(`Pipeline: ${rpFacts.assetPath} — shadows ${rpFacts.shadowDistance}m/${rpFacts.cascadeCount} cascades/`
        + `${rpFacts.mainShadowRes}px main, addl shadows ${rpFacts.additionalShadowsSupported ? rpFacts.additionalShadowAtlas + 'px' : 'off'}, `
        + `soft ${rpFacts.softShadows ? 'on(q' + rpFacts.softShadowQuality + ')' : 'off'}, HDR ${rpFacts.supportsHdr ? 'on' : 'off'}, `
        + `MSAA ${rpFacts.msaa}x, scale ${rpFacts.renderScale}`
        + (renderingMode !== null ? `, renderingMode ${renderingMode}` : '')
        + (ssao ? `, SSAO ${ssao.enabled ? `i=${ssao.intensity} r=${ssao.radius}` : 'off'}` : ''));

    return { rpFacts, rpVolumeOverrides, ssao, renderingMode };
}

// URP ShadowsMidtonesHighlights -> a Resolve-style .cube 3D LUT.
//
// Placement is structurally faithful for the demo project's configuration:
// its RP asset uses LDR grading mode (m_ColorGradingMode: 0), where URP
// applies the grading LUT AFTER tonemapping over display-referred linear
// [0,1] (UberPost.shader: "LDR Grading: Apply tonemapping ... Apply internal
// linear LUT") — the same slot as the engine's post_fx_ldr_stack
// CubeLutEffect with Linear input encoding, indexed by display-linear RGB in
// both engines. The only divergence is the tone curve feeding the LUT
// (their Neutral vs our ACES — near-identical at the night operating point,
// round-2 A/B).
//
// Wheel prep is URP-exact (core ColorUtils.PrepareShadowsMidtonesHighlights):
// sRGB->linear on the wheel color, w-offset scaled x4 when positive, added,
// clamped at 0. Range weights are the LutBuilder smoothstep triple over
// Rec.709 linear luminance.
function isIdentityWheel(v) {
    if (!Array.isArray(v)) return true;
    return Math.abs(v[0] - 1) < 1e-4 && Math.abs(v[1] - 1) < 1e-4
        && Math.abs(v[2] - 1) < 1e-4 && Math.abs(v[3] || 0) < 1e-4;
}
function smoothstep(e0, e1, x) {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
}
function bakeSmhCubeLut(smh, file) {
    const prep = v => {
        const a = Array.isArray(v) ? v : [1, 1, 1, 0];
        const w = (a[3] || 0) * ((a[3] || 0) < 0 ? 1 : 4);
        return [0, 1, 2].map(i => Math.max(srgbToLinear(a[i]) + w, 0));
    };
    const S = prep(smh.shadows), M = prep(smh.midtones), H = prep(smh.highlights);
    const shStart = smh.shadowsStart ?? 0, shEnd = smh.shadowsEnd ?? 0.3;
    const hiStart = smh.highlightsStart ?? 0.55, hiEnd = smh.highlightsEnd ?? 1;
    const kLutSize = 33; // Resolve-standard; URP's internal LUT is 32^3
    const lines = ['TITLE "URP ShadowsMidtonesHighlights bake (unity-scene-convert)"',
        `LUT_3D_SIZE ${kLutSize}`];
    for (let b = 0; b < kLutSize; b++)
        for (let g = 0; g < kLutSize; g++)
            for (let r = 0; r < kLutSize; r++) { // red fastest per .cube spec
                const c = [r / (kLutSize - 1), g / (kLutSize - 1), b / (kLutSize - 1)];
                const luma = 0.2126729 * c[0] + 0.7151522 * c[1] + 0.0721750 * c[2];
                const sh = 1 - smoothstep(shStart, shEnd, luma);
                const hi = smoothstep(hiStart, hiEnd, luma);
                const mid = 1 - sh - hi;
                const o = c.map((v, i) => Math.max(0, v * (S[i] * sh + M[i] * mid + H[i] * hi)));
                lines.push(`${o[0].toFixed(6)} ${o[1].toFixed(6)} ${o[2].toFixed(6)}`);
            }
    fs.writeFileSync(file, lines.join('\n') + '\n');
}

// -------- Unity colour-grade wheels -> native ColorGradeEffect bands --------
//
// Slice 1's ColorGradeEffect is a unified three-way corrector graded in an
// ACEScct-shaped LOG space: each band carries an RGB *chroma offset* (0 = neutral)
// plus a *master lightness* (0 = neutral), summed in the log domain and scaled by
// the shader's kGradeOffsetScale (0.5) at the band peak (hdr_color_fx.frag /
// ColorGradeParamsUBO.h). Unity's SMH/LGG wheels are per-channel operators on
// (mostly) linear light; we transfer them into that log-offset band model instead
// of baking a tonemap-coupled .cube LUT.
//
// Common currency = the log-multiply identity: a linear multiply by k is an ADD of
// log2(k)/kGradeEncSlope on the encoded axis (EncodeGradeLog body =
// (log2(x)+9.72)/17.52). Pre-dividing by the shader's 0.5 offset scale yields the
// stored wheel-space offset. Splitting per-channel offsets into their mean (=master
// lightness) + zero-mean remainder (=chroma) is exactly the native band's
// (Lightness, Color) decomposition, so an all-neutral wheel is a bit-exact no-op.
const kGradeEncSlope = 17.52;    // EncodeGradeLog body denominator (ACEScct/ACEScc)
const kGradeOffsetScale = 0.5;   // hdr_color_fx.frag kGradeOffsetScale
const kGradeMidGrey = 0.18;      // exposed mid-grey == the engine's log pivot
const kGradeOffsetClamp = 1.0;   // keep wheel-space offsets sane (|offset| <= 1)
const kRec709Luma = [0.2126729, 0.7151522, 0.0721750]; // Unity ColorUtils.Luminance

// A per-channel effective LINEAR multiplier (neutral = [1,1,1]) -> native band
// { color:[r,g,b] chroma offset, lightness master }. Exact for genuine multiplies
// (SMH, LGG gain); additive (lift) and power (gamma) operators are linearised to
// their mid-grey-referenced multiplier before this call.
function bandFromMultiplier(m) {
    const o = m.map(v => Math.log2(Math.max(v, 1e-6)) / kGradeEncSlope / kGradeOffsetScale);
    const master = (o[0] + o[1] + o[2]) / 3;
    const clamp = v => Math.max(-kGradeOffsetClamp, Math.min(kGradeOffsetClamp, v));
    return { color: o.map(v => clamp(v - master)), lightness: clamp(master) };
}

// URP core ColorUtils.PrepareShadowsMidtonesHighlights (verbatim): sRGB->linear on
// the wheel colour, +w (x4 when positive), clamp at 0. Per-channel MULTIPLIER
// (neutral (1,1,1) since GammaToLinear(1)=1, w=0). srgbToLinear == GammaToLinearSpace
// for the [0,1] wheel colours Unity's picker produces.
function prepSmhWheel(v) {
    const a = Array.isArray(v) ? v : [1, 1, 1, 0];
    const w = (a[3] || 0) * ((a[3] || 0) < 0 ? 1 : 4);
    return [0, 1, 2].map(i => Math.max(srgbToLinear(a[i]) + w, 0));
}

// URP core ColorUtils.PrepareLiftGammaGain (verbatim). Produces ASC-CDL SOP:
// gain = per-channel slope (multiply), lift = per-channel offset (add), gamma =
// per-channel power exponent (already inverted -> out = in^gamma). Wheel .w is the
// master slider. Neutrals: lift 0, gamma 1, gain 1.
function prepLiftGammaGain(liftV, gammaV, gainV) {
    const lum = v => kRec709Luma[0] * v[0] + kRec709Luma[1] * v[1] + kRec709Luma[2] * v[2];
    const la = Array.isArray(liftV) ? liftV : [1, 1, 1, 0];
    const ga = Array.isArray(gammaV) ? gammaV : [1, 1, 1, 0];
    const na = Array.isArray(gainV) ? gainV : [1, 1, 1, 0];
    let lift = [srgbToLinear(la[0]) * 0.15, srgbToLinear(la[1]) * 0.15, srgbToLinear(la[2]) * 0.15];
    const lumL = lum(lift), lw = la[3] || 0;
    lift = lift.map(v => v - lumL + lw);
    let gamma = [srgbToLinear(ga[0]) * 0.8, srgbToLinear(ga[1]) * 0.8, srgbToLinear(ga[2]) * 0.8];
    const lumG = lum(gamma), gw = (ga[3] || 0) + 1;
    gamma = gamma.map(v => 1 / Math.max(v - lumG + gw, 1e-3));
    let gain = [srgbToLinear(na[0]) * 0.8, srgbToLinear(na[1]) * 0.8, srgbToLinear(na[2]) * 0.8];
    const lumN = lum(gain), nw = (na[3] || 0) + 1;
    gain = gain.map(v => v - lumN + nw);
    return { lift, gamma, gain };
}

// Unity ShadowsMidtonesHighlights -> three native bands (multiply -> log-offset).
function smhToBands(smh) {
    return {
        shadows: bandFromMultiplier(prepSmhWheel(smh.shadows)),
        midtones: bandFromMultiplier(prepSmhWheel(smh.midtones)),
        highlights: bandFromMultiplier(prepSmhWheel(smh.highlights)),
    };
}

// Unity LiftGammaGain -> three native bands via ASC CDL. Gain(slope)->Highlights is
// an exact multiply. Lift(offset)->Shadows and Gamma(power)->Midtones are linearised
// to their mid-grey-referenced effective multiplier (lift: 1 + lift/mid; gamma:
// mid^(exp-1)) so hue / master / band-placement transfer faithfully; the distinct
// additive/power response curves collapse into the offset-only band (an A/B
// refinement, and inert for every shipped Synty pack -- none author LGG).
function lggToBands(lgg) {
    const p = prepLiftGammaGain(lgg.lift, lgg.gamma, lgg.gain);
    const liftMul = p.lift.map(v => 1 + v / kGradeMidGrey);
    const gammaMul = p.gamma.map(e => Math.pow(kGradeMidGrey, e - 1));
    return {
        shadows: bandFromMultiplier(liftMul),    // Lift  -> Shadows
        midtones: bandFromMultiplier(gammaMul),  // Gamma -> Midtones
        highlights: bandFromMultiplier(p.gain),  // Gain  -> Highlights
    };
}

// Compose two band sets. Both are log-domain offsets, so per-channel addition is
// the correct composition when a volume authors BOTH SMH and LGG.
function addBands(a, b) {
    const add = (x, y) => ({
        color: [x.color[0] + y.color[0], x.color[1] + y.color[1], x.color[2] + y.color[2]],
        lightness: x.lightness + y.lightness,
    });
    return {
        shadows: add(a.shadows, b.shadows),
        midtones: add(a.midtones, b.midtones),
        highlights: add(a.highlights, b.highlights),
    };
}

function bandsAreNeutral(bands, eps = 1e-5) {
    const n = b => Math.abs(b.color[0]) < eps && Math.abs(b.color[1]) < eps
        && Math.abs(b.color[2]) < eps && Math.abs(b.lightness) < eps;
    return n(bands.shadows) && n(bands.midtones) && n(bands.highlights);
}

// Native ColorGradeEffect band lines. Schema keys (BuiltInSceneSchemas.cpp): split
// vector as <band>ColorR/G/B + <band>Lightness. Zero channels are omitted (schema
// default is 0), keeping the emitted block to the values that actually carry.
function emitColorGradeBandLines(bands) {
    const L = [];
    const eps = 1e-5;
    const emit = (name, b) => {
        if (Math.abs(b.color[0]) >= eps) L.push(`ColorGradeEffect.${name}ColorR = ${fmtF(b.color[0])}`);
        if (Math.abs(b.color[1]) >= eps) L.push(`ColorGradeEffect.${name}ColorG = ${fmtF(b.color[1])}`);
        if (Math.abs(b.color[2]) >= eps) L.push(`ColorGradeEffect.${name}ColorB = ${fmtF(b.color[2])}`);
        if (Math.abs(b.lightness) >= eps) L.push(`ColorGradeEffect.${name}Lightness = ${fmtF(b.lightness)}`);
    };
    emit('shadows', bands.shadows);
    emit('midtones', bands.midtones);
    emit('highlights', bands.highlights);
    return L;
}

// ------------------------------------------------- FBX node scan -----------
// A multi-node Synty prop (lantern + glass, drawer bodies, chandelier arms,
// telescope tube) ships its sub-parts as extra mesh-bearing FBX nodes. ufbx's
// model loader emits one named submesh per node placed at that node's rest
// model-space transform; a scene importer that collapses the FBX to a single
// node drops every sub-part. This binary-FBX scanner recovers the node table so
// the converter can emit one child entity per extra mesh node, at the SAME rest
// offset the engine's own spawn produces. Verified against spawn_model on
// lantern/jewellery-box/viewing-scope/constellation-rings: each mesh node lands
// at translate((sum of ancestor+self Lcl Translation) + own RotationPivot) * cm,
// identity rotation, unit scale (both pivots collapse to a pure offset at the
// default pose; Lcl Translation accumulates down the chain, the pivot does not).
const kFbxCmToMeters = 0.01;          // Synty FBX author in centimetres (ufbx unit_meters)
const kFbxAuxNodeRe = /(_LOD\d+$|^UCX_|^UBX_|^USP_|^UCP_|_?collider$|_?collision$)/i;
const fbxNodeCache = new Map();       // unityGuid -> mesh-node list (or null)

function parseFbxBinary(buf) {
    if (buf.toString('latin1', 0, 20) !== 'Kaydara FBX Binary  ') return null; // ASCII/other
    const version = buf.readUInt32LE(23);
    const big = version >= 7500;
    const nullLen = big ? 25 : 13;
    function readNode(off) {
        const endOffset = big ? Number(buf.readBigUInt64LE(off)) : buf.readUInt32LE(off);
        const numProps = big ? Number(buf.readBigUInt64LE(off + 8)) : buf.readUInt32LE(off + 4);
        const nameLen = buf.readUInt8(big ? off + 24 : off + 12);
        let p = (big ? off + 25 : off + 13);
        const name = buf.toString('latin1', p, p + nameLen);
        p += nameLen;
        if (endOffset === 0) return null;
        const props = [];
        let q = p;
        for (let i = 0; i < numProps; i++) {
            const t = String.fromCharCode(buf.readUInt8(q)); q += 1;
            switch (t) {
                case 'Y': props.push(buf.readInt16LE(q)); q += 2; break;
                case 'C': props.push(!!buf.readUInt8(q)); q += 1; break;
                case 'I': props.push(buf.readInt32LE(q)); q += 4; break;
                case 'F': props.push(buf.readFloatLE(q)); q += 4; break;
                case 'D': props.push(buf.readDoubleLE(q)); q += 8; break;
                case 'L': props.push(buf.readBigInt64LE(q)); q += 8; break;
                case 'S': case 'R': {
                    const n = buf.readUInt32LE(q); q += 4;
                    props.push(t === 'S' ? buf.toString('latin1', q, q + n) : null);
                    q += n; break;
                }
                case 'f': case 'd': case 'l': case 'i': case 'b': {
                    const n = buf.readUInt32LE(q), enc = buf.readUInt32LE(q + 4), clen = buf.readUInt32LE(q + 8);
                    q += 12;
                    props.push(null);
                    q += enc === 1 ? clen : n * ({ f: 4, d: 8, l: 8, i: 4, b: 1 })[t];
                    break;
                }
                default: return null;
            }
        }
        const children = [];
        let pp = p;
        // Skip the property block by advancing to the nested-record region.
        pp = q;
        while (pp < endOffset - nullLen + 1 && pp < endOffset) {
            const c = readNode(pp);
            if (!c) { pp += nullLen; break; }
            children.push(c);
            pp = c.end;
        }
        return { name, props, children, end: endOffset };
    }
    const roots = [];
    let off = 27;
    while (off < buf.length) {
        const n = readNode(off);
        if (!n) break;
        roots.push(n);
        off = n.end;
        if (['Objects', 'Connections', 'GlobalSettings'].every(k => roots.some(r => r.name === k))) break;
    }
    return { version, roots };
}

// Returns the mesh-bearing nodes of an FBX as [{ id, name, parent, offset }]
// where offset is the node's rest position in the model frame (engine metres),
// or null when the FBX is ASCII / single-mesh / unreadable.
function scanFbxMeshNodes(file) {
    let fbx;
    try { fbx = parseFbxBinary(fs.readFileSync(file)); } catch { return null; }
    if (!fbx) return null;
    const objects = fbx.roots.find(r => r.name === 'Objects');
    const conns = fbx.roots.find(r => r.name === 'Connections');
    const gs = fbx.roots.find(r => r.name === 'GlobalSettings');
    if (!objects) return null;

    let unitScaleFactor = 1;
    if (gs) {
        const p70 = gs.children.find(c => c.name === 'Properties70');
        if (p70) for (const p of p70.children)
            if (p.props[0] === 'UnitScaleFactor' && typeof p.props[4] === 'number') unitScaleFactor = p.props[4];
    }
    const cm = unitScaleFactor / 100 || kFbxCmToMeters; // cm base -> metres

    const vec3 = (p70, key) => {
        if (!p70) return [0, 0, 0];
        const p = p70.children.find(c => c.props[0] === key);
        return p ? [p.props[4], p.props[5], p.props[6]].map(x => typeof x === 'number' ? x : 0) : [0, 0, 0];
    };
    const models = new Map(); // id -> { id, name, lclT, pivot, parent, mesh }
    const geometryIds = new Set();
    let hasNamedGeometry = false;
    for (const o of objects.children) {
        const id = typeof o.props[0] === 'bigint' ? o.props[0].toString() : String(o.props[0]);
        if (o.name === 'Geometry') {
            geometryIds.add(id);
            // When the FBX names its geometry elements (e.g. "Mesh.011"), the
            // engine names each submesh by the GEOMETRY name, not the owning
            // node — so a meshName = node name would miss and fall back to
            // submesh 0. Leave such models unsplit rather than emit sub-parts
            // that all resolve to the wrong submesh.
            if (String(o.props[1] || '').split('\x00')[0]) hasNamedGeometry = true;
            continue;
        }
        if (o.name !== 'Model') continue;
        const p70 = o.children.find(c => c.name === 'Properties70');
        models.set(id, {
            id,
            name: String(o.props[1] || '').split('\x00')[0],
            lclT: vec3(p70, 'Lcl Translation'),
            pivot: vec3(p70, 'RotationPivot'),
            parent: null,
            mesh: false,
        });
    }
    if (conns) for (const c of conns.children) {
        if (c.name !== 'C' || c.props[0] !== 'OO') continue;
        const child = c.props[1].toString(), parent = c.props[2].toString();
        if (models.has(child) && models.has(parent)) models.get(child).parent = parent;
        if (geometryIds.has(child) && models.has(parent)) models.get(parent).mesh = true;
    }
    if (models.size <= 1 || hasNamedGeometry) return null;

    // Accumulate Lcl Translation down the parent chain; RotationPivot is a
    // per-node geometry offset that does not accumulate to children.
    const accCache = new Map();
    const accLclT = (id) => {
        if (accCache.has(id)) return accCache.get(id);
        const m = models.get(id);
        const par = m.parent ? accLclT(m.parent) : [0, 0, 0];
        const v = [par[0] + m.lclT[0], par[1] + m.lclT[1], par[2] + m.lclT[2]];
        accCache.set(id, v);
        return v;
    };
    const out = [];
    for (const m of models.values()) {
        if (!m.mesh) continue;
        const a = accLclT(m.id);
        m.offset = [(a[0] + m.pivot[0]) * cm, (a[1] + m.pivot[1]) * cm, (a[2] + m.pivot[2]) * cm];
        out.push({ id: m.id, name: m.name, parent: m.parent, offset: m.offset });
    }
    return out;
}

// Build the node structure of a Unity YAML file (scene or prefab).
// Returns { nodes: Map<id,node>, anchorToNode: Map<anchor,id>, rootIds }.
function buildFileStructure(ctx, unityGuid, stack) {
    unityGuid = unityGuid.toLowerCase();
    if (ctx.structureCache.has(unityGuid)) return ctx.structureCache.get(unityGuid);
    if (stack.includes(unityGuid)) { warn(`prefab cycle at ${unityGuid}`, ctx.verbose); return null; }

    const pkgEntry = ctx.pkg.get(unityGuid);
    if (!pkgEntry) return null;
    const assetPath = pkgEntry.assetPath;
    const ext = path.extname(assetPath).toLowerCase();

    if (ext === '.fbx') {
        const stem = path.basename(assetPath, path.extname(assetPath));
        const root = makeNode(stem);
        root.meshFbxGuid = unityGuid;
        // Synty convention: SM_* = static mesh; anything else (Chr_, SK_,
        // FX_ ...) is character/FX content — out of scope for v1.
        root.nonStaticFbx = !/^sm_/i.test(stem);
        const st = {
            isFbx: true,
            nodes: new Map([[root.id, root]]),
            anchorToNode: new Map(),
            rootIds: [root.id],
        };
        // Split a multi-node prop into root + one child per extra mesh node so
        // the sub-parts (glass, lids, drawers, telescope tube) are emitted. Each
        // child binds its named submesh (Mesh.Name == FBX node name) at the rest
        // model-space offset the engine's model loader places it at. LOD/collider
        // helper nodes are skipped so they don't duplicate the body mesh.
        //
        // scanFbxMeshNodes returns RAW FBX model-space offsets. The engine's FBX
        // loader converts every vertex and node offset source->engine with a -X
        // reflection (MakeFbxAxisConversion: c.m = diag(-1,1,1), matching Unity's
        // FBX-import bake), so its model spawner places node k at negate-X(raw).
        // Emit the sub-part at that same engine-frame offset — negate the X of the
        // rest offset — or every offset sub-part mirrors to the wrong side of its
        // parent (telescope arm, cart door). Verified against the engine's own
        // spawn_model oracle: scope Arm_01 raw x=-0.1418 -> engine x=+0.1418.
        if (!root.nonStaticFbx) {
            let scan = fbxNodeCache.get(unityGuid);
            if (scan === undefined) {
                scan = scanFbxMeshNodes(path.join(pkgEntry.dir, 'asset'));
                fbxNodeCache.set(unityGuid, scan);
            }
            if (scan && scan.length > 1) {
                const rootScan = scan.find(n => n.name === stem)
                    || scan.find(n => n.parent === null) || scan[0];
                for (const sn of scan) {
                    if (sn === rootScan || kFbxAuxNodeRe.test(sn.name)) continue;
                    const child = makeNode(sn.name);
                    child.meshFbxGuid = unityGuid;
                    child.nonStaticFbx = false;
                    child.pos = [
                        -(sn.offset[0] - rootScan.offset[0]),
                        sn.offset[1] - rootScan.offset[1],
                        sn.offset[2] - rootScan.offset[2],
                    ];
                    child.father = root.id;
                    child.order = st.nodes.size;
                    st.nodes.set(child.id, child);
                    root.children.push(child.id);
                    stats.fbxSubPartNodes++;
                }
            }
        }
        ctx.structureCache.set(unityGuid, st);
        return st;
    }
    if (ext !== '.prefab' && ext !== '.unity') return null;

    const text = fs.readFileSync(path.join(pkgEntry.dir, 'asset'), 'utf8');
    const docs = parseUnityYaml(text, WANTED);

    // RenderSettings (fog + ambient + skybox) lives only in the top-level .unity
    // scene; capture it once for the environment pass in emitScene.
    if (ext === '.unity' && !ctx.renderSettings) {
        const rs = docs.find(d => d.classId === '104' && d.data);
        if (rs) ctx.renderSettings = parseRenderSettings(rs.data);
    }

    // URP global Volume -> post-processing overrides. The demo scenes hang
    // their grade (Bloom / ColorAdjustments / ...) off a global Volume's
    // sharedProfile asset; resolve the winning global volume (highest
    // priority) and parse its profile once for the environment pass.
    if (ext === '.unity' && !ctx.volumeOverrides) {
        let best = null;
        for (const d of docs) {
            if (d.classId !== '114' || !d.data) continue;
            const scr = d.data.m_Script;
            if (!scr || String(scr.guid).toLowerCase() !== kUrpVolumeScriptGuid) continue;
            if (!truthy01(d.data.m_Enabled) || !truthy01(d.data.m_IsGlobal)) continue;
            const prio = asNum(d.data.priority, 0);
            const prof = d.data.sharedProfile && d.data.sharedProfile.guid
                ? String(d.data.sharedProfile.guid).toLowerCase() : null;
            if (!prof) continue;
            if (!best || prio >= best.prio) best = { prio, prof };
        }
        if (best) {
            const entry = ctx.pkg.get(best.prof);
            if (entry) {
                ctx.volumeOverrides = parseVolumeProfile(
                    fs.readFileSync(path.join(entry.dir, 'asset'), 'utf8'));
                if (ctx.verbose) {
                    console.log(`volume profile: ${path.basename(entry.assetPath)} -> `
                        + Object.keys(ctx.volumeOverrides).join(', '));
                }
            }
        }
    }

    const st = {
        isFbx: false,
        nodes: new Map(),
        anchorToNode: new Map(), // transform/GO/renderer anchor -> node id
        rootIds: [],
    };

    const goToNode = new Map(); // GO anchor -> node id
    let order = 0;

    // Pass 1: real transforms -> nodes.
    for (const d of docs) {
        if (d.classId !== '4' || d.stripped || !d.data) continue;
        const node = makeNode('');
        node.order = order++;
        readTRS(node, d.data);
        node.fatherAnchor = (d.data.m_Father && d.data.m_Father.fileID) || '0';
        st.nodes.set(node.id, node);
        st.anchorToNode.set(d.anchor, node.id);
        const go = d.data.m_GameObject && d.data.m_GameObject.fileID;
        if (go && go !== '0') { st.anchorToNode.set(go, node.id); goToNode.set(go, node.id); }
    }

    // Pass 2: real GameObjects -> name/active.
    for (const d of docs) {
        if (d.classId !== '1' || d.stripped || !d.data) continue;
        const nid = goToNode.get(d.anchor);
        if (!nid) continue;
        const node = st.nodes.get(nid);
        node.name = String(d.data.m_Name ?? '');
        node.active = truthy01(d.data.m_IsActive);
    }

    // Pass 2.5: index stripped docs per instance. A stripped doc's anchor is
    // the object's computed fileID in THIS file; its m_CorrespondingSourceObject
    // fileID is the object's id in the source prefab's namespace — the same
    // namespace m_Modifications targets use. For a single-root variant prefab
    // the one unresolvable class-4 corr id IS the instance root transform's
    // computed id, which lets mod application discriminate root vs deep targets.
    const strippedByInstance = new Map(); // instAnchor -> { t4: [corr], t1: [corr] }
    for (const d of docs) {
        if (!d.stripped || (d.classId !== '4' && d.classId !== '1') || !d.data) continue;
        const inst = d.data.m_PrefabInstance && d.data.m_PrefabInstance.fileID;
        const corr = d.data.m_CorrespondingSourceObject && d.data.m_CorrespondingSourceObject.fileID;
        if (!inst || !corr) continue;
        if (!strippedByInstance.has(inst)) strippedByInstance.set(inst, { t4: [], t1: [] });
        strippedByInstance.get(inst)[d.classId === '4' ? 't4' : 't1'].push(corr);
    }

    // Pass 3: nested prefab instances.
    for (const d of docs) {
        if (d.classId !== '1001' || !d.data) continue;
        expandPrefabInstance(ctx, st, d, [...stack, unityGuid], strippedByInstance.get(d.anchor));
    }

    // Pass 4: stripped transform/GO docs alias into expanded instance clones.
    for (const d of docs) {
        if (!d.stripped || (d.classId !== '4' && d.classId !== '1')) continue;
        if (!d.data) continue;
        const instAnchor = d.data.m_PrefabInstance && d.data.m_PrefabInstance.fileID;
        const corr = d.data.m_CorrespondingSourceObject && d.data.m_CorrespondingSourceObject.fileID;
        const inst = st.instanceClones && st.instanceClones.get(instAnchor);
        if (!inst) continue;
        const subNodeId = inst.sub.anchorToNode.get(corr);
        const cloneId = subNodeId ? inst.map.get(subNodeId) : inst.rootCloneId;
        if (cloneId) st.anchorToNode.set(d.anchor, cloneId);
    }

    // Pass 5: real mesh filters / renderers (can attach to real or stripped GOs).
    for (const d of docs) {
        if (!d.data || d.stripped) continue;
        const go = d.data.m_GameObject && d.data.m_GameObject.fileID;
        const nid = go && st.anchorToNode.get(go);
        if (d.classId === '33') {
            if (!nid) continue;
            const node = st.nodes.get(nid);
            if (!node) continue;
            const mesh = d.data.m_Mesh || {};
            if (mesh.guid && !BUILTIN_GUIDS.has(String(mesh.guid).toLowerCase())) {
                node.meshFbxGuid = String(mesh.guid).toLowerCase();
            } else if (BUILTIN_MESHES[mesh.fileID]) {
                node.meshPrimitive = BUILTIN_MESHES[mesh.fileID];
            } else if (mesh.fileID && mesh.fileID !== '0') {
                stats.skippedBuiltinUnsupported++;
            }
            st.anchorToNode.set(d.anchor, nid);
        } else if (d.classId === '23') {
            if (!nid) continue;
            const node = st.nodes.get(nid);
            if (!node) continue;
            node.rendererEnabled = truthy01(d.data.m_Enabled);
            node.castShadows = truthy01(d.data.m_CastShadows);
            node.receiveShadows = truthy01(d.data.m_ReceiveShadows);
            // A real (non-instanced) MeshRenderer serializes its material slots
            // inline. The FBX loader splits a multi-material mesh into one submesh
            // per material (<base>_0.._N-1), so the slot count is the part count.
            if (Array.isArray(d.data.m_Materials) && d.data.m_Materials.length > 0) {
                node.matGuids = d.data.m_Materials.map(
                    m => (m && m.guid ? String(m.guid).toLowerCase() : null));
                if (node.matGuids.length > 1)
                    node.matCount = node.matGuids.length;
            }
            st.anchorToNode.set(d.anchor, nid);
        } else if (d.classId === '137') {
            if (nid) { const node = st.nodes.get(nid); if (node) node.skinned = true; }
            stats.skippedSkinned++;
        } else if (d.classId === '108') {
            // Unity LightType: 0=Spot 1=Directional 2=Point 3=Area 4=Disc.
            // v1 converts directional (sun) + point (torches); spot/area counted as skipped.
            // A future spot branch must route its transform through the same
            // conj(worldRot * kYFlip) the directional emitter uses: a spot shines
            // along a direction, so both the -Z shine-vector convention and the
            // FromTRS inverse-rotation apply. Emitting the raw world rotation would
            // mirror its aim in the XZ plane, exactly the bug the directionals had.
            const uType = String(d.data.m_Type ?? '1');
            const node = nid && st.nodes.get(nid);
            if (node && (uType === '1' || uType === '2')) {
                const col = d.data.m_Color || {};
                const shadowType = d.data.m_Shadows && d.data.m_Shadows.m_Type;
                node.light = {
                    type: uType === '1' ? 'directional' : 'point',
                    color: [asNum(col.r, 1), asNum(col.g, 1), asNum(col.b, 1)],
                    intensity: asNum(d.data.m_Intensity, 1),
                    range: asNum(d.data.m_Range, 10),
                    shadows: truthy01(shadowType),
                    enabled: truthy01(d.data.m_Enabled),
                };
                stats.convertedLights++;
            } else {
                stats.skippedLights++;
            }
        } else if (d.classId === '114') {
            // UniversalAdditionalLightData (identified by its tier field): the
            // per-light URP additional-shadow resolution tier, an index into
            // the RP asset's tier resolutions (0/1/2 = low/medium/high).
            const tier = d.data.m_AdditionalLightsShadowResolutionTier;
            if (tier !== undefined && nid) {
                const node = st.nodes.get(nid);
                if (node) node.urpShadowTier = asNum(tier, null);
            }
        }
        else if (d.classId === '20') stats.skippedCameras++;
        else if (d.classId === '198' || d.classId === '199') stats.skippedParticles++;
        else if (d.classId === '205') stats.lodGroups++;
    }

    // Pass 6: resolve father links.
    for (const node of st.nodes.values()) {
        if (node.father !== null) continue; // instance-internal links already set
        const fa = node.fatherAnchor;
        if (!fa || fa === '0') { node.father = 'ROOT'; continue; }
        const pid = st.anchorToNode.get(fa);
        if (pid && pid !== node.id) node.father = pid;
        else { node.father = 'ROOT'; stats.unresolvedFatherLinks++; }
    }
    for (const node of st.nodes.values()) {
        if (node.father === 'ROOT') { node.father = null; st.rootIds.push(node.id); }
        else st.nodes.get(node.father).children.push(node.id);
    }
    st.rootIds.sort((a, b) => st.nodes.get(a).order - st.nodes.get(b).order);
    for (const node of st.nodes.values())
        node.children.sort((a, b) => st.nodes.get(a).order - st.nodes.get(b).order);

    ctx.structureCache.set(unityGuid, st);
    return st;
}

const TRS_PROPS = new Set([
    'm_LocalPosition.x', 'm_LocalPosition.y', 'm_LocalPosition.z',
    'm_LocalRotation.x', 'm_LocalRotation.y', 'm_LocalRotation.z', 'm_LocalRotation.w',
    'm_LocalScale.x', 'm_LocalScale.y', 'm_LocalScale.z',
]);

// Expand one PrefabInstance doc into `st` by cloning the source structure
// and applying m_Modifications. Unknown mod targets (Unity's hash-computed
// fileIDs for nested-prefab internals, or FBX importer internals) are routed
// to the instance ROOT node — the dominant Synty case is a single-node prop.
function expandPrefabInstance(ctx, st, doc, stack, strippedRefs) {
    const mod = doc.data.m_Modification || {};
    const srcGuid = doc.data.m_SourcePrefab && String(doc.data.m_SourcePrefab.guid || '').toLowerCase();
    const sub = srcGuid ? buildFileStructure(ctx, srcGuid, stack) : null;
    if (!sub) { stats.unresolvedPrefabSources++; return; }
    if (sub.rootIds.length !== 1) {
        warn(`prefab ${srcGuid} has ${sub.rootIds.length} roots; using first`, ctx.verbose);
    }

    stats.prefabInstancesExpanded++;

    // Clone the source node tree.
    const map = new Map(); // sub node id -> clone id
    for (const [sid, snode] of sub.nodes) {
        const c = cloneNode(snode);
        c.order = st.nodes.size; // keep file order grouping
        map.set(sid, c.id);
        st.nodes.set(c.id, c);
    }
    for (const [sid, snode] of sub.nodes) {
        const c = st.nodes.get(map.get(sid));
        c.father = snode.father ? map.get(snode.father) : null;
    }
    const rootCloneId = map.get(sub.rootIds[0]);
    const rootClone = st.nodes.get(rootCloneId);
    // Instance root attaches into the CONTAINER file via m_TransformParent.
    rootClone.father = null;
    rootClone.fatherAnchor = (mod.m_TransformParent && mod.m_TransformParent.fileID) || '0';
    // Non-root clones keep resolved internal fathers; mark them done.
    for (const [sid, snode] of sub.nodes) {
        if (sid === sub.rootIds[0]) continue;
        const c = st.nodes.get(map.get(sid));
        if (c.father === null) c.father = rootCloneId; // orphan safety
    }

    // Material overrides: recover m_Materials.Array.{size,data[k]} mods and bind
    // each to the specific renderer it targets. Unity computes the target as
    // {fileID: <renderer id in the source prefab>, guid: <source prefab guid>,
    // type: 3}; the guid always equals this instance's m_SourcePrefab (verified
    // 7033/7033 elven, 7775/7775 ancient), so the renderer resolves through the
    // source structure's anchorToNode (renderer/GO/transform id -> source node)
    // and then the clone map. Per-renderer resolution places recolours on the
    // right sub-part of a multi-part prop — a jewellery-box lid, chandelier
    // glass, window glass, drawer front — that a single-mesh heuristic bound to
    // the body (or dropped entirely once >1 renderer was overridden).
    //
    // A renderer id the source doesn't index (a direct-FBX renderer, or a
    // stripped renderer of a deeper nested prefab) has no node to resolve to.
    // A SINGLE-target instance then falls back to the sole mesh clone — the
    // dominant wrapper-prefab case, and how the previous pass bound everything.
    // A MULTI-target instance gets no fallback: smearing a partial recolour onto
    // the wrong sub-part is worse than leaving that slot at its FBX default, so
    // the unresolved slot is dropped and counted.
    const materialSeenTargets = new Set();
    {
        const matByTarget = new Map(); // target fileID -> { size, slots: Map<idx, matGuid|null> }
        for (const m of (mod.m_Modifications || [])) {
            if (!m || !m.propertyPath || !m.target) continue;
            const t = m.target.fileID || '0';
            const sz = /^m_Materials\.Array\.size$/.exec(m.propertyPath);
            const dm = /^m_Materials\.Array\.data\[(\d+)\]$/.exec(m.propertyPath);
            if (!sz && !dm) continue;
            if (!matByTarget.has(t)) matByTarget.set(t, { size: 0, slots: new Map() });
            const rec = matByTarget.get(t);
            if (sz) rec.size = Math.max(rec.size, asNum(m.value, 0));
            else {
                const idx = parseInt(dm[1], 10);
                rec.size = Math.max(rec.size, idx + 1);
                // Material assignment lives in objectReference, not value.
                const g = m.objectReference && m.objectReference.guid;
                rec.slots.set(idx, g ? String(g).toLowerCase() : null);
            }
        }
        if (matByTarget.size > 0) {
            const meshClones = [];
            for (const cid of map.values()) {
                const c = st.nodes.get(cid);
                if (c.meshFbxGuid || c.meshPrimitive) meshClones.push(c);
            }
            // Fallback target for unresolved renderer ids: the sole mesh node
            // (single-mesh wrapper / direct FBX), else the root body of a
            // multi-node prop.
            const soleMeshClone = meshClones.length === 1 ? meshClones[0]
                : (rootClone.meshFbxGuid ? rootClone : null);
            const singleTarget = matByTarget.size === 1;
            for (const [t, rec] of matByTarget) {
                materialSeenTargets.add(t);
                const sid = sub.anchorToNode.get(t);
                let node = sid ? st.nodes.get(map.get(sid)) : null;
                if (node && !(node.meshFbxGuid || node.meshPrimitive)) node = null;
                if (!node && singleTarget) node = soleMeshClone;
                if (!node) {
                    stats.droppedMaterialOverrides += [...rec.slots.values()].filter(Boolean).length;
                    continue;
                }
                if (rec.size > node.matCount) node.matCount = rec.size;
                // Overlay only the overridden slots; slots the mod leaves alone
                // keep whatever the wrapper/FBX already supplied.
                for (const [idx, g] of rec.slots) if (g) node.matGuids[idx] = g;
                stats.materialOverridesBound += [...rec.slots.values()].filter(Boolean).length;
            }
        }
    }

    // Root discrimination: among this instance's stripped-doc corr ids, the
    // ones the source structure cannot resolve are computed ids of nested
    // objects. Exactly one unresolved class-4 corr => the root transform's
    // computed id (Synty variant prefabs: prefab wrapping an FBX).
    let rootTransformCorr = null, rootGoCorr = null;
    if (strippedRefs) {
        const un4 = strippedRefs.t4.filter(c => !sub.anchorToNode.has(c));
        const un1 = strippedRefs.t1.filter(c => !sub.anchorToNode.has(c));
        if (un4.length === 1) rootTransformCorr = un4[0];
        if (un1.length === 1) rootGoCorr = un1[0];
    }

    // Apply modifications grouped by target fileID.
    const groups = new Map();
    for (const m of (mod.m_Modifications || [])) {
        if (!m || !m.target) continue;
        const t = m.target.fileID || '0';
        if (!groups.has(t)) groups.set(t, []);
        groups.get(t).push(m);
    }
    const NAMEISH = new Set(['m_Name', 'm_TagString', 'm_Layer', 'm_StaticEditorFlags', 'm_RootOrder',
        'm_LocalEulerAnglesHint.x', 'm_LocalEulerAnglesHint.y', 'm_LocalEulerAnglesHint.z']);
    let rootTrsApplied = false, rootNameApplied = false;
    for (const [target, mods] of groups) {
        // Material-override group already handled by the recovery pass above
        // (bound to its renderer, or dropped as unresolvable) — don't route it
        // to the root or count it again as a dropped deep override.
        if (materialSeenTargets.has(target)
            && mods.every(m => m && /^m_Materials\.Array\./.test(m.propertyPath))) {
            continue;
        }
        let nid = sub.anchorToNode.get(target);
        let node = nid ? st.nodes.get(map.get(nid)) : null;
        if (!node) {
            const hasTrs = mods.some(m => TRS_PROPS.has(m.propertyPath));
            if (target === rootTransformCorr || target === rootGoCorr) {
                node = rootClone;
                if (hasTrs) rootTrsApplied = true;
                if (mods.some(m => m.propertyPath === 'm_Name')) rootNameApplied = true;
            } else if (hasTrs) {
                if (rootTransformCorr) { stats.droppedDeepTrsOverrides++; continue; }
                if (rootTrsApplied) { stats.modTargetConflicts++; continue; }
                rootTrsApplied = true;
                stats.modTargetFallbacks++;
                node = rootClone;
            } else {
                // Non-TRS group. A rename-only group belongs to the root GO in
                // the dominant case; anything else with a known root id is a
                // deep override we cannot place (dropped, counted).
                const nameOnly = mods.every(m => NAMEISH.has(m.propertyPath));
                const hasName = mods.some(m => m.propertyPath === 'm_Name');
                if (hasName && nameOnly && !rootNameApplied) {
                    rootNameApplied = true;
                    stats.modTargetFallbacks++;
                    node = rootClone;
                } else if (!rootTransformCorr) {
                    stats.modTargetFallbacks++;
                    node = rootClone;
                } else {
                    stats.droppedDeepPropOverrides++;
                    if (mods.some(m => m.propertyPath === 'm_IsActive' && !truthy01(m.value)))
                        stats.droppedDeepActiveDisables++;
                    continue;
                }
            }
        }
        for (const m of mods) applyModification(node, m.propertyPath, m.value);
    }

    // Register for stripped-doc alias resolution (pass 4 of the container).
    if (!st.instanceClones) st.instanceClones = new Map();
    st.instanceClones.set(doc.anchor, { sub, map, rootCloneId });
}

function applyModification(node, prop, value) {
    switch (prop) {
        case 'm_LocalPosition.x': node.pos[0] = asNum(value, node.pos[0]); break;
        case 'm_LocalPosition.y': node.pos[1] = asNum(value, node.pos[1]); break;
        case 'm_LocalPosition.z': node.pos[2] = asNum(value, node.pos[2]); break;
        case 'm_LocalRotation.x': node.rot[0] = asNum(value, node.rot[0]); break;
        case 'm_LocalRotation.y': node.rot[1] = asNum(value, node.rot[1]); break;
        case 'm_LocalRotation.z': node.rot[2] = asNum(value, node.rot[2]); break;
        case 'm_LocalRotation.w': node.rot[3] = asNum(value, node.rot[3]); break;
        case 'm_LocalScale.x': node.scale[0] = asNum(value, node.scale[0]); break;
        case 'm_LocalScale.y': node.scale[1] = asNum(value, node.scale[1]); break;
        case 'm_LocalScale.z': node.scale[2] = asNum(value, node.scale[2]); break;
        case 'm_Name': if (value) node.name = String(value); break;
        case 'm_IsActive': node.active = truthy01(value); break;
        case 'm_Enabled': node.rendererEnabled = truthy01(value); break;
        case 'm_CastShadows': node.castShadows = truthy01(value); break;
        case 'm_ReceiveShadows': node.receiveShadows = truthy01(value); break;
        default: break; // m_RootOrder, hints, materials, ... ignored in v1
    }
}

// ------------------------------------------------------ emission -----------
function fmtF(v) {
    if (Number.isInteger(v)) return String(v);
    // Round-trippable but compact.
    return String(Math.round(v * 1e7) / 1e7);
}
const fmt3 = (a) => `(${fmtF(a[0])}, ${fmtF(a[1])}, ${fmtF(a[2])})`;
const fmt4 = (a) => `(${fmtF(a[0])}, ${fmtF(a[1])}, ${fmtF(a[2])}, ${fmtF(a[3])})`;
// The engine composes a Transform's rotation matrix as the TRANSPOSE of the
// standard quaternion->matrix (Transform::FromTRS), i.e. it renders R(q)^T =
// R(q^-1): the CONJUGATE of the stored quaternion drives both orientation and
// the rotation of child local offsets. The engine round-trips its own content
// (write and read both conjugate), so it is self-consistent — but Unity stores
// standard-convention quaternions. Emitting conj(q) = (-x,-y,-z,w) makes
// FromTRS(conj(q)) = R(q), so parent-offset composition (q^-1 v q with the
// conjugated q) and rendered orientation both match Unity exactly. Verified
// numerically on the observatory-telescope chain (parent yaw -11.1deg): the
// engine rotated the child offset by +11.1deg; the Unity-minus-engine world
// position residual (-11.459, 0, -2.403) matches conj-vs-non-conj to 3 dp.
const conj = (q) => [-q[0], -q[1], -q[2], q[3]];

// ---- transform convention (see the FromTRS note above conj) --------------
// The engine renders R(conj(q_stored)); the converter therefore emits the
// CONJUGATE of every Unity quaternion so FromTRS(conj(q)) = R(q) and both the
// rendered orientation and the conj-dependent parent-offset composition match
// Unity exactly. These primitives are module-level (not emitScene closures) so
// tests/transform-convention.test.mjs can exercise the exact emitted math and
// fail loudly if a future edit -- or a stale copy of this file -- drops the
// conjugation. Bump TRANSFORM_CONVENTION_VERSION (and the startup banner) on
// any intentional change to the convention.
const TRANSFORM_CONVENTION_VERSION = 'conj-v2 (R(conj(q)) engine)';

// Hamilton product (x,y,z,w arrays).
const qMul = (a, b) => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
// Rotate vector v by quaternion q: v' = q * (v,0) * q^-1.
const qRotate = (q, v) => {
    const [x, y, z, w] = q;
    const uvx = y * v[2] - z * v[1], uvy = z * v[0] - x * v[2], uvz = x * v[1] - y * v[0];
    const uuvx = y * uvz - z * uvy, uuvy = z * uvx - x * uvz, uuvz = x * uvy - y * uvx;
    return [v[0] + 2 * (w * uvx + uuvx), v[1] + 2 * (w * uvy + uuvy), v[2] + 2 * (w * uvz + uuvz)];
};
// Unity directional/spot lights shine along +Z; the engine extracts light
// direction as the entity's -Z (RenderExtractionSystem negates the world Z
// column). A 180-degree local-Y turn maps that -Z onto Unity's authored +Z.
const kYFlip = [0, 1, 0, 0];

// The rotation the converter STORES for a plain object: conj of the Unity
// local quaternion, so the engine's R(conj(stored)) renders R(q_unity).
const emitObjectQuat = (qUnity) => conj(qUnity);
// The rotation the converter STORES for a directional light: the composed
// world rotation, Y-flipped so -Z aligns to Unity forward, then conjugated
// for the engine convention (kept in sync with the mesh path).
const emitDirectionalQuat = (worldRot) => conj(qMul(worldRot, kYFlip));

// Compose a root->leaf chain of local {pos,rot,scale} nodes into a world
// {pos,rot,scl} (uniform-scale assumption is fine for light placement).
const composeWorldTRS = (chain) => {
    let pos = [0, 0, 0], rot = [0, 0, 0, 1], scl = [1, 1, 1];
    for (const c of chain) {
        const scaled = [c.pos[0] * scl[0], c.pos[1] * scl[1], c.pos[2] * scl[2]];
        const rotated = qRotate(rot, scaled);
        pos = [pos[0] + rotated[0], pos[1] + rotated[1], pos[2] + rotated[2]];
        rot = qMul(rot, c.rot);
        scl = [scl[0] * c.scale[0], scl[1] * c.scale[1], scl[2] * c.scale[2]];
    }
    return { pos, rot, scl };
};

const sanitizeName = (s) => s.replace(/["\\]/g, "'").replace(/[\r\n]/g, ' ');
// The FBX source-node name the engine matches submeshes against. Unity appends
// " (N)" to disambiguate duplicate GameObjects in a parent; the FBX node has no
// such suffix, so strip a single trailing " (N)" for the meshName selector only
// (Name.value keeps the full instance name for the hierarchy).
const meshMatchName = (s) => sanitizeName((s || '').replace(/ \(\d+\)$/, ''));

// Ambient floor (opt-in AmbientLight component): the ADDITIVE analogue of the sky's
// multiplicative AmbientTint. Unity's flat/gradient ambient is display-referred fill light;
// we map it to a scene-linear irradiance floor added to the diffuse term (ibl.glsl
// GE_AmbientFloor). Intensity is the nit level Color x Intensity / 203 resolves to on the
// shared reference-white anchor (see AmbientLight.h). The 60-nit anchor comes from the
// gradient-sky finding that a full ambient around this level reads as a believable night
// fill; it is a per-scene art knob, not a physical derivation.
//   Unity m_AmbientMode: 0 = Skybox (omit — that ambient IS the sky IBL), 1 = Trilight/Gradient
//   -> Trilight, 3 = Flat/Color -> Flat (Unity stores the flat colour in m_AmbientSkyColor).
// This REPLACES the SkyEnvironment.AmbientTint* emission for these modes so a converted scene
// never carries a double ambient (multiplicative tint AND additive floor); the multiplicative
// AmbientTint stays a hand-authoring feature the converter simply no longer emits.
//
// Colour space: Unity's m_Ambient*Color RenderSettings fields serialize the colour PICKER'S
// sRGB-encoded floats, not linear light (proof: ElvenRealm Demo.unity's trilight sky is
// {0.5082908, 0.39215687, 0.85882354} — exactly the 8-bit swatch {130,100,219}/255 on g/b).
// AmbientLight colours are authored-linear (AmbientLight.h), so decode here, with the same
// LDR/HDR rule as linearizeUnityTint: swatches with every channel <= 1 decode per-channel,
// any channel > 1 means an HDR picker value already in linear working space — pass through.
// The decode lives HERE at emission, NOT in parseRenderSettings: isNight's 0.6 luminance
// threshold was calibrated on the display-referred (sRGB) values and must keep seeing them.
// Module-level (not an emitScene closure) so tests/ambient-linearization.test.mjs can guard
// the exact emitted numbers.
function linearizeAmbientColor(c) {
    if (c[0] > 1 || c[1] > 1 || c[2] > 1) return c; // HDR: already linear
    return [srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2])];
}

// ---- faithful Unity skybox (pipeline rationale + conventions: skybox.js) ---
// 8K equirect cap matches the ElvenRealm source at the equator exactly: a
// 2048px/face cubemap spans 4 faces around the horizon = 8192 texels. The
// actual width is min(cap, 4 * faceSize) — undersampling drops star points,
// oversampling wastes cook time and VRAM.
const kSkyboxEquirectMaxWidth = 8192;

// Resolve RenderSettings.m_SkyboxMaterial to a baked equirect .hdr in the
// project's Textures_Unity/, or null (with a warning) when the scene has no
// skybox, the material is not builtin Skybox/Cubemap over a DDS cubemap, or
// there is no project texture dir. On null the emitted scene simply keeps the
// procedural SkyEnvironment sky — the pre-skybox behavior, never a black dome.
// A .bake.json sidecar records the bake parameters so a re-run only skips the
// (slow, ~1 min) resample when source AND parameters are unchanged.
function resolveSceneSkybox(ctx) {
    const rs = ctx.renderSettings;
    if (!rs || !rs.skyboxGuid) return null;
    const entry = ctx.pkg.get(rs.skyboxGuid);
    if (!entry) {
        warn(`RenderSettings skybox material ${rs.skyboxGuid} not in package — procedural sky stays`, ctx.verbose);
        return null;
    }
    let mat = null;
    try { mat = skybox.parseUnitySkyboxMat(fs.readFileSync(path.join(entry.dir, 'asset'), 'utf8')); }
    catch (e) { warn(`skybox material ${entry.assetPath} unreadable: ${e.message}`, ctx.verbose); return null; }
    if (!mat || !mat.isBuiltinCubemap || !mat.texGuid) {
        warn(`skybox material ${entry.assetPath} is not builtin Skybox/Cubemap with a bound _Tex `
           + `(shader fileID ${mat ? mat.shaderFileId : '?'}) — procedural sky stays`, ctx.verbose);
        return null;
    }
    const texEntry = ctx.pkg.get(mat.texGuid);
    if (!texEntry) {
        warn(`skybox cubemap ${mat.texGuid} not in package — procedural sky stays`, ctx.verbose);
        return null;
    }
    if (!/\.dds$/i.test(texEntry.assetPath)) {
        warn(`skybox cubemap ${texEntry.assetPath}: only DDS cubemaps are supported — procedural sky stays`, ctx.verbose);
        return null;
    }
    if (!ctx.texCopyDir) {
        warn(`skybox conversion needs the project texture dir (run with --project, without --no-copy-textures)`, ctx.verbose);
        return null;
    }
    if (mat.rotationDegrees !== 0) {
        warn(`skybox _Rotation=${mat.rotationDegrees}: the Y-rotation sign parity between Unity's dome `
           + `rotation and Skybox.RotationDegrees is UNVERIFIED (no reference scene uses it) — verify visually`, ctx.verbose);
    }
    const stem = path.basename(texEntry.assetPath, path.extname(texEntry.assetPath));
    const outName = `${stem}_equirect.hdr`;
    const outAbs = path.join(ctx.texCopyDir, outName);
    const relPath = `${kTexCopyRel}/${outName}`;
    const mult = skybox.computeSkyboxMultiplier(mat.tint, mat.exposure);
    const srcAbs = path.join(texEntry.dir, 'asset');
    const metaAbs = outAbs + '.bake.json';
    const bakeParams = { maxWidth: kSkyboxEquirectMaxWidth, multiplier: mult, srcMtimeMs: 0 };
    try { bakeParams.srcMtimeMs = fs.statSync(srcAbs).mtimeMs; } catch (_) { /* stat at read below */ }
    let reused = false;
    try {
        const prior = JSON.parse(fs.readFileSync(metaAbs, 'utf8'));
        reused = fs.statSync(outAbs).size > 0 && JSON.stringify(prior) === JSON.stringify(bakeParams);
    } catch (_) { /* no sidecar/output -> bake */ }
    let stats = null;
    if (!reused) {
        console.error(`Skybox: baking ${texEntry.assetPath} -> ${relPath} `
                    + `(mult ${mult.map(fmtF).join('/')})...`);
        const t0 = Date.now();
        try {
            stats = skybox.convertDdsCubemapToEquirectHdr(
                fs.readFileSync(srcAbs), outAbs, kSkyboxEquirectMaxWidth, mult);
        } catch (e) {
            warn(`skybox cubemap conversion failed: ${e.message} — procedural sky stays`, ctx.verbose);
            return null;
        }
        fs.writeFileSync(metaAbs, JSON.stringify(bakeParams));
        console.error(`Skybox: baked ${stats.faceSize}px/face -> ${stats.width}x${stats.height} `
                    + `in ${((Date.now() - t0) / 1000).toFixed(1)}s (mean L ${stats.meanLuminance.toExponential(3)}, `
                    + `peak L ${stats.maxLuminance.toFixed(4)} scene-linear)`);
    }
    return { relPath, guid: deterministicGuid(relPath), rotationDegrees: mat.rotationDegrees, reused, stats };
}
function emitAmbientLightLines(rs, verbose) {
    const out = [];
    const kAmbientFloorNits = 60;
    // Day latent (same class as the daylight point-light branch in the light emitter): the
    // 60-nit anchor is a NIGHT operating point. No converted day scene uses ambientMode 1/3
    // yet; when one does, an additive 60-nit floor is imperceptible under a bright day sky
    // and is NOT a calibrated replacement for the multiplicative tint it displaces — warn
    // instead of inventing a day constant.
    const ambientEmitted = !!(rs && (rs.ambientMode === 1 || rs.ambientMode === 3));
    if (ambientEmitted && !rs.isNight) {
        warn(`day-scene ambient emission is uncalibrated: AmbientLight.Intensity is set to the `
           + `night ${kAmbientFloorNits}-nit anchor, which is imperceptible under a day sky — `
           + `tune AmbientLight.Intensity in the converted scene by hand`, verbose);
    }
    if (rs && rs.ambientMode === 1 && rs.ambientSky && rs.ambientEquator && rs.ambientGround) {
        out.push(`AmbientLight.Mode = 1`);
        out.push(`AmbientLight.SkyColor = ${fmt3(linearizeAmbientColor(rs.ambientSky))}`);
        out.push(`AmbientLight.EquatorColor = ${fmt3(linearizeAmbientColor(rs.ambientEquator))}`);
        out.push(`AmbientLight.GroundColor = ${fmt3(linearizeAmbientColor(rs.ambientGround))}`);
        out.push(`AmbientLight.Intensity = ${kAmbientFloorNits}`);
    } else if (rs && rs.ambientMode === 3 && rs.ambientSky) {
        out.push(`AmbientLight.Mode = 0`);
        out.push(`AmbientLight.Color = ${fmt3(linearizeAmbientColor(rs.ambientSky))}`);
        out.push(`AmbientLight.Intensity = ${kAmbientFloorNits}`);
    }
    return out;
}

function emitScene(ctx, st, sceneName) {
    const out = [];
    out.push(`[scene name="${sanitizeName(sceneName)}" version=1]`);
    out.push(`; Converted from Unity scene by openengine-unity-scene-converter`);
    out.push('');

    const emitted = {
        entities: 0, meshEntities: 0, groupEntities: 0, lights: 0, suppressedAdditionalLightShadows: 0,
        localShadowTiers: [0, 0, 0, 0], // shadowed locals emitted, indexed by engine tier (1=Low 2=Medium 3=High)
        resolvedMeshes: 0, unresolvedMeshes: 0, materialParts: 0, materialsBound: 0, hiddenSkyFx: 0,
        uniqueFbx: new Set(), unresolvedFbxStems: new Set(),
        sunEntityId: null, environment: false,
        directionalsBeyondEngineCap: 0,
    };

    // keep = has a (convertible) mesh or light, or any descendant kept.
    const keepCache = new Map();
    const isMeshNode = (n) => (n.meshFbxGuid && !n.skinned && !n.nonStaticFbx) || n.meshPrimitive;
    const keep = (nid) => {
        if (keepCache.has(nid)) return keepCache.get(nid);
        const n = st.nodes.get(nid);
        let k = false;
        if (!n.active) {
            countSubtreeSkips(nid);
            k = false;
        } else {
            k = isMeshNode(n) || !!n.light || n.children.some(keep);
            if (n.meshFbxGuid && n.skinned) { /* counted at parse */ }
            if (n.meshFbxGuid && n.nonStaticFbx && !n.skinned) stats.skippedNonStaticFbx++;
        }
        keepCache.set(nid, k);
        return k;
    };
    const countSubtreeSkips = (nid) => {
        const n = st.nodes.get(nid);
        if (isMeshNode(n)) stats.skippedInactive++;
        n.children.forEach(countSubtreeSkips);
    };

    // World TRS by composing the parent chain (uniform-scale assumption is fine
    // for light placement). Used to emit directional lights unparented. The
    // composition math lives in module-level composeWorldTRS so the transform-
    // convention tests can exercise the exact emitted path.
    const worldTRS = (nid) => {
        const chain = [];
        for (let cur = nid; cur; cur = st.nodes.get(cur).father) chain.unshift(st.nodes.get(cur));
        return composeWorldTRS(chain);
    };

    // The engine lights up to 4 directional lights per world (the strongest,
    // per RenderServices::PackForwardLightDirectionals — luma x intensity
    // ordering; all converter-emitted directionals share the same Lux scale
    // and default range), with cascaded shadows from the primary only. Every
    // enabled directional is emitted enabled; this scan only picks the
    // STRONGEST one so the SkyEnvironment sun anchor and the engine's primary
    // shading/shadow pick coincide. Strength mirrors the engine's ordering;
    // ties keep the first in traversal order (the engine tie-break is the
    // lower entity id, i.e. emitted first).
    const kEngineDirectionalCap = 4;
    let strongestDirectionalNid = null;
    {
        const dirLuma = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
        const enabledDirs = [];
        const scanDirs = (nid) => {
            const n = st.nodes.get(nid);
            if (!n || !n.active) return; // inactive subtrees never emit
            if (n.light && n.light.type === 'directional' && n.light.enabled)
                enabledDirs.push({ nid, name: n.name || 'Unnamed', strength: dirLuma(n.light.color) * n.light.intensity });
            n.children.forEach(scanDirs);
        };
        for (const r of st.rootIds) scanDirs(r);
        if (enabledDirs.length > 0) {
            let best = enabledDirs[0];
            for (const d of enabledDirs) if (d.strength > best.strength) best = d;
            strongestDirectionalNid = best.nid;
        }
        if (enabledDirs.length > kEngineDirectionalCap) {
            emitted.directionalsBeyondEngineCap = enabledDirs.length - kEngineDirectionalCap;
            console.error(`NOTE: ${enabledDirs.length} enabled directionals; the engine lights the `
                + `strongest ${kEngineDirectionalCap} (shadows from the primary only) — the rest will not contribute`);
        }
    }

    let idCounter = 0;
    const emitNode = (nid, parentEntityId) => {
        if (!keep(nid)) return;
        const n = st.nodes.get(nid);
        const eid = 'e_' + (++idCounter);
        const isDirLight = !!(n.light && n.light.type === 'directional');
        // Directional lights: emit at top level with composed world TRS — the
        // sky/environment system only binds an UNPARENTED directional as the
        // sun, and Unity scenes routinely nest lights under group objects.
        // Object rotations are conjugated to the engine's quaternion convention
        // (see conj above). The directional-light branch composes the world
        // rotation here (worldTRS/qMul, from the unconjugated Unity locals) and
        // then applies the SAME conjugation the mesh path uses: the engine's
        // FromTRS renders R(conj(q)) and extracts a light's shine direction as
        // conj(q)*(0,0,-1) (RenderExtractionSystem negates the world Z column).
        // kYFlip (a 180-degree local-Y turn) maps that -Z onto Unity's authored
        // +Z forward before the conjugation, so the emitted sun shines exactly
        // along Unity's world forward. Verified numerically: engine shine dir vs
        // Unity forward dot == 1.0 for both ElvenRealm directionals (the earlier
        // unconjugated form left them ~59 and ~81 degrees off — Z matched but the
        // XZ azimuth was mirrored).
        let pos = n.pos, rot = emitObjectQuat(n.rot), scale = n.scale;
        let parentAttr = parentEntityId ? ` parent="${parentEntityId}"` : '';
        if (isDirLight) {
            const w = worldTRS(nid);
            pos = w.pos; scale = w.scl;
            rot = emitDirectionalQuat(w.rot);
            parentAttr = '';
        }
        out.push(`[entity id="${eid}"${parentAttr}]`);
        out.push(`Name.value = "${sanitizeName(n.name || 'Unnamed')}"`);
        out.push(`Transform.position = ${fmt3(pos)}`);
        out.push(`Transform.rotation = ${fmt4(rot)}`);
        out.push(`Transform.scale = ${fmt3(scale)}`);

        emitted.entities++;
        let wasMesh = false;
        let meshRef = null, meshBase = null; // set when a multi-material node needs sibling parts
        if (n.meshPrimitive) {
            out.push(`MeshRenderer.meshPrimitive = ${n.meshPrimitive}`);
            emitMaterialRef(n, 0);
            emitMeshCommon(n);
            wasMesh = true;
        } else if (isMeshNode(n)) {
            emitted.uniqueFbx.add(n.meshFbxGuid);
            const ref = resolveMeshAsset(ctx, n.meshFbxGuid);
            if (ref) {
                out.push(`MeshRenderer.meshAsset = [path="${ref.path}" guid="${ref.guid}"]`);
                // Bind the specific submesh by source-node name. Unity references
                // meshes by fileID (which we cannot map to a submesh index), so
                // multi-submesh models would otherwise all render submesh 0. The
                // node name equals the engine's Mesh.Name; single-mesh models
                // ignore it, so it is safe to always emit.
                const mn = meshMatchName(n.name);
                if (n.matCount > 1 && mn) {
                    // Multi-material node: the FBX loader split it into <base>_0..
                    // <base>_{N-1}. A MeshRenderer binds ONE submesh, so bind part 0
                    // here (its submesh is named <base>_0, not the bare <base>) and
                    // emit sibling child entities for parts 1..N-1 below.
                    out.push(`MeshRenderer.meshName = "${mn}_0"`);
                    meshRef = ref; meshBase = mn;
                } else if (mn) {
                    out.push(`MeshRenderer.meshName = "${mn}"`);
                }
                emitMeshCommon(n, emitMaterialRef(n, 0));
                emitted.resolvedMeshes++;
                wasMesh = true;
            } else {
                const stem = fbxStem(ctx, n.meshFbxGuid);
                out.push(`; UNRESOLVED mesh asset: ${stem}.fbx (unity guid ${n.meshFbxGuid})`);
                emitted.unresolvedMeshes++;
                emitted.unresolvedFbxStems.add(stem);
            }
        }
        if (n.light) {
            // Engine LightType: 0=Directional 1=Point. The engine is physical-by-
            // default (sky/exposure anchored around a ~100k-lux sun): directional
            // lights map to Lux (illuminance), point/spot lights to Candela
            // (luminous intensity) so they drive the physical inverse-square falloff.
            const isDir = n.light.type === 'directional';
            out.push(`Light.type = ${isDir ? 0 : 1}`);
            out.push(`Light.color = ${fmt3(n.light.color)}`);
            // Unity URP with physical light units OFF (every Synty pack) authors
            // intensity as a display-referred linear multiplier: BOTH directional
            // and punctual lights fold intensity straight into the light color, and
            // the punctual inverse-square term equals 1 at the 1 m reference
            // distance. So a directional and a point light of the SAME Unity
            // intensity deposit the same energy at 1 m. Mirror that in the engine's
            // physical units: anchor Unity intensity 1.0 to a per-scene reference
            // illuminance — full daylight (~100k lux) by day, a stylized moon
            // (~2k lux) at night, since night moonlight is authored ~1.5 and would
            // render as a blown-out day at the daylight scale — and use the SAME
            // anchor for directional (Lux) and punctual (Candela) lights. Anchoring
            // both to one scale keeps them physically consistent exactly as URP
            // does. This replaces the old hand-tuned 12000 cd/unit punctual
            // constant, which ran torches ~6x brighter than the moon, forced
            // auto-exposure to stop down, and had to be medicated by a scene
            // exposure-compensation cut.
            const kDaylightReferenceLux = 100000;
            const kMoonlightReferenceLux = 2000;
            const night = !!(ctx.renderSettings && ctx.renderSettings.isNight);
            const referenceScale = night ? kMoonlightReferenceLux : kDaylightReferenceLux;
            // Day latent: no ElvenRealm scene has point lights in a day scene, so
            // the daylight branch is currently unreached. When it is, it maps Unity
            // intensity 2 -> 200,000 cd (2x the sun's illuminance at 1 m) — faithful
            // to URP's own math but a hotspot under daytime auto-exposure. A day
            // scene that carries point lights needs a per-light cap or a validation
            // pass before it is converted.
            out.push(`Light.intensity = ${fmtF(n.light.intensity * referenceScale)}`);
            out.push(`Light.intensityUnit = ${isDir ? 'Lux' : 'Candela'}`);
            if (!isDir) out.push(`Light.range = ${fmtF(n.light.range)}`);
            // Local-light (point/spot) shadow policy (--local-shadows):
            //   faithful (default) — emit the source flag, plus a resolution
            //     tier for shadow-casting locals. The old blanket suppression's
            //     cost model is superseded on both sides: her real RP asset
            //     DOES render additional-light shadows (2048 atlas, tiers
            //     256/512/1024 — not the URP-default-asset OFF the suppression
            //     assumed), and the engine now prices a shadowed local as a
            //     culled slot in the shared punctual atlas (S0 tiers + S1
            //     culling + M2a early-out + M1 multi-light atlas), not the
            //     dedicated 6-face cube pass that once cost ElvenRealm
            //     10 ms CPU/frame for one light.
            //   off — the legacy blanket: castsShadows=false for every
            //     non-directional light, for scenes whose source pipeline
            //     really never rendered them (e.g. raw Synty packs, which ship
            //     no URP asset at all).
            // The directional sun's shadow flag passes through in both modes.
            const faithful = ctx.localShadows !== 'off';
            const castsShadows = isDir ? n.light.shadows : (faithful && n.light.shadows);
            out.push(`Light.castsShadows = ${castsShadows ? 'true' : 'false'}`);
            if (!isDir && n.light.shadows) {
                if (faithful) {
                    // Engine LightShadowTier (0=Inherit 1=Low 2=Medium 3=High)
                    // from URP's per-light tier (0/1/2 = low/medium/high);
                    // unset or custom tiers land on Medium.
                    const tier = n.urpShadowTier === 0 ? 1 : n.urpShadowTier === 2 ? 3 : 2;
                    out.push(`Light.shadowResolutionTier = ${tier}`);
                    emitted.localShadowTiers[tier]++;
                } else {
                    emitted.suppressedAdditionalLightShadows++;
                }
            }
            if (!n.light.enabled) out.push(`Light.enabled = false`);
            emitted.lights++;
            // The SkyEnvironment sun anchor binds the STRONGEST enabled
            // directional (luma x intensity, the strongestDirectionalNid scan
            // above) — the same light the engine picks as its shading/shadow
            // primary, so anchor and primary coincide by construction.
            if (isDir && n.light.enabled && nid === strongestDirectionalNid)
                emitted.sunEntityId = eid;
        }
        if (wasMesh) emitted.meshEntities++; else emitted.groupEntities++;
        out.push('');
        // Sibling entities for the remaining material parts of a multi-material
        // mesh (parts 1..N-1). They parent to this entity with an identity local
        // transform (co-located) and inherit its render flags; each binds one
        // submesh by its <base>_<k> name.
        if (meshRef && meshBase) {
            for (let k = 1; k < n.matCount; ++k) {
                const peid = 'e_' + (++idCounter);
                out.push(`[entity id="${peid}" parent="${eid}"]`);
                out.push(`Name.value = "${sanitizeName(n.name || 'Unnamed')} [mat ${k}]"`);
                out.push(`Transform.position = (0, 0, 0)`);
                out.push(`Transform.rotation = (0, 0, 0, 1)`);
                out.push(`Transform.scale = (1, 1, 1)`);
                out.push(`MeshRenderer.meshAsset = [path="${meshRef.path}" guid="${meshRef.guid}"]`);
                out.push(`MeshRenderer.meshName = "${meshBase}_${k}"`);
                emitMeshCommon(n, emitMaterialRef(n, k));
                out.push('');
                emitted.entities++;
                emitted.meshEntities++;
                emitted.resolvedMeshes++;
                emitted.materialParts++;
            }
        }
        for (const c of n.children) emitNode(c, eid);
    };
    const emitMeshCommon = (n, hidden) => {
        out.push(`MeshRenderer.renderLayerMask = 1`);
        out.push(`MeshRenderer.castShadows = ${n.castShadows ? 'true' : 'false'}`);
        out.push(`MeshRenderer.receiveShadows = ${n.receiveShadows ? 'true' : 'false'}`);
        if (!n.rendererEnabled || hidden) out.push(`MeshRenderer.enabled = false`);
    };
    // Bind the .material generated from the Unity material at submesh slot `slot`.
    // Emitted before the render flags so the canonical `material` property is
    // grouped with meshAsset/meshName. Path-form ref: SceneIO derives the guid
    // from the authored path (the freshly generated asset is not yet scanned).
    // Returns true when the slot's Unity material is a hideMesh family (sky FX
    // the engine owns, or unmappable FX whose FBX-default render is garbage) —
    // the caller then disables the renderer instead of drawing a wrong mesh.
    const emitMaterialRef = (n, slot) => {
        const ug = remapPropWaterSubmesh(n, n.matGuids[slot]);
        if (!ug) return false;
        const m = resolveMaterial(ctx, ug);
        if (m) {
            out.push(`MeshRenderer.material = [path="${m.path}" guid="${m.guid}"]`);
            emitted.materialsBound++;
        }
        const hidden = ctx.matHide.has(ug);
        if (hidden) emitted.hiddenSkyFx++;
        return hidden;
    };

    for (const r of st.rootIds) emitNode(r, null);

    // Ambient/sky: this engine has NO flat ambient — all ambient light is
    // sky-derived IBL irradiance, and the sky only exists via a SkyEnvironment
    // component (see the editor's SeedDefaultSceneEntities). Unity scenes get
    // their fill light from skybox ambient GI, so a converted scene without
    // this entity renders shadowed surfaces pitch black. Emit the default-
    // scene environment pair: a SkyEnvironment linked to the converted sun
    // (TimeOfDayDrivesSunLight=false so the sky follows the AUTHORED sun
    // instead of rotating it to noon) + a global ACES tonemap volume.
    if (emitted.sunEntityId) {
        out.push(`[entity id="e_${++idCounter}"]`);
        out.push(`Name.value = "Sky Environment"`);
        out.push(`Transform.position = (0, 0, 0)`);
        out.push(`Transform.rotation = (0, 0, 0, 1)`);
        out.push(`Transform.scale = (1, 1, 1)`);
        out.push(`SkyEnvironment.SunLight = "${emitted.sunEntityId}"`);
        out.push(`SkyEnvironment.TimeOfDayDrivesSunLight = false`);
        out.push(...emitAmbientLightLines(ctx.renderSettings, ctx.verbose));
        // Night sky/IBL trim used to be emitted here (SkyExposureTrim = 2,
        // IblIntensity = 0.4). Removed: dimming the sky/IBL is pixel-inert under
        // auto-exposure (the meter re-normalizes it) — the lever that survives
        // metering is the negative exposure bias below. Both now stay at their
        // SkyEnvironment defaults (IblIntensity 1.0, SkyExposureTrim 0; see
        // SkyEnvironment.h), giving the moonlit surfaces their full IBL fill,
        // which is what the physical-unit punctual lights are balanced against.
        out.push('');
        out.push(`[entity id="e_${++idCounter}"]`);
        out.push(`Name.value = "Post Process Volume"`);
        out.push(`Transform.position = (0, 0, 0)`);
        out.push(`Transform.rotation = (0, 0, 0, 1)`);
        out.push(`Transform.scale = (1, 1, 1)`);
        out.push(`PostProcessVolume.enabled = true`);
        out.push(`PostProcessVolume.isGlobal = true`);
        // ACES stays — a deliberate divergence. The real demo project
        // tonemaps NEUTRAL via the RP asset's quality-level volume profile
        // (round 3; the pack-only data made it look like mode=None because
        // the scene profile's Tonemapping override is off). Round 2 A/B'd
        // Neutral vs ACES at the night operating point: near-identical.
        out.push(`PostProcessVolume.tonemap = 0`);
        // Night operating-point bias (slice 5b). 5a established that dimming the
        // sky/IBL/moon is pixel-inert under auto-exposure (the meter re-normalizes
        // it away) and that SkyExposureTrim +2 is the clamp ceiling but still leaves
        // night reading washed-out. The lever that survives metering is a NEGATIVE
        // exposure compensation: it folds into the auto-exposure key
        // (RenderExtractionSystem::applyCameraExposure), lowering the metered
        // operating point so the whole frame resolves darker instead of being
        // gained back up. This is a physical pipeline term (EV stops); the artistic
        // license is the value. Emitted as an ExposureAdjustmentEffect on the global
        // volume so it also drives camera-less views (the editor Scene View).
        // Unity's ColorAdjustments postExposure (EV) folds into the same
        // compensation term — both are photographic stops on the metered key.
        const vol = ctx.volumeOverrides || {};
        const colAdj = (vol.ColorAdjustments && vol.ColorAdjustments.active) ? vol.ColorAdjustments : null;
        const colAdjPostExposureEv = (colAdj && typeof colAdj.postExposure === 'number') ? colAdj.postExposure : 0;
        if (ctx.renderSettings && ctx.renderSettings.isNight) {
            // Night scenes span an extreme dynamic range: dim moonlit surfaces + a near-black
            // sky + a few bright torch/window emissives + the authored purple ambient wash.
            // Auto-exposure meters the whole frame, so the operating point SWINGS with camera
            // framing -- wide vantages that see more dark sky drive the gain to the MinEv floor
            // and blow the lit surfaces and the purple ambient to WHITE; tighter framings crush
            // to black. A negative ExposureCompensation shifts the metering key (it IS effective
            // -- the histogram meters un-exposed luminance, so a key shift lowers the whole frame
            // persistently), but it does NOT remove the framing swing, so the wash returns at
            // other vantages. The lever that removes the camera dependence is PINNING the adapted
            // EV: ClampMin == ClampMax collapses the adaptation envelope to a single EV (see
            // ExposureAdjustmentEffect.h). Cross-lane verified: a pinned night EV reads correctly
            // at all distances where Auto blew out, and the purple ambient survives at every vantage.
            //
            // Art-tunable per scene (the pipeline term is physical EV stops; the value is license):
            // brighter night scenes (snow/ice) read well near 8; darker forest interiors near 6.5-7.
            // 7.5 is the balanced default. Unity's ColorAdjustments.postExposure (a brighten in
            // stops) folds into the pin as a lower EV so the authored intent survives -- once
            // min == max the compensation term itself is clamped out.
            const kNightPinnedEv100 = 7.5;
            const pinnedEv = kNightPinnedEv100 - colAdjPostExposureEv;
            out.push(`ExposureAdjustmentEffect.enabled = true`);
            out.push(`ExposureAdjustmentEffect.clampMin = true`);
            out.push(`ExposureAdjustmentEffect.minEv = ${fmtF(pinnedEv)}`);
            out.push(`ExposureAdjustmentEffect.clampMax = true`);
            out.push(`ExposureAdjustmentEffect.maxEv = ${fmtF(pinnedEv)}`);
        } else if (colAdjPostExposureEv !== 0) {
            // Day scenes keep auto-exposure; carry Unity's ColorAdjustments.postExposure as a
            // metering-key compensation (photographic stops on the metered operating point).
            out.push(`ExposureAdjustmentEffect.enabled = true`);
            out.push(`ExposureAdjustmentEffect.compensation = ${fmtF(colAdjPostExposureEv)}`);
        }
        // URP Bloom -> BloomEffect. Both apply after exposure / before
        // tonemap on scene-linear HDR (URP: LDR white = 1.0; engine: 203-nit
        // paperwhite = 1.0), so intensity carries over directly. Threshold
        // does NOT carry raw: URP stores it as a GAMMA-space number and
        // converts at dispatch (BloomPostProcessPass.cs: `threshold =
        // Mathf.GammaToLinearSpace(bloom.threshold.value)`; knee hardcoded
        // 0.5*threshold, both linear). Round 2 carried the gamma number
        // straight into the engine's linear threshold — 0.8 gamma is 0.604
        // linear, so our bloom started ~32% too high and read tighter/dimmer
        // than theirs. Convert first, then mirror the knee.
        // URP `scatter` (upsample mip blend = lerp(0.05, 0.95, scatter)) maps
        // 1:1 to BloomEffect.Scatter, which IS the engine's dual-filter upsample
        // blend (default 0.5 = the old fixed pyramid). Emit the URP-mapped blend
        // so the halo width matches Unity (their scatter 1.0 -> 0.95, URP default
        // 0.7 -> 0.68). Lens dirt is a non-physical smudge overlay, skipped.
        const bloom = (vol.Bloom && vol.Bloom.active) ? vol.Bloom : null;
        if (bloom && (bloom.intensity || 0) > 0) {
            const kUrpBloomDefaultThreshold = 0.9;
            const kUrpBloomDefaultScatter = 0.7;
            const thrGamma = typeof bloom.threshold === 'number' ? bloom.threshold : kUrpBloomDefaultThreshold;
            const thr = srgbToLinear(thrGamma);
            const scatter = typeof bloom.scatter === 'number' ? bloom.scatter : kUrpBloomDefaultScatter;
            out.push(`BloomEffect.enabled = true`);
            out.push(`BloomEffect.threshold = ${fmtF(thr)}`);
            out.push(`BloomEffect.knee = ${fmtF(0.5 * thr)}`);
            out.push(`BloomEffect.intensity = ${fmtF(bloom.intensity)}`);
            out.push(`BloomEffect.strength = 1`);
            out.push(`BloomEffect.scatter = ${fmtF(0.05 + 0.9 * scatter)}`);
            if (bloom.dirtIntensity)
                warn(`volume Bloom lens-dirt (intensity ${bloom.dirtIntensity}) not translated (non-physical overlay; URP adds dirtTex * intensity * bloom on top of the bloom term)`, ctx.verbose);
        }
        // Unity colour grade -> the slice-1 native ColorGradeEffect (unified
        // three-way log corrector). ShadowsMidtonesHighlights and LiftGammaGain
        // map to the three bands (below); ColorAdjustments contrast/saturation map
        // to the global knobs. All emit into ONE ColorGradeEffect block.
        const cgLines = [];

        // SMH / LGG -> native bands (preferred). The legacy tonemap-coupled .cube
        // LUT bake is kept as an opt-in fallback (--grade-lut) for one release of
        // A/B before deletion, per the color-grading design (D4/D6).
        const smh = (vol.ShadowsMidtonesHighlights && vol.ShadowsMidtonesHighlights.active)
            ? vol.ShadowsMidtonesHighlights : null;
        const smhLive = smh && [smh.shadows, smh.midtones, smh.highlights].some(w => Array.isArray(w) && !isIdentityWheel(w));
        const lgg = (vol.LiftGammaGain && vol.LiftGammaGain.active) ? vol.LiftGammaGain : null;
        const lggLive = lgg && [lgg.lift, lgg.gamma, lgg.gain].some(w => Array.isArray(w) && !isIdentityWheel(w));

        if (ctx.gradeLutFallback && smhLive && ctx.projectDir) {
            // Opt-in legacy path: bake SMH to a Resolve-style .cube (see
            // bakeSmhCubeLut). ASSET-ROOT-relative name: SceneIO resolves relative
            // lutAsset paths against <project>/assets, so "assets/x.cube" would
            // double to <project>/assets/assets/x.cube and fail GUID resolution.
            const lutName = `${sceneName}_smh_lut.cube`;
            bakeSmhCubeLut(smh, path.join(ctx.projectDir, 'assets', lutName));
            out.push(`CubeLutEffect.enabled = true`);
            out.push(`CubeLutEffect.stackOrder = 0`);
            out.push(`CubeLutEffect.intensity = 1`);
            out.push(`CubeLutEffect.inputEncoding = 0`);
            out.push(`CubeLutEffect.lutAsset = [path="${lutName}" guid=""]`);
            warn(`volume ShadowsMidtonesHighlights baked to assets/${lutName} (--grade-lut legacy path)`, ctx.verbose);
            if (lggLive)
                noteDropped('volume grade', 'LiftGammaGain (native-band mapping disabled by --grade-lut; the LUT fallback bakes SMH only)', ctx.verbose);
        } else {
            // Native three-way bands. Unlike the LUT bake these need no --project
            // dir (no file is written), so SMH/LGG now carry for pkg-only runs too.
            let bands = null;
            if (smhLive) bands = smhToBands(smh);
            if (lggLive) bands = bands ? addBands(bands, lggToBands(lgg)) : lggToBands(lgg);
            if (bands && !bandsAreNeutral(bands)) {
                cgLines.push(...emitColorGradeBandLines(bands));
                warn(`volume grade: ${[smhLive && 'ShadowsMidtonesHighlights', lggLive && 'LiftGammaGain'].filter(Boolean).join(' + ')} -> native ColorGradeEffect three-way bands`, ctx.verbose);
            }
        }

        // ColorAdjustments contrast/saturation are percentage offsets (-100..100
        // around 0); ColorGradeEffect uses multipliers around 1, both graded in HDR
        // before the tonemap. Saturation carries 1:1 (luma-weighted lerp in both).
        // Contrast now carries the FULL percentage: slice 1 grades contrast in LOG
        // space around encoded mid-grey (kPivot = EncodeGradeLog(0.18) = 0.4136 =
        // ACEScc mid-grey), the SAME space and pivot URP uses (contrast = 1 +
        // pct/100). The old converter HALVED it (/200) to compensate for the
        // then-linear ColorGradeEffect pivot (linear-around-0.5 crushed scene-
        // referred shadows ~2x too hard); the log-space unification removes that
        // mismatch, so the /200 workaround is retired -> /100 (exact URP match).
        if (colAdj) {
            if (typeof colAdj.contrast === 'number' && colAdj.contrast !== 0)
                cgLines.push(`ColorGradeEffect.contrast = ${fmtF(1 + colAdj.contrast / 100)}`);
            if (typeof colAdj.saturation === 'number' && colAdj.saturation !== 0)
                cgLines.push(`ColorGradeEffect.saturation = ${fmtF(1 + colAdj.saturation / 100)}`);
        }

        if (cgLines.length) {
            out.push(`ColorGradeEffect.enabled = true`);
            // Grade in log (slice-1 default) — matches Unity's ACEScc log grading.
            out.push(`ColorGradeEffect.gradeInLog = true`);
            out.push(...cgLines);
        }

        // ColorAdjustments Hue Shift no longer maps: the unified ColorGradeEffect
        // dropped the single-range Hue field (the new schema consume-DROPS a stray
        // `hue` key), and hue rotation is a later grade slice. Report it honestly
        // rather than emit a key the schema silently swallows.
        if (colAdj && typeof colAdj.hueShift === 'number' && colAdj.hueShift !== 0)
            noteDropped('volume grade', 'ColorAdjustments.hueShift (unified ColorGradeEffect has no hue channel yet — deferred to a later grade slice)', ctx.verbose);
        // URP SSAO renderer feature (--unity-project) -> engine GTAO.
        // URP: ao = pow(saturate(occ * Intensity * falloff * rcpSamples), 0.6)
        // — Intensity scales the occlusion amount ~linearly below saturation.
        // Engine GTAO Intensity is a pow() on visibility (1 = physical); for
        // shallow occlusion v^k ≈ 1 - k(1-v), the same first-order weakening,
        // so Intensity and Radius carry 1:1 (radius is world-space metres in
        // both). DirectLightingStrength has no engine analog (GTAO gates
        // ambient only) — skipped. Without this the converted scene runs NO
        // AO at all (engine AOIntensity defaults to 0 = node disabled) while
        // the Unity demo renders with SSAO on.
        const ssao = ctx.projectPipeline && ctx.projectPipeline.ssao;
        if (ssao && ssao.enabled && (ssao.intensity || 0) > 0) {
            out.push(`AmbientOcclusionEffect.enabled = true`);
            out.push(`AmbientOcclusionEffect.intensity = ${fmtF(ssao.intensity)}`);
            if (typeof ssao.radius === 'number')
                out.push(`AmbientOcclusionEffect.radius = ${fmtF(ssao.radius)}`);
        }
        // (ShadowsMidtonesHighlights / LiftGammaGain are mapped to native
        // ColorGradeEffect bands in the unified colour-grade block above.)
        // URP Vignette -> VignetteEffect (LDR stack, post-tonemap, same slot as
        // URP's uber-post). The engine shader is URP-exact:
        // color *= lerp(vigColor, 1, pow(saturate(1 - dot(d,d)), smoothness*5)),
        // d = |uv-center| * intensity*3, d.x *= rounded ? aspect : 1. Their value
        // is intensity 0.2 / smoothness 0.2 / black -> gentle 12%-corner framing.
        const vig = (vol.Vignette && vol.Vignette.active) ? vol.Vignette : null;
        if (vig && (vig.intensity || 0) > 0) {
            out.push(`VignetteEffect.enabled = true`);
            out.push(`VignetteEffect.intensity = ${fmtF(vig.intensity)}`);
            out.push(`VignetteEffect.smoothness = ${fmtF(typeof vig.smoothness === 'number' ? vig.smoothness : 0.2)}`);
            if (vig.rounded)
                out.push(`VignetteEffect.rounded = true`);
            // URP vignette color defaults to black (the neutral darkening); emit only when authored.
            if (Array.isArray(vig.color) && (vig.color[0] > 0 || vig.color[1] > 0 || vig.color[2] > 0)) {
                out.push(`VignetteEffect.colorR = ${fmtF(vig.color[0])}`);
                out.push(`VignetteEffect.colorG = ${fmtF(vig.color[1])}`);
                out.push(`VignetteEffect.colorB = ${fmtF(vig.color[2])}`);
            }
        }
        // URP ChromaticAberration -> ChromaticAberrationEffect (LDR stack, same
        // slot as URP's uber-post lens pass). Unity's `intensity` is a normalized
        // [0,1] ClampedFloatParameter whose screen offset is resolution-RELATIVE
        // (URP spreads samples by intensity * 0.05 of screen width); the engine's
        // Intensity is the max red/blue separation in ABSOLUTE pixels, clamped
        // [0, kIntensityMax]. There is no unit-exact conversion without assuming a
        // target resolution, so map the normalized range onto the engine's full
        // pixel range (off->off, max->max, linear between): faithful in intent and
        // proportion. The exact pixel scale is an A/B-calibration refinement
        // (converter-improvement-plan) — the shipped Synty packs author no CA, so
        // this path is inert for them. Only emit when actually authored.
        const kEngineCaIntensityMax = 12; // ChromaticAberrationEffect::kIntensityMax
        const ca = (vol.ChromaticAberration && vol.ChromaticAberration.active) ? vol.ChromaticAberration : null;
        if (ca && typeof ca.intensity === 'number' && ca.intensity > 0) {
            const px = Math.min(kEngineCaIntensityMax, Math.max(0, ca.intensity * kEngineCaIntensityMax));
            out.push(`ChromaticAberrationEffect.enabled = true`);
            out.push(`ChromaticAberrationEffect.intensity = ${fmtF(px)}`);
        }
        // Honest drop reporting. Everything above is what the converter KNOWS how
        // to translate; anything else the user authored in the volume is dropped.
        // Enumerate every parsed override (parseVolumeProfile keeps only fields the
        // user explicitly set, m_OverrideState=1) and record the ones with no
        // engine mapping so the final report can list what didn't carry over.
        // Keyed off the actual profile contents, not a hand-maintained deny-list,
        // so a newly-authored SplitToning/ChannelMixer/ColorCurves is never
        // silently swallowed the way the old fixed list swallowed everything but
        // three names.
        const kTranslatedVolumeComponents = new Set([
            'ColorAdjustments',            // postExposure/contrast/saturation (hueShift reported below)
            'Bloom', 'Vignette', 'ChromaticAberration',
            'ShadowsMidtonesHighlights',   // -> native ColorGradeEffect bands (or --grade-lut .cube fallback)
            'LiftGammaGain',               // -> native ColorGradeEffect bands via ASC CDL
            'Tonemapping',                 // deliberately substituted with ACES (documented divergence)
        ]);
        const componentHasEffect = (comp) => Object.entries(comp).some(([k, v]) => k !== 'active'
            && (Array.isArray(v) ? !isIdentityWheel(v)
                : typeof v === 'number' ? v !== 0
                : typeof v === 'string' ? v.length > 0 : false));
        for (const [name, comp] of Object.entries(vol)) {
            if (!comp || !comp.active || kTranslatedVolumeComponents.has(name)) continue;
            if (componentHasEffect(comp))
                noteDropped('volume grade', `${name} (authored override, no engine mapping yet)`, ctx.verbose);
        }
        // Sub-settings of components we translate only partially. ColorAdjustments'
        // Color Filter is an HDR pre-tonemap tint multiply; the engine has a
        // ColorFilterEffect but it sits in the LDR (post-tonemap) stack, so the
        // faithful placement is a judgment call spec'd in the plan — report it as
        // dropped rather than emit a mis-placed tint.
        if (colAdj && Array.isArray(colAdj.colorFilter) && !isIdentityWheel(colAdj.colorFilter))
            noteDropped('volume grade', 'ColorAdjustments.colorFilter (HDR tint; ColorFilterEffect is LDR-stack — placement TBD)', ctx.verbose);
        if (bloom && Array.isArray(bloom.tint) && !isIdentityWheel(bloom.tint))
            noteDropped('volume grade', 'Bloom.tint (colored bloom; BloomEffect has no tint channel yet)', ctx.verbose);
        // Distance fog (slice 5b). Unity's linear distance fog -> the engine's
        // analytical HeightFogEffect, DISTANCE term only. Unity linear fog has no
        // height or sun-scatter component, so we emit neither (the ambient fill
        // stays sky-IBL + exposure — never a flat fog/ambient term). MinDistance =
        // Unity fogStart keeps the near field untouched; the ramp smooths across
        // [fogStart, fogEnd]; Emissive carries Unity's authored fog colour verbatim
        // (a render-setting colour, linear like the light/ambient colours read
        // above). Amplitude (intensity/density/opacity) uses the engine's shipped
        // Night-fog values so the haze reads as mood, not a wash. Emitted only when
        // Unity fog is on (ER yes; AE no -> no fog, the control).
        const rsFog = ctx.renderSettings;
        if (rsFog && rsFog.fogEnabled && rsFog.fogColor) {
            const near = Math.max(0, rsFog.fogStart);
            // Linear mode carries start/end directly; exp/exp-squared modes have no
            // range, so approximate one from density (~3 optical depths) to keep the
            // mood translating. ER is Linear (mode 1).
            const far = rsFog.fogMode === 1
                ? Math.max(near + 1, rsFog.fogEnd)
                : Math.max(near + 1, 3.0 / Math.max(rsFog.fogDensity, 1e-4));
            // A SHORT onset (a fraction of the span) keeps the optical-depth ramp
            // roughly linear from fogStart->fogEnd, matching Unity's linear fog; a
            // long smoothLength (== the full span) dumps the whole cubic ease-in near
            // the far plane and reads as almost no haze until the horizon.
            const onset = Math.max(10, (far - near) / 8);
            out.push(`HeightFogEffect.enabled = true`);
            out.push(`HeightFogEffect.distanceFogEnabled = true`);
            out.push(`HeightFogEffect.heightFogEnabled = false`);
            out.push(`HeightFogEffect.minDistance = ${fmtF(near)}`);
            out.push(`HeightFogEffect.smoothLength = ${fmtF(onset)}`);
            out.push(`HeightFogEffect.maxDistance = ${fmtF(far)}`);
            // density/intensity/maxOpacity chosen (warehouse A/B) so the haze reaches
            // its ~half-max cap around Unity's fogEnd — mirroring Unity's "fully
            // fogged by fogEnd" intent while the cap stops it washing the frame.
            out.push(`HeightFogEffect.intensity = 0.8`);
            out.push(`HeightFogEffect.density = 0.5`);
            out.push(`HeightFogEffect.maxOpacity = 0.5`);
            out.push(`HeightFogEffect.emissive = ${fmt3(rsFog.fogColor)}`);
            out.push(`HeightFogEffect.gradientMode = 0`);
            out.push(`HeightFogEffect.trackDirectionalLight = false`);
            out.push(`HeightFogEffect.noiseEnabled = false`);
            out.push(`HeightFogEffect.skyEnabled = false`);
            out.push(`HeightFogEffect.useTimeOfDay = false`);
        }
        // URP shadow distance -> ShadowSettingsEffect on the global volume. This is a
        // per-world override of the ShadowMap render node's blueprint: it drives the
        // directional cascade fit for the whole scene (and camera-less views like the
        // editor Scene View). Only MaxShadowDistance maps 1:1 from Unity — it's in
        // world meters, same as ours. ER's value is 50m vs the engine blueprint's 200m:
        // a deliberate look lever (sharper near shadows + a large GPU saving from
        // tighter cascades).
        //
        // Cascade SPLITS: Unity authors 3 explicit split distances (ER: 6.15/14.63/26.8
        // at 50m). Our engine partitions with a single split-lambda blend between
        // uniform (0) and logarithmic (1). Least-squares fitting lambda to ER's splits
        // lands at ~0.38 (raw 0.01 scene-view near) .. ~0.52 (SDSM-tightened near);
        // 0.45 is the representative compromise (per-split residual < ~1.4m). We do NOT
        // reproduce the 3 splits exactly — that needs explicit-split support in
        // ComputeSplits, out of scope here.
        //
        // BIASES: Unity's depth/normal bias are in shadow-map TEXEL / slope units, NOT
        // transferable to ours (DepthBias is an NDC receiver offset; NormalBias is a
        // world-space normal offset). So we DON'T copy Unity's 0.1/0.5 raw — we keep the
        // engine's proven ER values (the current ForwardPlus .rendergraph baseline:
        // depthBias 0.0001 NDC, normalBias 0.5 world).
        {
            const kErShadowDistanceM = 50;   // ER m_ShadowDistance fallback when no --unity-project
            const kShadowSplitLambda = 0.45; // closest single-lambda fit to ER's explicit splits
            const kShadowDepthBias = 0.0001; // engine NDC receiver bias (proven ER value)
            const kShadowNormalBias = 0.5;   // engine world-space normal offset (proven ER value)
            const rpShadowDist = (ctx.projectPipeline && ctx.projectPipeline.rpFacts
                && typeof ctx.projectPipeline.rpFacts.shadowDistance === 'number')
                ? ctx.projectPipeline.rpFacts.shadowDistance : null;
            const maxShadowDistance = (rpShadowDist && rpShadowDist > 0) ? rpShadowDist : kErShadowDistanceM;
            out.push(`ShadowSettingsEffect.enabled = true`);
            out.push(`ShadowSettingsEffect.maxShadowDistance = ${fmtF(maxShadowDistance)}`);
            out.push(`ShadowSettingsEffect.splitLambda = ${fmtF(kShadowSplitLambda)}`);
            out.push(`ShadowSettingsEffect.depthBias = ${fmtF(kShadowDepthBias)}`);
            out.push(`ShadowSettingsEffect.normalBias = ${fmtF(kShadowNormalBias)}`);
        }
        out.push('');
        emitted.entities += 2;
        emitted.environment = true;
    }

    // Faithful Unity skybox: RenderSettings.m_SkyboxMaterial (builtin
    // Skybox/Cubemap) -> equirect HDRI on Components::Skybox. A valid Skybox
    // takes priority over SkyEnvironment in SkyEnvironmentSystem and drives
    // dome + IBL; the SkyEnvironment entity above stays as the sun link and
    // the fail-visible fallback (HDRI missing/unimported -> procedural sky,
    // never a black dome). Ambient remains the AmbientLight trilight floor:
    // Unity ambientMode 1 means the skybox did not feed ambient GI there
    // either, and the starfield's own IBL contribution is ~0 — consistent.
    // Emitted OUTSIDE the sun guard: a sunless scene still gets its sky.
    const skyboxRef = resolveSceneSkybox(ctx);
    if (skyboxRef) {
        out.push(`[entity id="e_${++idCounter}"]`);
        out.push(`Name.value = "Skybox (Unity)"`);
        out.push(`Transform.position = (0, 0, 0)`);
        out.push(`Transform.rotation = (0, 0, 0, 1)`);
        out.push(`Transform.scale = (1, 1, 1)`);
        out.push(`Skybox.Enabled = true`);
        out.push(`Skybox.HDRIIntensity = 1`); // Unity tint*colorspace*exposure baked into the .hdr
        out.push(`Skybox.IblIntensity = 1`);
        out.push(`Skybox.IblLowerHemisphereDarkness = 0`);
        out.push(`Skybox.RotationDegrees = ${fmtF(skyboxRef.rotationDegrees)}`);
        out.push(`Skybox.HDRI = [path="${skyboxRef.relPath}" guid="${skyboxRef.guid}"]`);
        out.push('');
        emitted.entities += 1;
        emitted.skybox = skyboxRef;
    }
    return { text: out.join('\n') + '\n', emitted };
}

function fbxStem(ctx, unityGuid) {
    const e = ctx.pkg.get(unityGuid);
    return e ? path.basename(e.assetPath, path.extname(e.assetPath)) : unityGuid;
}

const meshRefCache = new Map();
function resolveMeshAsset(ctx, unityFbxGuid) {
    if (meshRefCache.has(unityFbxGuid)) return meshRefCache.get(unityFbxGuid);
    let ref = null;
    if (ctx.assetDb) {
        const stem = fbxStem(ctx, unityFbxGuid).toLowerCase();
        const candidates = ctx.assetDb.byStem.get(stem) || [];
        if (candidates.length > 0) {
            // Prefer shortest path on ambiguity (top-level import over copies).
            const best = [...candidates].sort((a, b) => a.path.length - b.path.length)[0];
            if (candidates.length > 1)
                warn(`ambiguous stem '${stem}': ${candidates.length} assetdb entries; using ${best.path}`, ctx.verbose);
            ref = { guid: best.guid, path: relativizeToProject(ctx, best.path) };
        }
    }
    meshRefCache.set(unityFbxGuid, ref);
    return ref;
}

function relativizeToProject(ctx, p) {
    const norm = p.replace(/\\/g, '/');
    if (!ctx.projectDir) return norm;
    const proj = ctx.projectDir.replace(/\\/g, '/').replace(/\/+$/, '') + '/';
    if (norm.toLowerCase().startsWith(proj.toLowerCase()))
        return norm.slice(proj.length);
    return norm;
}

// ----------------------------------------------------- materials -----------
// Unity .mat -> engine .material. The FBX-embedded materials carry DEAD source
// texture paths, so every FBX material renders textureless flat base-color;
// the REAL shipped textures + cutout/blend flags + tints + emission live in the
// .mat files. We parse them and emit engine StandardPBR .material assets that
// bind the already-imported project textures (resolved by filename stem, like
// meshes). Shader family is irrelevant to us — we read the m_SavedProperties
// (texture slots, colors, floats, keywords) and map onto standard_pbr.

const kMatOutRel = 'Materials_Unity';
const kTexCopyRel = 'Textures_Unity';
const kEmissionPaperwhiteNits = 203; // engine: 203 nits == scene-linear 1.0

// Deterministic GUID (8-4-4-4-12) from a seed string. The scene material ref
// resolves by PATH (SceneIO cross-project recovery derives the canonical guid
// from the authored path); this guid is only a stable, self-consistent hint.
function deterministicGuid(seed) {
    const prime = 1099511628211n, mask = (1n << 64n) - 1n;
    let a = 14695981039346656037n, b = 1099511628211n;
    for (let i = 0; i < seed.length; i++) {
        const c = BigInt(seed.charCodeAt(i));
        a = ((a ^ c) * prime) & mask;
        b = ((b ^ (c * 3n + 7n)) * prime) & mask;
    }
    const hex = a.toString(16).padStart(16, '0') + b.toString(16).padStart(16, '0');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

const sanitizeFileName = (s) => (s || 'Material').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'Material';

// Parse the m_SavedProperties of a Unity material YAML into a plain struct.
function parseUnityMat(text) {
    if (!/m_SavedProperties:/.test(text)) return null;
    const info = { shaderGuid: null, keywords: new Set(), renderType: '', texEnvs: {}, floats: {}, colors: {} };
    const sh = text.match(/m_Shader:\s*\{fileID:\s*[-\d]+,\s*guid:\s*([0-9a-fA-F]{32})/);
    if (sh) info.shaderGuid = sh[1].toLowerCase();
    const kw = text.match(/m_ValidKeywords:\s*([\s\S]*?)\n\s*m_InvalidKeywords:/);
    if (kw) for (const m of kw[1].matchAll(/-\s*(\w+)/g)) info.keywords.add(m[1]);
    const rt = text.match(/RenderType:\s*(\w+)/);
    if (rt) info.renderType = rt[1];
    const texBlock = text.match(/m_TexEnvs:\s*([\s\S]*?)\n\s*m_Ints:/);
    if (texBlock) {
        const re = /-\s*(\w+):\s*\n\s*m_Texture:\s*\{fileID:\s*(\d+)(?:,\s*guid:\s*([0-9a-f]{32}))?/g;
        let m; while ((m = re.exec(texBlock[1]))) if (m[3]) info.texEnvs[m[1]] = m[3];
    }
    for (const m of text.matchAll(/-\s*(_\w+):\s*([-0-9.eE]+)\s*$/gm)) info.floats[m[1]] = parseFloat(m[2]);
    for (const m of text.matchAll(/-\s*(_\w+):\s*\{r:\s*([-0-9.eE]+),\s*g:\s*([-0-9.eE]+),\s*b:\s*([-0-9.eE]+),\s*a:\s*([-0-9.eE]+)\}/g))
        info.colors[m[1]] = [+m[2], +m[3], +m[4], +m[5]];
    return info;
}

// Locate the TextureCompiler CLI (PNG/TGA -> UASTC KTX2 encoder, built by the
// engine's BUILD_TOOLS). Search order: explicit --texc, GE_TEXC env var, then
// engine build trees under the current working directory (covers running the
// converter from an engine repo checkout).
function findTexc(explicit) {
    const candidates = [];
    if (explicit) candidates.push(explicit);
    if (process.env.GE_TEXC) candidates.push(process.env.GE_TEXC);
    for (const preset of ['vs2026-x64-local', 'vs2026-x64-local-unity', 'vs2022-x64-local']) {
        for (const config of ['DebugFast', 'Release', 'RelWithDebInfo', 'Debug']) {
            candidates.push(path.join(process.cwd(), 'build', preset, 'bin', config, 'Tools', 'TextureCompiler.exe'));
        }
    }
    for (const c of candidates) {
        try { if (fs.existsSync(c)) return c; } catch { /* keep probing */ }
    }
    return null;
}

// Encode `sourceAbs` to `<texCopyDir>/<destName>` with slot-appropriate flags.
// kind: 'color' (sRGB), 'linear' (masks/MR/AO), 'normal' (linear + per-mip
// renormalize). Returns true on success.
function encodeKtx2(ctx, sourceAbs, dest, kind) {
    const flags = kind === 'normal' ? ['--normal-map']
        : kind === 'linear' ? ['--linear']
        : ['--srgb'];
    const r = spawnSync(ctx.texc, [sourceAbs, dest, ...flags], { stdio: ['ignore', 'ignore', 'pipe'] });
    if (r.status !== 0) {
        const err = (r.stderr ? r.stderr.toString() : '').trim().split('\n')[0] || `exit ${r.status}`;
        warn(`ktx2 encode failed for ${sourceAbs}: ${err}`, ctx.verbose);
        return false;
    }
    return true;
}

const texRefCache = new Map();
function resolveTexture(ctx, unityTexGuid, texKind) {
    if (!unityTexGuid || !ctx.assetDb) return null;
    const kind = texKind || 'color';
    const cacheKey = ctx.texc ? `${unityTexGuid}|${kind}` : unityTexGuid;
    if (texRefCache.has(cacheKey)) return texRefCache.get(cacheKey);
    let ref = null;
    const e = ctx.pkg.get(unityTexGuid.toLowerCase());
    if (e) {
        const stem = path.basename(e.assetPath, path.extname(e.assetPath)).toLowerCase();
        let candidates = ctx.assetDb.texByStem.get(stem) || [];
        if (candidates.length === 0)
            candidates = ctx.assetDb.texByNormStem.get(stem.replace(/[^a-z0-9]/g, '')) || [];

        let best = null;
        if (candidates.length > 0) {
            best = [...candidates].sort((a, b) => a.path.length - b.path.length)[0];
            if (candidates.length > 1)
                warn(`ambiguous texture stem '${stem}': ${candidates.length} entries; using ${best.path}`, ctx.verbose);
        }

        // KTX2 mode: encode into Textures_Unity/ regardless of whether the
        // source is an already-imported project texture or a pack file. The
        // material then references the compressed, pre-mipped container; the
        // original stays untouched. Data slots get a `_linear`/`_normal`
        // suffix so one image bound as both color and data can't collide.
        if (ctx.texc && ctx.texCopyDir) {
            // assetdb texture paths are relative to the project's assets root
            // (e.g. "textures/walls/stucco_brown_01.png"); probe both anchors.
            const projectAbs = (p) => {
                if (path.isAbsolute(p)) return p;
                const underAssets = path.join(ctx.projectDir, 'assets', p);
                return fs.existsSync(underAssets) ? underAssets : path.join(ctx.projectDir, p);
            };
            const sourceAbs = best ? projectAbs(best.path) : path.join(e.dir, 'asset');
            const baseStem = path.basename(e.assetPath, path.extname(e.assetPath));
            const destName = (kind === 'color' ? baseStem : `${baseStem}_${kind}`) + '.ktx2';
            const rel = kTexCopyRel + '/' + destName;
            const dest = path.join(ctx.texCopyDir, destName);
            let ok = fs.existsSync(dest);
            if (!ok) {
                try { ok = encodeKtx2(ctx, sourceAbs, dest, kind); }
                catch (err) { warn(`ktx2 encode threw for ${sourceAbs}: ${err.message}`, ctx.verbose); }
            }
            if (ok) {
                ref = { guid: deterministicGuid(rel), path: rel };
                ctx.matStats.texEncoded++;
                texRefCache.set(cacheKey, ref);
                return ref;
            }
            // Encode failed (unsupported source format etc.) — fall through to
            // the PNG reference/copy behavior below.
        }

        if (best) {
            ref = { guid: best.guid, path: relativizeToProject(ctx, best.path) };
            ctx.matStats.texResolved++;
        } else if (ctx.texCopyDir) {
            // Genuinely not imported into the project (the pack ships more textures
            // than were imported — normal/emissive maps, alt swatches). Copy the
            // pack's source image in so the editor imports it; reference by PATH so
            // TextureService re-derives the guid from the path once scanned.
            const destName = path.basename(e.assetPath);
            const rel = kTexCopyRel + '/' + destName;
            const dest = path.join(ctx.texCopyDir, destName);
            try {
                if (!fs.existsSync(dest)) fs.copyFileSync(path.join(e.dir, 'asset'), dest);
                ref = { guid: deterministicGuid(rel), path: rel };
                ctx.matStats.texCopied++;
            } catch (err) {
                warn(`failed to copy texture ${e.assetPath}: ${err.message}`, ctx.verbose);
                ctx.matStats.texUnresolved++;
            }
        } else {
            warn(`unresolved texture: ${e.assetPath} (stem '${stem}')`, ctx.verbose);
            ctx.matStats.texUnresolved++;
        }
    } else {
        ctx.matStats.texUnresolved++;
    }
    texRefCache.set(cacheKey, ref);
    return ref;
}

// First candidate texEnv slot (Synty custom names + URP fallbacks) that resolves.
function pickTexture(ctx, info, candidates, texKind) {
    for (const key of candidates) {
        const g = info.texEnvs[key];
        if (!g) continue;
        const ref = resolveTexture(ctx, g, texKind);
        if (ref) return ref;
    }
    return null;
}

const round7 = (v) => Math.round(v * 1e7) / 1e7;

// Synty shader-GUID (8-char prefix) -> dispatch classification. Every material in
// both packs is a Synty custom ShaderGraph shader, not stock URP/Lit. The
// workhorse families are functionally URP-Lit PBR surfaces and map faithfully to
// standard_pbr; the FX/particle/sky/triplanar families are degraded to a flat
// standard_pbr map THIS phase (their dedicated surfaces — triplanar_pbr, unlit —
// are later slices) and carry a `note` so the per-scene report is honest about
// the gap rather than silently defaulting. `unmappable` families have no OpenPBR
// analogue at all (auto-generated ShaderGraph node properties): they are detected
// and left at the FBX default instead of emitting a garbage material.
const kShaderDispatch = {
    '0730dae3': { name: 'Generic_Basic',          surface: 'standard_pbr' },
    'baa0a858': { name: 'Generic_Decals',         surface: 'standard_pbr' },
    '3b44a38e': { name: 'Generic_Standard',       surface: 'standard_pbr', note: 'character hair/skin masks dropped' },
    'd79125f9': { name: 'Generic_Basic_Specular', surface: 'standard_pbr', note: 'Bronze/Gold — the only real metals' },
    '19e269a3': { name: 'PolygonShader',          surface: 'triplanar_pbr', note: 'world-space 3-axis projection; snow/emission/overlay deferred' },
    '0736e099': { name: 'Generic_ParticlesUnlit', surface: 'standard_pbr', note: 'unlit deferred' },
    'dfec08fb': { name: 'Generic_ParticlesLit',   surface: 'standard_pbr', note: 'unlit deferred' },
    '00000000': { name: 'Builtin_FX',             surface: 'standard_pbr', note: 'unlit deferred' },
    '88fd8f21': { name: 'Waterfall',              surface: 'water_stylized', note: 'FLOW: panned Color_Mask + Normals ripple + fresnel rim' },
    '87c14512': { name: 'Waterfall_Top_FX',       surface: 'waterfall_fx', note: 'FALLS: panned churn ribbons through the emission lobe (premultiplied blend)' },
    'de1d8687': { name: 'SkyDome',                surface: 'standard_pbr', note: 'engine owns sky — degraded' },
    // hideMesh: the engine's SkyEnvironment already renders a physical moon and
    // night sky, so Unity's hand-placed sky-FX billboards must not ALSO render —
    // a degraded standard_pbr moon card is a giant flat white slab in the sky.
    // The material is still generated and bound (inspectable provenance); only
    // the renderer is disabled. FogDome/SkyDome stays: it is translucent and
    // carries the authored night haze mood.
    'e8644287': { name: 'Moon',                   surface: 'standard_pbr', note: 'engine owns sky — hidden', hideMesh: true },
    '3d532bc2': { name: 'Skybox_Generic',         surface: 'standard_pbr', note: 'engine owns sky — degraded' },
    // Aurora is unmappable (no material emitted), and its curtain meshes render
    // as opaque slabs under the FBX-default material — hide those renderers too.
    '6b091954': { name: 'Aurora',                 surface: 'unmappable',   reason: 'ShaderGraph FX — no OpenPBR analogue', hideMesh: true },
};

// A ShaderGraph shader whose properties are auto-generated node handles
// (_SampleTexture2D_<hash>, or any name carrying a 16+ hex-digit run) cannot be
// scraped into a faithful PBR material — the old converter grabbed such a node's
// internal _Color as if it were the base tint (Aurora shipped baseColor
// [0.227,1,0] opacity 0). Detected here as a fallback safety-net for unknown
// shader GUIDs not in kShaderDispatch.
const kAutoNamedProp = /_SampleTexture2D|_[0-9a-fA-F]{16,}/;
function hasAutoNamedProps(info) {
    for (const k of Object.keys(info.texEnvs)) if (kAutoNamedProp.test(k)) return true;
    for (const k of Object.keys(info.colors)) if (kAutoNamedProp.test(k)) return true;
    for (const k of Object.keys(info.floats)) if (kAutoNamedProp.test(k)) return true;
    return false;
}
function hasRecognizableSlot(info) {
    const t = info.texEnvs;
    return info.colors._BaseColor !== undefined || info.colors._Color !== undefined
        || t._Albedo_Map !== undefined || t._Base_Map !== undefined || t._BaseMap !== undefined
        || t._MainTex !== undefined || info.floats._Metallic !== undefined
        || info.floats._Smoothness !== undefined;
}

// PolygonShader's _Enable_Triplanar_* toggles are ShaderGraph BooleanShaderProperties
// that ALL default OFF in the pack source: PolygonShader.shadergraph (shader GUID
// 19e269a311c45cd4482cf0ac0e694503) serializes m_Value:false for
// _Enable_Triplanar_Texture, _Enable_Triplanar_Normals and _Enable_Triplanar_Emission.
// A .mat that omits the float therefore renders with the toggle DISABLED in Unity, so
// the absent-value fallback here must be 0 - encoded explicitly rather than relying on
// `undefined !== 1` so a future default-on toggle gets a deliberate entry, not a
// silent misroute to flat standard_pbr.
const kTriplanarToggleDefaults = {
    _Enable_Triplanar_Texture: 0,
    _Enable_Triplanar_Normals: 0,
};
function triplanarToggleOn(floats, name) {
    const v = floats[name] !== undefined ? floats[name] : kTriplanarToggleDefaults[name];
    return v === 1;
}

// { family, mappable, note?, reason? }. Known GUIDs win; an unknown GUID whose
// props are all auto-named node handles with nothing recognizable falls back.
function classifyMaterial(info, name) {
    const disp = kShaderDispatch[(info.shaderGuid || '').slice(0, 8)];
    if (disp) {
        if (disp.surface === 'unmappable')
            return { family: disp.name, mappable: false, reason: disp.reason, hideMesh: !!disp.hideMesh };
        // Generic_Basic is a shared super-shader (statues, window glass AND still water
        // bodies all parameterize it — ground truth from the source project). A water
        // body authored on it carries no FLOW-graph GUID (88fd8f21), so it would fall to
        // the flat standard_pbr map and read as a near-black opaque slab (ElvenRealm's
        // Water_01 lowland plane: sRGB baseColor ~0.09 -> near-black, no emission) while
        // its WaterFlow_01 siblings glow. Route Generic_Basic water bodies to the same
        // stylized-water surface by material name. Verified corpus-safe: Water_01 is the
        // ONLY Generic_Basic material named "water*" in either pack (the Glass_* family
        // that shares this GUID never carries a water name).
        if (disp.name === 'Generic_Basic' && /^water/i.test(name || ''))
            return { family: disp.name, mappable: true, surface: 'water_stylized',
                     note: 'Generic_Basic water body -> stylized water' };
        // PolygonShader is a super-shader with a triplanar toggle. Only route to the
        // triplanar front-end when it is actually enabled — otherwise the material uses the
        // regular UV base-map path (e.g. Waterflow_01: _Enable_Triplanar_Texture=0, a water
        // scroll with no triplanar textures) and must fall to the flat standard_pbr map, not
        // render as an empty grey triplanar. Absent toggles resolve to the shader's own
        // defaults (all OFF — see kTriplanarToggleDefaults for the source citation).
        if (disp.surface === 'triplanar_pbr'
            && !triplanarToggleOn(info.floats, '_Enable_Triplanar_Texture')
            && !triplanarToggleOn(info.floats, '_Enable_Triplanar_Normals'))
            return { family: disp.name, mappable: true, surface: 'standard_pbr',
                     note: 'triplanar disabled -> flat base-map map' };
        return { family: disp.name, mappable: true, surface: disp.surface, note: disp.note, hideMesh: !!disp.hideMesh };
    }
    const label = 'Unknown(' + (info.shaderGuid || 'null').slice(0, 8) + ')';
    if (hasAutoNamedProps(info) && !hasRecognizableSlot(info))
        return { family: label, mappable: false, reason: 'auto-named ShaderGraph properties' };
    return { family: label, mappable: true, surface: 'standard_pbr', note: 'unknown shader — blind standard_pbr map' };
}

// Unity's colour picker serialises an LDR swatch as sRGB-encoded floats (proof:
// Synty's {79,65,45}/255 tints round-trip exactly). Our uBaseColor uniform is a
// multiply applied in linear working space with no hardware sRGB decode, so an
// LDR tint must be linearised here or it reads too bright / desaturated against
// Unity. HDR tints (any RGB channel > 1 — e.g. Circle_Material_01=1.844, fire=8)
// are authored directly in linear working space and pass through UNCHANGED.
// Residual ambiguity (accepted, documented): a tint authored as a dim HDR value
// with all channels <= 1 is indistinguishable from an LDR swatch and will be
// linearised. Alpha is opacity (already linear) and is never gamma-mapped.
function srgbToLinear(c) {
    if (c <= 0) return 0;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function linearizeUnityTint(rgba) {
    if (rgba[0] > 1 || rgba[1] > 1 || rgba[2] > 1) return rgba; // HDR: passthrough
    return [srgbToLinear(rgba[0]), srgbToLinear(rgba[1]), srgbToLinear(rgba[2]), rgba[3]];
}

// Build an engine StandardPBR MaterialDocument from parsed Unity .mat props.
// Returns { doc, needsFidelity }: needsFidelity is false for a plain white
// opaque untextured material (no gain over the FBX default; skip to bound the
// blast radius).
function buildMaterialDoc(ctx, info, materialName) {
    const f = info.floats, c = info.colors, kw = info.keywords, rt = info.renderType;
    const doc = {
        schemaVersion: 3,
        materialName,
        lightingModel: 'StandardPBR',
        surfaceShader: 'Surfaces/standard_pbr.glsl',
        // Synty FBX meshes carry baked LayerElementColor vertex colors (e.g. the
        // statue helmet/torso/base "spirit" gradient) that NO Synty shader graph
        // samples — Generic_Basic has no VertexColor node. Our standard_pbr surface
        // multiplies vertexColor into baseColor AND opacity, so mask it off to match
        // Unity (verified: no ': COLOR' semantic in the cached generated sources).
        ignoreVertexColor: true,
    };

    const baseCol = c._BaseColor || c._Color || [1, 1, 1, 1];
    // Explicit authoring wins. URP/ShaderGraph materials carry _Surface (0 = opaque,
    // 1 = transparent) and _AlphaClip; when either is present, the legacy Standard
    // float (_Mode) and the tint's alpha channel are stale corpus noise, not intent.
    // Witness: PolygonElven_Emissive_Fade_01 authors _Surface:0 + _AlphaClip:1 with a
    // 0.07 tint alpha — URP CLIPS it invisible (0.07 < cutoff 0.5 discards every
    // fragment), while the old _Mode:3 / tint-alpha heuristics mis-routed it to Blend
    // (glowing statue-shaped aura columns over the bridge statues). The legacy _Mode
    // branch stays for genuinely legacy built-in shaders (AE Fog_01: no _Surface at
    // all, _Mode:3). Tint alpha alone NEVER forces Blend (#608's water lesson,
    // applied to the generic path).
    const hasUrpAuthoring = f._Surface !== undefined || f._AlphaClip !== undefined;
    const transparent = kw.has('_SURFACE_TYPE_TRANSPARENT') || kw.has('_ALPHABLEND_ON')
        || kw.has('_ALPHAPREMULTIPLY_ON') || kw.has('_BUILTIN_SURFACE_TYPE_TRANSPARENT')
        || f._Surface === 1 || rt === 'Transparent'
        || (!hasUrpAuthoring && f._Mode !== undefined && f._Mode >= 2 && !kw.has('_ALPHATEST_ON'));
    const cutout = kw.has('_ALPHATEST_ON') || kw.has('_BUILTIN_ALPHATEST_ON')
        || rt === 'TransparentCutout' || (f._AlphaClip === 1) || (f._Mode === 1);

    if (transparent) doc.alphaMode = 'Blend';
    else if (cutout) doc.alphaMode = 'Mask';
    else doc.alphaMode = 'Opaque';

    if (f._Cull === 0) doc.doubleSided = true;

    const props = {};
    const tint = linearizeUnityTint(baseCol);
    props.baseColor = [round7(tint[0]), round7(tint[1]), round7(tint[2]), round7(tint[3])];
    if (f._Metallic !== undefined) props.metallic = Math.max(0, Math.min(1, f._Metallic));
    const gloss = f._Smoothness !== undefined ? f._Smoothness
        : (f._Glossiness !== undefined ? f._Glossiness : undefined);
    if (gloss !== undefined) props.roughness = Math.max(0.04, Math.min(1, 1 - gloss));
    if (doc.alphaMode === 'Blend') props.opacity = round7(baseCol[3]);
    if (doc.alphaMode === 'Mask') {
        const cutoff = f._Cutoff !== undefined ? f._Cutoff
            : (f._Alpha_Clip_Threshold !== undefined ? f._Alpha_Clip_Threshold : 0.5);
        props.alphaCutoff = Math.max(0, Math.min(1, cutoff));
    }

    const textures = {};
    let hasTexture = false;
    const albedo = pickTexture(ctx, info, ['_Albedo_Map', '_Base_Map', '_BaseMap', '_MainTex', '_Color_Mask'], 'color');
    if (albedo) { textures.albedoMap = { guid: albedo.guid, path: albedo.path }; hasTexture = true; }
    const normal = pickTexture(ctx, info, ['_Normal_Map', '_Normals', '_BumpMap', '_NormalMap'], 'normal');
    if (normal) { textures.normalMap = { guid: normal.guid, path: normal.path }; hasTexture = true; }
    const mr = pickTexture(ctx, info, ['_MetallicGlossMap', '_SpecGlossMap', '_MetallicRoughnessMap'], 'linear');
    if (mr) { textures.metallicRoughnessMap = { guid: mr.guid, path: mr.path }; hasTexture = true; }
    const ao = pickTexture(ctx, info, ['_OcclusionMap', '_AO_Map'], 'linear');
    if (ao) { textures.aoMap = { guid: ao.guid, path: ao.path }; hasTexture = true; }

    // Emission: engine emissive = (emissiveTex + tint) * (nits / 203). Synty's
    // emission is a masked map modulated by an (often HDR) emission color, so
    // with a map we drive it via the map + a luminance scalar (tint 0) and with
    // no map we use the color directly.
    //
    // The gate must honor the SHADER's own emission switch, not just slot
    // presence. Every emission-capable Synty shadergraph (Generic_Basic,
    // Generic_Standard, Generic_ParticlesLit) routes emission through a
    // `Branch(_Enable_Emission)` node, and the packs ship whole families with
    // a bound emission map and the branch OFF: the WindowGlass materials carry
    // a Moon/Stars starfield in _Emission_Map, and every PolygonElven atlas
    // material carries an *_Emissive atlas — all with _Enable_Emission: 0.
    // Translating those as live emission painted a 203-nit starfield onto
    // every window pane (the round-2 "blue haze"). When the float is absent
    // (URP Lit-style shaders), fall back to the _EMISSION keyword when a map
    // is bound, or an HDR emission color with no map (Gen_FireFrames_01).
    const emCol = c._Emission_Color || c._EmissionColor;
    const emMap = pickTexture(ctx, info, ['_Emission_Map', '_EmissionMap'], 'color');
    const emMax = emCol ? Math.max(emCol[0], emCol[1], emCol[2]) : 0;
    let emissionEnabled = f._Enable_Emission !== undefined
        ? f._Enable_Emission === 1
        : (emMap ? kw.has('_EMISSION') : true);
    // Every Synty graph MULTIPLIES the map by _Emission_Color, so a black
    // color zeroes a bound map even with the branch enabled (Generic_01_A).
    // The engine's additive (tex + tint) form can't express that product;
    // treat map-with-black-color as no emission.
    if (emMap && emMax < 0.004) emissionEnabled = false;
    let hasEmission = false;
    if (emissionEnabled && (emMap || emMax > 1.01)) {
        const lum = kEmissionPaperwhiteNits * Math.max(1, emMax);
        if (emMap) {
            textures.emissiveMap = { guid: emMap.guid, path: emMap.path };
            props.emissive = [0, 0, 0];
            hasTexture = true;
        } else {
            const s = Math.max(1, emMax);
            props.emissive = [round7(emCol[0] / s), round7(emCol[1] / s), round7(emCol[2] / s)];
        }
        props.emissionLuminance = round7(lum);
        hasEmission = true;
    }

    doc.properties = props;
    if (Object.keys(textures).length > 0) doc.textures = textures;

    const baseColorNotWhite = props.baseColor.slice(0, 3).some(v => Math.abs(v - 1) > 0.01);
    const needsFidelity = hasTexture || hasEmission || doc.alphaMode !== 'Opaque' || baseColorNotWhite;
    return { doc, needsFidelity };
}

// Build an engine triplanar_pbr MaterialDocument from a Synty PolygonShader .mat. The
// custom shader becomes a texture-PROJECTION front-end feeding the UNCHANGED OpenPBR BRDF:
// 3-axis albedo + normal in the shared slots (interleaved albedo/normal so the triset-
// collapse fast path is slots 0-1), per-axis world tiling, one axis-blend sharpness, and
// per-axis float metallic/roughness. Snow cap, triplanar emission, and the height/parallax
// overlay are deferred (design §3.1: off in every sampled corpus material). PolygonShader
// materials always carry textures/params, so needsFidelity is always true.
function buildTriplanarDoc(ctx, info, materialName) {
    const f = info.floats, c = info.colors;
    const clamp01 = (v) => Math.max(0, Math.min(1, v));
    const doc = {
        schemaVersion: 3,
        materialName,
        lightingModel: 'StandardPBR',
        surfaceShader: 'Surfaces/triplanar_pbr.glsl',
        // No CONVERTED Synty top-level graph samples vertex color (VertexColorNode
        // exists only in SnowMask.shadersubgraph — referenced by nothing we convert —
        // and the particle graphs, which are not converted); triplanar_pbr multiplies it in.
        ignoreVertexColor: true,
    };

    // Rocks/dirt/cliffs/ground are opaque geometry; the corpus _AlphaClip=1 is a shader
    // default with no cutout intent (the triplanar albedo carries no mask). Force Opaque.
    doc.alphaMode = 'Opaque';
    if (f._Cull === 0) doc.doubleSided = true;

    // PolygonShader gates its triplanar albedo and normal sets with INDEPENDENT toggles
    // (either-on routes here — see classifyMaterial). A set whose toggle is off is not
    // sampled by Unity even when its _Triplanar_* slots carry stale assignments, so it
    // must not be sourced from them here either. Disabled normals fall to the flat
    // default (geometric normal) — the safe read of "triplanar normals off".
    const texturesOn = triplanarToggleOn(f, '_Enable_Triplanar_Texture');
    const normalsOn = triplanarToggleOn(f, '_Enable_Triplanar_Normals');

    // Per-axis albedo + normal texture guids, with graceful fallback when a slot is
    // unassigned (e.g. Bricks_Grey_01 leaves _Triplanar_Texture_Top empty -> use side).
    const albTop = texturesOn ? info.texEnvs._Triplanar_Texture_Top : undefined;
    const albSide = texturesOn ? info.texEnvs._Triplanar_Texture_Side : undefined;
    const albBottom = texturesOn ? info.texEnvs._Triplanar_Texture_Bottom : undefined;
    const nrmTop = normalsOn ? info.texEnvs._Triplanar_Normal_Texture_Top : undefined;
    const nrmSide = normalsOn ? info.texEnvs._Triplanar_Normal_Texture_Side : undefined;
    const nrmBottom = normalsOn ? info.texEnvs._Triplanar_Normal_Texture_Bottom : undefined;

    const aTop = albTop || albSide || albBottom;
    const aSide = albSide || albTop || albBottom;
    const aBottom = albBottom || albSide || albTop;
    const nTop = nrmTop || nrmSide || nrmBottom;
    const nSide = nrmSide || nrmTop || nrmBottom;
    const nBottom = nrmBottom || nrmSide || nrmTop;

    // Albedo and normal layering collapse INDEPENDENTLY (matching the shader's two flag
    // lanes, uParams23.w / uParams24.w). One shared flag was the slot-3 black-default
    // trap: per-axis-different albedo with a uniform (or absent) normal set forced the
    // shader onto the layered normal slots, and unbound slot 3 defaults to BLACK (enum
    // kEmissive), which decodes to a garbage tangent normal on the side projection.
    // Uniform/absent normals therefore stay collapsed on slot 1 (or its flat default)
    // regardless of what the albedo set does, and vice versa.
    const albedoLayered = !(aTop === aSide && aSide === aBottom);
    const normalLayered = !(nTop === nSide && nSide === nBottom);

    const textures = {};
    const bind = (name, unityGuid, texKind) => {
        const ref = unityGuid ? resolveTexture(ctx, unityGuid, texKind) : null;
        if (ref) textures[name] = { guid: ref.guid, path: ref.path };
    };
    bind('triplanarAlbedoTop', aTop, 'color');
    bind('triplanarNormalTop', nTop, 'normal');
    if (albedoLayered) {
        bind('triplanarAlbedoSide', aSide, 'color');
        bind('triplanarAlbedoBottom', aBottom, 'color');
    }
    if (normalLayered) {
        bind('triplanarNormalSide', nSide, 'normal');
        bind('triplanarNormalBottom', nBottom, 'normal');
    }

    // Albedo gap when routed here normals-only (_Enable_Triplanar_Texture=0) or when a
    // toggle-on material assigns no _Triplanar_Texture_* at all: Unity samples the
    // regular UV base map in that configuration, so fall back to it rather than leaving
    // slot 0 at its white default (an all-white rock). The engine front-end has no
    // separate UV path — the base map is world-projected like any collapsed triset —
    // which is the closest faithful read of a single uniform albedo.
    if (!textures.triplanarAlbedoTop) {
        const base = pickTexture(ctx, info, ['_Albedo_Map', '_Base_Map', '_BaseMap', '_MainTex'], 'color');
        if (base) textures.triplanarAlbedoTop = { guid: base.guid, path: base.path };
    }

    // Params. Tiling is world-space UV frequency; the global _Tiling is the side/base, with
    // per-axis _TilingTop/_TilingBottom overrides. When _Tiling is absent but the per-axis
    // pair is present (Bricks_Grey_01), fall the base back to _TilingTop so the side does not
    // read at a mismatched frequency; otherwise a neutral 1.0.
    const tiling = f._Tiling !== undefined ? f._Tiling
        : (f._TilingTop !== undefined ? f._TilingTop
        : (f._TilingBottom !== undefined ? f._TilingBottom : 1.0));
    const props = {
        triplanarTilingTop: round7(f._TilingTop !== undefined ? f._TilingTop : tiling),
        triplanarTilingSide: round7(tiling),
        triplanarTilingBottom: round7(f._TilingBottom !== undefined ? f._TilingBottom : tiling),
        triplanarBlendSharpness: round7(f._Triplanar_Fade !== undefined ? clamp01(f._Triplanar_Fade) : 0.5),
        triplanarLayered: albedoLayered ? 1 : 0,
        triplanarNormalLayered: normalLayered ? 1 : 0,
    };

    // Per-axis metallic (float; census: zero metallic-gloss map usage) w/ global _Metallic fallback.
    const metal = f._Metallic !== undefined ? f._Metallic : 0;
    props.triplanarMetallicTop = round7(clamp01(f._Top_Metallic !== undefined ? f._Top_Metallic : metal));
    props.triplanarMetallicSide = round7(clamp01(f._Side_Metallic !== undefined ? f._Side_Metallic : metal));
    props.triplanarMetallicBottom = round7(clamp01(f._Bottom_Metallic !== undefined ? f._Bottom_Metallic : metal));

    // Per-axis roughness = 1 - smoothness, clamped off the mirror singularity (matches §2).
    const gloss = f._Smoothness !== undefined ? f._Smoothness : 0.5;
    const roughFrom = (s) => Math.max(0.04, Math.min(1, 1 - (s !== undefined ? s : gloss)));
    props.triplanarRoughnessTop = round7(roughFrom(f._Top_Smoothness));
    props.triplanarRoughnessSide = round7(roughFrom(f._Side_Smoothness));
    props.triplanarRoughnessBottom = round7(roughFrom(f._Bottom_Smoothness));

    // Base-colour tint (Synty _Color_Tint; white in the sampled corpus). LDR sRGB tints are
    // linearised, HDR passes through — same rule as the standard path. uBaseColor is a
    // multiply over the projected albedo, so white is an exact no-op.
    const tintCol = c._Color_Tint || c._BaseColor || c._Color;
    if (tintCol) {
        const tint = linearizeUnityTint(tintCol);
        props.baseColor = [round7(tint[0]), round7(tint[1]), round7(tint[2]), 1];
    }

    doc.properties = props;
    if (Object.keys(textures).length > 0) doc.textures = textures;
    return { doc, needsFidelity: true };
}

// Synty's SM_Prop_BirdBath prop authors its water-bowl submesh (a mesh node literally
// named "water") with Glass_06 — a window-glass material shared by ~380 real window
// meshes in ElvenRealm — rather than a water material, so the bowls convert to shiny
// cyan glass instead of holding water. Remap ONLY that submesh to the pack's still-water
// body material (Water_01, now routed to the stylized-water surface). Gated on the exact
// glass guid AND the "water" node name so it can never touch an actual window: no window
// mesh node is named "water", and no other "water"-named node carries the glass material.
const kGlass06MatGuid    = 'b253cb5ee0fc4a047be47d7b7a1c42dc'; // Glass_06 (window glass)
const kWaterBodyMatGuid  = '6d24c2fc3a1139d4ab252fdaf2d031d2'; // Water_01 (still water body)
function remapPropWaterSubmesh(node, unityMatGuid) {
    if (unityMatGuid === kGlass06MatGuid && String(node.name || '').toLowerCase() === 'water')
        return kWaterBodyMatGuid;
    return unityMatGuid;
}

// Copy a PROJECT-side surface shader next to the generated materials so
// "surfaceShader": "<name>.glsl" resolves material-dir-local (ShaderComposer resolves the
// material's own directory first). The shaders are authored content, not engine built-ins — they
// land in the user's project where they can read and extend them. One source of truth: the
// copies bundled with this package under shaders/.
//
// Refresh policy (hash-compare, not copy-if-missing): a destination copy that
// matches a KNOWN shipped version (shaders/shipped-hashes.json — every version
// ever shipped, hashed over LF-normalized content) is pristine and safe to
// auto-overwrite with the current version; an unknown hash means the user
// edited their copy, which is warned about and never clobbered.
const kWaterShaderRel = 'water_stylized.glsl';
const kFallsShaderRel = 'waterfall_fx.glsl';
const kShaderSrcDir = path.join(__dirname, '..', 'shaders');
const kShippedHashesFile = 'shipped-hashes.json';

const hashShaderText = (text) =>
    crypto.createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');

const shippedHashesCache = new Map(); // srcDir -> { rel: [sha256, ...] }
function loadShippedHashes(srcDir) {
    if (shippedHashesCache.has(srcDir)) return shippedHashesCache.get(srcDir);
    let manifest = {};
    try { manifest = JSON.parse(fs.readFileSync(path.join(srcDir, kShippedHashesFile), 'utf8')); }
    catch { /* no manifest -> nothing auto-refreshes, user copies stay safe */ }
    shippedHashesCache.set(srcDir, manifest);
    return manifest;
}

// Pure decision: what to do with an existing destination copy.
function classifySurfaceShaderDest(srcText, destText, shippedHashes) {
    if (destText === null) return 'copy';
    const destHash = hashShaderText(destText);
    if (destHash === hashShaderText(srcText)) return 'up-to-date';
    if (Array.isArray(shippedHashes) && shippedHashes.includes(destHash)) return 'refresh';
    return 'user-modified';
}

// Returns the action taken: 'copied' | 'up-to-date' | 'refreshed' |
// 'skipped-user-modified' | 'error' (undefined when memoized for this run).
function ensureSurfaceShaderCopied(ctx, rel) {
    if (!ctx.matOutDir) return;
    if (!ctx.copiedSurfaceShaders) ctx.copiedSurfaceShaders = new Set();
    if (ctx.copiedSurfaceShaders.has(rel)) return;
    ctx.copiedSurfaceShaders.add(rel);
    const srcDir = ctx.shaderSrcDir || kShaderSrcDir;
    const src = path.join(srcDir, rel);
    const dest = path.join(ctx.matOutDir, rel);
    try {
        const srcText = fs.readFileSync(src, 'utf8');
        const destText = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : null;
        const action = classifySurfaceShaderDest(srcText, destText, loadShippedHashes(srcDir)[rel]);
        switch (action) {
        case 'copy':
            fs.copyFileSync(src, dest);
            return 'copied';
        case 'up-to-date':
            return 'up-to-date';
        case 'refresh':
            fs.copyFileSync(src, dest);
            console.error(`surface shader refreshed: ${dest} (pristine shipped version -> current)`);
            return 'refreshed';
        case 'user-modified':
            warn(`surface shader NOT refreshed (${dest}): existing copy differs from every shipped version — `
                + `treating as user-edited and keeping it. Delete the file to get the current version.`, ctx.verbose);
            return 'skipped-user-modified';
        }
    } catch (err) {
        warn(`surface shader not copied (${src}): ${err.message} — the referencing .material will not resolve its surface`, ctx.verbose);
        return 'error';
    }
}

// Build a stylized-water MaterialDocument from a Synty Waterfall_Emissive .mat (GUID 88fd8f21).
// The custom Synty shader becomes a PROJECT-authored surface front-end (water_stylized.glsl) feeding
// the UNCHANGED OpenPBR BRDF. All water params ride the GENERIC user block (user0..user8) — no
// engine-side lane per property — proving a user can port this with the material APIs alone.
//
// Blend: authored OPAQUE (the shipped 88fd8f21 instances override the graph's transparent default to
// _Surface:0 / _ZWrite:1 — see user-shader-extensibility-2026-07.html §5). The stale _Water_Color.a
// alpha is NOT used to force transparency; only an explicit _Surface==1 / transparent keyword does.
function buildWaterDoc(ctx, info, materialName) {
    ensureSurfaceShaderCopied(ctx, kWaterShaderRel);
    const f = info.floats, c = info.colors, kw = info.keywords;
    const doc = {
        schemaVersion: 3,
        materialName,
        lightingModel: 'StandardPBR',
        surfaceShader: kWaterShaderRel, // material-dir-local, project-side
        // Waterfall planes carry baked vertex colors the Synty FALLS/FLOW graphs
        // never sample; the water surface multiplies vertexColor in, so mask it off.
        ignoreVertexColor: true,
    };

    // Verdict-honoring blend: opaque unless the instance explicitly overrides to transparent.
    const transparent = f._Surface === 1 || kw.has('_SURFACE_TYPE_TRANSPARENT') || kw.has('_ALPHABLEND_ON');
    doc.alphaMode = transparent ? 'Blend' : 'Opaque';
    if (f._Cull === 0) doc.doubleSided = true;

    const waterCol = c._Water_Color || c._Color || c._BaseColor || [1, 1, 1, 1];
    const tint = linearizeUnityTint(waterCol);
    const metallic = f._Metallic !== undefined ? Math.max(0, Math.min(1, f._Metallic)) : 0.1;
    const gloss = f._Smoothness !== undefined ? f._Smoothness
        : (f._Glossiness !== undefined ? f._Glossiness : 0.7);
    const roughness = Math.max(0.04, Math.min(1, 1 - gloss));

    // Scroll: the Waterfall FLOW graph pans BOTH samples (Color_Mask + Normals)
    // with Speed = Vector2(0, 1) * _UVScroll_Speed — V-only, UV/sec (Synty's
    // Panner subgraph 155f6dcf is exactly Out = UV + Speed * Time; the 0.01
    // damping constant lives only in the FALLS graph 87c14512, not here). The
    // MAGNITUDE carries over 1:1, but the SIGN does not: the FBX importer's V
    // flip (TexCoords[1] = 1 - uv.y) mirrors the mesh's V axis, so the apparent
    // motion of a +V sample offset is inverted vs Unity — static appearance
    // cancels (texture row order), animated offsets do not. Emit -sp so the
    // flow reads the same as Unity. Verified in-engine per mesh family
    // (2026-07-18, timed-screenshot displacement): waterfall sheet
    // SM_Env_Water_Plane_Waterfall_02 pattern moves UP the falls with +sp,
    // DOWN with -sp; river plane SM_Env_Water_Plane_01 pattern moves upstream
    // with +sp, downstream (toward its falls lip) with -sp.
    const sp = f._UVScroll_Speed !== undefined ? f._UVScroll_Speed
        : (f._Scoll_Speed !== undefined ? f._Scoll_Speed : 0.5);
    const overlayPower = f._Water_Overlay_Power !== undefined ? f._Water_Overlay_Power : 0.3;
    // _Fresnel_Power in the graph is NOT an exponent: the FLOW Emission block is
    // Fresnel_Color * min(fresnelEffect, _Fresnel_Power) — the authored value
    // (0.01..0.012 across the corpus) is a CAP that bounds the rim to a subtle
    // ~2-nit sheen. The shader keeps a stylized pow-3 falloff for the rim's
    // shape (user3) and bounds it with the authored cap (user8).
    const kFresnelExponent = 3.0;
    const fresnelRimCap = f._Fresnel_Power !== undefined ? f._Fresnel_Power : 0.012;
    const fresnelCol = linearizeUnityTint(c._Fresnel_Color || c._FresnelColour || [1, 1, 1, 0]);
    // "Emission" (float, range 0..5) is the authored brightness of the luminous
    // Water_Color x Color_Mask overlay, and it carries over 1:1: user7 is a
    // scene-linear emission scale where 1.0 == 203 nits (GE_EMISSION_PAPERWHITE_NITS
    // in the surface shader) — the same paperwhite anchor buildMaterialDoc uses
    // for emissionLuminance. An earlier version damped this with an invented
    // `* 0.12` constant (no Unity counterpart) and the shader further gated the
    // term by (fresnel + overlay*power); together they left the night water an
    // order of magnitude darker than the Unity reference (near-black falls/river).
    const emissionStrength = Math.max(0, f._Emission !== undefined ? f._Emission : 1);

    doc.properties = {
        baseColor: [round7(tint[0]), round7(tint[1]), round7(tint[2]), round7(waterCol[3])],
        metallic: round7(metallic),
        roughness: round7(roughness),
        user0: 0,                                // scrollSpeedX (graph pans V only)
        user1: round7(-sp),                      // scrollSpeedY (negated: importer V flip inverts apparent motion; see note above)
        user2: round7(overlayPower),             // overlayPower
        user3: kFresnelExponent,                 // fresnelPower
        user4: round7(fresnelCol[0]),            // fresnelColor.r
        user5: round7(fresnelCol[1]),            // fresnelColor.g
        user6: round7(fresnelCol[2]),            // fresnelColor.b
        user7: round7(emissionStrength),         // emissionStrength (scene-linear; 1.0 == 203-nit paperwhite)
        user8: round7(fresnelRimCap),            // fresnelRimCap (authored _Fresnel_Power; bounds the rim like Unity's min())
    };

    const textures = {};
    // The graph routes both samples through Tiling And Offset with a CONSTANT (2,1)
    // tiling (an in-graph Vector2, not a .mat property). The surface shader derives
    // both UVs from the slot-0 transform, so author it on albedoMap.
    const albedo = pickTexture(ctx, info, ['_Color_Mask', '_Albedo_Map', '_Base_Map', '_BaseMap', '_MainTex'], 'color');
    if (albedo) textures.albedoMap = { guid: albedo.guid, path: albedo.path, tiling: [2, 1] };
    const normal = pickTexture(ctx, info, ['_Normals', '_Normal_Map', '_BumpMap', '_NormalMap'], 'normal');
    if (normal) textures.normalMap = { guid: normal.guid, path: normal.path };
    if (Object.keys(textures).length > 0) doc.textures = textures;

    return { doc, needsFidelity: true };
}

// Build a FALLS churn-FX MaterialDocument from a Synty Waterfall .mat (GUID 87c14512) — the
// white/cyan churn ribbons at the falls' lips (WaterFall_Top_FX, 31 plane instances in ER).
// The graph is an emission-driven transparent FX surface (waterfall_fx.glsl carries the decoded
// node math); the previous routing degraded it to standard_pbr, which scraped stale legacy
// floats into an invisible material (green _Color tint, opacity 0, alphaMode Blend).
function buildFallsDoc(ctx, info, materialName) {
    ensureSurfaceShaderCopied(ctx, kFallsShaderRel);
    const f = info.floats, c = info.colors, kw = info.keywords;
    const doc = {
        schemaVersion: 3,
        materialName,
        lightingModel: 'StandardPBR',
        surfaceShader: kFallsShaderRel, // material-dir-local, project-side
        // The FX planes carry baked vertex colors the FALLS graph never samples.
        ignoreVertexColor: true,
    };

    const transparent = f._Surface === 1 || kw.has('_SURFACE_TYPE_TRANSPARENT') || kw.has('_ALPHABLEND_ON');
    doc.alphaMode = transparent ? 'Blend' : 'Opaque';
    if (transparent) {
        // Faithful blend: the .mat authors _ALPHAPREMULTIPLY_ON with SrcBlend One /
        // DstBlend OneMinusSrcAlpha (URP preserve-specular premultiply). The surface
        // premultiplies the diffuse base by alpha; emission rides un-premultiplied, so
        // thin-alpha churn still adds light over the falls.
        doc.blend = { srcColor: 'One', dstColor: 'OneMinusSrcAlpha',
                      srcAlpha: 'One', dstAlpha: 'OneMinusSrcAlpha' };
    }
    if (f._Cull === 0) doc.doubleSided = true;

    // Panner: offset = 0.01 * _Speed * t — the damping constant lives IN the graph (not in
    // the FLOW sibling), so the effective UV/sec speed is folded here. Sign: the FBX
    // importer's V flip inverts APPARENT V motion (see buildWaterDoc's note); U is
    // untouched. FALLS ships _Speed = (20, 0) — a pure U pan along the rim mesh.
    const kFallsPanDamping = 0.01;
    const speed = c._Speed || [0, 0, 0, 0];
    const waterCol = linearizeUnityTint(c._Water_Color || [1, 1, 1, 1]);
    // _Brightness carries 1:1 as a scene-linear emission scale (1.0 == 203-nit paperwhite),
    // the same anchor as the FLOW family's user7 / buildMaterialDoc's emissionLuminance.
    const brightness = Math.max(0, f._Brightness !== undefined ? f._Brightness : 1);

    // BaseColor/metallic/roughness are graph CONSTANTS (grey 0.5, 0, smoothness 0.5)
    // hardcoded in the surface — the .mat's _Metallic/_Smoothness/_Color floats are stale
    // legacy props the graph never reads (exactly what the old degraded routing scraped).
    doc.properties = {
        user0: round7(kFallsPanDamping * speed[0]),  // panSpeedU (effective UV/sec)
        user1: round7(-kFallsPanDamping * speed[1]), // panSpeedV (negated: importer V flip inverts apparent motion)
        user2: round7(brightness),                   // brightness (_Brightness; 1.0 == 203-nit paperwhite)
        user4: round7(waterCol[0]),                  // waterColor.r (_Water_Color, linearized)
        user5: round7(waterCol[1]),                  // waterColor.g
        user6: round7(waterCol[2]),                  // waterColor.b
    };

    // Three named slots: albedoMap is the engine well-known slot 0 (panned churn);
    // churnDetail/fadeMask are USER names declared by the surface's @texture tags — the
    // .material binds them by name and the composer's slot map does the rest.
    const textures = {};
    const t01 = resolveTexture(ctx, info.texEnvs._Texture_01, 'color');
    if (t01) textures.albedoMap = { guid: t01.guid, path: t01.path };
    const t02 = resolveTexture(ctx, info.texEnvs._Texture_02, 'color');
    if (t02) textures.churnDetail = { guid: t02.guid, path: t02.path };
    const t03 = resolveTexture(ctx, info.texEnvs._Texture_03, 'color');
    if (t03) textures.fadeMask = { guid: t03.guid, path: t03.path };
    if (Object.keys(textures).length > 0) doc.textures = textures;

    return { doc, needsFidelity: true };
}

// Per-Synty-shader-family tally for the honest material report.
function famStat(ctx, family) {
    let s = ctx.matStats.byFamily.get(family);
    if (!s) { s = { generated: 0, plain: 0, fallback: 0, note: '' }; ctx.matStats.byFamily.set(family, s); }
    return s;
}

// Generate (once) the .material for a Unity material guid; return { path, guid }
// for the scene ref, or null if it needs no override (plain) or is unresolvable.
function resolveMaterial(ctx, unityMatGuid) {
    if (!ctx.matOutDir) return null;
    if (ctx.materialCache.has(unityMatGuid)) return ctx.materialCache.get(unityMatGuid);
    let result = null;
    const e = ctx.pkg.get(unityMatGuid);
    if (e && path.extname(e.assetPath).toLowerCase() === '.mat') {
        let text = null;
        try { text = fs.readFileSync(path.join(e.dir, 'asset'), 'utf8'); } catch { /* unreadable */ }
        const info = text ? parseUnityMat(text) : null;
        if (info) {
            const name = path.basename(e.assetPath, '.mat');
            const cls = classifyMaterial(info, name);
            const fam = famStat(ctx, cls.family);
            if (cls.note) fam.note = cls.note;
            if (cls.hideMesh) ctx.matHide.add(unityMatGuid);
            if (!cls.mappable) {
                // No OpenPBR analogue: leave the renderer at its FBX default rather
                // than emit a scraped-garbage material (Aurora used to ship a fully
                // transparent green tint). Recorded for the per-scene audit report.
                fam.fallback++;
                ctx.matStats.fallbackUnmappable++;
                ctx.matStats.fallbackList.push({ name, shader: info.shaderGuid || 'null', reason: cls.reason });
            } else {
                const { doc, needsFidelity } = cls.surface === 'triplanar_pbr'
                    ? buildTriplanarDoc(ctx, info, name)
                    : cls.surface === 'water_stylized'
                    ? buildWaterDoc(ctx, info, name)
                    : cls.surface === 'waterfall_fx'
                    ? buildFallsDoc(ctx, info, name)
                    : buildMaterialDoc(ctx, info, name);
                if (needsFidelity) {
                    const base = sanitizeFileName(name) + '__' + unityMatGuid.slice(0, 8);
                    const rel = kMatOutRel + '/' + base + '.material';
                    fs.writeFileSync(path.join(ctx.matOutDir, base + '.material'), JSON.stringify(doc, null, 2) + '\n');
                    result = { path: rel, guid: deterministicGuid(rel) };
                    ctx.matStats.generated++;
                    fam.generated++;
                } else {
                    ctx.matStats.skippedPlain++;
                    fam.plain++;
                }
            }
        } else {
            ctx.matStats.unresolvedMat++;
        }
    } else {
        ctx.matStats.unresolvedMat++;
    }
    ctx.materialCache.set(unityMatGuid, result);
    return result;
}

// ---------------------------------------------------------------- main -----
function main(argv = process.argv) {
    // Banner: every run logs which transform convention this copy emits, so any
    // regen log proves WHICH converter ran. A stale copy without this line (or
    // with a different version) is self-identifying — see the
    // stale-terrain-branch-copy trap that motivated these guards.
    console.error(`transform-convention: ${TRANSFORM_CONVENTION_VERSION}`);
    const args = parseArgs(argv);
    if (!args.pkg || !args.scene) {
        console.error('Usage: node convert.js --pkg <extracted-pkg-dir> --scene <scene path suffix|guid> --project <target-project-dir> [--assetdb <file>] [--unity-project <unity-project-dir>] [--out <output.scene>] [--local-shadows off|faithful] [--verbose]');
        process.exit(2);
    }
    const localShadows = args['local-shadows'] || 'faithful';
    if (localShadows !== 'off' && localShadows !== 'faithful')
        fail(`--local-shadows must be off|faithful (got '${localShadows}')`);

    const ctx = {
        pkg: buildPackageIndex(args.pkg),
        pkgDir: args.pkg,
        projectDir: args.project || null,
        assetDb: null,
        structureCache: new Map(),
        materialCache: new Map(),
        matHide: new Set(),     // unity material guids whose bound meshes must not render (engine owns sky / unmappable FX)
        renderSettings: null,
        volumeOverrides: null,
        matOutDir: null,
        texCopyDir: null,
        texc: null,
        matStats: { generated: 0, skippedPlain: 0, unresolvedMat: 0, texResolved: 0, texCopied: 0, texEncoded: 0, texUnresolved: 0,
            fallbackUnmappable: 0, fallbackList: [], byFamily: new Map() },
        projectPipeline: null,
        localShadows,
        gradeLutFallback: !!args['grade-lut'],  // opt-in legacy SMH .cube bake (A/B vs native bands)
        verbose: !!args.verbose,
    };
    console.error(`Package: ${ctx.pkg.size} assets indexed`);

    // Project-level pipeline state (--unity-project <unity-project-dir>): a
    // .unitypackage never ships URP pipeline assets or quality settings; a
    // real Unity project dir supplies the active RP asset (SSAO feature,
    // shadow/HDR/MSAA facts) and the quality-level volume profile that layers
    // UNDER the scene's global volume in URP's stack.
    if (args['unity-project'])
        ctx.projectPipeline = loadUnityProjectPipeline(args['unity-project'], ctx.verbose);

    // Generated .material assets and copied-in textures land under the project's
    // asset root (<project>/assets/{Materials_Unity,Textures_Unity}); the scene
    // and materials reference them relative to that root, matching how mesh
    // refs are authored. Texture copy is disabled with --no-copy-textures.
    if (ctx.projectDir) {
        ctx.matOutDir = path.join(ctx.projectDir, 'assets', kMatOutRel);
        fs.mkdirSync(ctx.matOutDir, { recursive: true });
        if (!args['no-copy-textures']) {
            ctx.texCopyDir = path.join(ctx.projectDir, 'assets', kTexCopyRel);
            fs.mkdirSync(ctx.texCopyDir, { recursive: true });
        }
        // Textures ship as UASTC KTX2 (block-compressed on the GPU, pre-mipped)
        // by default; --png restores the raw-image reference/copy behavior.
        if (!args.png && ctx.texCopyDir) {
            ctx.texc = findTexc(args.texc);
            if (ctx.texc) console.error(`KTX2 encoder: ${ctx.texc}`);
            else console.error('WARNING: TextureCompiler.exe not found (build with -DBUILD_TOOLS=ON, or pass --texc/--png); falling back to raw texture copies');
        }
    }

    // Locate the scene by guid or path suffix.
    let sceneGuid = null;
    const wanted = args.scene.toLowerCase().replace(/\\/g, '/');
    if (ctx.pkg.has(wanted)) sceneGuid = wanted;
    else {
        for (const [g, e] of ctx.pkg) {
            const p = e.assetPath.toLowerCase();
            if (p.endsWith('.unity') && p.endsWith(wanted)) { sceneGuid = g; break; }
        }
    }
    if (!sceneGuid) fail(`scene '${args.scene}' not found in package`);
    const scenePath = ctx.pkg.get(sceneGuid).assetPath;
    console.error(`Scene: ${scenePath} (${sceneGuid})`);

    // Asset database (real project or explicit file).
    const dbFile = args.assetdb
        || (args.project && fs.existsSync(path.join(args.project, 'AssetDatabase.assetdb'))
            ? path.join(args.project, 'AssetDatabase.assetdb') : null);
    if (dbFile) {
        ctx.assetDb = loadAssetDb(dbFile);
        let models = 0;
        for (const v of ctx.assetDb.byStem.values()) models += v.length;
        console.error(`AssetDb: ${dbFile} (${ctx.assetDb.byGuid.size} assets, ${models} model files)`);
    } else {
        console.error('AssetDb: NONE — all mesh refs will be unresolved');
    }

    const t0 = Date.now();
    const st = buildFileStructure(ctx, sceneGuid, []);
    if (!st) fail('failed to parse scene');
    console.error(`Expanded ${st.nodes.size} nodes in ${Date.now() - t0} ms`);

    // Merge the RP asset's quality-level volume profile UNDER the scene's
    // global volume (URP applies default profile -> RP profile -> scene
    // volumes; the neutral global default contributes nothing).
    if (ctx.projectPipeline && ctx.projectPipeline.rpVolumeOverrides)
        ctx.volumeOverrides = layerVolumeOverrides(
            ctx.projectPipeline.rpVolumeOverrides, ctx.volumeOverrides || {});

    const sceneName = path.basename(scenePath, '.unity');
    const { text, emitted } = emitScene(ctx, st, sceneName);

    const outFile = args.out
        || (args.project ? path.join(args.project, 'assets', sceneName + '_unity.scene')
                         : sceneName + '_unity.scene');
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, text);

    // A freshly converted scene supersedes any prior edit session's autosave
    // backup. The editor's crash-recovery prompt (SceneBackupRecovery) fires when
    // `<stem>.backup.scene` is NEWER than the scene, and its "restore" path opens
    // that stale backup INSTEAD of this conversion. Leaving the sibling behind makes
    // the next open offer the old content and read as "the scene wasn't saved
    // properly", so a (re)convert clears it.
    {
        const ext = path.extname(outFile);
        const backupFile = outFile.slice(0, outFile.length - ext.length) + '.backup' + ext;
        try { fs.rmSync(backupFile, { force: true }); } catch (_) { /* best-effort */ }
    }

    // ------------------------------------------------------------ stats ----
    const s = stats;
    console.log('--- conversion stats ---');
    console.log(`output:                    ${outFile}`);
    console.log(`nodes expanded:            ${st.nodes.size}`);
    console.log(`prefab instances expanded: ${s.prefabInstancesExpanded}`);
    console.log(`entities emitted:          ${emitted.entities} (${emitted.meshEntities} mesh, ${emitted.groupEntities} group)`);
    console.log(`extra material-part ents:  ${emitted.materialParts} (siblings for multi-material meshes)`);
    console.log(`material refs bound:       ${emitted.materialsBound}`);
    console.log(`sky/FX meshes hidden:      ${emitted.hiddenSkyFx} (hideMesh families: engine owns sky / unmappable FX)`);
    console.log(`.material assets generated:${ctx.matStats.generated} (skipped plain: ${ctx.matStats.skippedPlain}, unresolved .mat: ${ctx.matStats.unresolvedMat})`);
    console.log(`material textures resolved:${ctx.matStats.texResolved} (ktx2-encoded: ${ctx.matStats.texEncoded}, copied-in: ${ctx.matStats.texCopied}, unresolved: ${ctx.matStats.texUnresolved})`);

    // Honest per-scene material report: which Synty shader family each unique
    // material dispatched to, and the un-mappable shaders left at FBX default.
    console.log('--- material dispatch by Synty shader family (unique .mat) ---');
    const fams = [...ctx.matStats.byFamily.entries()]
        .sort((a, b) => (b[1].generated + b[1].plain + b[1].fallback) - (a[1].generated + a[1].plain + a[1].fallback));
    for (const [fam, c] of fams) {
        const note = c.note ? `  (${c.note})` : '';
        console.log(`  ${fam.padEnd(22)} generated ${String(c.generated).padStart(3)}  plain ${String(c.plain).padStart(3)}  fallback ${String(c.fallback).padStart(2)}${note}`);
    }
    if (ctx.matStats.fallbackList.length) {
        console.log(`un-mappable shaders: ${ctx.matStats.fallbackUnmappable} (override skipped -> FBX default, NOT smeared)`);
        for (const f of ctx.matStats.fallbackList)
            console.log(`  ${f.name}  [shader ${f.shader}]  ${f.reason}`);
    }
    if (emitted.skybox) {
        console.log(`skybox: faithful Unity cubemap -> ${emitted.skybox.relPath}`
            + (emitted.skybox.reused ? ' (bake reused)' : ''));
    }
    console.log(`mesh refs resolved:        ${emitted.resolvedMeshes}`);
    console.log(`mesh refs UNRESOLVED:      ${emitted.unresolvedMeshes} (${emitted.unresolvedFbxStems.size} unique fbx)`);
    console.log(`unique static fbx used:    ${emitted.uniqueFbx.size}`);
    console.log(`skipped skinned meshes:    ${s.skippedSkinned}`);
    console.log(`skipped non-SM fbx nodes:  ${s.skippedNonStaticFbx}`);
    console.log(`skipped inactive meshes:   ${s.skippedInactive}`);
    console.log(`lights converted:          ${emitted.lights} (dir+point; spot/area skipped: ${s.skippedLights})`);
    if (emitted.directionalsBeyondEngineCap > 0) {
        console.log(`directionals beyond cap:   ${emitted.directionalsBeyondEngineCap} (engine lights the strongest 4 — shadows from the primary only; the rest will not contribute)`);
    }
    if (ctx.localShadows === 'off') {
        console.log(`addl-light shadows:        off — ${emitted.suppressedAdditionalLightShadows} source-flagged local shadows suppressed (--local-shadows=off)`);
    } else {
        const lt = emitted.localShadowTiers;
        console.log(`addl-light shadows:        faithful — ${lt[1] + lt[2] + lt[3]} shadowed locals emitted (tier low/med/high: ${lt[1]}/${lt[2]}/${lt[3]})`);
    }
    console.log(`skipped cameras:           ${s.skippedCameras}`);
    console.log(`skipped particle systems:  ${s.skippedParticles}`);
    console.log(`lod groups seen:           ${s.lodGroups}`);
    console.log(`fbx sub-part nodes emitted:${s.fbxSubPartNodes} (multi-node prop children: glass/lids/drawers/arms)`);
    console.log(`mod-target root fallbacks: ${s.modTargetFallbacks}`);
    console.log(`mod-target conflicts:      ${s.modTargetConflicts}`);
    console.log(`material overrides bound:  ${s.materialOverridesBound} (per-renderer variant recolours resolved to their sub-part)`);
    console.log(`dropped material overrides: ${s.droppedMaterialOverrides} (multi-renderer targets that could not resolve to a node — left at FBX default, not smeared)`);
    console.log(`dropped deep TRS overrides:  ${s.droppedDeepTrsOverrides}`);
    console.log(`dropped deep prop overrides: ${s.droppedDeepPropOverrides} (${s.droppedDeepActiveDisables} were m_IsActive=0 -> possible ghost meshes)`);
    console.log(`unresolved prefab sources: ${s.unresolvedPrefabSources}`);
    console.log(`unresolved father links:   ${s.unresolvedFatherLinks}`);
    if (emitted.unresolvedFbxStems.size > 0) {
        console.log('unresolved fbx stems:');
        for (const st2 of [...emitted.unresolvedFbxStems].sort()) console.log('  ' + st2);
    }

    // Honest "what didn't carry over" summary. Printed unconditionally (not gated
    // on --verbose) so every conversion tells the user which recognized settings
    // were dropped — grouped by kind, de-duplicated, so a run is self-documenting.
    if (droppedSettings.length) {
        console.log('--- recognized settings dropped (no engine mapping) ---');
        const byKind = new Map();
        for (const d of droppedSettings) {
            if (!byKind.has(d.kind)) byKind.set(d.kind, new Set());
            byKind.get(d.kind).add(d.detail);
        }
        for (const [kind, details] of byKind)
            for (const detail of [...details].sort())
                console.log(`  [${kind}] ${detail}`);
    } else {
        console.log('recognized settings dropped: none');
    }

    if (!ctx.verbose && warnings.length)
        console.error(`(${warnings.length} warnings; rerun with --verbose)`);
}

// CLI entry. Gated so unit-style checks can require() the material-mapping
// functions (classifyMaterial / buildTriplanarDoc / buildMaterialDoc /
// parseUnityMat) without running a conversion.
if (require.main === module) main();

module.exports = {
    main,
    classifyMaterial, buildTriplanarDoc, buildMaterialDoc, buildWaterDoc, buildFallsDoc, parseUnityMat,
    // Surface-shader refresh (exercised by tests/surface-shader-refresh.test.mjs).
    ensureSurfaceShaderCopied, classifySurfaceShaderDest, hashShaderText,
    // Transform convention (exercised by tests/transform-convention.test.mjs).
    TRANSFORM_CONVENTION_VERSION,
    conj, qMul, qRotate, kYFlip, emitObjectQuat, emitDirectionalQuat, composeWorldTRS,
    // Ambient colour space (exercised by tests/ambient-linearization.test.mjs).
    srgbToLinear, linearizeAmbientColor, emitAmbientLightLines,
};
