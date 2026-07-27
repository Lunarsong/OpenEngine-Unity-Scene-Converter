// Stock URP Lit.shader dispatch (kShaderDispatch '933532a4').
//
// URP/Lit is Unity's hand-written standard shader — before this entry, every
// material bound to it fell to the blind unknown-shader standard_pbr map with
// generic property guessing. The dispatch maps the URP property set
// deliberately and, per the honest-drop rule, REPORTS what the engine schema
// cannot express instead of approximating silently:
//   - _BaseMap/_BaseColor -> albedoMap/baseColor (sRGB->linear, HDR passthrough)
//   - _BumpMap -> normalMap; _OcclusionMap -> aoMap
//   - _Metallic/_Smoothness -> metallic / roughness = 1 - smoothness
//   - _MetallicGlossMap/_SpecGlossMap: DROPPED (URP packs smoothness in alpha;
//     the engine map is glTF G=roughness/B=metallic — wrong channels)
//   - _EmissionMap/_EmissionColor strictly behind the _EMISSION keyword
//   - _Cutoff/_Surface/_AlphaClip -> alphaMode/alphaCutoff (existing ladder)
//   - _Cull 0 -> doubleSided; _Blend additive -> T1 blend state
//   - shared _BaseMap m_Scale/m_Offset -> per-slot tiling/offset with the
//     V-flip-exact affine map (engine V row = {sy, 1 - sy - oy})
//
// Every mapping test carries a mutation partner so a hardcoded expectation
// cannot pass by accident. All fixtures are synthetic — no licensed content.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const CONVERT = path.join(__dirname, '..', 'src', 'convert.js');
const convert = require(CONVERT);

const { classifyMaterial, buildMaterialDoc, parseUnityMat } = convert;

// The URP Lit shader GUID is fixed across every URP install.
const kUrpLitGuid = '933532a4fcc9baf4fa0491de14d08ed7';

// ------------------------------------------------------------ pure helpers --
// Minimal ctx: texture guids resolve to nothing (empty package), which is all
// the scalar-property tests need; texture binding is proven by the full
// conversion fixture below.
function pureCtx() {
    return {
        pkg: new Map(),
        assetDb: null,
        texc: null,
        texCopyDir: null,
        verbose: false,
        matStats: { texResolved: 0, texCopied: 0, texEncoded: 0, texUnresolved: 0 },
    };
}

function urpInfo({ keywords = [], renderType = 'Opaque', texEnvs = {}, texST = {}, floats = {}, colors = {} } = {}) {
    return {
        shaderGuid: kUrpLitGuid,
        keywords: new Set(keywords),
        renderType,
        texEnvs,
        texST,
        floats,
        colors,
    };
}

const kUrpCls = classifyMaterial(urpInfo(), 'Probe');

// ------------------------------------------------------------ classification
test('URP Lit GUID dispatches to the URP_Lit family, standard_pbr surface', () => {
    assert.equal(kUrpCls.family, 'URP_Lit');
    assert.equal(kUrpCls.mappable, true);
    assert.equal(kUrpCls.surface, 'standard_pbr');
    assert.equal(kUrpCls.urpLit, true);
});

test('mutation: a different GUID prefix still falls to the blind unknown map', () => {
    const info = urpInfo({ colors: { _BaseColor: [1, 1, 1, 1] } });
    info.shaderGuid = 'deadbeef000000000000000000000000';
    const cls = classifyMaterial(info, 'Probe');
    assert.equal(cls.family, 'Unknown(deadbeef)');
    assert.ok(!cls.urpLit);
});

// ------------------------------------------------------------------ parsing
test('parseUnityMat captures non-identity per-slot m_Scale/m_Offset, omits identity', () => {
    const yaml = [
        'm_SavedProperties:',
        '    m_TexEnvs:',
        '    - _BaseMap:',
        '        m_Texture: {fileID: 0}',
        '        m_Scale: {x: 2, y: 0.5}',
        '        m_Offset: {x: 0.25, y: 0.1}',
        '    - _BumpMap:',
        '        m_Texture: {fileID: 0}',
        '        m_Scale: {x: 1, y: 1}',
        '        m_Offset: {x: 0, y: 0}',
        '    m_Ints: []',
        '',
    ].join('\n');
    const info = parseUnityMat(yaml);
    assert.deepEqual(info.texST._BaseMap, [2, 0.5, 0.25, 0.1]);
    assert.equal(info.texST._BumpMap, undefined); // identity omitted
});

