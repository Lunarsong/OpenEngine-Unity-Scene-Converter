// KTX2 texture-staging guards for the `--texc` lane.
//
// The editor's import modal always passes `--texc <TextureCompiler>`, so every
// shipped import goes through this path, yet the rest of the corpus pins
// `--png` (raw copies) — the compressed lane was uncovered. What is pinned
// here is the CONVERTER's half of the lane, not the encoder's:
//   - slot -> encoder flag: colour `--srgb`, masks/MR/AO `--linear`, normals
//     `--normal-map`;
//   - destination naming: colour keeps the bare stem, data slots take a
//     `_linear` / `_normal` suffix, so one image bound as two kinds cannot
//     collide on one container;
//   - materials reference `Textures_Unity/<name>.ktx2` (deterministic guid),
//     never the source image;
//   - source preference: an assetdb-resolved project texture is encoded in
//     place of the pack's copy;
//   - encode reuse: an existing container is never re-encoded;
//   - a failing encode degrades to the raw-copy behaviour instead of dropping
//     the texture;
//   - the `ktx2-encoded:` stat line, the --json `materials.texEncoded` counter
//     and the per-file `textures` progress items the modal's tally reads.
//
// The real TextureCompiler is a native tool this package does not ship, so the
// fixture stands one in the way the Synty soak did: a deterministic encoder
// whose output is a pure function of (source bytes, flag) —
// `FAKEKTX2 <flag> <byte count> <sha256>\n` followed by the source bytes. It
// is delivered by pointing `--texc` at the Node binary itself and giving each
// synthetic "image" a body that IS the encoder: the converter spawns
// `<texc> <src> <dest> <flag>`, which Node runs as `node <script> <dest>
// <flag>`. That keeps the fixture dependency-free and identical on every
// platform (no shell wrapper, no chmod, no compiled helper). Each spawn costs
// a Node start-up, so the conversions are shared across tests rather than
// re-run per assertion.
//
// All fixtures are synthetic — no licensed content.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONVERT = path.join(__dirname, '..', 'src', 'convert.js');

const kSceneGuid = '000000000000000000000000000000a1';
const kCrateFbxGuid = '000000000000000000000000000000d4';
const kAlbedoGuid = '000000000000000000000000000000e1';
const kNormalGuid = '000000000000000000000000000000e2';
const kMaskGuid = '000000000000000000000000000000e3';
const kBrokenGuid = '000000000000000000000000000000e4';
const kMatCrateGuid = '000000000000000000000000000000f1';
const kMatReuseGuid = '000000000000000000000000000000f2';
const kMatBrokenGuid = '000000000000000000000000000000f3';
const kShaderGuid = '000000000000000000000000000000e9'; // unknown family, recognizable slots

// ------------------------------------------------- stand-in encoder bodies --
const kEncoderModule = [
    "'use strict';",
    '// Deterministic TextureCompiler stand-in: same CLI shape as the real tool',
    '// (<src> <dest> --srgb|--linear|--normal-map). Output is a pure function of',
    '// the source bytes and the flag, so every assertion below is exact.',
    'module.exports = function encode() {',
    "    const fs = require('fs');",
    "    const crypto = require('crypto');",
    '    const [, src, dest, flag] = process.argv;',
    '    const bytes = fs.readFileSync(src);',
    "    const sha = crypto.createHash('sha256').update(bytes).digest('hex');",
    '    fs.writeFileSync(dest, Buffer.concat([',
    '        Buffer.from(`FAKEKTX2 ${flag} ${bytes.length} ${sha}\\n`), bytes]));',
    '};',
    '',
].join('\n');

// A synthetic image body. Distinct per marker (so containers differ) and, when
// the converter hands it to the "encoder", it performs the encode itself.
function imageBody(encoderPath, marker) {
    return `require(${JSON.stringify(encoderPath)})(); // image bytes: ${marker}\n`;
}

// An image whose encode fails: writes nothing, exits non-zero.
function brokenImageBody(marker) {
    return `process.exit(1); // image bytes: ${marker}\n`;
}

function expectedContainer(sourceBytes, flag) {
    const bytes = Buffer.from(sourceBytes);
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    return Buffer.concat([Buffer.from(`FAKEKTX2 ${flag} ${bytes.length} ${sha}\n`), bytes]);
}

// ------------------------------------------------------------------ fixture --
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

