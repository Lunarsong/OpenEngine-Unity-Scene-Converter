// Regression guards for the Unity-scene converter's TRANSFORM CONVENTION.
//
// The engine renders R(conj(q_stored)) (Transform::FromTRS builds the transpose
// of the standard quaternion->matrix basis; see Engine/Include/Components/
// Transform.h). The converter therefore emits the CONJUGATE of every Unity
// quaternion so FromTRS(conj(q)) == R(q): rendered orientation AND the
// conj-dependent parent-offset composition both match Unity exactly. A stale or
// wrong copy of convert.js (e.g. a terrain-branch checkout predating the
// conjugation fix) silently mirrors rotations in the XZ plane. These tests fail
// loudly if that regresses.
//
// Run:
//   npm test                                        (from the package root)
//   node --test tests/
//   node tests/transform-convention.test.mjs
//
// Pure ESM test; imports the real CommonJS convert.js via createRequire so the
// EXACT emitted math is exercised, not a re-implementation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONVERT = path.join(__dirname, '..', 'src', 'convert.js');
const require = createRequire(import.meta.url);
const convert = require(CONVERT);

const {
    TRANSFORM_CONVENTION_VERSION,
    conj, qRotate, emitObjectQuat, emitDirectionalQuat, composeWorldTRS,
} = convert;

// ---------------------------------------------------------------- helpers ---
const DP = 6;
const approx = (a, b, dp = DP) => Math.abs(a - b) <= 0.5 * Math.pow(10, -dp);
function assertVec(actual, expected, msg, dp = DP) {
    assert.equal(actual.length, expected.length, `${msg}: length`);
    for (let i = 0; i < expected.length; i++)
        assert.ok(approx(actual[i], expected[i], dp),
            `${msg} [${i}]: got ${actual[i]}, want ${expected[i]} (>${dp}dp)`);
}

// Standard column-major quaternion -> 3x3 rotation matrix (glm / Unity basis).
// FromTRS(q) stores the TRANSPOSE of this, i.e. it equals rotMat3(conj(q)).
function rotMat3(q) {
    const [x, y, z, w] = q;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    return [
        1 - (yy + zz), xy + wz, xz - wy,   // col 0
        xy - wz, 1 - (xx + zz), yz + wx,   // col 1
        xz + wy, yz - wx, 1 - (xx + yy),   // col 2
    ];
}
// T * R(q) * S(scale), column-major 4x4.
function mat4FromTRS(pos, q, scale) {
    const r = rotMat3(q);
    return [
        r[0] * scale[0], r[1] * scale[0], r[2] * scale[0], 0,
        r[3] * scale[1], r[4] * scale[1], r[5] * scale[1], 0,
        r[6] * scale[2], r[7] * scale[2], r[8] * scale[2], 0,
        pos[0], pos[1], pos[2], 1,
    ];
}
// What the engine actually renders for a STORED quat: FromTRS(stored) == the
// standard TRS built from conj(stored).
const engineMat4 = (pos, stored, scale) => mat4FromTRS(pos, conj(stored), scale);
// How the engine rotates a vector by a STORED quat: R(conj(stored)) * v.
const engineRotate = (stored, v) => qRotate(conj(stored), v);

const yawY = (deg) => {
    const h = (deg * Math.PI / 180) / 2;
    return [0, Math.sin(h), 0, Math.cos(h)];
};

// -------------------------------------------------------------- the version -
test('version constant is present and well-formed', () => {
    assert.equal(typeof TRANSFORM_CONVENTION_VERSION, 'string');
    assert.ok(TRANSFORM_CONVENTION_VERSION.length > 0);
    // Encodes the engine convention this copy emits. If the convention changes,
    // this string MUST change with it (and the banner + these goldens updated).
    assert.equal(TRANSFORM_CONVENTION_VERSION, 'conj-v2 (R(conj(q)) engine)');
});

// -------------------------------------------------- (a) object rotation ------
test('object rotation: emitted quat == conj(unity local) to 6dp', () => {
    // A known, normalized Unity local quaternion (45deg about a tilted axis).
    const qUnity = [0.1830127, 0.3535534, 0.1830127, 0.8965755];
    const emitted = emitObjectQuat(qUnity);
    assertVec(emitted, [-0.1830127, -0.3535534, -0.1830127, 0.8965755],
        'emitObjectQuat != conj(qUnity)');
    // And the engine's FromTRS(emitted) must reproduce the original Unity
    // rotation basis (round-trip): rotMat3(conj(emitted)) == rotMat3(qUnity).
    assertVec(rotMat3(conj(emitted)), rotMat3(qUnity), 'engine basis != Unity basis');
});

