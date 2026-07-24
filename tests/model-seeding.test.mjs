// Mesh auto-seeding guards: a scene that references a pack FBX the target
// project has never imported must NOT emit an UNRESOLVED stub — the converter
// extracts the pack's own FBX bytes into Models_Unity/<pack-relative> and
// references it by path (guid="") so the editor's post-move registration
// binds it. Contracts pinned here:
//   - assetdb resolution stays FIRST: already-imported project models win,
//     so re-imports never duplicate content;
//   - seeding preserves the multi-scene byte-identical subset property;
//   - counters flip unresolved -> seeded (per-scene seededMeshes, summary
//     models.seeded, outputs kind "model");
//   - no --project (CLI --out mode) or a guid absent from the pack still
//     reports UNRESOLVED — seeding never invents content.
// The in-editor import modal is built on these: its "models extracted" phase
// and the no-pre-step import flow regress if this file goes red.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONVERT = path.join(__dirname, '..', 'src', 'convert.js');

// ---------------------------------------------------------------- fixture ---
const kSceneTownGuid = '000000000000000000000000000000a1';
const kSceneCoveGuid = '000000000000000000000000000000b2';
const kSceneGapGuid = '000000000000000000000000000000c3';
const kSceneTexGuid = '000000000000000000000000000000a4';
const kCrateFbxGuid = '000000000000000000000000000000d4';
const kRockFbxGuid = '000000000000000000000000000000e5';
const kAbsentFbxGuid = '000000000000000000000000000000f6'; // never in the bundle
const kTexPngGuid = '000000000000000000000000000000e7';
const kMatGuid = '000000000000000000000000000000e8';
const kShaderGuid = '000000000000000000000000000000e9'; // unknown family, recognizable slots

const kPngBytes = 'PNG-PIXEL-BYTES-03';

const kCrateBytes = 'FBX-CRATE-BYTES-01';
const kRockBytes = 'FBX-ROCK-BYTES-02';

// One GameObject+Transform+MeshFilter+MeshRenderer block referencing an FBX
// guid. `base` keeps anchors unique per object.
function meshObjectYaml(base, name, fbxGuid) {
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
    ].join('\n');
}

function sceneYaml(objects) {
    return ['%YAML 1.1', '%TAG !u! tag:unity3d.com,2011:', ...objects, ''].join('\n');
}

// Mesh object whose renderer binds a .mat (drives material generation +
// texture resolution).
function texturedObjectYaml(base, name, fbxGuid, matGuid) {
    return [
        meshObjectYaml(base, name, fbxGuid),
        '  m_Materials:',
        `  - {fileID: 2100000, guid: ${matGuid}, type: 2}`,
    ].join('\n');
}

function matYaml(name, texGuid) {
    return `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!21 &2100000
Material:
  m_Name: ${name}
  m_Shader: {fileID: 4800000, guid: ${kShaderGuid}, type: 3}
  m_ValidKeywords: []
  m_InvalidKeywords: []
  stringTagMap:
    RenderType: Opaque
  m_SavedProperties:
    serializedVersion: 3
    m_TexEnvs:
    - _BaseMap:
        m_Texture: {fileID: 2800000, guid: ${texGuid}, type: 3}
        m_Scale: {x: 1, y: 1}
        m_Offset: {x: 0, y: 0}
    m_Ints: []
    m_Floats:
    - _Metallic: 0
    - _Smoothness: 0.4
    m_Colors:
    - _BaseColor: {r: 1, g: 0.9, b: 0.8, a: 1}
`;
}

function bundleEntries() {
    return {
        [kSceneTownGuid]: {
            pathname: 'Assets/Scenes/SeedTown.unity',
            asset: sceneYaml([
                meshObjectYaml(100, 'CrateA', kCrateFbxGuid),
                meshObjectYaml(200, 'RockA', kRockFbxGuid),
            ]),
        },
        [kSceneCoveGuid]: {
            pathname: 'Assets/Scenes/SeedCove.unity',
            asset: sceneYaml([meshObjectYaml(100, 'CrateB', kCrateFbxGuid)]),
        },
        [kSceneGapGuid]: {
            pathname: 'Assets/Scenes/SeedGap.unity',
            asset: sceneYaml([meshObjectYaml(100, 'Ghost', kAbsentFbxGuid)]),
        },
        [kSceneTexGuid]: {
            pathname: 'Assets/Scenes/SeedTex.unity',
            asset: sceneYaml([texturedObjectYaml(100, 'TexCrate', kCrateFbxGuid, kMatGuid)]),
        },
        [kCrateFbxGuid]: { pathname: 'Assets/PolyPack/Models/SM_Prop_Crate_01.fbx', asset: kCrateBytes },
        [kRockFbxGuid]: { pathname: 'Assets/PolyPack/Models/SM_Env_Rock_02.fbx', asset: kRockBytes },
        [kTexPngGuid]: { pathname: 'Assets/PolyPack/Textures/T_Crate_Albedo.png', asset: kPngBytes },
        [kMatGuid]: { pathname: 'Assets/PolyPack/Materials/M_Crate.mat', asset: matYaml('M_Crate', kTexPngGuid) },
    };
}