// ------------------------------------------------------- scalar properties --
test('_BaseColor maps sRGB->linear; mutation: HDR channel passes through', () => {
    const ldr = buildMaterialDoc(pureCtx(), urpInfo({ colors: { _BaseColor: [0.5, 0.5, 0.5, 1] } }), 'Ldr', kUrpCls);
    assert.ok(Math.abs(ldr.doc.properties.baseColor[0] - 0.2140411) < 1e-6);
    const hdr = buildMaterialDoc(pureCtx(), urpInfo({ colors: { _BaseColor: [1.844, 0.5, 0.5, 1] } }), 'Hdr', kUrpCls);
    assert.equal(hdr.doc.properties.baseColor[0], 1.844); // HDR: no linearization
});

test('_Metallic/_Smoothness -> metallic / roughness = 1 - smoothness, with mutation', () => {
    const a = buildMaterialDoc(pureCtx(), urpInfo({ floats: { _Metallic: 0.25, _Smoothness: 0.6 } }), 'A', kUrpCls);
    assert.equal(a.doc.properties.metallic, 0.25);
    assert.ok(Math.abs(a.doc.properties.roughness - 0.4) < 1e-9);
    const b = buildMaterialDoc(pureCtx(), urpInfo({ floats: { _Metallic: 0.9, _Smoothness: 0.2 } }), 'B', kUrpCls);
    assert.equal(b.doc.properties.metallic, 0.9);
    assert.ok(Math.abs(b.doc.properties.roughness - 0.8) < 1e-9);
});

test('specular workflow (_WorkflowMode 0) forces metallic 0; mutation: metallic mode keeps _Metallic', () => {
    const spec = buildMaterialDoc(pureCtx(),
        urpInfo({ floats: { _WorkflowMode: 0, _Metallic: 0.8, _Smoothness: 0.5 } }), 'Spec', kUrpCls);
    assert.equal(spec.doc.properties.metallic, 0);
    const metal = buildMaterialDoc(pureCtx(),
        urpInfo({ floats: { _WorkflowMode: 1, _Metallic: 0.8, _Smoothness: 0.5 } }), 'Metal', kUrpCls);
    assert.equal(metal.doc.properties.metallic, 0.8);
});

// -------------------------------------------------------------- alpha ladder
test('_Surface/_AlphaClip/_Cutoff ladder: cutout with authored threshold, with mutation', () => {
    const a = buildMaterialDoc(pureCtx(),
        urpInfo({ floats: { _Surface: 0, _AlphaClip: 1, _Cutoff: 0.35 } }), 'CutA', kUrpCls);
    assert.equal(a.doc.alphaMode, 'Mask');
    assert.equal(a.doc.properties.alphaCutoff, 0.35);
    const b = buildMaterialDoc(pureCtx(),
        urpInfo({ floats: { _Surface: 0, _AlphaClip: 1, _Cutoff: 0.7 } }), 'CutB', kUrpCls);
    assert.equal(b.doc.properties.alphaCutoff, 0.7);
    const opaque = buildMaterialDoc(pureCtx(),
        urpInfo({ floats: { _Surface: 0, _AlphaClip: 0 } }), 'Op', kUrpCls);
    assert.equal(opaque.doc.alphaMode, 'Opaque');
});

test('_Surface 1 -> Blend with opacity from tint alpha', () => {
    const r = buildMaterialDoc(pureCtx(),
        urpInfo({ floats: { _Surface: 1 }, colors: { _BaseColor: [1, 1, 1, 0.35] } }), 'Glass', kUrpCls);
    assert.equal(r.doc.alphaMode, 'Blend');
    assert.equal(r.doc.properties.opacity, 0.35);
});

test('_Blend 2 (additive) maps to exact T1 blend state; mutations: 0 -> default, 1 -> dropped premultiply', () => {
    const add = buildMaterialDoc(pureCtx(),
        urpInfo({ floats: { _Surface: 1, _Blend: 2 } }), 'Add', kUrpCls);
    assert.deepEqual(add.doc.blend,
        { srcColor: 'SrcAlpha', dstColor: 'One', srcAlpha: 'One', dstAlpha: 'One' });
    const alpha = buildMaterialDoc(pureCtx(),
        urpInfo({ floats: { _Surface: 1, _Blend: 0 } }), 'Alpha', kUrpCls);
    assert.equal(alpha.doc.blend, undefined); // engine default IS straight alpha
    const premul = buildMaterialDoc(pureCtx(),
        urpInfo({ floats: { _Surface: 1, _Blend: 1 } }), 'Premul', kUrpCls);
    assert.equal(premul.doc.blend, undefined); // approximated (reported via drop summary)
});