// The two directional ground truths recorded from the ElvenRealm conversion.
// Root directionals -> composed world rot == local; emitted = conj(worldRot * kYFlip).
test('directional ground truths (sun + fill) match the record to 6dp', () => {
    const sunSrc = [0.061370693, 0.96439517, -0.20186353, -0.15945758];
    const fillSrc = [-0.19457838, 0.3549998, -0.07791842, -0.91106707];
    // Feed through the exact emitted path: worldTRS of a root == its local rot.
    const sunWorld = composeWorldTRS([{ pos: [0, 0, 0], rot: sunSrc, scale: [1, 1, 1] }]);
    const fillWorld = composeWorldTRS([{ pos: [0, 0, 0], rot: fillSrc, scale: [1, 1, 1] }]);
    assertVec(emitDirectionalQuat(sunWorld.rot),
        [-0.2018635, 0.1594576, -0.0613707, -0.9643952], 'sun directional emit');
    assertVec(emitDirectionalQuat(fillWorld.rot),
        [-0.0779184, 0.9110671, 0.1945784, -0.3549998], 'fill directional emit');
});

// -------------------------------------------- (b) parented composition -------
test('parented position: conj emission reproduces Unity world offset', () => {
    // Parent yawed in Y (echoes the observatory-telescope chain, ~-11.1deg),
    // child offset in the XZ plane so the conj-vs-non-conj residual stays y==0
    // exactly like the recorded telescope signature (-11.459, 0, -2.403).
    const parentRot = yawY(-11.1);
    const childLocal = [1.2, 0, 0.4];

    // Unity composes the child's world offset as R(parentRot) * childLocal.
    const unityOffset = qRotate(parentRot, childLocal);

    // The converter emits conj(parentRot) as the parent's stored quat; the
    // engine applies R(conj(stored)) to the offset. Round-trip must match Unity.
    const storedParent = emitObjectQuat(parentRot);
    const engineOffset = engineRotate(storedParent, childLocal);
    assertVec(engineOffset, unityOffset, 'parented world offset (conj path)');

    // Negative control: had the converter emitted the RAW (non-conjugated)
    // quat, the engine would rotate the offset the WRONG way -> a non-zero
    // residual confined to the XZ plane. This is the exact bug class the guard
    // defends; assert the divergence exists and has the recorded shape (y==0).
    const wrongOffset = engineRotate(parentRot, childLocal); // stored = raw (bug)
    const residual = [
        unityOffset[0] - wrongOffset[0],
        unityOffset[1] - wrongOffset[1],
        unityOffset[2] - wrongOffset[2],
    ];
    const mag = Math.hypot(...residual);
    assert.ok(mag > 1e-3, `non-conj residual should be significant, got ${mag}`);
    assert.ok(Math.abs(residual[1]) < 1e-9,
        `non-conj residual must stay in XZ plane (y==0), got y=${residual[1]}`);
});

// ------------------------------------------------ (c) negative scale ---------
test('negative scale (mirror) round-trips to the same world matrix', () => {
    // A mirrored (negative-X) object with non-uniform scale and a real rotation.
    const pos = [5, -2, 7];
    const qUnity = [0.2705981, 0.2705981, 0, 0.9238795]; // 45deg about (1,1,0)/sqrt2-ish
    const scale = [-1, 2, 3];

    // Unity's world matrix.
    const unity = mat4FromTRS(pos, qUnity, scale);
    // The converter emits conj(qUnity) and passes scale THROUGH unchanged; the
    // engine's FromTRS reconstructs the same matrix.
    const stored = emitObjectQuat(qUnity);
    const engine = engineMat4(pos, stored, scale);
    assertVec(engine, unity, 'negative-scale world matrix round-trip');

    // The mirror survives: determinant of the upper-3x3 is negative (odd number
    // of negative scale axes). Documents that the converter does NOT normalize
    // away the mirror (the editor's decomposition reset bug is downstream and
    // out of scope for the converter).
    const r = rotMat3(conj(stored));
    const m = [
        r[0] * scale[0], r[1] * scale[0], r[2] * scale[0],
        r[3] * scale[1], r[4] * scale[1], r[5] * scale[1],
        r[6] * scale[2], r[7] * scale[2], r[8] * scale[2],
    ];
    const det = m[0] * (m[4] * m[8] - m[5] * m[7])
        - m[3] * (m[1] * m[8] - m[2] * m[7])
        + m[6] * (m[1] * m[5] - m[2] * m[4]);
    assert.ok(det < 0, `mirror must be preserved (det<0), got ${det}`);
});