// slots: { _BaseMap: guid, _BumpMap: guid, _MetallicGlossMap: guid }
function matYaml(name, slots) {
    const texEnvs = Object.entries(slots).map(([slot, guid]) => [
        `    - ${slot}:`,
        `        m_Texture: {fileID: 2800000, guid: ${guid}, type: 3}`,
        '        m_Scale: {x: 1, y: 1}',
        '        m_Offset: {x: 0, y: 0}',
    ].join('\n'));
    return [
        '%YAML 1.1',
        '%TAG !u! tag:unity3d.com,2011:',
        '--- !u!21 &2100000',
        'Material:',
        `  m_Name: ${name}`,
        `  m_Shader: {fileID: 4800000, guid: ${kShaderGuid}, type: 3}`,
        '  m_ValidKeywords: []',
        '  m_InvalidKeywords: []',
        '  stringTagMap:',
        '    RenderType: Opaque',
        '  m_SavedProperties:',
        '    serializedVersion: 3',
        '    m_TexEnvs:',
        ...texEnvs,
        '    m_Ints: []',
        '    m_Floats:',
        '    - _Metallic: 0',
        '    - _Smoothness: 0.4',
        '    m_Colors:',
        '    - _BaseColor: {r: 1, g: 1, b: 1, a: 1}',
        '',
    ].join('\n');
}

// Source bytes, keyed by role, so assertions can recompute containers exactly.
function sourceBodies(encoderPath) {
    return {
        packAlbedo: imageBody(encoderPath, 'pack albedo'),       // shadowed by the project copy
        projectAlbedo: imageBody(encoderPath, 'project albedo'), // assetdb-resolved source
        normal: imageBody(encoderPath, 'normal'),
        mask: imageBody(encoderPath, 'mask'),
        broken: brokenImageBody('broken'),
    };
}

function buildFixture(tmp) {
    const encoderPath = path.join(tmp, 'faketexc.cjs');
    fs.writeFileSync(encoderPath, kEncoderModule);
    const src = sourceBodies(encoderPath);

    const entries = {
        [kSceneGuid]: {
            pathname: 'Assets/Scenes/TexTown.unity',
            asset: ['%YAML 1.1', '%TAG !u! tag:unity3d.com,2011:',
                meshObjectYaml(100, 'Crate', kCrateFbxGuid, kMatCrateGuid),
                meshObjectYaml(200, 'CrateReuse', kCrateFbxGuid, kMatReuseGuid),
                meshObjectYaml(300, 'CrateBroken', kCrateFbxGuid, kMatBrokenGuid),
                ''].join('\n'),
        },
        [kCrateFbxGuid]: { pathname: 'Assets/PolyPack/Models/SM_Prop_Crate_01.fbx', asset: 'FBX-BYTES' },
        [kAlbedoGuid]: { pathname: 'Assets/PolyPack/Textures/T_Crate_Albedo.png', asset: src.packAlbedo },
        [kNormalGuid]: { pathname: 'Assets/PolyPack/Textures/T_Crate_Normal.png', asset: src.normal },
        [kMaskGuid]: { pathname: 'Assets/PolyPack/Textures/T_Crate_Mask.png', asset: src.mask },
        [kBrokenGuid]: { pathname: 'Assets/PolyPack/Textures/T_Crate_Broken.png', asset: src.broken },
        // Colour + normal + MR/AO slots, so all three encoder flags are exercised.
        [kMatCrateGuid]: {
            pathname: 'Assets/PolyPack/Materials/M_Crate.mat',
            asset: matYaml('M_Crate', { _BaseMap: kAlbedoGuid, _BumpMap: kNormalGuid, _MetallicGlossMap: kMaskGuid }),
        },
        // The SAME image in a colour slot and a normal slot: two containers.
        [kMatReuseGuid]: {
            pathname: 'Assets/PolyPack/Materials/M_Reuse.mat',
            asset: matYaml('M_Reuse', { _BaseMap: kAlbedoGuid, _BumpMap: kAlbedoGuid }),
        },
        [kMatBrokenGuid]: {
            pathname: 'Assets/PolyPack/Materials/M_Broken.mat',
            asset: matYaml('M_Broken', { _BaseMap: kBrokenGuid }),
        },
    };

    const pkgDir = path.join(tmp, 'pkg');
    for (const [guid, e] of Object.entries(entries)) {
        const gdir = path.join(pkgDir, guid);
        fs.mkdirSync(gdir, { recursive: true });
        fs.writeFileSync(path.join(gdir, 'pathname'), e.pathname + '\n');
        fs.writeFileSync(path.join(gdir, 'asset'), e.asset);
    }

    // Project: the crate model and the albedo texture are "already imported";
    // the project's own albedo copy differs from the pack's, so the container
    // proves which source the encoder was pointed at.
    const proj = path.join(tmp, 'proj');
    fs.mkdirSync(path.join(proj, 'assets', 'textures'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'assets', 'textures', 'T_Crate_Albedo.png'), src.projectAlbedo);

    const db = path.join(tmp, 'AssetDatabase.assetdb');
    fs.writeFileSync(db, [
        JSON.stringify({ format: 'assetdb', version: 1 }),
        JSON.stringify({ guid: '11111111-2222-3333-4444-555555555555', path: 'models/SM_Prop_Crate_01.fbx', type: 'Model' }),
        JSON.stringify({ guid: '11111111-2222-3333-4444-666666666666', path: 'textures/T_Crate_Albedo.png', type: 'Texture' }),
        '',
    ].join('\n'));

    return { tmp, pkgDir, proj, db, src };
}

