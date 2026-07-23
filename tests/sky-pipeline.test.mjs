// Guards for the faithful Unity skybox pipeline (skybox.js + convert.js
// emission): DDS cubemap ingest, D3D face-lookup orientation, the engine's
// equirect inverse mapping, sRGB->linear decode, the Unity dome multiplier
// (tint * unity_ColorSpaceDouble * exposure, identity-snapped at the #808080
// authoring default), Radiance RGBE round-trip, and the end-to-end Skybox
// component emission through the real CLI. All fixtures are synthetic — no
// licensed content.
//
// Direction ground truth (sky_render.frag EncodeDirToLatLongUv):
//   u = atan2(z, x)/2pi + 0.5, v = acos(y)/pi
// so on a baked equirect: u=0.5 -> +X, u=0.75 -> +Z, u->0/1 -> -X, u=0.25 -> -Z,
// v->0 -> +Y (zenith), v->1 -> -Y (nadir).

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
const sky = require(path.join(__dirname, '..', 'src', 'skybox.js'));

const srgbToLinear = (c) => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
const approx = (a, b, tol) => Math.abs(a - b) <= tol;

// ------------------------------------------------- synthetic DDS cubemap ---
// Uncompressed BGRA8 cubemap, one solid colour per face (mirrors the exact
// header class Skybox_Stars_01.dds ships: fourCC 0, 32bpp, BGRA masks,
// caps2 = cubemap | all six faces).
const kFaceColors = [ // [r,g,b] 0..255, DDS face order +X -X +Y -Y +Z -Z
    [200, 0, 0], [0, 200, 0], [0, 0, 200],
    [200, 200, 0], [0, 200, 200], [200, 0, 200],
];

function buildSyntheticDdsCubemap(faceSize) {
    const faceBytes = faceSize * faceSize * 4;
    const buf = Buffer.alloc(128 + 6 * faceBytes);
    buf.writeUInt32LE(0x20534444, 0);          // "DDS "
    buf.writeUInt32LE(124, 4);                 // header size
    buf.writeUInt32LE(0x1007, 8);              // CAPS|HEIGHT|WIDTH|PIXELFORMAT
    buf.writeUInt32LE(faceSize, 12);           // height
    buf.writeUInt32LE(faceSize, 16);           // width
    buf.writeUInt32LE(0, 28);                  // mipmapcount (0 == just mip 0)
    buf.writeUInt32LE(32, 76);                 // ddspf size
    buf.writeUInt32LE(0x41, 80);               // DDPF_RGB | DDPF_ALPHAPIXELS
    buf.writeUInt32LE(0, 84);                  // fourCC 0 (uncompressed)
    buf.writeUInt32LE(32, 88);                 // bit count
    buf.writeUInt32LE(0x00FF0000, 92);         // R mask (BGRA layout)
    buf.writeUInt32LE(0x0000FF00, 96);         // G mask
    buf.writeUInt32LE(0x000000FF, 100);        // B mask
    buf.writeUInt32LE(0xFF000000, 104);        // A mask
    buf.writeUInt32LE(0x1008, 108);            // caps: COMPLEX|TEXTURE
    buf.writeUInt32LE(0xFE00, 112);            // caps2: CUBEMAP + all six faces
    for (let f = 0; f < 6; f++) {
        const [r, g, b] = kFaceColors[f];
        const base = 128 + f * faceBytes;
        for (let p = 0; p < faceSize * faceSize; p++) {
            buf[base + p * 4] = b;
            buf[base + p * 4 + 1] = g;
            buf[base + p * 4 + 2] = r;
            buf[base + p * 4 + 3] = 255;
        }
    }
    return buf;
}

// RGBE mantissa is 8-bit: relative error <= ~1/128, plus bilinear float slop.
const kHdrTol = 0.01;