// --------------------------------------------------------------------- cull
test('_Cull 0 -> doubleSided; mutation: back-face default (2) stays single-sided', () => {
    const ds = buildMaterialDoc(pureCtx(), urpInfo({ floats: { _Cull: 0 } }), 'Ds', kUrpCls);
    assert.equal(ds.doc.doubleSided, true);
    const bf = buildMaterialDoc(pureCtx(), urpInfo({ floats: { _Cull: 2 } }), 'Bf', kUrpCls);
    assert.equal(bf.doc.doubleSided, undefined);
});

// ---------------------------------------------------------------- emission --
test('colour-only emission is gated on _EMISSION for URP Lit (generic path is not)', () => {
    const colors = { _EmissionColor: [4, 2, 1, 1] };
    const off = buildMaterialDoc(pureCtx(), urpInfo({ colors }), 'EmOff', kUrpCls);
    assert.equal(off.doc.properties.emissive, undefined);
    const on = buildMaterialDoc(pureCtx(), urpInfo({ colors, keywords: ['_EMISSION'] }), 'EmOn', kUrpCls);
    assert.deepEqual(on.doc.properties.emissive, [1, 0.5, 0.25]);
    assert.equal(on.doc.properties.emissionLuminance, 203 * 4);

    // Control proving the gate is the URP branch: the SAME info through the
    // generic unknown-shader path emits without any keyword (HDR heuristic).
    const genericInfo = urpInfo({ colors });
    genericInfo.shaderGuid = 'deadbeef000000000000000000000000';
    const generic = buildMaterialDoc(pureCtx(), genericInfo, 'EmGen', classifyMaterial(genericInfo, 'EmGen'));
    assert.deepEqual(generic.doc.properties.emissive, [1, 0.5, 0.25]);
});

test('URP keyword-on LDR emission colour emits (no HDR>1 threshold); generic path drops it', () => {
    const colors = { _EmissionColor: [0.5, 0.25, 0.125, 1] };
    const urp = buildMaterialDoc(pureCtx(), urpInfo({ colors, keywords: ['_EMISSION'] }), 'EmLdr', kUrpCls);
    assert.deepEqual(urp.doc.properties.emissive, [0.5, 0.25, 0.125]);
    assert.equal(urp.doc.properties.emissionLuminance, 203);

    const genericInfo = urpInfo({ colors, keywords: ['_EMISSION'] });
    genericInfo.shaderGuid = 'deadbeef000000000000000000000000';
    const generic = buildMaterialDoc(pureCtx(), genericInfo, 'EmLdrGen', classifyMaterial(genericInfo, 'EmLdrGen'));
    assert.equal(generic.doc.properties.emissive, undefined); // 1.01 heuristic holds there
});

// ------------------------------------------------- full-pipeline conversion --
// Texture binding, the metallic-gloss honest drop, tiling emission and the
// report lines need a real conversion: synthetic extracted-package dir, --png
// staging, one mesh object per material (the resolver runs per renderer bind).

function meshObjectYaml(base, name, fbxGuid, matGuid) {
    return [
        `--- !u!1 &${base}`,
        'GameObject:',
        `  m_Name: ${name}`,
        '  m_IsActive: 1',
        `--- !u!4 &${base + 1}`,
        'Transform:',
        `  m_GameObject: {fileID: ${base}}`,
        '  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}',
        '  m_LocalPosition: {x: 0, y: 0, z: 0}',
        '  m_LocalScale: {x: 1, y: 1, z: 1}',
        '  m_Father: {fileID: 0}',
        `--- !u!33 &${base + 2}`,
        'MeshFilter:',
        `  m_GameObject: {fileID: ${base}}`,
        `  m_Mesh: {fileID: 4300000, guid: ${fbxGuid}, type: 3}`,
        `--- !u!23 &${base + 3}`,
        'MeshRenderer:',
        `  m_GameObject: {fileID: ${base}}`,
        '  m_Enabled: 1',
        '  m_CastShadows: 1',
        '  m_ReceiveShadows: 1',
        '  m_Materials:',
        `  - {fileID: 2100000, guid: ${matGuid}, type: 2}`,
    ].join('\n');
}