function writeExtractedDir(dir) {
    for (const [guid, e] of Object.entries(bundleEntries())) {
        const gdir = path.join(dir, guid);
        fs.mkdirSync(gdir, { recursive: true });
        fs.writeFileSync(path.join(gdir, 'pathname'), e.pathname + '\n');
        fs.writeFileSync(path.join(gdir, 'asset'), e.asset);
    }
    return dir;
}

// Minimal project assetdb journal: the rock is "already imported", the crate
// is not.
function writeAssetDb(file) {
    fs.writeFileSync(file, [
        JSON.stringify({ format: 'assetdb', version: 1 }),
        JSON.stringify({
            guid: '11111111-2222-3333-4444-555555555555',
            path: 'models/SM_Env_Rock_02.fbx',
            type: 'Model',
        }),
        '',
    ].join('\n'));
    return file;
}

function run(args) {
    return spawnSync(process.execPath, [CONVERT, ...args], { encoding: 'utf8' });
}

function tmpdir(tag) {
    return fs.mkdtempSync(path.join(os.tmpdir(), tag));
}

function summaryOf(res) {
    const lines = res.stdout.split('\n').filter((l) => l.trim());
    return { lines: lines.map((l) => JSON.parse(l)), summary: JSON.parse(lines[lines.length - 1]) };
}

