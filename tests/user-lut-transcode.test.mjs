// URP ColorLookup -> CubeLutEffect promote (convert.js): the user's 2D strip
// LUT texture is transcoded to a Resolve-style .cube at convert time and the
// volume's contribution carries as CubeLutEffect.intensity with Rec709SRGB
// input encoding (URP samples the user LUT over sRGB-encoded display color —
// core Color.hlsl ApplyColorGrading). Covers the PNG decoder (filters,
// bit depths), the strip green-axis flip (GPU v=0 = PNG bottom row), the
// emit path, honest drops for unsupported inputs, and the --grade-lut
// conflict (single CubeLutEffect slot). All fixtures are synthetic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONVERT = path.join(__dirname, '..', 'src', 'convert.js');
const require = createRequire(import.meta.url);
const { decodePng, bakeLookupCubeLut } = require(CONVERT);

const kUrpVolumeScriptGuid = '172515602e62fb746b5d573b38a5fe58';

// ------------------------------------------------------- PNG encoding ------
const kCrcTable = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c;
    }
    return t;
})();
function crc32(buf) {
    let c = 0xffffffff;
    for (const b of buf) c = kCrcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 8 + data.length);
    return out;
}
// texel(x, y) -> [r,g,b] bytes; y is a PNG file row (top first). Filter 0 rows.
function encodePng(width, height, texel) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; ihdr[9] = 2; // 8-bit truecolor RGB
    const raw = Buffer.alloc(height * (1 + width * 3));
    for (let y = 0; y < height; y++) {
        const at = y * (1 + width * 3);
        raw[at] = 0;
        for (let x = 0; x < width; x++) {
            const [r, g, b] = texel(x, y);
            raw[at + 1 + x * 3] = r;
            raw[at + 1 + x * 3 + 1] = g;
            raw[at + 1 + x * 3 + 2] = b;
        }
    }
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// A NEUTRAL (identity) Unity LUT strip: width = size^2, height = size. Green
// increases UPWARD in the file (GPU v=0 = bottom row), red along x within a
// slice, blue indexes the slice.
function neutralStrip(size) {
    return encodePng(size * size, size, (x, y) => {
        const r = x % size, b = Math.floor(x / size), g = size - 1 - y;
        const q = (i) => Math.round((i / (size - 1)) * 255);
        return [q(r), q(g), q(b)];
    });
}

// ------------------------------------------------------- decoder units -----
test('decodePng reconstructs all five PNG filter types', () => {
    // 2px-wide RGB rows, one per filter; expectations hand-computed per spec.
    const rows = [
        [0, 10, 20, 30, 40, 50, 60],
        [1, 1, 2, 3, 4, 5, 6],
        [2, 1, 1, 1, 1, 1, 1],
        [3, 10, 10, 10, 10, 10, 10],
        [4, 5, 5, 5, 5, 5, 5],
    ];
    const raw = Buffer.from(rows.flat());
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(2, 0);
    ihdr.writeUInt32BE(5, 4);
    ihdr[8] = 8; ihdr[9] = 2;
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
    const img = decodePng(png);
    assert.equal(img.width, 2);
    assert.equal(img.height, 5);
    assert.deepEqual([...img.px], [
        10, 20, 30, 40, 50, 60,       // None
        1, 2, 3, 5, 7, 9,             // Sub
        2, 3, 4, 6, 8, 10,            // Up
        11, 11, 12, 18, 19, 21,       // Average
        16, 16, 17, 23, 24, 26,       // Paeth
    ]);
});

test('decodePng rejects unsupported shapes with clear reasons', () => {
    assert.throws(() => decodePng(Buffer.from('not a png at all')), /not a PNG/);
    const gray = Buffer.alloc(13);
    gray.writeUInt32BE(1, 0); gray.writeUInt32BE(1, 4);
    gray[8] = 8; gray[9] = 0; // grayscale
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', gray), chunk('IDAT', zlib.deflateSync(Buffer.from([0, 7]))), chunk('IEND', Buffer.alloc(0))]);
    assert.throws(() => decodePng(png), /color type 0 not supported/);
});