test('readDdsCubemap ingests the Skybox_Stars_01 header class', () => {
    const cube = sky.readDdsCubemap(buildSyntheticDdsCubemap(8));
    assert.equal(cube.size, 8);
    assert.equal(cube.faces.length, 6);
    assert.deepEqual(cube.channelOffsets, { r: 2, g: 1, b: 0 }); // BGRA bytes
    assert.throws(() => sky.readDdsCubemap(Buffer.alloc(64)), /not a DDS|truncated/);
});

test('equirect bake puts each cube face at the engine sampling direction', () => {
    const cube = sky.readDdsCubemap(buildSyntheticDdsCubemap(8));
    const W = 64, H = 32;
    const rgb = sky.bakeEquirect(cube, W, H, [1, 1, 1]);
    const texel = (px, py) => {
        const o = (py * W + px) * 3;
        return [rgb[o], rgb[o + 1], rgb[o + 2]];
    };
    const lin = kFaceColors.map((c) => c.map((v) => srgbToLinear(v / 255)));
    const probes = [
        [32, 16, 0, '+X at u=0.5, horizon'],
        [0, 16, 1, '-X at u->0, horizon'],
        [48, 16, 4, '+Z at u=0.75, horizon'],
        [16, 16, 5, '-Z at u=0.25, horizon'],
        [32, 0, 2, '+Y at zenith row'],
        [32, 31, 3, '-Y at nadir row'],
    ];
    for (const [px, py, face, what] of probes) {
        const got = texel(px, py);
        for (let c = 0; c < 3; c++)
            assert.ok(approx(got[c], lin[face][c], kHdrTol),
                `${what}: ch${c} got ${got[c]}, want ${lin[face][c]} (face ${face})`);
    }
});

test('bake decodes sRGB and applies the per-channel multiplier in linear space', () => {
    const cube = sky.readDdsCubemap(buildSyntheticDdsCubemap(8));
    const rgb = sky.bakeEquirect(cube, 64, 32, [2, 1, 0.5]);
    const o = (16 * 64 + 32) * 3; // +X probe
    const wantR = srgbToLinear(200 / 255) * 2;
    assert.ok(approx(rgb[o], wantR, kHdrTol * 2), `mult r: got ${rgb[o]}, want ${wantR}`);
    assert.ok(approx(rgb[o + 1], 0, 1e-6), 'g stays 0');
    assert.ok(approx(rgb[o + 2], 0, 1e-6), 'b stays 0');
});

test('computeSkyboxMultiplier: exact identity at the Unity neutral default', () => {
    // #808080 tint, exposure 1: srgbToLinear(0.5)*4.59479 = 0.98347 -> designed
    // as neutral, snaps to exactly 1 so the source texels bake bit-faithfully.
    assert.deepEqual(sky.computeSkyboxMultiplier([0.5, 0.5, 0.5], 1), [1, 1, 1]);
    // Non-neutral values do NOT snap.
    const white = sky.computeSkyboxMultiplier([1, 1, 1], 1);
    assert.ok(approx(white[0], 4.59479380, 1e-6), `white tint: ${white[0]}`);
    const dim = sky.computeSkyboxMultiplier([0.5, 0.5, 0.5], 0.5);
    assert.ok(approx(dim[0], 0.98347 * 0.5, 1e-4), `half exposure: ${dim[0]}`);
    // Chroma tint keeps per-channel ratios.
    const tinted = sky.computeSkyboxMultiplier([0.5, 0.25, 0.5], 1);
    assert.ok(tinted[1] < tinted[0] && approx(tinted[0], 0.98347, 1e-4));
});