function run(args) {
    return spawnSync(process.execPath, [CONVERT, ...args], { encoding: 'utf8' });
}

// The stand-in encoder IS the Node binary running the "image" as a script.
function convertWithTexc(fx, extra = []) {
    return run(['--pkg', fx.pkgDir, '--scene', 'TexTown.unity', '--project', fx.proj,
                '--assetdb', fx.db, '--texc', process.execPath, ...extra]);
}

const tmpdirs = [];
function newFixture(tag) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), tag));
    tmpdirs.push(tmp);
    return buildFixture(tmp);
}
after(() => {
    for (const d of tmpdirs) fs.rmSync(d, { recursive: true, force: true });
});

// One --texc conversion, shared by the assertions that only read its result
// (each encode is a process spawn, so re-running per test is pure cost).
let sharedRun = null;
function shared() {
    if (!sharedRun) {
        const fx = newFixture('texc-shared-');
        const res = convertWithTexc(fx, ['--verbose']);
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

function texDir(proj) {
    return path.join(proj, 'assets', 'Textures_Unity');
}

// -------------------------------------------------------------------- tests --

test('--texc encodes each slot with its own flag and suffix, and materials bind the .ktx2', () => {
    const { fx, res } = shared();
    assert.match(res.stderr, /KTX2 encoder:/);

    // Colour keeps the bare stem; data slots take their kind suffix.
    const albedo = path.join(texDir(fx.proj), 'T_Crate_Albedo.ktx2');
    const normal = path.join(texDir(fx.proj), 'T_Crate_Normal_normal.ktx2');
    const mask = path.join(texDir(fx.proj), 'T_Crate_Mask_linear.ktx2');
    for (const p of [albedo, normal, mask]) assert.ok(fs.existsSync(p), `missing ${path.basename(p)}`);

    // Flag per slot, and (for the albedo) the assetdb-resolved PROJECT copy as
    // the source rather than the pack's.
    assert.ok(fs.readFileSync(albedo).equals(expectedContainer(fx.src.projectAlbedo, '--srgb')),
              'albedo must be the project copy encoded with --srgb');
    assert.ok(fs.readFileSync(normal).equals(expectedContainer(fx.src.normal, '--normal-map')),
              'normal slot must encode with --normal-map');
    assert.ok(fs.readFileSync(mask).equals(expectedContainer(fx.src.mask, '--linear')),
              'MR/mask slot must encode with --linear');

    // Materials reference the containers, never the source image.
    const mat = readMaterial(fx.proj, 'M_Crate');
    assert.equal(mat.textures.albedoMap.path, 'Textures_Unity/T_Crate_Albedo.ktx2');
    assert.equal(mat.textures.normalMap.path, 'Textures_Unity/T_Crate_Normal_normal.ktx2');
    assert.equal(mat.textures.metallicRoughnessMap.path, 'Textures_Unity/T_Crate_Mask_linear.ktx2');
    assert.match(mat.textures.albedoMap.guid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // The only raw image staged is the one whose encode failed (below).
    assert.deepEqual(fs.readdirSync(texDir(fx.proj)).filter((f) => f.endsWith('.png')), ['T_Crate_Broken.png']);
});

test('one image bound as colour and as normal produces two containers, not one', () => {
    const { fx } = shared();
    const asColor = path.join(texDir(fx.proj), 'T_Crate_Albedo.ktx2');
    const asNormal = path.join(texDir(fx.proj), 'T_Crate_Albedo_normal.ktx2');
    assert.ok(fs.existsSync(asNormal), 'the normal-slot binding needs its own container');
    assert.ok(fs.readFileSync(asColor).equals(expectedContainer(fx.src.projectAlbedo, '--srgb')));
    assert.ok(fs.readFileSync(asNormal).equals(expectedContainer(fx.src.projectAlbedo, '--normal-map')));

    const reuse = readMaterial(fx.proj, 'M_Reuse');
    assert.equal(reuse.textures.albedoMap.path, 'Textures_Unity/T_Crate_Albedo.ktx2');
    assert.equal(reuse.textures.normalMap.path, 'Textures_Unity/T_Crate_Albedo_normal.ktx2');
});

test('a failing encode degrades to the raw copy instead of dropping the texture', () => {
    const { fx, res } = shared();
    assert.equal(fs.existsSync(path.join(texDir(fx.proj), 'T_Crate_Broken.ktx2')), false);
    assert.equal(fs.readFileSync(path.join(texDir(fx.proj), 'T_Crate_Broken.png'), 'utf8'), fx.src.broken,
                 'source image copied in verbatim when the encode fails');
    assert.equal(readMaterial(fx.proj, 'M_Broken').textures.albedoMap.path, 'Textures_Unity/T_Crate_Broken.png');
    assert.match(res.stderr, /ktx2 encode failed/);
});

test('the human summary reports the ktx2 lane', () => {
    const { res } = shared();
    // 4 containers: albedo (srgb), albedo (normal-map), normal, mask; the
    // broken one is the copied-in fallback.
    assert.match(res.stdout, /material textures resolved:0 \(ktx2-encoded: 4, copied-in: 1, unresolved: 0\)/);
});

test('an existing container is reused, never re-encoded', () => {
    const { fx } = shared();
    // Stamp a container produced by the shared run: a re-encode overwrites it.
    const mask = path.join(texDir(fx.proj), 'T_Crate_Mask_linear.ktx2');
    fs.writeFileSync(mask, 'ALREADY-ENCODED-SENTINEL');

    const res = convertWithTexc(fx);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(fs.readFileSync(mask, 'utf8'), 'ALREADY-ENCODED-SENTINEL', 'container was re-encoded');
    // Reused containers still count as encoded and still bind.
    assert.match(res.stdout, /ktx2-encoded: 4/);
    assert.equal(readMaterial(fx.proj, 'M_Crate').textures.metallicRoughnessMap.path,
                 'Textures_Unity/T_Crate_Mask_linear.ktx2');
});

test('--json reports the lane: texEncoded counter, per-file progress items, declared outputs', () => {
    const fx = newFixture('texc-json-');
    const res = convertWithTexc(fx, ['--json']);
    assert.equal(res.status, 0, res.stderr);

    const lines = res.stdout.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    const summary = lines[lines.length - 1];
    assert.equal(summary.phase, 'summary');
    assert.equal(summary.materials.texEncoded, 4);
    assert.equal(summary.materials.texCopied, 1);
    assert.equal(summary.materials.texUnresolved, 0);

    // The modal's texture tally: one progress item per staged file.
    const staged = lines.filter((l) => l.phase === 'textures').map((l) => l.detail);
    assert.deepEqual(staged.sort(), [
        'Textures_Unity/T_Crate_Albedo.ktx2',
        'Textures_Unity/T_Crate_Albedo_normal.ktx2',
        'Textures_Unity/T_Crate_Broken.png',
        'Textures_Unity/T_Crate_Mask_linear.ktx2',
        'Textures_Unity/T_Crate_Normal_normal.ktx2',
    ]);
    // Every staged file is also declared as an output (the modal's overwrite check).
    assert.equal(summary.outputs.filter((o) => o.kind === 'texture').length, 5);
});

test('--png keeps the raw-copy lane (no containers, imported textures referenced in place)', () => {
    const fx = newFixture('texc-png-');
    const res = convertWithTexc(fx, ['--png']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(fs.readdirSync(texDir(fx.proj)).some((f) => f.endsWith('.ktx2')), false);
    assert.equal(readMaterial(fx.proj, 'M_Crate').textures.albedoMap.path, 'textures/T_Crate_Albedo.png');
    assert.match(res.stdout, /ktx2-encoded: 0/);
});
