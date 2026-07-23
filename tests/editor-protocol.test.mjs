// Editor-integration protocol guards: --list-scenes inventory mode, --json
// progress/summary lines, raw .unitypackage input, and multi-scene subset
// conversion.
//
// The in-editor "Import Unity Scenes" modal is built ON these contracts:
//   - --list-scenes populates the scene multi-select (fast, no conversion);
//   - --json turns stdout into JSON lines the editor parses for the progress
//     bar, the overwrite-collision check (summary.outputs), and the
//     "Open Scene" menu (per-scene output paths);
//   - a raw .unitypackage is accepted anywhere an extracted dir is;
//   - converting a SUBSET of scenes emits each scene byte-identical to a
//     standalone run while sharing Materials_Unity/Textures_Unity emission.
// A regression here breaks the editor UI, not just the CLI.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONVERT = path.join(__dirname, '..', 'src', 'convert.js');

// ---------------------------------------------------------------- fixture ---
const kSceneAGuid = '000000000000000000000000000000aa';
const kSceneBGuid = '000000000000000000000000000000bb';

function sceneYaml(objectName) {
    return [
        '%YAML 1.1',
        '%TAG !u! tag:unity3d.com,2011:',
        '--- !u!1 &100',
        'GameObject:',
        `  m_Name: ${objectName}`,
        '  m_IsActive: 1',
        '--- !u!4 &101',
        'Transform:',
        '  m_GameObject: {fileID: 100}',
        '  m_LocalRotation: {x: 0, y: 0.258819, z: 0, w: 0.9659258}',
        '  m_LocalPosition: {x: 1, y: 2, z: 3}',
        '  m_LocalScale: {x: 1, y: 1, z: 1}',
        '  m_Father: {fileID: 0}',
        '--- !u!33 &102',
        'MeshFilter:',
        '  m_GameObject: {fileID: 100}',
        '  m_Mesh: {fileID: 10202, guid: 0000000000000000e000000000000000, type: 0}',
        '--- !u!23 &103',
        'MeshRenderer:',
        '  m_GameObject: {fileID: 100}',
        '  m_Enabled: 1',
        '  m_CastShadows: 1',
        '  m_ReceiveShadows: 1',
        '',
    ].join('\n');
}