test('parseUnitySkyboxMat reads builtin Skybox/Cubemap materials', () => {
    const mat = sky.parseUnitySkyboxMat([
        'Material:',
        '  m_Name: Sky_01',
        '  m_Shader: {fileID: 103, guid: 0000000000000000f000000000000000, type: 0}',
        '  m_SavedProperties:',
        '    m_TexEnvs:',
        '    - _Tex:',
        '        m_Texture: {fileID: 8900000, guid: 00000000000000000000000000cccccc, type: 3}',
        '    m_Floats:',
        '    - _Exposure: 1.25',
        '    - _Rotation: 45',
        '    m_Colors:',
        '    - _Tint: {r: 0.5, g: 0.5, b: 0.5, a: 0.5}',
    ].join('\n'));
    assert.ok(mat);
    assert.equal(mat.isBuiltinCubemap, true);
    assert.equal(mat.texGuid, '00000000000000000000000000cccccc');
    assert.equal(mat.exposure, 1.25);
    assert.equal(mat.rotationDegrees, 45);
    assert.deepEqual(mat.tint, [0.5, 0.5, 0.5]);

    const other = sky.parseUnitySkyboxMat(
        'Material:\n  m_Shader: {fileID: 106, guid: 0000000000000000f000000000000000, type: 0}\n');
    assert.ok(other && !other.isBuiltinCubemap, 'non-cubemap builtin must not classify');
});

test('Radiance RGBE writer/reader round-trip (RLE) within mantissa error', () => {
    const W = 64, H = 4;
    const rgb = new Float32Array(W * H * 3);
    for (let i = 0; i < W * H; i++) {
        // Mix of zeros (RLE runs), gradients (literals), and HDR-range values.
        rgb[i * 3] = i % 7 === 0 ? 0 : (i % 100) / 25;
        rgb[i * 3 + 1] = i < W ? 0 : 0.001 * (i % 50);
        rgb[i * 3 + 2] = i % 13 === 0 ? 3.5 : 0.25;
    }
    const tmp = path.join(os.tmpdir(), `sky-rgbe-${process.pid}.hdr`);
    try {
        sky.writeRadianceHdr(tmp, W, H, rgb);
        const back = sky.readRadianceHdr(tmp);
        assert.equal(back.width, W);
        assert.equal(back.height, H);
        for (let i = 0; i < rgb.length; i += 3) {
            // RGBE shares one exponent per texel: quantization error is
            // relative to the texel's MAX channel (step = max/128), not to
            // each channel individually.
            const texelMax = Math.max(rgb[i], rgb[i + 1], rgb[i + 2]);
            const tol = Math.max(1e-6, texelMax / 128);
            for (let c = 0; c < 3; c++)
                assert.ok(approx(back.rgb[i + c], rgb[i + c], tol),
                    `rgb[${i + c}]: got ${back.rgb[i + c]}, want ${rgb[i + c]} (texel max ${texelMax})`);
        }
        // 1.0 encodes exactly (mantissa 128, exponent 129).
        sky.writeRadianceHdr(tmp, 8, 1, new Float32Array([1, 1, 1, 0, 0, 0, 1, 1, 1, 0, 0, 0, 1, 1, 1, 0, 0, 0, 1, 1, 1, 0, 0, 0]));
        const one = sky.readRadianceHdr(tmp);
        assert.equal(one.rgb[0], 1);
    } finally {
        fs.rmSync(tmp, { force: true });
    }
});