// ----------------------------------- end-to-end: run the real CLI -----------
// Strongest wrong-copy guard: build a tiny self-contained Unity package
// (builtin Cube primitive -> no FBX/assetdb needed), run convert.js as a child
// process, and assert the emitted .scene carries the conjugated rotations,
// preserves negative scale, and that the startup banner names the convention.
function buildFixture(dir) {
    const guid = '00000000000000000000000000abcdef';
    const gdir = path.join(dir, guid);
    fs.mkdirSync(gdir, { recursive: true });
    fs.writeFileSync(path.join(gdir, 'pathname'), 'Assets/Scenes/Test.unity\n');
    const scene = [
        '%YAML 1.1',
        '%TAG !u! tag:unity3d.com,2011:',
        '--- !u!1 &100',
        'GameObject:',
        '  m_Name: Parent',
        '  m_IsActive: 1',
        '--- !u!4 &101',
        'Transform:',
        '  m_GameObject: {fileID: 100}',
        '  m_LocalRotation: {x: 0, y: 0.258819, z: 0, w: 0.9659258}',
        '  m_LocalPosition: {x: 0, y: 0, z: 0}',
        '  m_LocalScale: {x: 1, y: 1, z: 1}',
        '  m_Father: {fileID: 0}',
        '--- !u!1 &200',
        'GameObject:',
        '  m_Name: ChildCube',
        '  m_IsActive: 1',
        '--- !u!4 &201',
        'Transform:',
        '  m_GameObject: {fileID: 200}',
        '  m_LocalRotation: {x: 0.3826834, y: 0, z: 0, w: 0.9238795}',
        '  m_LocalPosition: {x: 2, y: 0, z: 0}',
        '  m_LocalScale: {x: -1, y: 1, z: 1}',
        '  m_Father: {fileID: 101}',
        '--- !u!33 &202',
        'MeshFilter:',
        '  m_GameObject: {fileID: 200}',
        '  m_Mesh: {fileID: 10202, guid: 0000000000000000e000000000000000, type: 0}',
        '--- !u!23 &203',
        'MeshRenderer:',
        '  m_GameObject: {fileID: 200}',
        '  m_Enabled: 1',
        '  m_CastShadows: 1',
        '  m_ReceiveShadows: 1',
        '--- !u!1 &300',
        'GameObject:',
        '  m_Name: Sun',
        '  m_IsActive: 1',
        '--- !u!4 &302',
        'Transform:',
        '  m_GameObject: {fileID: 300}',
        '  m_LocalRotation: {x: 0.061370693, y: 0.96439517, z: -0.20186353, w: -0.15945758}',
        '  m_LocalPosition: {x: 0, y: 10, z: 0}',
        '  m_LocalScale: {x: 1, y: 1, z: 1}',
        '  m_Father: {fileID: 0}',
        '--- !u!108 &301',
        'Light:',
        '  m_GameObject: {fileID: 300}',
        '  m_Enabled: 1',
        '  m_Type: 1',
        '  m_Color: {r: 1, g: 1, b: 1, a: 1}',
        '  m_Intensity: 1',
        '  m_Range: 10',
        '  m_Shadows:',
        '    m_Type: 2',
        '',
    ].join('\n');
    fs.writeFileSync(path.join(gdir, 'asset'), scene);
    return dir;
}

// Parse the emitted text .scene into [{ id, parent, props:{k:v} }].
function parseScene(text) {
    const entities = [];
    let cur = null;
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        const head = /^\[entity id="([^"]+)"(?:\s+parent="([^"]+)")?\]/.exec(line);
        if (head) { cur = { id: head[1], parent: head[2] || null, props: {} }; entities.push(cur); continue; }
        if (line.startsWith('[')) { cur = null; continue; } // e.g. [scene ...]
        if (!cur) continue;
        const kv = /^([A-Za-z0-9_.]+)\s*=\s*(.*)$/.exec(line);
        if (kv) cur.props[kv[1]] = kv[2];
    }
    return entities;
}
const parseTuple = (s) => s.replace(/[()]/g, '').split(',').map(v => parseFloat(v.trim()));