// ---------------------------------------------------- hostile inputs -------
// A .png inside a .unitypackage is untrusted input to the (hosted) converter:
// every attacker-shaped case must TERMINATE with a deterministic,
// twin-identical error — never hang, never return a garbage image.
const kSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function ihdrData(w, h, { depth = 8, colorType = 2 } = {}) {
    const d = Buffer.alloc(13);
    d.writeUInt32BE(w >>> 0, 0);
    d.writeUInt32BE(h >>> 0, 4);
    d[8] = depth; d[9] = colorType;
    return d;
}
// Declared chunk length 0xFFFFFFF4 on a junk type: dodges every typed throw;
// a signed-length reader computes off += 12 + (-12) and wedges forever.
const kHostileChunkPng = Buffer.concat([kSig,
    Buffer.from([0xff, 0xff, 0xff, 0xf4]), Buffer.from('jUNK', 'latin1')]);
// IHDR declares 13 data bytes; the file ends after 5.
const kTruncatedPng = Buffer.concat([kSig,
    Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR', 'latin1'), Buffer.from([0, 0, 0, 16, 0])]);
// 0xFFFFFFFF x 0xFFFFFFFF declared dimensions (signed readers see -1x-1).
const kHugeDimsPng = Buffer.concat([kSig,
    chunk('IHDR', ihdrData(0xffffffff, 0xffffffff)),
    chunk('IDAT', zlib.deflateSync(Buffer.from([0]))), chunk('IEND', Buffer.alloc(0))]);
// Valid strip-shaped 64x8 header whose IDAT inflates to 50000 bytes (expected 1544).
const kBombPng = Buffer.concat([kSig,
    chunk('IHDR', ihdrData(64, 8)),
    chunk('IDAT', zlib.deflateSync(Buffer.alloc(50000))), chunk('IEND', Buffer.alloc(0))]);
// Valid header, garbage zlib stream.
const kCorruptPng = Buffer.concat([kSig,
    chunk('IHDR', ihdrData(64, 8)),
    chunk('IDAT', Buffer.from('garbage-bytes-here')), chunk('IEND', Buffer.alloc(0))]);
// The IDAT deflate payload of a REAL strip PNG (encodePng emits exactly
// signature | IHDR | IDAT | IEND, so the payload sits at a fixed offset).
function stripIdat(size) {
    const png = neutralStrip(size);
    const at = 8 + 12 + 13; // signature + IHDR chunk
    assert.equal(png.toString('latin1', at + 4, at + 8), 'IDAT');
    return { ihdr: png.subarray(8, at), idat: png.subarray(at + 8, at + 8 + png.readUInt32BE(at)) };
}
// cut(n) -> how many of the n deflate bytes survive the truncation.
function cutStripPng(cut) {
    const { ihdr, idat } = stripIdat(8);
    return Buffer.concat([kSig, ihdr, chunk('IDAT', idat.subarray(0, cut(idat.length))),
        chunk('IEND', Buffer.alloc(0))]);
}
// Truncated-download shapes on a valid 64x8 strip (1544 expected bytes): the
// zlib stream never reaches Z_STREAM_END. inflateSync THROWS on these — the
// reference behavior the C# twin has to reproduce, since .NET's ZLibStream
// hands back the partial output without complaining.
const kTruncDeflatePng = cutStripPng((n) => n >> 1); // cut at ~50%
// Only the 4-byte Adler-32 lost: still decodes all 1544 expected bytes, so the
// missing terminator is the ONLY thing marking it corrupt.
const kAdlerCutPng = cutStripPng((n) => n - 4);
// The other short-output class: a VALID, COMPLETE zlib stream that decodes to
// fewer bytes than the header declares. Inflate SUCCEEDS; the size check
// reports it — a different note, and it must stay reachable.
const kShortDeflatePng = Buffer.concat([kSig,
    chunk('IHDR', ihdrData(64, 8)),
    chunk('IDAT', zlib.deflateSync(Buffer.alloc(100))), chunk('IEND', Buffer.alloc(0))]);

test('hostile chunk length terminates (no signed-length wedge): missing IHDR/IDAT', () => {
    assert.throws(() => decodePng(kHostileChunkPng), /missing IHDR\/IDAT/);
});

test('truncated IHDR is rejected', () => {
    assert.throws(() => decodePng(kTruncatedPng), /truncated PNG chunk/);
});

test('huge declared dimensions are rejected before any allocation', () => {
    assert.throws(() => decodePng(kHugeDimsPng),
        /PNG dimensions 4294967295x4294967295 not supported \(LUT strips are at most 65536x256\)/);
});

test('zlib bomb past the declared size fails as the normalized inflate error', () => {
    assert.throws(() => decodePng(kBombPng), (e) => e.message === 'PNG inflate failed');
});

test('corrupt IDAT fails as the same normalized inflate error', () => {
    assert.throws(() => decodePng(kCorruptPng), (e) => e.message === 'PNG inflate failed');
});

test('a deflate stream cut mid-IDAT is an inflate failure, not a short read', () => {
    assert.throws(() => decodePng(kTruncDeflatePng), (e) => e.message === 'PNG inflate failed');
    assert.throws(() => decodePng(kAdlerCutPng), (e) => e.message === 'PNG inflate failed');
});

test('a COMPLETE zlib stream that decodes short is the size check, not an inflate failure', () => {
    assert.throws(() => decodePng(kShortDeflatePng), (e) => e.message === 'truncated PNG pixel data');
});

test('bakeLookupCubeLut: neutral strip -> identity .cube (green axis flipped from file rows)', () => {
    const size = 4;
    const img = decodePng(neutralStrip(size));
    const tmp = path.join(os.tmpdir(), `lutbake-${process.pid}.cube`);
    try {
        bakeLookupCubeLut(img, tmp);
        const lines = fs.readFileSync(tmp, 'utf8').trim().split('\n');
        assert.equal(lines[1], 'LUT_3D_SIZE 4');
        assert.equal(lines.length, 2 + size * size * size);
        const q = (i) => (Math.round((i / (size - 1)) * 255) / 255).toFixed(6);
        let at = 2;
        for (let b = 0; b < size; b++)
            for (let g = 0; g < size; g++)
                for (let r = 0; r < size; r++, at++)
                    assert.equal(lines[at], `${q(r)} ${q(g)} ${q(b)}`,
                        `entry (r=${r} g=${g} b=${b})`);
    } finally {
        fs.rmSync(tmp, { force: true });
    }
});

// ------------------------------------------------------- CLI fixtures ------
function put(dir, guid, pathname, content) {
    const gdir = path.join(dir, guid);
    fs.mkdirSync(gdir, { recursive: true });
    fs.writeFileSync(path.join(gdir, 'pathname'), pathname + '\n');
    fs.writeFileSync(path.join(gdir, 'asset'), content);
}

const kLutTexGuid = '00000000000000000000000000ab0003'; // must be valid hex (Unity guid shape)

function colorLookupDoc(contribution, texGuid) {
    return [
        '--- !u!114 &7',
        'MonoBehaviour:',
        '  m_Name: ColorLookup',
        '  active: 1',
        '  texture:',
        '    m_OverrideState: 1',
        texGuid ? `    m_Value: {fileID: 2800000, guid: ${texGuid}, type: 3}` : '    m_Value: {fileID: 0}',
        '  contribution:',
        '    m_OverrideState: 1',
        `    m_Value: ${contribution}`,
    ].join('\n');
}

function buildFixture(dir, { profileExtra = [], lutAsset = null, lutAssetPath = 'Assets/LUTs/TealOrange.png' }) {
    const sceneGuid = '00000000000000000000000000lu0001';
    const profGuid = '00000000000000000000000000lu0002';
    put(dir, sceneGuid, 'Assets/Scenes/LutTest.unity', [
        '%YAML 1.1',
        '%TAG !u! tag:unity3d.com,2011:',
        '--- !u!104 &2',
        'RenderSettings:',
        '  m_Fog: 0',
        '  m_AmbientMode: 0',
        '  m_AmbientSkyColor: {r: 0.6, g: 0.6, b: 0.6, a: 1}',
        '--- !u!1 &300',
        'GameObject:',
        '  m_Name: Sun',
        '  m_IsActive: 1',
        '--- !u!4 &302',
        'Transform:',
        '  m_GameObject: {fileID: 300}',
        '  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}',
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
        '--- !u!1 &400',
        'GameObject:',
        '  m_Name: Global Volume',
        '  m_IsActive: 1',
        '--- !u!4 &402',
        'Transform:',
        '  m_GameObject: {fileID: 400}',
        '  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}',
        '  m_LocalPosition: {x: 0, y: 0, z: 0}',
        '  m_LocalScale: {x: 1, y: 1, z: 1}',
        '  m_Father: {fileID: 0}',
        '--- !u!114 &401',
        'MonoBehaviour:',
        '  m_GameObject: {fileID: 400}',
        '  m_Enabled: 1',
        `  m_Script: {fileID: 11500000, guid: ${kUrpVolumeScriptGuid}, type: 3}`,
        '  m_IsGlobal: 1',
        '  priority: 0',
        `  sharedProfile: {fileID: 11400000, guid: ${profGuid}, type: 2}`,
        '',
    ].join('\n'));
    put(dir, profGuid, 'Assets/Volumes/LutProfile.asset', [
        '%YAML 1.1',
        '%TAG !u! tag:unity3d.com,2011:',
        ...profileExtra,
        '',
    ].join('\n'));
    if (lutAsset) put(dir, kLutTexGuid, lutAssetPath, lutAsset);
    return dir;
}

function runConvert(tmp, fixtureOpts, extraArgs = []) {
    const pkgDir = buildFixture(path.join(tmp, 'pkg'), fixtureOpts);
    const projDir = path.join(tmp, 'proj');
    fs.mkdirSync(projDir, { recursive: true });
    // timeout: a hostile LUT must never wedge the converter — a hang here is a
    // test FAILURE (status null / ETIMEDOUT), not a silent stall.
    const res = spawnSync(process.execPath,
        [CONVERT, '--pkg', pkgDir, '--scene', 'LutTest.unity', '--project', projDir, '--png', ...extraArgs],
        { encoding: 'utf8', timeout: 60000 });
    assert.equal(res.status, 0, `convert.js exited ${res.status}${res.error ? ` (${res.error.message})` : ''}\nstderr:\n${res.stderr}`);
    const scene = fs.readFileSync(path.join(projDir, 'assets', 'LutTest_unity.scene'), 'utf8');
    return { res, scene, projDir };
}

test('ColorLookup converts to CubeLutEffect with a transcoded .cube', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'userlut-'));
    try {
        const { res, scene, projDir } = runConvert(tmp, {
            profileExtra: [colorLookupDoc(0.75, kLutTexGuid)],
            lutAsset: neutralStrip(16),
        });
        assert.match(scene, /CubeLutEffect\.enabled = true/);
        assert.match(scene, /CubeLutEffect\.intensity = 0\.75\b/);
        assert.match(scene, /CubeLutEffect\.inputEncoding = 1\b/);
        assert.match(scene, /CubeLutEffect\.lutAsset = \[path="LutTest_lookup_lut\.cube" guid=""\]/);
        const cube = fs.readFileSync(path.join(projDir, 'assets', 'LutTest_lookup_lut.cube'), 'utf8');
        assert.match(cube, /^TITLE "URP ColorLookup strip transcode \(unity-scene-convert\)"\nLUT_3D_SIZE 16\n/);
        assert.equal(cube.trim().split('\n').length, 2 + 16 * 16 * 16);
        assert.doesNotMatch(res.stdout, /\[volume grade\] ColorLookup/);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('zero contribution is inert (URP IsActive gate) — no emit, no drop note', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'userlut-'));
    try {
        const { res, scene, projDir } = runConvert(tmp, {
            profileExtra: [colorLookupDoc(0, kLutTexGuid)],
            lutAsset: neutralStrip(16),
        });
        assert.doesNotMatch(scene, /CubeLutEffect/);
        assert.doesNotMatch(res.stdout, /ColorLookup/);
        assert.equal(fs.existsSync(path.join(projDir, 'assets', 'LutTest_lookup_lut.cube')), false);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('non-strip dimensions are an honest drop (URP ValidateLUT mirror)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'userlut-'));
    try {
        const bad = encodePng(32, 16, () => [128, 128, 128]); // width != height^2
        const { res, scene } = runConvert(tmp, {
            profileExtra: [colorLookupDoc(1, kLutTexGuid)],
            lutAsset: bad,
        });
        assert.doesNotMatch(scene, /CubeLutEffect/);
        assert.match(res.stdout, /ColorLookup \(TealOrange\.png: 32x16 is not a LUT strip/);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('non-PNG LUT textures are an honest drop naming the format', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'userlut-'));
    try {
        const { res, scene } = runConvert(tmp, {
            profileExtra: [colorLookupDoc(1, kLutTexGuid)],
            lutAsset: Buffer.from('TGA-BYTES'),
            lutAssetPath: 'Assets/LUTs/TealOrange.tga',
        });
        assert.doesNotMatch(scene, /CubeLutEffect/);
        assert.match(res.stdout, /ColorLookup \(LUT texture format '\.tga' not supported yet; PNG strips only\)/);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('--grade-lut SMH bake yields the CubeLutEffect slot to ColorLookup; SMH carries as native bands', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'userlut-'));
    try {
        const smh = [
            '--- !u!114 &8',
            'MonoBehaviour:',
            '  m_Name: ShadowsMidtonesHighlights',
            '  active: 1',
            '  shadows:',
            '    m_OverrideState: 1',
            '    m_Value: {x: 1.2, y: 1, z: 0.9, w: 0}',
            '  midtones:',
            '    m_OverrideState: 1',
            '    m_Value: {x: 1, y: 1, z: 1, w: 0}',
            '  highlights:',
            '    m_OverrideState: 1',
            '    m_Value: {x: 0.9, y: 1, z: 1.1, w: 0}',
        ].join('\n');
        const { res, scene, projDir } = runConvert(tmp, {
            profileExtra: [colorLookupDoc(1, kLutTexGuid), smh],
            lutAsset: neutralStrip(16),
        }, ['--grade-lut', '--verbose']);
        // The single CubeLutEffect is the user LUT (Rec709SRGB), not the SMH bake (Linear).
        assert.match(scene, /CubeLutEffect\.inputEncoding = 1\b/);
        assert.doesNotMatch(scene, /CubeLutEffect\.inputEncoding = 0\b/);
        assert.equal(fs.existsSync(path.join(projDir, 'assets', 'LutTest_smh_lut.cube')), false);
        // SMH still carries — as native three-way bands.
        assert.match(scene, /ColorGradeEffect\./);
        assert.match(res.stderr, /--grade-lut bake superseded by ColorLookup/);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

// Hostile LUT payloads through the full CLI: the conversion must complete
// (runConvert's spawnSync timeout turns a wedge into a failure), emit no
// CubeLutEffect, and report the honest drop.
for (const [name, payload, note] of [
    ['hostile chunk length', () => kHostileChunkPng, /ColorLookup \(TealOrange\.png: missing IHDR\/IDAT\)/],
    ['truncated IHDR', () => kTruncatedPng, /ColorLookup \(TealOrange\.png: truncated PNG chunk\)/],
    ['huge dimensions', () => kHugeDimsPng, /ColorLookup \(TealOrange\.png: PNG dimensions 4294967295x4294967295 not supported/],
    ['zlib bomb', () => kBombPng, /ColorLookup \(TealOrange\.png: PNG inflate failed\)/],
    ['deflate stream cut mid-IDAT', () => kTruncDeflatePng, /ColorLookup \(TealOrange\.png: PNG inflate failed\)/],
    ['IDAT missing only its Adler-32', () => kAdlerCutPng, /ColorLookup \(TealOrange\.png: PNG inflate failed\)/],
    ['complete-but-short IDAT', () => kShortDeflatePng, /ColorLookup \(TealOrange\.png: truncated PNG pixel data\)/],
]) {
    test(`CLI terminates and honestly drops a ${name} LUT`, () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'userlut-'));
        try {
            const { res, scene } = runConvert(tmp, {
                profileExtra: [colorLookupDoc(1, kLutTexGuid)],
                lutAsset: payload(),
            });
            assert.doesNotMatch(scene, /CubeLutEffect/);
            assert.match(res.stdout, note);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });
}