// ----------------------------------------- end-to-end: run the real CLI ----
function buildSkyFixture(dir) {
    const sceneGuid = '00000000000000000000000000abc001';
    const matGuid = '00000000000000000000000000abc002';
    const ddsGuid = '00000000000000000000000000abc003';
    const put = (guid, pathname, content) => {
        const gdir = path.join(dir, guid);
        fs.mkdirSync(gdir, { recursive: true });
        fs.writeFileSync(path.join(gdir, 'pathname'), pathname + '\n');
        fs.writeFileSync(path.join(gdir, 'asset'), content);
    };
    put(sceneGuid, 'Assets/Scenes/SkyTest.unity', [
        '%YAML 1.1',
        '%TAG !u! tag:unity3d.com,2011:',
        '--- !u!104 &2',
        'RenderSettings:',
        '  m_Fog: 0',
        '  m_AmbientMode: 0',
        '  m_AmbientSkyColor: {r: 0.5, g: 0.5, b: 0.5, a: 1}',
        `  m_SkyboxMaterial: {fileID: 2100000, guid: ${matGuid}, type: 2}`,
        '--- !u!1 &100',
        'GameObject:',
        '  m_Name: Anchor',
        '  m_IsActive: 1',
        '--- !u!4 &101',
        'Transform:',
        '  m_GameObject: {fileID: 100}',
        '  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}',
        '  m_LocalPosition: {x: 0, y: 0, z: 0}',
        '  m_LocalScale: {x: 1, y: 1, z: 1}',
        '  m_Father: {fileID: 0}',
        '',
    ].join('\n'));
    put(matGuid, 'Assets/Sky/SkyTest.mat', [
        'Material:',
        '  m_Name: SkyTest',
        '  m_Shader: {fileID: 103, guid: 0000000000000000f000000000000000, type: 0}',
        '  m_SavedProperties:',
        '    m_TexEnvs:',
        '    - _Tex:',
        `        m_Texture: {fileID: 8900000, guid: ${ddsGuid}, type: 3}`,
        '    m_Floats:',
        '    - _Exposure: 1',
        '    - _Rotation: 0',
        '    m_Colors:',
        '    - _Tint: {r: 0.5, g: 0.5, b: 0.5, a: 0.5}',
        '',
    ].join('\n'));
    put(ddsGuid, 'Assets/Textures/StarsTest.dds', buildSyntheticDdsCubemap(8));
    return dir;
}

test('end-to-end: CLI bakes the skybox and emits the Skybox component', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skyguard-'));
    try {
        const pkgDir = buildSkyFixture(path.join(tmp, 'pkg'));
        const projDir = path.join(tmp, 'proj');
        fs.mkdirSync(projDir, { recursive: true });
        const res = spawnSync(process.execPath,
            [CONVERT, '--pkg', pkgDir, '--scene', 'SkyTest.unity', '--project', projDir, '--png'],
            { encoding: 'utf8' });
        assert.equal(res.status, 0, `convert.js exited ${res.status}\nstderr:\n${res.stderr}`);

        const hdrPath = path.join(projDir, 'assets', 'Textures_Unity', 'StarsTest_equirect.hdr');
        assert.ok(fs.existsSync(hdrPath), 'equirect .hdr not baked into Textures_Unity');
        assert.ok(fs.existsSync(hdrPath + '.bake.json'), 'bake sidecar missing');

        const scene = fs.readFileSync(path.join(projDir, 'assets', 'SkyTest_unity.scene'), 'utf8');
        assert.match(scene, /Name\.value = "Skybox \(Unity\)"/);
        assert.match(scene, /Skybox\.Enabled = true/);
        assert.match(scene, /Skybox\.HDRIIntensity = 1/);
        assert.match(scene, /Skybox\.RotationDegrees = 0/);
        assert.match(scene, /Skybox\.HDRI = \[path="Textures_Unity\/StarsTest_equirect\.hdr" guid="[0-9a-f-]{36}"\]/);

        // The baked dome carries the cube colours at the engine's directions
        // (8px faces -> 32x16 bake; +X face at u=0.5 on the horizon row).
        const hdr = sky.readRadianceHdr(hdrPath);
        assert.equal(hdr.width, 32);
        assert.equal(hdr.height, 16);
        const o = (8 * 32 + 16) * 3;
        const want = srgbToLinear(200 / 255); // identity multiplier: tint snapped
        assert.ok(approx(hdr.rgb[o], want, kHdrTol), `+X probe r: ${hdr.rgb[o]} vs ${want}`);
        assert.ok(hdr.rgb[o + 1] < kHdrTol && hdr.rgb[o + 2] < kHdrTol, '+X probe g/b ~0');

        // Re-run: the bake must be reused (sidecar parameters unchanged).
        const res2 = spawnSync(process.execPath,
            [CONVERT, '--pkg', pkgDir, '--scene', 'SkyTest.unity', '--project', projDir, '--png'],
            { encoding: 'utf8' });
        assert.equal(res2.status, 0);
        assert.match(res2.stdout, /bake reused/);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});