// slots: name -> { guid, scale?, offset? }
function urpMatYaml(name, { keywords = [], renderType = 'Opaque', slots = {}, floats = {}, colors = {} }) {
    const L = ['%YAML 1.1', '%TAG !u! tag:unity3d.com,2011:', '--- !u!21 &2100000', 'Material:', `  m_Name: ${name}`];
    L.push(`  m_Shader: {fileID: 4800000, guid: ${kUrpLitGuid}, type: 3}`);
    if (keywords.length) {
        L.push('  m_ValidKeywords:');
        for (const k of keywords) L.push(`  - ${k}`);
    } else {
        L.push('  m_ValidKeywords: []');
    }
    L.push('  m_InvalidKeywords: []');
    L.push('  stringTagMap:');
    L.push(`    RenderType: ${renderType}`);
    L.push('  m_SavedProperties:');
    L.push('    serializedVersion: 3');
    L.push('    m_TexEnvs:');
    for (const [slot, s] of Object.entries(slots)) {
        const scale = s.scale || [1, 1];
        const offset = s.offset || [0, 0];
        L.push(`    - ${slot}:`);
        L.push(`        m_Texture: {fileID: 2800000, guid: ${s.guid}, type: 3}`);
        L.push(`        m_Scale: {x: ${scale[0]}, y: ${scale[1]}}`);
        L.push(`        m_Offset: {x: ${offset[0]}, y: ${offset[1]}}`);
    }
    L.push('    m_Ints: []');
    L.push('    m_Floats:');
    for (const [k, v] of Object.entries(floats)) L.push(`    - ${k}: ${v}`);
    L.push('    m_Colors:');
    for (const [k, v] of Object.entries(colors))
        L.push(`    - ${k}: {r: ${v[0]}, g: ${v[1]}, b: ${v[2]}, a: ${v[3]}}`);
    L.push('');
    return L.join('\n');
}

const kSceneGuid = '000000000000000000000000000b0001';
const kFbxGuid = '000000000000000000000000000b0002';
const kAlbedoGuid = '000000000000000000000000000b00a1';
const kNormalGuid = '000000000000000000000000000b00a2';
const kMaskGuid = '000000000000000000000000000b00a3';
const kAoGuid = '000000000000000000000000000b00a4';
const kEmitGuid = '000000000000000000000000000b00a5';
const kMatFullGuid = '000000000000000000000000000b00f1';
const kMatNoEmGuid = '000000000000000000000000000b00f2';

function buildFixture(tmp) {
    // The shared _BaseMap ST (scale 2,0.5 / offset 0.25,0.1) exercises the
    // fractional-V case where the naive copy and the V-flip-exact map differ.
    const entries = {
        [kSceneGuid]: {
            pathname: 'Assets/Scenes/UrpTown.unity',
            asset: ['%YAML 1.1', '%TAG !u! tag:unity3d.com,2011:',
                meshObjectYaml(100, 'Full', kFbxGuid, kMatFullGuid),
                meshObjectYaml(200, 'NoEmission', kFbxGuid, kMatNoEmGuid),
                ''].join('\n'),
        },
        [kFbxGuid]: { pathname: 'Assets/UrpPack/Models/SM_Prop_Urp_01.fbx', asset: 'FBX-BYTES' },
        [kAlbedoGuid]: { pathname: 'Assets/UrpPack/Textures/T_Urp_Albedo.png', asset: 'PNG-ALBEDO' },
        [kNormalGuid]: { pathname: 'Assets/UrpPack/Textures/T_Urp_Normal.png', asset: 'PNG-NORMAL' },
        [kMaskGuid]: { pathname: 'Assets/UrpPack/Textures/T_Urp_Metallic.png', asset: 'PNG-METALLIC' },
        [kAoGuid]: { pathname: 'Assets/UrpPack/Textures/T_Urp_AO.png', asset: 'PNG-AO' },
        [kEmitGuid]: { pathname: 'Assets/UrpPack/Textures/T_Urp_Emit.png', asset: 'PNG-EMIT' },
        [kMatFullGuid]: {
            pathname: 'Assets/UrpPack/Materials/M_UrpFull.mat',
            asset: urpMatYaml('M_UrpFull', {
                keywords: ['_EMISSION'],
                slots: {
                    _BaseMap: { guid: kAlbedoGuid, scale: [2, 0.5], offset: [0.25, 0.1] },
                    _BumpMap: { guid: kNormalGuid },
                    _MetallicGlossMap: { guid: kMaskGuid },
                    _OcclusionMap: { guid: kAoGuid },
                    _EmissionMap: { guid: kEmitGuid },
                },
                floats: {
                    _Surface: 0, _AlphaClip: 0, _Cull: 2, _WorkflowMode: 1,
                    _Metallic: 0.3, _Smoothness: 0.4, _BumpScale: 0.8, _OcclusionStrength: 0.9,
                },
                colors: { _BaseColor: [1, 1, 1, 1], _EmissionColor: [2, 1, 0.5, 1] },
            }),
        },
        // Identical emission authoring MINUS the keyword: the map must not bind.
        [kMatNoEmGuid]: {
            pathname: 'Assets/UrpPack/Materials/M_UrpNoEm.mat',
            asset: urpMatYaml('M_UrpNoEm', {
                slots: {
                    _BaseMap: { guid: kAlbedoGuid },
                    _EmissionMap: { guid: kEmitGuid },
                },
                floats: { _Surface: 0, _Metallic: 0, _Smoothness: 0.5 },
                colors: { _BaseColor: [1, 1, 1, 1], _EmissionColor: [2, 1, 0.5, 1] },
            }),
        },
    };
    const pkgDir = path.join(tmp, 'pkg');
    for (const [guid, e] of Object.entries(entries)) {
        const gdir = path.join(pkgDir, guid);
        fs.mkdirSync(gdir, { recursive: true });
        fs.writeFileSync(path.join(gdir, 'pathname'), e.pathname + '\n');
        fs.writeFileSync(path.join(gdir, 'asset'), e.asset);
    }
    const proj = path.join(tmp, 'proj');
    fs.mkdirSync(proj, { recursive: true });
    return { pkgDir, proj };
}