test('end-to-end: CLI emits conj rotation, preserves negative scale, prints banner', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'convguard-'));
    try {
        const pkgDir = buildFixture(path.join(tmp, 'pkg'));
        const outFile = path.join(tmp, 'out', 'Test_unity.scene');
        const res = spawnSync(process.execPath,
            [CONVERT, '--pkg', pkgDir, '--scene', 'Test.unity', '--out', outFile],
            { encoding: 'utf8' });
        assert.equal(res.status, 0, `convert.js exited ${res.status}\nstderr:\n${res.stderr}`);

        // Banner proves which converter ran.
        assert.match(res.stderr, /transform-convention: conj-v2 \(R\(conj\(q\)\) engine\)/,
            'startup banner missing from stderr');

        const entities = parseScene(fs.readFileSync(outFile, 'utf8'));
        const byName = (n) => entities.find(e => e.props['Name.value'] === `"${n}"`);

        const parent = byName('Parent');
        const child = byName('ChildCube');
        assert.ok(parent && child, 'Parent/ChildCube entities not emitted');

        // Object rotations are conjugated.
        assertVec(parseTuple(parent.props['Transform.rotation']),
            [0, -0.258819, 0, 0.9659258], 'parent emitted rotation (conj)');
        assertVec(parseTuple(child.props['Transform.rotation']),
            [-0.3826834, 0, 0, 0.9238795], 'child emitted rotation (conj)');

        // Negative scale preserved verbatim (mirror not normalized away).
        assertVec(parseTuple(child.props['Transform.scale']),
            [-1, 1, 1], 'child negative scale preserved');
        // Local position untouched; parent linkage preserved for engine compose.
        assertVec(parseTuple(child.props['Transform.position']), [2, 0, 0], 'child local position');
        assert.equal(child.parent, parent.id, 'child must parent to Parent entity');

        // Directional light emitted at top level with the recorded ground truth.
        const sun = entities.find(e => e.props['Light.type'] === '0');
        assert.ok(sun, 'directional light entity not emitted');
        assert.equal(sun.parent, null, 'directional light must be unparented (sun anchor)');
        assertVec(parseTuple(sun.props['Transform.rotation']),
            [-0.2018635, 0.1594576, -0.0613707, -0.9643952], 'sun directional emitted rotation');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

// ------------- multi-directional: all enabled, sun anchor = strongest --------
// The engine lights up to 4 directionals (strongest-first; cascaded shadows
// from the primary only — RenderServices::PackForwardLightDirectionals). The
// converter emits every enabled directional ENABLED and binds the
// SkyEnvironment sun anchor to the strongest (luma x intensity), so the anchor
// and the engine's primary shading/shadow pick coincide. A stderr NOTE fires
// only when the scene carries more enabled directionals than the engine cap.
function buildDirectionalFixture(dir, sceneName, fillCount) {
    const guid = '00000000000000000000000000abcd02';
    const gdir = path.join(dir, guid);
    fs.mkdirSync(gdir, { recursive: true });
    fs.writeFileSync(path.join(gdir, 'pathname'), `Assets/Scenes/${sceneName}\n`);
    const lines = [
        '%YAML 1.1',
        '%TAG !u! tag:unity3d.com,2011:',
        // Strong sun: shadow-casting, intensity 3.16 (the Demo_unity shape).
        '--- !u!1 &300',
        'GameObject:',
        '  m_Name: Sun',
        '  m_IsActive: 1',
        '--- !u!4 &302',
        'Transform:',
        '  m_GameObject: {fileID: 300}',
        '  m_LocalRotation: {x: 0.061370693, y: 0.96439517, z: -0.20186353, w: -0.15945758}',
        '  m_LocalPosition: {x: 0, y: 10, z: 0}',
        '  m_LocalScale: {x: 1, y: 1, z: 1}',
        '  m_Father: {fileID: 0}',
        '--- !u!108 &301',
        'Light:',
        '  m_GameObject: {fileID: 300}',
        '  m_Enabled: 1',
        '  m_Type: 1',
        '  m_Color: {r: 0.48, g: 0.58, b: 1, a: 1}',
        '  m_Intensity: 3.16',
        '  m_Range: 10',
        '  m_Shadows:',
        '    m_Type: 2',
    ];
    // Weak fills: enabled, no shadows, intensity 0.96 — the shipped-scene
    // shape that used to steal the shading UBO pre-fix.
    for (let i = 0; i < fillCount; ++i) {
        const go = 400 + i * 10;
        lines.push(
            `--- !u!1 &${go}`,
            'GameObject:',
            `  m_Name: Fill${i === 0 ? '' : i + 1}`,
            '  m_IsActive: 1',
            `--- !u!4 &${go + 2}`,
            'Transform:',
            `  m_GameObject: {fileID: ${go}}`,
            '  m_LocalRotation: {x: 0, y: 0.9110671, z: 0.1945784, w: -0.3549998}',
            '  m_LocalPosition: {x: 0, y: 8, z: 0}',
            '  m_LocalScale: {x: 1, y: 1, z: 1}',
            '  m_Father: {fileID: 0}',
            `--- !u!108 &${go + 1}`,
            'Light:',
            `  m_GameObject: {fileID: ${go}}`,
            '  m_Enabled: 1',
            '  m_Type: 1',
            '  m_Color: {r: 0.35, g: 0.81, b: 1, a: 1}',
            '  m_Intensity: 0.96',
            '  m_Range: 10',
            '  m_Shadows:',
            '    m_Type: 0');
    }
    lines.push('');
    fs.writeFileSync(path.join(gdir, 'asset'), lines.join('\n'));
    return dir;
}

test('end-to-end: all enabled directionals stay enabled; sun anchor = strongest', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'convguard-dir-'));
    try {
        const pkgDir = buildDirectionalFixture(path.join(tmp, 'pkg'), 'TwoDir.unity', /*fillCount=*/1);
        const outFile = path.join(tmp, 'out', 'TwoDir_unity.scene');
        const res = spawnSync(process.execPath,
            [CONVERT, '--pkg', pkgDir, '--scene', 'TwoDir.unity', '--out', outFile],
            { encoding: 'utf8' });
        assert.equal(res.status, 0, `convert.js exited ${res.status}\nstderr:\n${res.stderr}`);
        assert.doesNotMatch(res.stderr, /extra enabled directional|enabled directionals/,
            'no demotion warning / cap note may fire within the engine cap');

        const entities = parseScene(fs.readFileSync(outFile, 'utf8'));
        const byName = (n) => entities.find(e => e.props['Name.value'] === `"${n}"`);
        const sun = byName('Sun');
        const fill = byName('Fill');
        assert.ok(sun && fill, 'both directional entities must be emitted');

        // Both stay enabled: the engine lights N directionals now.
        assert.notEqual(sun.props['Light.enabled'], 'false', 'Sun must stay enabled');
        assert.notEqual(fill.props['Light.enabled'], 'false', 'Fill must stay enabled');
        const enabledDirs = entities.filter(e =>
            e.props['Light.type'] === '0' && e.props['Light.enabled'] !== 'false');
        assert.equal(enabledDirs.length, 2, 'every enabled directional must be emitted enabled');

        // The sky sun anchor binds the strongest (luma x intensity) directional.
        const env = entities.find(e => 'SkyEnvironment.SunLight' in e.props);
        assert.ok(env, 'SkyEnvironment entity not emitted');
        assert.equal(env.props['SkyEnvironment.SunLight'], `"${sun.id}"`,
            'SkyEnvironment.SunLight must bind the strongest directional');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('end-to-end: >4 enabled directionals emit the engine-cap stderr note, all enabled', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'convguard-dircap-'));
    try {
        // Sun + 5 fills = 6 enabled directionals (2 beyond the engine's 4-light cap).
        const pkgDir = buildDirectionalFixture(path.join(tmp, 'pkg'), 'SixDir.unity', /*fillCount=*/5);
        const outFile = path.join(tmp, 'out', 'SixDir_unity.scene');
        const res = spawnSync(process.execPath,
            [CONVERT, '--pkg', pkgDir, '--scene', 'SixDir.unity', '--out', outFile],
            { encoding: 'utf8' });
        assert.equal(res.status, 0, `convert.js exited ${res.status}\nstderr:\n${res.stderr}`);
        assert.match(res.stderr, /NOTE: 6 enabled directionals; the engine lights the strongest 4/,
            'engine-cap note missing from stderr');

        const entities = parseScene(fs.readFileSync(outFile, 'utf8'));
        const enabledDirs = entities.filter(e =>
            e.props['Light.type'] === '0' && e.props['Light.enabled'] !== 'false');
        assert.equal(enabledDirs.length, 6, 'all directionals stay enabled even past the cap');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});