// Bundle entries: <guid> -> { pathname, asset } — two scenes plus assorted
// non-scene assets so the inventory counts have something to count.
function bundleEntries() {
    return {
        [kSceneAGuid]: { pathname: 'Assets/Scenes/AlphaTown.unity', asset: sceneYaml('AlphaCube') },
        [kSceneBGuid]: { pathname: 'Assets/Scenes/BetaCove.unity', asset: sceneYaml('BetaCube') },
        '000000000000000000000000000000c1': { pathname: 'Assets/Materials/Rock.mat', asset: 'not parsed' },
        '000000000000000000000000000000c2': { pathname: 'Assets/Models/Rock.fbx', asset: 'not parsed' },
        '000000000000000000000000000000c3': { pathname: 'Assets/Textures/Rock_Albedo.png', asset: 'not parsed' },
        '000000000000000000000000000000c4': { pathname: 'Assets/Prefabs/Rock.prefab', asset: 'not parsed' },
        '000000000000000000000000000000c5': { pathname: 'Assets/Scenes', asset: '' }, // folder asset
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

// Minimal ustar writer — enough to synthesize a real .unitypackage (gzipped
// tar of <guid>/{pathname,asset}) without any dependency.
function tarHeader(name, size) {
    const h = Buffer.alloc(512);
    h.write(name, 0, 'utf8');
    h.write('0000644\0', 100, 'ascii');
    h.write('0000000\0', 108, 'ascii');
    h.write('0000000\0', 116, 'ascii');
    h.write(size.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
    h.write('00000000000\0', 136, 'ascii');
    h.write('        ', 148, 'ascii');
    h.write('0', 156, 'ascii');
    h.write('ustar', 257, 'ascii');
    h.write('00', 263, 'ascii');
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
    return h;
}
function writeUnityPackage(file) {
    const parts = [];
    for (const [guid, e] of Object.entries(bundleEntries())) {
        for (const [leaf, body] of [['pathname', e.pathname + '\n'], ['asset', e.asset]]) {
            const buf = Buffer.from(body);
            parts.push(tarHeader(`${guid}/${leaf}`, buf.length), buf,
                Buffer.alloc((512 - (buf.length % 512)) % 512));
        }
    }
    parts.push(Buffer.alloc(1024));
    fs.writeFileSync(file, zlib.gzipSync(Buffer.concat(parts)));
    return file;
}

function run(args) {
    return spawnSync(process.execPath, [CONVERT, ...args], { encoding: 'utf8' });
}

function tmpdir(tag) {
    return fs.mkdtempSync(path.join(os.tmpdir(), tag));
}

// ------------------------------------------------------------ --list-scenes -
function assertInventory(res, bundleKind) {
    assert.equal(res.status, 0, `exit ${res.status}\nstderr:\n${res.stderr}`);
    const inv = JSON.parse(res.stdout);
    assert.equal(inv.bundleKind, bundleKind);
    assert.equal(inv.scenes.length, 2, 'two scenes listed');
    assert.deepEqual(inv.scenes.map((s) => s.name), ['AlphaTown', 'BetaCove'], 'sorted by path');
    assert.equal(inv.scenes[0].path, 'Assets/Scenes/AlphaTown.unity');
    assert.equal(inv.scenes[0].guid, kSceneAGuid);
    assert.equal(inv.assetCounts.scene, 2);
    assert.equal(inv.assetCounts.material, 1);
    assert.equal(inv.assetCounts.model, 1);
    assert.equal(inv.assetCounts.texture, 1);
    assert.equal(inv.assetCounts.prefab, 1);
    assert.equal(inv.assetCounts.folder, 1);
    assert.equal(inv.totalAssets, 7);
}

test('--list-scenes: extracted dir -> JSON inventory, no conversion', () => {
    const tmp = tmpdir('lsdir-');
    try {
        const pkgDir = writeExtractedDir(path.join(tmp, 'pkg'));
        assertInventory(run(['--list-scenes', pkgDir]), 'extracted-dir');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('--list-scenes: raw .unitypackage -> same inventory without extraction', () => {
    const tmp = tmpdir('lspkg-');
    try {
        const pkg = writeUnityPackage(path.join(tmp, 'demo.unitypackage'));
        assertInventory(run(['--list-scenes', pkg]), 'unitypackage');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------- --json -
test('--json: stdout is pure JSON lines — progress schema + final summary', () => {
    const tmp = tmpdir('json-');
    try {
        const pkgDir = writeExtractedDir(path.join(tmp, 'pkg'));
        const proj = path.join(tmp, 'proj');
        const res = run(['--pkg', pkgDir, '--scene', 'AlphaTown.unity', '--project', proj, '--png', '--json']);
        assert.equal(res.status, 0, `exit ${res.status}\nstderr:\n${res.stderr}`);

        const lines = res.stdout.split('\n').filter((l) => l.trim());
        assert.ok(lines.length >= 4, `expected >=4 JSON lines, got ${lines.length}`);
        const objs = lines.map((l, i) => {
            try { return JSON.parse(l); }
            catch { assert.fail(`stdout line ${i} is not JSON: ${l}`); }
        });

        // Progress lines: {phase, step, total, detail}, step increasing to total.
        const progress = objs.filter((o) => o.phase !== 'summary');
        assert.ok(progress.length >= 3, 'index/expand/emit/write progress lines');
        for (const p of progress) {
            assert.equal(typeof p.phase, 'string');
            assert.equal(typeof p.step, 'number');
            assert.equal(typeof p.detail, 'string');
            assert.ok('total' in p, 'total present (number or null)');
        }
        const phased = progress.map((p) => p.phase);
        for (const want of ['index', 'expand', 'emit', 'write'])
            assert.ok(phased.includes(want), `phase '${want}' emitted`);
        const stepped = progress.filter((p) => p.total !== null);
        for (let i = 1; i < stepped.length; i++)
            assert.ok(stepped[i].step > stepped[i - 1].step, 'steps strictly increase');
        assert.equal(stepped[stepped.length - 1].step, stepped[stepped.length - 1].total,
            'final progress step reaches total');

        // Summary: last line, per-scene record + outputs list.
        const summary = objs[objs.length - 1];
        assert.equal(summary.phase, 'summary');
        assert.equal(summary.ok, true);
        assert.equal(summary.scenes.length, 1);
        const rec = summary.scenes[0];
        assert.equal(rec.scene, 'AlphaTown');
        assert.equal(rec.guid, kSceneAGuid);
        assert.ok(fs.existsSync(rec.output), `scene output exists: ${rec.output}`);
        assert.ok(Array.isArray(rec.dropped), 'honest-drop entries present');
        assert.ok(rec.entities >= 1, 'entity count carried');
        const sceneOutputs = summary.outputs.filter((o) => o.kind === 'scene');
        assert.equal(sceneOutputs.length, 1);
        assert.equal(sceneOutputs[0].path, rec.output);

        // No human stats block leaked onto stdout.
        assert.doesNotMatch(res.stdout, /conversion stats/);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// ------------------------------------------------------- raw pkg conversion -
test('raw .unitypackage as --pkg converts identically to the extracted dir', () => {
    const tmp = tmpdir('rawpkg-');
    try {
        const pkgDir = writeExtractedDir(path.join(tmp, 'pkg'));
        const pkg = writeUnityPackage(path.join(tmp, 'demo.unitypackage'));
        const outDir = run(['--pkg', pkgDir, '--scene', 'AlphaTown.unity', '--out', path.join(tmp, 'a', 'A.scene')]);
        const outPkg = run(['--pkg', pkg, '--scene', 'AlphaTown.unity', '--out', path.join(tmp, 'b', 'A.scene')]);
        assert.equal(outDir.status, 0, outDir.stderr);
        assert.equal(outPkg.status, 0, outPkg.stderr);
        assert.equal(
            fs.readFileSync(path.join(tmp, 'a', 'A.scene'), 'utf8'),
            fs.readFileSync(path.join(tmp, 'b', 'A.scene'), 'utf8'),
            'raw-pack conversion must be byte-identical to extracted-dir conversion');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// ------------------------------------------------------------- multi-scene --
test('multi --scene: one run converts both scenes; summary lists each', () => {
    const tmp = tmpdir('multi-');
    try {
        const pkgDir = writeExtractedDir(path.join(tmp, 'pkg'));
        const proj = path.join(tmp, 'proj');
        const res = run(['--pkg', pkgDir, '--scene', 'AlphaTown.unity', '--scene', 'BetaCove.unity',
            '--project', proj, '--png', '--json']);
        assert.equal(res.status, 0, `exit ${res.status}\nstderr:\n${res.stderr}`);
        const lines = res.stdout.split('\n').filter((l) => l.trim());
        const summary = JSON.parse(lines[lines.length - 1]);
        assert.equal(summary.scenes.length, 2);
        assert.deepEqual(summary.scenes.map((s) => s.scene), ['AlphaTown', 'BetaCove']);
        for (const s of summary.scenes) assert.ok(fs.existsSync(s.output), `missing ${s.output}`);
        assert.equal(summary.outputs.filter((o) => o.kind === 'scene').length, 2);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('subset consistency: a scene converted after another is byte-identical to a standalone run', () => {
    const tmp = tmpdir('subset-');
    try {
        const pkgDir = writeExtractedDir(path.join(tmp, 'pkg'));
        const projAB = path.join(tmp, 'projAB');
        const projB = path.join(tmp, 'projB');
        const both = run(['--pkg', pkgDir, '--scene', 'AlphaTown.unity', '--scene', 'BetaCove.unity',
            '--project', projAB, '--png']);
        const bOnly = run(['--pkg', pkgDir, '--scene', 'BetaCove.unity', '--project', projB, '--png']);
        assert.equal(both.status, 0, both.stderr);
        assert.equal(bOnly.status, 0, bOnly.stderr);
        assert.equal(
            fs.readFileSync(path.join(projAB, 'assets', 'BetaCove_unity.scene'), 'utf8'),
            fs.readFileSync(path.join(projB, 'assets', 'BetaCove_unity.scene'), 'utf8'),
            'scene B emitted in a multi-scene run must match scene B alone');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('--out with multiple --scene flags is refused', () => {
    const tmp = tmpdir('outmulti-');
    try {
        const pkgDir = writeExtractedDir(path.join(tmp, 'pkg'));
        const res = run(['--pkg', pkgDir, '--scene', 'AlphaTown.unity', '--scene', 'BetaCove.unity',
            '--out', path.join(tmp, 'x.scene')]);
        assert.notEqual(res.status, 0, '--out + multi-scene must fail');
        assert.match(res.stderr, /--out is single-scene only/);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