const tmpdirs = [];
after(() => {
    for (const d of tmpdirs) fs.rmSync(d, { recursive: true, force: true });
});

let sharedRun = null;
function shared() {
    if (!sharedRun) {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'urp-lit-'));
        tmpdirs.push(tmp);
        const fx = buildFixture(tmp);
        const res = spawnSync(process.execPath,
            [CONVERT, '--pkg', fx.pkgDir, '--scene', 'UrpTown.unity', '--project', fx.proj, '--png'],
            { encoding: 'utf8' });
        assert.equal(res.status, 0, `exit ${res.status}\nstderr:\n${res.stderr}`);
        sharedRun = { fx, res };
    }
    return sharedRun;
}

function readMaterial(proj, namePrefix) {
    const dir = path.join(proj, 'assets', 'Materials_Unity');
    const file = fs.readdirSync(dir).find((f) => f.startsWith(namePrefix));
    assert.ok(file, `material ${namePrefix}* generated`);
    return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
}

test('full URP Lit material binds albedo/normal/ao/emissive and NOT the metallic-gloss map', () => {
    const { fx } = shared();
    const doc = readMaterial(fx.proj, 'M_UrpFull');
    assert.ok(doc.textures.albedoMap, 'albedoMap bound');
    assert.ok(doc.textures.normalMap, 'normalMap bound');
    assert.ok(doc.textures.aoMap, 'aoMap bound');
    assert.ok(doc.textures.emissiveMap, 'emissiveMap bound (_EMISSION on)');
    assert.equal(doc.textures.metallicRoughnessMap, undefined,
        'metallic-gloss map must be honest-dropped, not bound to wrong channels');
    assert.equal(doc.properties.metallic, 0.3);
    assert.ok(Math.abs(doc.properties.roughness - 0.6) < 1e-9);
});

test('shared _BaseMap ST carries to every bound slot with the V-flip-exact affine map', () => {
    const { fx } = shared();
    const doc = readMaterial(fx.proj, 'M_UrpFull');
    // scale (2, 0.5), offset (0.25, 0.1): engine V row = {sy, 1 - sy - oy}
    // -> tiling [2, 0.5], offset [0.25, 1 - 0.5 - 0.1 = 0.4].
    for (const slot of ['albedoMap', 'normalMap', 'aoMap', 'emissiveMap']) {
        assert.deepEqual(doc.textures[slot].tiling, [2, 0.5], `${slot} tiling`);
        assert.deepEqual(doc.textures[slot].offset, [0.25, 0.4], `${slot} offset`);
    }
});

test('mutation: same emission authoring without _EMISSION binds no emissiveMap', () => {
    const { fx } = shared();
    const doc = readMaterial(fx.proj, 'M_UrpNoEm');
    assert.ok(doc.textures.albedoMap, 'albedoMap bound');
    assert.equal(doc.textures.emissiveMap, undefined, 'keyword gate must hold');
    assert.equal(doc.properties.emissive, undefined);
});

test('report names the URP_Lit family and the per-material honest drops', () => {
    const { res } = shared();
    assert.match(res.stdout, /URP_Lit\s+generated\s+2/);
    assert.match(res.stdout, /\[material\] URP\/Lit M_UrpFull: metallic\/spec-gloss map dropped/);
    assert.match(res.stdout, /\[material\] URP\/Lit M_UrpFull: _BumpScale != 1 dropped/);
    assert.match(res.stdout, /\[material\] URP\/Lit M_UrpFull: _OcclusionStrength != 1 dropped/);
    // The clean material must NOT appear in the drop summary.
    assert.ok(!res.stdout.includes('URP/Lit M_UrpNoEm:'), 'no false drops for the clean material');
});