// ------------------------------------------------------------------ tests ---
test('seeding: pack FBX missing from the project is extracted and referenced by path', () => {
    const tmp = tmpdir('seed-');
    try {
        const pkgDir = writeExtractedDir(path.join(tmp, 'pkg'));
        const proj = path.join(tmp, 'proj');
        const res = run(['--pkg', pkgDir, '--scene', 'SeedTown.unity', '--project', proj, '--png', '--json']);
        assert.equal(res.status, 0, `exit ${res.status}\nstderr:\n${res.stderr}`);

        // Extracted bytes land at Models_Unity/<pack-relative> (Assets/ stripped).
        const crateDest = path.join(proj, 'assets', 'Models_Unity', 'PolyPack', 'Models', 'SM_Prop_Crate_01.fbx');
        const rockDest = path.join(proj, 'assets', 'Models_Unity', 'PolyPack', 'Models', 'SM_Env_Rock_02.fbx');
        assert.equal(fs.readFileSync(crateDest, 'utf8'), kCrateBytes, 'crate FBX bytes extracted verbatim');
        assert.equal(fs.readFileSync(rockDest, 'utf8'), kRockBytes, 'rock FBX bytes extracted verbatim');

        // Scene references the seeded copies by path with an empty guid
        // (SceneIO path-fallback binds them once the registry scans the move).
        const scene = fs.readFileSync(path.join(proj, 'assets', 'SeedTown_unity.scene'), 'utf8');
        assert.match(scene, /MeshRenderer\.meshAsset = \[path="Models_Unity\/PolyPack\/Models\/SM_Prop_Crate_01\.fbx" guid=""\]/);
        assert.match(scene, /MeshRenderer\.meshAsset = \[path="Models_Unity\/PolyPack\/Models\/SM_Env_Rock_02\.fbx" guid=""\]/);
        assert.doesNotMatch(scene, /UNRESOLVED/);

        const { lines, summary } = summaryOf(res);
        assert.equal(summary.scenes[0].seededMeshes, 2, 'both refs seeded');
        assert.equal(summary.scenes[0].unresolvedMeshes, 0, 'nothing left unresolved');
        assert.equal(summary.scenes[0].resolvedMeshes, 0, 'no assetdb -> nothing assetdb-resolved');
        assert.equal(summary.models.seeded, 2, 'summary counts unique extracted models');
        assert.equal(summary.outputs.filter((o) => o.kind === 'model').length, 2, 'model outputs recorded for the move pass');
        assert.ok(lines.some((o) => o.phase === 'models'), 'models progress phase streamed');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('assetdb-first: an already-imported model wins; only the missing one seeds', () => {
    const tmp = tmpdir('seeddb-');
    try {
        const pkgDir = writeExtractedDir(path.join(tmp, 'pkg'));
        const proj = path.join(tmp, 'proj');
        const db = writeAssetDb(path.join(tmp, 'AssetDatabase.assetdb'));
        const res = run(['--pkg', pkgDir, '--scene', 'SeedTown.unity', '--project', proj,
            '--assetdb', db, '--png', '--json']);
        assert.equal(res.status, 0, `exit ${res.status}\nstderr:\n${res.stderr}`);

        const scene = fs.readFileSync(path.join(proj, 'assets', 'SeedTown_unity.scene'), 'utf8');
        assert.match(scene, /MeshRenderer\.meshAsset = \[path="models\/SM_Env_Rock_02\.fbx" guid="11111111-2222-3333-4444-555555555555"\]/,
            'rock binds the project asset, not a seeded copy');
        assert.match(scene, /MeshRenderer\.meshAsset = \[path="Models_Unity\/PolyPack\/Models\/SM_Prop_Crate_01\.fbx" guid=""\]/,
            'crate still seeds');
        assert.ok(!fs.existsSync(path.join(proj, 'assets', 'Models_Unity', 'PolyPack', 'Models', 'SM_Env_Rock_02.fbx')),
            'no duplicate copy of the already-imported rock');

        const { summary } = summaryOf(res);
        assert.equal(summary.scenes[0].resolvedMeshes, 1);
        assert.equal(summary.scenes[0].seededMeshes, 1);
        assert.equal(summary.scenes[0].unresolvedMeshes, 0);
        assert.equal(summary.models.seeded, 1);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('subset consistency: seeded scenes stay byte-identical between multi-scene and standalone runs', () => {
    const tmp = tmpdir('seedsub-');
    try {
        const pkgDir = writeExtractedDir(path.join(tmp, 'pkg'));
        const projAB = path.join(tmp, 'projAB');
        const projB = path.join(tmp, 'projB');
        const both = run(['--pkg', pkgDir, '--scene', 'SeedTown.unity', '--scene', 'SeedCove.unity',
            '--project', projAB, '--png']);
        const bOnly = run(['--pkg', pkgDir, '--scene', 'SeedCove.unity', '--project', projB, '--png']);
        assert.equal(both.status, 0, both.stderr);
        assert.equal(bOnly.status, 0, bOnly.stderr);
        assert.equal(
            fs.readFileSync(path.join(projAB, 'assets', 'SeedCove_unity.scene'), 'utf8'),
            fs.readFileSync(path.join(projB, 'assets', 'SeedCove_unity.scene'), 'utf8'),
            'seeded scene emitted in a multi-scene run must match the standalone run');
        // The shared crate extracts once per project, identically.
        const rel = ['assets', 'Models_Unity', 'PolyPack', 'Models', 'SM_Prop_Crate_01.fbx'];
        assert.equal(fs.readFileSync(path.join(projAB, ...rel), 'utf8'), kCrateBytes);
        assert.equal(fs.readFileSync(path.join(projB, ...rel), 'utf8'), kCrateBytes);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('no --project (CLI --out mode): seeding is off, the ref stays UNRESOLVED', () => {
    const tmp = tmpdir('seedout-');
    try {
        const pkgDir = writeExtractedDir(path.join(tmp, 'pkg'));
        const out = path.join(tmp, 'out', 'Town.scene');
        const res = run(['--pkg', pkgDir, '--scene', 'SeedTown.unity', '--out', out]);
        assert.equal(res.status, 0, res.stderr);
        const scene = fs.readFileSync(out, 'utf8');
        assert.match(scene, /; UNRESOLVED mesh asset: SM_Prop_Crate_01\.fbx/);
        assert.ok(!fs.existsSync(path.join(tmp, 'out', 'Models_Unity')), 'nothing extracted without a project stage');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('no assetdb: material textures still copy in from the pack (import-everything)', () => {
    const tmp = tmpdir('seedtex-');
    try {
        const pkgDir = writeExtractedDir(path.join(tmp, 'pkg'));
        const proj = path.join(tmp, 'proj');
        const res = run(['--pkg', pkgDir, '--scene', 'SeedTex.unity', '--project', proj, '--png', '--json']);
        assert.equal(res.status, 0, `exit ${res.status}\nstderr:\n${res.stderr}`);

        const texDest = path.join(proj, 'assets', 'Textures_Unity', 'T_Crate_Albedo.png');
        assert.equal(fs.readFileSync(texDest, 'utf8'), kPngBytes, 'pack image copied verbatim');

        // The generated material binds the copied texture by Textures_Unity path.
        const matDir = path.join(proj, 'assets', 'Materials_Unity');
        const matFile = fs.readdirSync(matDir).find((f) => f.startsWith('M_Crate'));
        assert.ok(matFile, 'material generated');
        const mat = JSON.parse(fs.readFileSync(path.join(matDir, matFile), 'utf8'));
        assert.equal(mat.textures.albedoMap.path, 'Textures_Unity/T_Crate_Albedo.png');

        const { summary } = summaryOf(res);
        assert.equal(summary.materials.texCopied, 1);
        assert.equal(summary.materials.texUnresolved, 0);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('guid absent from the pack: honest UNRESOLVED, never fabricated', () => {
    const tmp = tmpdir('seedgap-');
    try {
        const pkgDir = writeExtractedDir(path.join(tmp, 'pkg'));
        const proj = path.join(tmp, 'proj');
        const res = run(['--pkg', pkgDir, '--scene', 'SeedGap.unity', '--project', proj, '--png', '--json']);
        assert.equal(res.status, 0, `exit ${res.status}\nstderr:\n${res.stderr}`);
        const { summary } = summaryOf(res);
        assert.equal(summary.scenes[0].seededMeshes, 0);
        assert.equal(summary.scenes[0].unresolvedMeshes, 1);
        const scene = fs.readFileSync(path.join(proj, 'assets', 'SeedGap_unity.scene'), 'utf8');
        assert.match(scene, /; UNRESOLVED mesh asset/);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
