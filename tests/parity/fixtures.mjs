'use strict';
// Parity-corpus fixture builders: synthesizes every input class the 62-test
// suite builds in-code (editor-protocol, model-seeding, sky-pipeline,
// color-grade-mapping, volume-drop-reporting, transform-convention,
// ambient-linearization behavior via CLI scenes) plus extended fixtures for
// port hard-parts (binary FBX node scanner, prefab modifications, the bin/
// wrapper sugar). All content is synthetic — licensed-clean.
//
// Exports buildCorpus(root) -> [{ name, pkgDir?, runs: [...] }] where each run
// is { name, args: [...], expectFail?: true, entry?: 'convert'|'wrapper' }.
// Args may contain the placeholders '<PROJ>' and '<OUT>' which the runner
// substitutes with per-side scratch dirs.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// ------------------------------------------------------------- helpers -----
function put(dir, guid, pathname, content) {
    const gdir = path.join(dir, guid);
    fs.mkdirSync(gdir, { recursive: true });
    fs.writeFileSync(path.join(gdir, 'pathname'), pathname + '\n');
    fs.writeFileSync(path.join(gdir, 'asset'), content);
}

const kUrpVolumeScriptGuid = '172515602e62fb746b5d573b38a5fe58';

// Minimal ustar writer (mirrors editor-protocol.test.mjs).
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
function writeUnityPackage(file, entries) {
    const parts = [];
    for (const [guid, e] of Object.entries(entries)) {
        for (const [leaf, body] of [['pathname', e.pathname + '\n'], ['asset', e.asset]]) {
            const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
            parts.push(tarHeader(`${guid}/${leaf}`, buf.length), buf,
                Buffer.alloc((512 - (buf.length % 512)) % 512));
        }
    }
    parts.push(Buffer.alloc(1024));
    fs.writeFileSync(file, zlib.gzipSync(Buffer.concat(parts)));
    return file;
}
function writeExtractedDir(dir, entries) {
    for (const [guid, e] of Object.entries(entries)) put(dir, guid, e.pathname, e.asset);
    return dir;
}

// ---------------------------------------------------- YAML scene pieces ----
function meshObjectYaml(base, name, fbxGuid, opts = {}) {
    const lines = [
        `--- !u!1 &${base}`,
        'GameObject:',
        `  m_Name: ${name}`,
        `  m_IsActive: ${opts.inactive ? 0 : 1}`,
        `--- !u!4 &${base + 1}`,
        'Transform:',
        `  m_GameObject: {fileID: ${base}}`,
        `  m_LocalRotation: {x: ${opts.rot?.[0] ?? 0}, y: ${opts.rot?.[1] ?? 0}, z: ${opts.rot?.[2] ?? 0}, w: ${opts.rot?.[3] ?? 1}}`,
        `  m_LocalPosition: {x: ${opts.pos?.[0] ?? 0}, y: ${opts.pos?.[1] ?? 0}, z: ${opts.pos?.[2] ?? 0}}`,
        `  m_LocalScale: {x: ${opts.scale?.[0] ?? 1}, y: ${opts.scale?.[1] ?? 1}, z: ${opts.scale?.[2] ?? 1}}`,
        `  m_Father: {fileID: ${opts.father ?? 0}}`,
        `--- !u!33 &${base + 2}`,
        'MeshFilter:',
        `  m_GameObject: {fileID: ${base}}`,
        fbxGuid
            ? `  m_Mesh: {fileID: 4300000, guid: ${fbxGuid}, type: 3}`
            : `  m_Mesh: {fileID: ${opts.builtinFileId ?? 10202}, guid: 0000000000000000e000000000000000, type: 0}`,
        `--- !u!23 &${base + 3}`,
        'MeshRenderer:',
        `  m_GameObject: {fileID: ${base}}`,
        `  m_Enabled: ${opts.disabled ? 0 : 1}`,
        `  m_CastShadows: ${opts.noCast ? 0 : 1}`,
        `  m_ReceiveShadows: ${opts.noReceive ? 0 : 1}`,
    ];
    if (opts.matGuids && opts.matGuids.length) {
        lines.push('  m_Materials:');
        for (const g of opts.matGuids)
            lines.push(`  - {fileID: 2100000, guid: ${g}, type: 2}`);
    }
    return lines.join('\n');
}

function lightYaml(base, name, type, opts = {}) {
    const lines = [
        `--- !u!1 &${base}`,
        'GameObject:',
        `  m_Name: ${name}`,
        '  m_IsActive: 1',
        `--- !u!4 &${base + 2}`,
        'Transform:',
        `  m_GameObject: {fileID: ${base}}`,
        `  m_LocalRotation: {x: ${opts.rot?.[0] ?? 0}, y: ${opts.rot?.[1] ?? 0}, z: ${opts.rot?.[2] ?? 0}, w: ${opts.rot?.[3] ?? 1}}`,
        `  m_LocalPosition: {x: ${opts.pos?.[0] ?? 0}, y: ${opts.pos?.[1] ?? 10}, z: ${opts.pos?.[2] ?? 0}}`,
        '  m_LocalScale: {x: 1, y: 1, z: 1}',
        `  m_Father: {fileID: ${opts.father ?? 0}}`,
        `--- !u!108 &${base + 1}`,
        'Light:',
        `  m_GameObject: {fileID: ${base}}`,
        `  m_Enabled: ${opts.disabled ? 0 : 1}`,
        `  m_Type: ${type}`,
        `  m_Color: {r: ${opts.color?.[0] ?? 1}, g: ${opts.color?.[1] ?? 1}, b: ${opts.color?.[2] ?? 1}, a: 1}`,
        `  m_Intensity: ${opts.intensity ?? 1}`,
        `  m_Range: ${opts.range ?? 10}`,
        '  m_Shadows:',
        `    m_Type: ${opts.noShadows ? 0 : 2}`,
    ];
    if (opts.urpTier !== undefined) {
        lines.push(
            `--- !u!114 &${base + 3}`,
            'MonoBehaviour:',
            `  m_GameObject: {fileID: ${base}}`,
            '  m_Enabled: 1',
            '  m_Script: {fileID: 11500000, guid: 474bcb49853aa07438625e644c072ee6, type: 3}',
            `  m_AdditionalLightsShadowResolutionTier: ${opts.urpTier}`);
    }
    return lines.join('\n');
}

function sceneYaml(objects, renderSettings) {
    const parts = ['%YAML 1.1', '%TAG !u! tag:unity3d.com,2011:'];
    if (renderSettings) parts.push(renderSettings);
    parts.push(...objects, '');
    return parts.join('\n');
}

function globalVolumeYaml(base, profGuid, priority = 0) {
    return [
        `--- !u!1 &${base}`,
        'GameObject:',
        '  m_Name: Global Volume',
        '  m_IsActive: 1',
        `--- !u!4 &${base + 2}`,
        'Transform:',
        `  m_GameObject: {fileID: ${base}}`,
        '  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}',
        '  m_LocalPosition: {x: 0, y: 0, z: 0}',
        '  m_LocalScale: {x: 1, y: 1, z: 1}',
        '  m_Father: {fileID: 0}',
        `--- !u!114 &${base + 1}`,
        'MonoBehaviour:',
        `  m_GameObject: {fileID: ${base}}`,
        '  m_Enabled: 1',
        `  m_Script: {fileID: 11500000, guid: ${kUrpVolumeScriptGuid}, type: 3}`,
        '  m_IsGlobal: 1',
        `  priority: ${priority}`,
        `  sharedProfile: {fileID: 11400000, guid: ${profGuid}, type: 2}`,
    ].join('\n');
}

function profileYaml(docs) {
    const profile = ['%YAML 1.1', '%TAG !u! tag:unity3d.com,2011:'];
    docs.forEach((body, i) => profile.push(`--- !u!114 &${i + 1}`, 'MonoBehaviour:', ...body));
    profile.push('');
    return profile.join('\n');
}
const smhDoc = (shadows, midtones, highlights, limits = {}) => [
    '  m_Name: ShadowsMidtonesHighlights', '  active: 1',
    '  shadows:', '    m_OverrideState: 1', `    m_Value: {x: ${shadows[0]}, y: ${shadows[1]}, z: ${shadows[2]}, w: ${shadows[3]}}`,
    '  midtones:', '    m_OverrideState: 1', `    m_Value: {x: ${midtones[0]}, y: ${midtones[1]}, z: ${midtones[2]}, w: ${midtones[3]}}`,
    '  highlights:', '    m_OverrideState: 1', `    m_Value: {x: ${highlights[0]}, y: ${highlights[1]}, z: ${highlights[2]}, w: ${highlights[3]}}`,
    ...Object.entries(limits).flatMap(([k, v]) => [`  ${k}:`, '    m_OverrideState: 1', `    m_Value: ${v}`]),
];
const lggDoc = (lift, gamma, gain) => [
    '  m_Name: LiftGammaGain', '  active: 1',
    '  lift:', '    m_OverrideState: 1', `    m_Value: {x: ${lift[0]}, y: ${lift[1]}, z: ${lift[2]}, w: ${lift[3]}}`,
    '  gamma:', '    m_OverrideState: 1', `    m_Value: {x: ${gamma[0]}, y: ${gamma[1]}, z: ${gamma[2]}, w: ${gamma[3]}}`,
    '  gain:', '    m_OverrideState: 1', `    m_Value: {x: ${gain[0]}, y: ${gain[1]}, z: ${gain[2]}, w: ${gain[3]}}`,
];
const colAdjDoc = (fields) => ['  m_Name: ColorAdjustments', '  active: 1',
    ...Object.entries(fields).flatMap(([k, v]) => [`  ${k}:`, '    m_OverrideState: 1', `    m_Value: ${v}`])];
const bloomDoc = (fields) => ['  m_Name: Bloom', '  active: 1',
    ...Object.entries(fields).flatMap(([k, v]) => [`  ${k}:`, '    m_OverrideState: 1', `    m_Value: ${v}`])];
const vignetteDoc = (fields) => ['  m_Name: Vignette', '  active: 1',
    ...Object.entries(fields).flatMap(([k, v]) => [`  ${k}:`, '    m_OverrideState: 1', `    m_Value: ${v}`])];

const kDaySun = () => lightYaml(300, 'Sun', 1, {
    rot: [0.1913417, 0.8001031, -0.4619398, 0.3314136], pos: [0, 10, 0],
});
const kDayRenderSettings = [
    '--- !u!104 &2',
    'RenderSettings:',
    '  m_Fog: 0',
    '  m_AmbientMode: 0',
    '  m_AmbientSkyColor: {r: 0.6, g: 0.6, b: 0.6, a: 1}',
].join('\n');

// ------------------------------------------------------- PNG LUT strip -----
const kPngCrcTable = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c;
    }
    return t;
})();
function pngCrc32(buf) {
    let c = 0xffffffff;
    for (const b of buf) c = kPngCrcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    data.copy(out, 8);
    out.writeUInt32BE(pngCrc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 8 + data.length);
    return out;
}
// texel(x, y) -> [r,g,b] in 0..1; y is a PNG file row (top first). Filter-0
// rows; depth 8 or 16, alpha adds an opaque A channel (exercises the RGBA and
// 16-bit decode branches of both converter twins).
function encodePng(width, height, texel, { depth = 8, alpha = false } = {}) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = depth;
    ihdr[9] = alpha ? 6 : 2;
    const channels = alpha ? 4 : 3;
    const bytes = depth >> 3;
    const raw = Buffer.alloc(height * (1 + width * channels * bytes));
    for (let y = 0; y < height; y++) {
        const rowAt = y * (1 + width * channels * bytes);
        raw[rowAt] = 0;
        for (let x = 0; x < width; x++) {
            const rgb = texel(x, y);
            const px = [...rgb, 1].slice(0, channels);
            for (let i = 0; i < channels; i++) {
                const at = rowAt + 1 + (x * channels + i) * bytes;
                if (depth === 8) raw[at] = Math.round(px[i] * 255);
                else raw.writeUInt16BE(Math.round(px[i] * 65535), at);
            }
        }
    }
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}
// A red/blue-swapped Unity LUT strip (width = size^2, height = size; green
// increases UPWARD in the file) — orientation-sensitive on every axis.
function lutStrip(size, opts) {
    return encodePng(size * size, size, (x, y) => {
        const r = x % size, b = Math.floor(x / size), g = size - 1 - y;
        return [b / (size - 1), g / (size - 1), r / (size - 1)];
    }, opts);
}
// Hostile PNG payloads (decoder-hardening parity: both twins must TERMINATE
// with identical drop notes — see user-lut-transcode.test.mjs for anatomy).
const kPngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function lutIhdrData(w, h) {
    const d = Buffer.alloc(13);
    d.writeUInt32BE(w >>> 0, 0);
    d.writeUInt32BE(h >>> 0, 4);
    d[8] = 8; d[9] = 2;
    return d;
}
const hostileChunkPng = () => Buffer.concat([kPngSig,
    Buffer.from([0xff, 0xff, 0xff, 0xf4]), Buffer.from('jUNK', 'latin1')]);
const truncatedPng = () => Buffer.concat([kPngSig,
    Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR', 'latin1'), Buffer.from([0, 0, 0, 16, 0])]);
const hugeDimsPng = () => Buffer.concat([kPngSig,
    pngChunk('IHDR', lutIhdrData(0xffffffff, 0xffffffff)),
    pngChunk('IDAT', zlib.deflateSync(Buffer.from([0]))), pngChunk('IEND', Buffer.alloc(0))]);
const bombPng = () => Buffer.concat([kPngSig,
    pngChunk('IHDR', lutIhdrData(64, 8)),
    pngChunk('IDAT', zlib.deflateSync(Buffer.alloc(50000))), pngChunk('IEND', Buffer.alloc(0))]);
const corruptPng = () => Buffer.concat([kPngSig,
    pngChunk('IHDR', lutIhdrData(64, 8)),
    pngChunk('IDAT', Buffer.from('garbage-bytes-here')), pngChunk('IEND', Buffer.alloc(0))]);
// The IDAT deflate payload of a REAL strip PNG: encodePng emits exactly
// signature | IHDR | IDAT | IEND, so it sits at a fixed offset.
function stripIdat(size) {
    const png = lutStrip(size);
    const at = 8 + 12 + 13; // signature + IHDR chunk
    if (png.toString('latin1', at + 4, at + 8) !== 'IDAT')
        throw new Error('fixture bug: strip PNG is not sig|IHDR|IDAT|IEND');
    return { ihdr: png.subarray(8, at), idat: png.subarray(at + 8, at + 8 + png.readUInt32BE(at)) };
}
// cut(n) -> how many of the n deflate bytes survive.
function cutStripPng(cut) {
    const { ihdr, idat } = stripIdat(8);
    return Buffer.concat([kPngSig, ihdr, pngChunk('IDAT', idat.subarray(0, cut(idat.length))),
        pngChunk('IEND', Buffer.alloc(0))]);
}
// Truncated-download shapes: the strip's zlib stream never reaches
// Z_STREAM_END. Node's inflateSync throws there; .NET's ZLibStream hands back
// the partial output instead, so the C# twin has to detect the unterminated
// stream to land on the same drop note. The adler-cut variant is the sharp one:
// it still yields every expected byte, so only the termination check separates
// it from a good strip.
const truncDeflatePng = () => cutStripPng((n) => n >> 1); // cut at ~50%
const adlerCutPng = () => cutStripPng((n) => n - 4);      // only the Adler-32 lost
// The OTHER short-output class: a VALID, COMPLETE zlib stream that decodes to
// fewer bytes than the 64x8 IHDR declares (1544). Both twins inflate it
// successfully and report the size check ("truncated PNG pixel data") — that
// note must stay reachable, distinct from the inflate failure above.
const shortDeflatePng = () => Buffer.concat([kPngSig,
    pngChunk('IHDR', lutIhdrData(64, 8)),
    pngChunk('IDAT', zlib.deflateSync(Buffer.alloc(100))), pngChunk('IEND', Buffer.alloc(0))]);

// ------------------------------------------------------- DDS cubemap -------
const kFaceColors = [
    [200, 0, 0], [0, 200, 0], [0, 0, 200],
    [200, 200, 0], [0, 200, 200], [200, 0, 200],
];
function buildSyntheticDdsCubemap(faceSize) {
    const faceBytes = faceSize * faceSize * 4;
    const buf = Buffer.alloc(128 + 6 * faceBytes);
    buf.writeUInt32LE(0x20534444, 0);
    buf.writeUInt32LE(124, 4);
    buf.writeUInt32LE(0x1007, 8);
    buf.writeUInt32LE(faceSize, 12);
    buf.writeUInt32LE(faceSize, 16);
    buf.writeUInt32LE(0, 28);
    buf.writeUInt32LE(32, 76);
    buf.writeUInt32LE(0x41, 80);
    buf.writeUInt32LE(0, 84);
    buf.writeUInt32LE(32, 88);
    buf.writeUInt32LE(0x00FF0000, 92);
    buf.writeUInt32LE(0x0000FF00, 96);
    buf.writeUInt32LE(0x000000FF, 100);
    buf.writeUInt32LE(0xFF000000, 104);
    buf.writeUInt32LE(0x1008, 108);
    buf.writeUInt32LE(0xFE00, 112);
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
    // A gradient on the +X face so the bake exercises bilinear + RLE literals.
    const base = 128;
    for (let y = 0; y < faceSize; y++)
        for (let x = 0; x < faceSize; x++) {
            const o = base + (y * faceSize + x) * 4;
            buf[o + 2] = 60 + Math.floor((x / Math.max(1, faceSize - 1)) * 180);
        }
    return buf;
}

// ------------------------------------------------------ binary FBX ---------
// Minimal binary FBX (version 7400, 32-bit offsets) with GlobalSettings +
// Objects (Model nodes with Properties70 Lcl Translation / RotationPivot,
// Geometry nodes) + Connections — exactly what scanFbxMeshNodes reads.
function fbxNode(name, props, children) {
    return { name, props: props || [], children: children || [] };
}
const fbxS = (s) => ({ t: 'S', v: s });
const fbxL = (v) => ({ t: 'L', v: BigInt(v) });
const fbxD = (v) => ({ t: 'D', v });
const fbxI = (v) => ({ t: 'I', v });

function fbxP70Vec(key, x, y, z) {
    return fbxNode('P', [fbxS(key), fbxS('Vector3D'), fbxS('Vector'), fbxS(''), fbxD(x), fbxD(y), fbxD(z)]);
}
function fbxP70Num(key, v) {
    return fbxNode('P', [fbxS(key), fbxS('double'), fbxS('Number'), fbxS(''), fbxD(v)]);
}

function serializeFbx(roots) {
    const chunks = [];
    let offset = 0;
    const push = (buf) => { chunks.push(buf); offset += buf.length; };
    const header = Buffer.alloc(27);
    header.write('Kaydara FBX Binary  ', 0, 'latin1');
    header[20] = 0x00; header[21] = 0x1A; header[22] = 0x00;
    header.writeUInt32LE(7400, 23);
    push(header);

    function propBuf(p) {
        switch (p.t) {
            case 'S': {
                const s = Buffer.from(p.v, 'latin1');
                const b = Buffer.alloc(5 + s.length);
                b.write('S', 0, 'latin1'); b.writeUInt32LE(s.length, 1); s.copy(b, 5);
                return b;
            }
            case 'L': {
                const b = Buffer.alloc(9);
                b.write('L', 0, 'latin1'); b.writeBigInt64LE(p.v, 1);
                return b;
            }
            case 'D': {
                const b = Buffer.alloc(9);
                b.write('D', 0, 'latin1'); b.writeDoubleLE(p.v, 1);
                return b;
            }
            case 'I': {
                const b = Buffer.alloc(5);
                b.write('I', 0, 'latin1'); b.writeInt32LE(p.v, 1);
                return b;
            }
            default: throw new Error('unsupported fbx prop ' + p.t);
        }
    }

    function nodeSize(n) {
        let sz = 13 + n.name.length;
        for (const p of n.props) sz += propBuf(p).length;
        for (const c of n.children) sz += nodeSize(c);
        if (n.children.length > 0) sz += 13; // null terminator record
        return sz;
    }
    function writeNode(n, at) {
        const bufs = [];
        const propBufs = n.props.map(propBuf);
        const propLen = propBufs.reduce((a, b) => a + b.length, 0);
        const end = at + nodeSize(n);
        const h = Buffer.alloc(13 + n.name.length);
        h.writeUInt32LE(end, 0);
        h.writeUInt32LE(n.props.length, 4);
        h.writeUInt32LE(propLen, 8);
        h.writeUInt8(n.name.length, 12);
        h.write(n.name, 13, 'latin1');
        bufs.push(h);
        let cur = at + h.length;
        for (const pb of propBufs) { bufs.push(pb); cur += pb.length; }
        for (const c of n.children) {
            const cb = writeNode(c, cur);
            bufs.push(cb);
            cur += cb.length;
        }
        if (n.children.length > 0) { bufs.push(Buffer.alloc(13)); cur += 13; }
        return Buffer.concat(bufs);
    }
    for (const r of roots) {
        const b = writeNode(r, offset);
        push(b);
    }
    push(Buffer.alloc(13)); // top-level terminator
    return Buffer.concat(chunks);
}

function buildMultiNodeFbx() {
    // Root body "SM_Prop_Scope_01" + two mesh children at rest offsets (cm)
    // + one LOD helper node that must be filtered out.
    const models = [
        { id: 1001n, name: 'SM_Prop_Scope_01', lclT: [0, 0, 0], pivot: [0, 0, 0], parent: null, geo: 2001n },
        { id: 1002n, name: 'Arm_01', lclT: [-14.18, 25, 0], pivot: [2, 0, 1], parent: 1001n, geo: 2002n },
        { id: 1003n, name: 'Lens_01', lclT: [0, 40, 6], pivot: [0, 1.5, 0], parent: 1002n, geo: 2003n },
        { id: 1004n, name: 'Scope_LOD1', lclT: [5, 5, 5], pivot: [0, 0, 0], parent: 1001n, geo: 2004n },
    ];
    const objectChildren = [];
    for (const m of models) {
        objectChildren.push(fbxNode('Model', [ { t: 'L', v: m.id }, fbxS(m.name + '\x00\x01Model'), fbxS('Mesh') ], [
            fbxNode('Properties70', [], [
                fbxP70Vec('Lcl Translation', m.lclT[0], m.lclT[1], m.lclT[2]),
                fbxP70Vec('RotationPivot', m.pivot[0], m.pivot[1], m.pivot[2]),
            ]),
        ]));
        objectChildren.push(fbxNode('Geometry', [ { t: 'L', v: m.geo }, fbxS('\x00\x01Geometry'), fbxS('Mesh') ], []));
    }
    const connChildren = [];
    for (const m of models) {
        connChildren.push(fbxNode('C', [fbxS('OO'), { t: 'L', v: m.geo }, { t: 'L', v: m.id }]));
        if (m.parent !== null)
            connChildren.push(fbxNode('C', [fbxS('OO'), { t: 'L', v: m.id }, { t: 'L', v: m.parent }]));
    }
    const roots = [
        fbxNode('GlobalSettings', [], [
            fbxNode('Properties70', [], [
                fbxNode('P', [fbxS('UnitScaleFactor'), fbxS('double'), fbxS('Number'), fbxS(''), fbxD(1)]),
            ]),
        ]),
        fbxNode('Objects', [], objectChildren),
        fbxNode('Connections', [], connChildren),
    ];
    return serializeFbx(roots);
}

// -------------------------------------------------------------- .mat YAML --
// texEnvs values: texture guid string, or { guid, scale, offset } to author a
// non-identity per-slot ST (URP Lit's shared _BaseMap tiling).
function matYaml(name, { shaderGuid, keywords = [], renderType = 'Opaque', texEnvs = {}, floats = {}, colors = {} }) {
    const L = ['%YAML 1.1', '%TAG !u! tag:unity3d.com,2011:', '--- !u!21 &2100000', 'Material:', `  m_Name: ${name}`];
    L.push(`  m_Shader: {fileID: 4800000, guid: ${shaderGuid}, type: 3}`);
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
    for (const [slot, v] of Object.entries(texEnvs)) {
        const t = typeof v === 'string' ? { guid: v } : v;
        const scale = t.scale || [1, 1];
        const offset = t.offset || [0, 0];
        L.push(`    - ${slot}:`);
        L.push(`        m_Texture: {fileID: 2800000, guid: ${t.guid}, type: 3}`);
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

// ------------------------------------------------------------ fixtures -----
export function buildCorpus(root) {
    const fixtures = [];
    const F = (name, buildEntriesOrDir, runs) => fixtures.push({ name, ...buildEntriesOrDir, runs });

    // ---- 1. protocol (editor-protocol.test.mjs corpus) ----
    {
        const sceneBody = (objectName) => sceneYaml([
            meshObjectYaml(100, objectName, null, { pos: [1, 2, 3], rot: [0, 0.258819, 0, 0.9659258] }),
        ]);
        const entries = {
            '000000000000000000000000000000aa': { pathname: 'Assets/Scenes/AlphaTown.unity', asset: sceneBody('AlphaCube') },
            '000000000000000000000000000000bb': { pathname: 'Assets/Scenes/BetaCove.unity', asset: sceneBody('BetaCube') },
            '000000000000000000000000000000c1': { pathname: 'Assets/Materials/Rock.mat', asset: 'not parsed' },
            '000000000000000000000000000000c2': { pathname: 'Assets/Models/Rock.fbx', asset: 'not parsed' },
            '000000000000000000000000000000c3': { pathname: 'Assets/Textures/Rock_Albedo.png', asset: 'not parsed' },
            '000000000000000000000000000000c4': { pathname: 'Assets/Prefabs/Rock.prefab', asset: 'not parsed' },
            '000000000000000000000000000000c5': { pathname: 'Assets/Scenes', asset: '' },
        };
        const dir = path.join(root, 'protocol');
        writeExtractedDir(path.join(dir, 'pkg'), entries);
        const rawPkg = writeUnityPackage(path.join(dir, 'demo.unitypackage'), entries);
        F('protocol', { pkgDir: path.join(dir, 'pkg') }, [
            { name: 'list-scenes-dir', args: ['--list-scenes', path.join(dir, 'pkg')] },
            { name: 'list-scenes-pkg', args: ['--list-scenes', rawPkg] },
            { name: 'json-single', args: ['--pkg', path.join(dir, 'pkg'), '--scene', 'AlphaTown.unity', '--project', '<PROJ>', '--png', '--json'] },
            { name: 'json-multi', args: ['--pkg', path.join(dir, 'pkg'), '--scene', 'AlphaTown.unity', '--scene', 'BetaCove.unity', '--project', '<PROJ>', '--png', '--json'] },
            { name: 'raw-pkg-out', args: ['--pkg', rawPkg, '--scene', 'AlphaTown.unity', '--out', '<OUT>/A.scene'] },
            { name: 'human-single', args: ['--pkg', path.join(dir, 'pkg'), '--scene', 'BetaCove.unity', '--project', '<PROJ>', '--png'] },
            { name: 'verbose', args: ['--pkg', path.join(dir, 'pkg'), '--scene', 'AlphaTown.unity', '--project', '<PROJ>', '--png', '--verbose'] },
            { name: 'out-multi-refused', args: ['--pkg', path.join(dir, 'pkg'), '--scene', 'AlphaTown.unity', '--scene', 'BetaCove.unity', '--out', '<OUT>/x.scene'], expectFail: true },
            { name: 'usage-error', args: [], expectFail: true },
            { name: 'missing-scene', args: ['--pkg', path.join(dir, 'pkg'), '--scene', 'Nope.unity', '--out', '<OUT>/n.scene'], expectFail: true },
            { name: 'bad-local-shadows', args: ['--pkg', path.join(dir, 'pkg'), '--scene', 'AlphaTown.unity', '--out', '<OUT>/n.scene', '--local-shadows', 'sometimes'], expectFail: true },
        ]);
    }

    // ---- 2. seeding (model-seeding.test.mjs corpus) ----
    {
        const kCrateFbxGuid = '000000000000000000000000000000d4';
        const kRockFbxGuid = '000000000000000000000000000000e5';
        const kAbsentFbxGuid = '000000000000000000000000000000f6';
        const kTexPngGuid = '000000000000000000000000000000e7';
        const kMatGuid = '000000000000000000000000000000e8';
        const kShaderGuid = '000000000000000000000000000000e9';
        const entries = {
            '000000000000000000000000000000a1': {
                pathname: 'Assets/Scenes/SeedTown.unity',
                asset: sceneYaml([
                    meshObjectYaml(100, 'CrateA', kCrateFbxGuid),
                    meshObjectYaml(200, 'RockA', kRockFbxGuid),
                ]),
            },
            '000000000000000000000000000000b2': {
                pathname: 'Assets/Scenes/SeedCove.unity',
                asset: sceneYaml([meshObjectYaml(100, 'CrateB', kCrateFbxGuid)]),
            },
            '000000000000000000000000000000c3': {
                pathname: 'Assets/Scenes/SeedGap.unity',
                asset: sceneYaml([meshObjectYaml(100, 'Ghost', kAbsentFbxGuid)]),
            },
            '000000000000000000000000000000a4': {
                pathname: 'Assets/Scenes/SeedTex.unity',
                asset: sceneYaml([meshObjectYaml(100, 'TexCrate', kCrateFbxGuid, { matGuids: [kMatGuid] })]),
            },
            [kCrateFbxGuid]: { pathname: 'Assets/PolyPack/Models/SM_Prop_Crate_01.fbx', asset: 'FBX-CRATE-BYTES-01' },
            [kRockFbxGuid]: { pathname: 'Assets/PolyPack/Models/SM_Env_Rock_02.fbx', asset: 'FBX-ROCK-BYTES-02' },
            [kTexPngGuid]: { pathname: 'Assets/PolyPack/Textures/T_Crate_Albedo.png', asset: 'PNG-PIXEL-BYTES-03' },
            [kMatGuid]: {
                pathname: 'Assets/PolyPack/Materials/M_Crate.mat',
                asset: matYaml('M_Crate', {
                    shaderGuid: kShaderGuid,
                    texEnvs: { _BaseMap: kTexPngGuid },
                    floats: { _Metallic: 0, _Smoothness: 0.4 },
                    colors: { _BaseColor: [1, 0.9, 0.8, 1] },
                }),
            },
        };
        const dir = path.join(root, 'seeding');
        const pkgDir = writeExtractedDir(path.join(dir, 'pkg'), entries);
        const dbFile = path.join(dir, 'AssetDatabase.assetdb');
        fs.writeFileSync(dbFile, [
            JSON.stringify({ format: 'assetdb', version: 1 }),
            JSON.stringify({ guid: '11111111-2222-3333-4444-555555555555', path: 'models/SM_Env_Rock_02.fbx', type: 'Model' }),
            '',
        ].join('\n'));
        F('seeding', { pkgDir }, [
            { name: 'seed-town', args: ['--pkg', pkgDir, '--scene', 'SeedTown.unity', '--project', '<PROJ>', '--png', '--json'] },
            { name: 'assetdb-first', args: ['--pkg', pkgDir, '--scene', 'SeedTown.unity', '--project', '<PROJ>', '--assetdb', dbFile, '--png', '--json'] },
            { name: 'multi-seed', args: ['--pkg', pkgDir, '--scene', 'SeedTown.unity', '--scene', 'SeedCove.unity', '--project', '<PROJ>', '--png'] },
            { name: 'cove-alone', args: ['--pkg', pkgDir, '--scene', 'SeedCove.unity', '--project', '<PROJ>', '--png'] },
            { name: 'out-mode-unresolved', args: ['--pkg', pkgDir, '--scene', 'SeedTown.unity', '--out', '<OUT>/Town.scene'] },
            { name: 'tex-copy', args: ['--pkg', pkgDir, '--scene', 'SeedTex.unity', '--project', '<PROJ>', '--png', '--json'] },
            { name: 'gap-unresolved', args: ['--pkg', pkgDir, '--scene', 'SeedGap.unity', '--project', '<PROJ>', '--png', '--json'] },
        ]);
    }

    // ---- 3. sky (sky-pipeline.test.mjs e2e corpus) ----
    {
        const sceneGuid = '00000000000000000000000000abc001';
        const matGuid = '00000000000000000000000000abc002';
        const ddsGuid = '00000000000000000000000000abc003';
        const entries = {
            [sceneGuid]: {
                pathname: 'Assets/Scenes/SkyTest.unity',
                asset: sceneYaml([
                    lightYaml(300, 'Sun', 1),
                ], [
                    '--- !u!104 &2',
                    'RenderSettings:',
                    '  m_Fog: 0',
                    '  m_AmbientMode: 0',
                    '  m_AmbientSkyColor: {r: 0.5, g: 0.5, b: 0.5, a: 1}',
                    `  m_SkyboxMaterial: {fileID: 2100000, guid: ${matGuid}, type: 2}`,
                ].join('\n')),
            },
            [matGuid]: {
                pathname: 'Assets/Sky/SkyTest.mat',
                asset: [
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
                ].join('\n'),
            },
            [ddsGuid]: { pathname: 'Assets/Textures/StarsTest.dds', asset: buildSyntheticDdsCubemap(8) },
        };
        const dir = path.join(root, 'sky');
        const pkgDir = writeExtractedDir(path.join(dir, 'pkg'), entries);
        F('sky', { pkgDir }, [
            { name: 'bake', args: ['--pkg', pkgDir, '--scene', 'SkyTest.unity', '--project', '<PROJ>', '--png'] },
            // Re-run into the SAME project dir: the runner keeps <PROJ> stable
            // within a fixture side, so this exercises the bake-reuse sidecar.
            { name: 'rebake-reuse', args: ['--pkg', pkgDir, '--scene', 'SkyTest.unity', '--project', '<PROJ>', '--png'] },
            { name: 'json', args: ['--pkg', pkgDir, '--scene', 'SkyTest.unity', '--project', '<PROJ>', '--png', '--json'] },
        ]);
    }

    // ---- 4. grade (color-grade-mapping.test.mjs corpus) ----
    {
        const dir = path.join(root, 'grade');
        const variants = {
            smh: [smhDoc([1.2, 1, 1, 0.05], [1, 1.1, 1, 0], [1, 1, 0.9, -0.02])],
            'smh-limits': [smhDoc([1.2, 1, 1, 0], [1, 1, 1, 0], [1, 1, 0.9, 0],
                { shadowsStart: 0.05, shadowsEnd: 0.45, highlightsStart: 0.6, highlightsEnd: 0.9 })],
            lgg: [lggDoc([1, 0.9, 1, 0.02], [1.1, 1, 1, -0.05], [1, 1, 1.15, 0.03])],
            'smh-plus-lgg': [
                smhDoc([1.2, 1, 1, 0], [1, 1, 1, 0], [1, 1, 0.9, 0]),
                lggDoc([1, 0.9, 1, 0], [1, 1, 1, 0], [1, 1, 1.15, 0]),
            ],
            coladj: [colAdjDoc({ postExposure: 0.4, contrast: 20, saturation: 10, hueShift: 15 })],
            // White-balance slice: WhiteBalance temp/tint + hueShift + colorFilter
            // all carry natively (ColorGradeEffect.temperature/tint/hueShift +
            // ColorFilterEffect from the sRGB->linear picker color).
            whitebalance: [
                ['  m_Name: WhiteBalance', '  active: 1',
                    '  temperature:', '    m_OverrideState: 1', '    m_Value: 30',
                    '  tint:', '    m_OverrideState: 1', '    m_Value: -12.5'],
                colAdjDoc({ hueShift: 25, colorFilter: '{r: 1, g: 0.8, b: 0.6, a: 1}', saturation: 10 }),
            ],
            'bloom-vignette': [
                bloomDoc({ threshold: 0.8, intensity: 0.6, scatter: 0.5, tint: '{r: 1, g: 0.5, b: 0.5, a: 1}' }),
                vignetteDoc({ intensity: 0.2, smoothness: 0.2, rounded: 1 }),
            ],
            none: [colAdjDoc({})],
        };
        for (const [vname, docs] of Object.entries(variants)) {
            const pkg = path.join(dir, vname, 'pkg');
            const sceneGuid = '00000000000000000000000000cg0001';
            const profGuid = '00000000000000000000000000cg0002';
            writeExtractedDir(pkg, {
                [sceneGuid]: {
                    pathname: 'Assets/Scenes/GradeTest.unity',
                    asset: sceneYaml([kDaySun(), globalVolumeYaml(400, profGuid)], kDayRenderSettings),
                },
                [profGuid]: { pathname: 'Assets/Volumes/GradeProfile.asset', asset: profileYaml(docs) },
            });
            F(`grade-${vname}`, { pkgDir: pkg }, [
                { name: 'convert', args: ['--pkg', pkg, '--scene', 'GradeTest.unity', '--project', '<PROJ>', '--png'] },
            ]);
        }
        // --grade-lut legacy path (writes the .cube).
        F('grade-lut', { pkgDir: path.join(dir, 'smh', 'pkg') }, [
            { name: 'lut', args: ['--pkg', path.join(dir, 'smh', 'pkg'), '--scene', 'GradeTest.unity', '--project', '<PROJ>', '--png', '--grade-lut'] },
        ]);
    }

    // ---- 5. drop (volume-drop-reporting.test.mjs corpus) ----
    {
        const dir = path.join(root, 'drop');
        const sceneGuid = '00000000000000000000000000dr0001';
        const profGuid = '00000000000000000000000000dr0002';
        const pkg = path.join(dir, 'pkg');
        writeExtractedDir(pkg, {
            [sceneGuid]: {
                pathname: 'Assets/Scenes/DropTest.unity',
                asset: sceneYaml([
                    lightYaml(300, 'Sun', 1),
                    globalVolumeYaml(400, profGuid),
                ], kDayRenderSettings),
            },
            [profGuid]: {
                pathname: 'Assets/Volumes/DropProfile.asset',
                asset: profileYaml([
                    colAdjDoc({ postExposure: 0.2, colorFilter: '{r: 1, g: 0.8, b: 0.6, a: 1}', saturation: 10 }),
                    ['  m_Name: ChromaticAberration', '  active: 1',
                        '  intensity:', '    m_OverrideState: 1', '    m_Value: 0.5'],
                    ['  m_Name: SplitToning', '  active: 1',
                        '  shadows:', '    m_OverrideState: 1', '    m_Value: {r: 0.2, g: 0.3, b: 0.5, a: 0}',
                        '  balance:', '    m_OverrideState: 1', '    m_Value: 20'],
                ]),
            },
        });
        F('drop', { pkgDir: pkg }, [
            { name: 'human', args: ['--pkg', pkg, '--scene', 'DropTest.unity', '--project', '<PROJ>', '--png'] },
            { name: 'json', args: ['--pkg', pkg, '--scene', 'DropTest.unity', '--project', '<PROJ>', '--png', '--json'] },
        ]);
    }

    // ---- 5b. userlut (ColorLookup strip -> CubeLutEffect .cube transcode) ----
    {
        const dir = path.join(root, 'userlut');
        const lutTexGuid = '00000000000000000000000000ab0003'; // hex — the emit regex requires Unity guid shape
        const lookupDoc = (contribution) => [
            '  m_Name: ColorLookup', '  active: 1',
            '  texture:', '    m_OverrideState: 1', `    m_Value: {fileID: 2800000, guid: ${lutTexGuid}, type: 3}`,
            '  contribution:', '    m_OverrideState: 1', `    m_Value: ${contribution}`,
        ];
        const variants = {
            rgb8: { docs: [lookupDoc(0.6)], lut: lutStrip(16), lutPath: 'Assets/LUTs/TealOrange.png' },
            rgba16: { docs: [lookupDoc(1)], lut: lutStrip(8, { depth: 16, alpha: true }), lutPath: 'Assets/LUTs/Deep.png' },
            inert: { docs: [lookupDoc(0)], lut: lutStrip(16), lutPath: 'Assets/LUTs/TealOrange.png' },
            badstrip: { docs: [lookupDoc(1)], lut: encodePng(32, 16, () => [0.5, 0.5, 0.5]), lutPath: 'Assets/LUTs/NotAStrip.png' },
            tga: { docs: [lookupDoc(1)], lut: Buffer.from('TGA-BYTES-NOT-DECODED'), lutPath: 'Assets/LUTs/TealOrange.tga' },
            conflict: {
                docs: [lookupDoc(0.8), smhDoc([1.2, 1, 0.9, 0], [1, 1, 1, 0], [0.9, 1, 1.1, 0])],
                lut: lutStrip(16), lutPath: 'Assets/LUTs/TealOrange.png', extraArgs: ['--grade-lut'],
            },
            // Hostile decoder inputs — both twins must terminate (the runner's
            // spawn timeout turns a wedge into a FAIL) with identical drop notes.
            hostilechunk: { docs: [lookupDoc(1)], lut: hostileChunkPng(), lutPath: 'Assets/LUTs/TealOrange.png' },
            truncated: { docs: [lookupDoc(1)], lut: truncatedPng(), lutPath: 'Assets/LUTs/TealOrange.png' },
            hugedims: { docs: [lookupDoc(1)], lut: hugeDimsPng(), lutPath: 'Assets/LUTs/TealOrange.png' },
            bomb: { docs: [lookupDoc(1)], lut: bombPng(), lutPath: 'Assets/LUTs/TealOrange.png' },
            corrupt: { docs: [lookupDoc(1)], lut: corruptPng(), lutPath: 'Assets/LUTs/TealOrange.png' },
            truncdeflate: { docs: [lookupDoc(1)], lut: truncDeflatePng(), lutPath: 'Assets/LUTs/TealOrange.png' },
            adlercut: { docs: [lookupDoc(1)], lut: adlerCutPng(), lutPath: 'Assets/LUTs/TealOrange.png' },
            shortdeflate: { docs: [lookupDoc(1)], lut: shortDeflatePng(), lutPath: 'Assets/LUTs/TealOrange.png' },
        };
        for (const [vname, v] of Object.entries(variants)) {
            const pkg = path.join(dir, vname, 'pkg');
            const sceneGuid = '00000000000000000000000000ab0001';
            const profGuid = '00000000000000000000000000ab0002';
            writeExtractedDir(pkg, {
                [sceneGuid]: {
                    pathname: 'Assets/Scenes/LutTest.unity',
                    asset: sceneYaml([kDaySun(), globalVolumeYaml(400, profGuid)], kDayRenderSettings),
                },
                [profGuid]: { pathname: 'Assets/Volumes/LutProfile.asset', asset: profileYaml(v.docs) },
                [lutTexGuid]: { pathname: v.lutPath, asset: v.lut },
            });
            F(`userlut-${vname}`, { pkgDir: pkg }, [
                { name: 'convert', args: ['--pkg', pkg, '--scene', 'LutTest.unity', '--project', '<PROJ>', '--png', ...(v.extraArgs || [])] },
            ]);
        }
    }

    // ---- 6. transform (transform-convention.test.mjs e2e corpus) ----
    {
        const dir = path.join(root, 'transform');
        const pkg = path.join(dir, 'pkg');
        writeExtractedDir(pkg, {
            '00000000000000000000000000abcdef': {
                pathname: 'Assets/Scenes/Test.unity',
                asset: sceneYaml([
                    [
                        '--- !u!1 &100', 'GameObject:', '  m_Name: Parent', '  m_IsActive: 1',
                        '--- !u!4 &101', 'Transform:', '  m_GameObject: {fileID: 100}',
                        '  m_LocalRotation: {x: 0, y: 0.258819, z: 0, w: 0.9659258}',
                        '  m_LocalPosition: {x: 0, y: 0, z: 0}',
                        '  m_LocalScale: {x: 1, y: 1, z: 1}',
                        '  m_Father: {fileID: 0}',
                    ].join('\n'),
                    meshObjectYaml(200, 'ChildCube', null, {
                        rot: [0.3826834, 0, 0, 0.9238795], pos: [2, 0, 0], scale: [-1, 1, 1], father: 101,
                    }),
                    lightYaml(300, 'Sun', 1, { rot: [0.1913417, 0.8001031, -0.4619398, 0.3314136] }),
                ]),
            },
        });
        const dirsPkg = path.join(dir, 'dirs-pkg');
        writeExtractedDir(dirsPkg, {
            '00000000000000000000000000abcd02': {
                pathname: 'Assets/Scenes/Dirs.unity',
                asset: sceneYaml([
                    lightYaml(300, 'SunA', 1, { intensity: 1.5 }),
                    lightYaml(310, 'SunB', 1, { intensity: 0.5 }),
                    lightYaml(320, 'SunC', 1, { intensity: 2.5, color: [0.9, 0.8, 0.7] }),
                    lightYaml(330, 'SunD', 1, { intensity: 0.25 }),
                    lightYaml(340, 'SunE', 1, { intensity: 1.0 }),
                    lightYaml(350, 'SunOff', 1, { disabled: true }),
                ]),
            },
        });
        F('transform', { pkgDir: pkg }, [
            { name: 'out', args: ['--pkg', pkg, '--scene', 'Test.unity', '--out', '<OUT>/Test_unity.scene'] },
        ]);
        F('directionals', { pkgDir: dirsPkg }, [
            { name: 'cap-note', args: ['--pkg', dirsPkg, '--scene', 'Dirs.unity', '--out', '<OUT>/Dirs_unity.scene'] },
        ]);
    }

    // ---- 7. night (ambient/fog/exposure/local-shadow paths via CLI) ----
    {
        const dir = path.join(root, 'night');
        const nightRs = (mode, fog) => [
            '--- !u!104 &2',
            'RenderSettings:',
            `  m_Fog: ${fog ? 1 : 0}`,
            '  m_FogColor: {r: 0.28, g: 0.22, b: 0.42, a: 1}',
            `  m_FogMode: ${fog === 'exp' ? 2 : 1}`,
            '  m_LinearFogStart: 20',
            '  m_LinearFogEnd: 180',
            '  m_FogDensity: 0.015',
            `  m_AmbientMode: ${mode}`,
            '  m_AmbientSkyColor: {r: 0.2314, g: 0.1804, b: 0.3608, a: 1}',
            '  m_AmbientEquatorColor: {r: 0.1137, g: 0.0902, b: 0.2196, a: 1}',
            '  m_AmbientGroundColor: {r: 0.0471, g: 0.0392, b: 0.1176, a: 1}',
        ].join('\n');
        const nightObjects = [
            lightYaml(300, 'Moon', 1, { intensity: 1.5, color: [0.7, 0.75, 1] }),
            lightYaml(400, 'Torch', 2, { intensity: 2, range: 8, color: [1, 0.6, 0.2], urpTier: 2 }),
            lightYaml(500, 'Lantern', 2, { intensity: 1, range: 5, color: [1, 0.7, 0.3], urpTier: 0 }),
            lightYaml(600, 'Spot', 0, {}),
            meshObjectYaml(700, 'Ground', null, { builtinFileId: 10209 }),
        ];
        const variants = {
            trilight: { rs: nightRs(1, true), objects: nightObjects },
            flat: { rs: nightRs(3, true), objects: nightObjects },
            'exp-fog': { rs: nightRs(1, 'exp'), objects: nightObjects },
            'night-postexposure': {
                rs: nightRs(1, true),
                objects: [...nightObjects, globalVolumeYaml(800, '00000000000000000000000000ni0002')],
                profile: profileYaml([colAdjDoc({ postExposure: 1.5 })]),
            },
        };
        for (const [vname, v] of Object.entries(variants)) {
            const pkg = path.join(dir, vname, 'pkg');
            const entries = {
                '00000000000000000000000000ni0001': {
                    pathname: 'Assets/Scenes/Night.unity',
                    asset: sceneYaml(v.objects, v.rs),
                },
            };
            if (v.profile)
                entries['00000000000000000000000000ni0002'] = { pathname: 'Assets/Volumes/NightProfile.asset', asset: v.profile };
            writeExtractedDir(pkg, entries);
            F(`night-${vname}`, { pkgDir: pkg }, [
                { name: 'faithful', args: ['--pkg', pkg, '--scene', 'Night.unity', '--project', '<PROJ>', '--png'] },
                { name: 'shadows-off', args: ['--pkg', pkg, '--scene', 'Night.unity', '--project', '<PROJ>', '--png', '--local-shadows', 'off'] },
            ]);
        }
    }

    // ---- 8. materials (family dispatch / emission / blend modes) ----
    {
        const dir = path.join(root, 'materials');
        const pkg = path.join(dir, 'pkg');
        const T = (n) => `00000000000000000000000000t${String(n).padStart(5, '0')}`;
        const M = (n) => `00000000000000000000000000m${String(n).padStart(5, '0')}`;
        // Hex-only texture guids: the parser's guid regex is [0-9a-f]{32}, so the
        // legacy T(n) ids (with their 't') never bind — these do.
        const UT = (n) => `00000000000000000000000000ab000${n}`;
        const texEntries = {};
        for (let i = 1; i <= 8; i++)
            texEntries[T(i)] = { pathname: `Assets/Pack/Textures/Tex_${i}_Map.png`, asset: `PNG-BYTES-${i}` };
        for (let i = 1; i <= 5; i++)
            texEntries[UT(i)] = { pathname: `Assets/Pack/Textures/T_Urp_${i}.png`, asset: `PNG-URP-${i}` };

        const kGlass06Guid = 'b253cb5ee0fc4a047be47d7b7a1c42dc'; // remap trigger (convert.js kGlass06MatGuid)
        const kWaterBodyGuid = '6d24c2fc3a1139d4ab252fdaf2d031d2'; // remap destination (kWaterBodyMatGuid)
        const mats = {
            [M(1)]: matYaml('Std_Full', {
                shaderGuid: '0730dae3aaaaaaaaaaaaaaaaaaaaaaaa',
                texEnvs: { _Albedo_Map: T(1), _Normal_Map: T(2), _MetallicGlossMap: T(3), _OcclusionMap: T(4), _Emission_Map: T(5) },
                floats: { _Metallic: 0.25, _Smoothness: 0.6, _Enable_Emission: 1 },
                colors: { _BaseColor: [0.3098039, 0.254902, 0.1764706, 1], _Emission_Color: [2, 1.5, 1, 1] },
            }),
            [M(2)]: matYaml('Cutout_Leaf', {
                shaderGuid: '0730dae3bbbbbbbbbbbbbbbbbbbbbbbb',
                keywords: ['_ALPHATEST_ON'],
                renderType: 'TransparentCutout',
                texEnvs: { _BaseMap: T(1) },
                floats: { _AlphaClip: 1, _Cutoff: 0.35, _Cull: 0 },
                colors: { _BaseColor: [1, 1, 1, 1] },
            }),
            [M(3)]: matYaml('Glass_Blend', {
                shaderGuid: '0730dae3cccccccccccccccccccccccc',
                keywords: ['_SURFACE_TYPE_TRANSPARENT'],
                renderType: 'Transparent',
                floats: { _Surface: 1, _Smoothness: 0.9 },
                colors: { _BaseColor: [0.4, 0.7, 0.9, 0.35] },
            }),
            [M(4)]: matYaml('Legacy_Fog', {
                shaderGuid: '00000000dddddddddddddddddddddddd',
                floats: { _Mode: 3 },
                colors: { _Color: [0.5, 0.5, 0.6, 0.4] },
            }),
            [M(5)]: matYaml('Plain_White', {
                shaderGuid: '0730dae3eeeeeeeeeeeeeeeeeeeeeeee',
                floats: {},
                colors: { _BaseColor: [1, 1, 1, 1] },
            }),
            [M(6)]: matYaml('Water_Pond', {
                shaderGuid: '0730dae3ffffffffffffffffffffffff',
                floats: { _Smoothness: 0.8 },
                colors: { _BaseColor: [0.05, 0.15, 0.2, 0.6] },
            }),
            [M(7)]: matYaml('WaterFlow_01', {
                shaderGuid: '88fd8f21aaaaaaaaaaaaaaaaaaaaaaaa',
                texEnvs: { _Color_Mask: T(6), _Normals: T(7) },
                floats: { _Metallic: 0.1, _Smoothness: 0.75, _UVScroll_Speed: 0.35, _Water_Overlay_Power: 0.4, _Fresnel_Power: 0.012, _Emission: 1.2 },
                colors: { _Water_Color: [0.1, 0.3, 0.45, 0.8], _Fresnel_Color: [0.7, 0.9, 1, 0] },
            }),
            [M(8)]: matYaml('WaterFall_Top_FX', {
                shaderGuid: '87c14512aaaaaaaaaaaaaaaaaaaaaaaa',
                keywords: ['_SURFACE_TYPE_TRANSPARENT', '_ALPHAPREMULTIPLY_ON'],
                renderType: 'Transparent',
                texEnvs: { _Texture_01: T(6), _Texture_02: T(7), _Texture_03: T(8) },
                floats: { _Surface: 1, _Brightness: 1.4 },
                colors: { _Speed: [20, 0, 0, 0], _Water_Color: [0.8, 0.95, 1, 1] },
            }),
            [M(9)]: matYaml('Cliff_Triplanar', {
                shaderGuid: '19e269a311c45cd4482cf0ac0e694503',
                texEnvs: {
                    _Triplanar_Texture_Top: T(1), _Triplanar_Texture_Side: T(2),
                    _Triplanar_Normal_Texture_Top: T(3), _Triplanar_Normal_Texture_Side: T(3), _Triplanar_Normal_Texture_Bottom: T(3),
                },
                floats: {
                    _Enable_Triplanar_Texture: 1, _Enable_Triplanar_Normals: 1,
                    _Tiling: 0.35, _TilingTop: 0.5, _Triplanar_Fade: 0.7,
                    _Top_Smoothness: 0.3, _Smoothness: 0.45, _Metallic: 0, _AlphaClip: 1,
                },
                colors: { _Color_Tint: [1, 1, 1, 1] },
            }),
            [M(10)]: matYaml('Flat_PolygonShader', {
                shaderGuid: '19e269a311c45cd4482cf0ac0e694503',
                texEnvs: { _Albedo_Map: T(1) },
                floats: { _Enable_Triplanar_Texture: 0, _Smoothness: 0.5 },
                colors: { _Color_Tint: [0.9, 0.85, 0.8, 1] },
            }),
            [M(11)]: matYaml('Aurora_01', {
                shaderGuid: '6b091954aaaaaaaaaaaaaaaaaaaaaaaa',
                texEnvs: { _SampleTexture2D_f00dbeefcafef00d_Tex: T(5) },
                floats: {},
                colors: { _Color: [0.227, 1, 0, 0] },
            }),
            [M(12)]: matYaml('Moon_01', {
                shaderGuid: 'e8644287aaaaaaaaaaaaaaaaaaaaaaaa',
                texEnvs: { _MainTex: T(5) },
                floats: {},
                colors: { _Color: [1, 1, 0.9, 1] },
            }),
            [M(13)]: matYaml('Unknown_Recognizable', {
                shaderGuid: 'deadbeefaaaaaaaaaaaaaaaaaaaaaaaa',
                texEnvs: { _MainTex: T(1) },
                floats: { _Smoothness: 0.5 },
                colors: { _Color: [0.8, 0.2, 0.2, 1] },
            }),
            [M(14)]: matYaml('Unknown_AutoNamed', {
                shaderGuid: 'cafebabeaaaaaaaaaaaaaaaaaaaaaaaa',
                texEnvs: { _SampleTexture2D_0123456789abcdef00_Tex: T(1) },
                floats: {},
                colors: { _Color_aabbccddeeff00112233445566778899: [0.5, 0.5, 0.5, 1] },
            }),
            [M(15)]: matYaml('Emission_ColorOnly', {
                shaderGuid: '0730dae399999999999999999999999a',
                floats: {},
                colors: { _BaseColor: [0.1, 0.1, 0.1, 1], _EmissionColor: [8, 3, 1, 1] },
            }),
            [M(16)]: matYaml('Emission_BlackKill', {
                shaderGuid: '0730dae399999999999999999999999b',
                texEnvs: { _Emission_Map: T(5), _Albedo_Map: T(1) },
                floats: { _Enable_Emission: 1 },
                colors: { _BaseColor: [0.5, 0.5, 0.5, 1], _Emission_Color: [0.001, 0.001, 0.001, 1] },
            }),
            [kGlass06Guid]: matYaml('Glass_06', {
                shaderGuid: '0730dae3aaaaaaaaaaaaaaaaaaaaaaaa',
                keywords: ['_SURFACE_TYPE_TRANSPARENT'],
                renderType: 'Transparent',
                floats: { _Surface: 1, _Smoothness: 0.95 },
                colors: { _BaseColor: [0.55, 0.8, 0.85, 0.3] },
            }),
            [kWaterBodyGuid]: matYaml('Water_01', {
                shaderGuid: '0730dae3bbbbbbbbbbbbbbbbbbbbbbbc',
                floats: { _Smoothness: 0.85 },
                colors: { _BaseColor: [0.04, 0.12, 0.18, 0.7] },
            }),
            // ---- stock URP Lit dispatch ('933532a4', the real URP Lit GUID).
            // Hex texture guids (unlike T(n)) so binds and tiling actually run.
            [M(17)]: matYaml('Urp_Full', {
                shaderGuid: '933532a4fcc9baf4fa0491de14d08ed7',
                keywords: ['_EMISSION'],
                texEnvs: {
                    _BaseMap: { guid: UT(1), scale: [2, 0.5], offset: [0.25, 0.1] },
                    _BumpMap: UT(2),
                    _MetallicGlossMap: UT(3),
                    _OcclusionMap: UT(4),
                    _EmissionMap: UT(5),
                },
                floats: { _Surface: 0, _AlphaClip: 0, _Cull: 2, _WorkflowMode: 1,
                          _Metallic: 0.3, _Smoothness: 0.4, _BumpScale: 0.8, _OcclusionStrength: 0.9 },
                colors: { _BaseColor: [0.7843137, 0.7843137, 0.7843137, 1], _EmissionColor: [2, 1, 0.5, 1] },
            }),
            [M(18)]: matYaml('Urp_CutoutSpec', {
                shaderGuid: '933532a4fcc9baf4fa0491de14d08ed7',
                keywords: ['_ALPHATEST_ON'],
                renderType: 'TransparentCutout',
                texEnvs: { _BaseMap: UT(1), _SpecGlossMap: UT(3) },
                floats: { _Surface: 0, _AlphaClip: 1, _Cutoff: 0.35, _Cull: 0,
                          _WorkflowMode: 0, _Metallic: 0.9, _Smoothness: 0.6 },
                colors: { _BaseColor: [1, 1, 1, 1], _SpecColor: [0.2, 0.2, 0.2, 1] },
            }),
            [M(19)]: matYaml('Urp_Additive', {
                shaderGuid: '933532a4fcc9baf4fa0491de14d08ed7',
                keywords: ['_SURFACE_TYPE_TRANSPARENT'],
                renderType: 'Transparent',
                floats: { _Surface: 1, _Blend: 2, _Smoothness: 0.2 },
                colors: { _BaseColor: [1, 0.5, 0.2, 0.6] },
            }),
            // Emission authored but the _EMISSION keyword is off: nothing may emit.
            [M(20)]: matYaml('Urp_EmissionOff', {
                shaderGuid: '933532a4fcc9baf4fa0491de14d08ed7',
                texEnvs: { _BaseMap: UT(1), _EmissionMap: UT(5) },
                floats: { _Surface: 0, _Metallic: 0, _Smoothness: 0.5 },
                colors: { _BaseColor: [0.5, 0.5, 0.5, 1], _EmissionColor: [2, 1, 0.5, 1] },
            }),
        };
        const sceneObjects = [
            meshObjectYaml(1000, 'FullProp', null, { matGuids: [M(1)] }),
            meshObjectYaml(1100, 'Leaf', null, { builtinFileId: 10208, matGuids: [M(2)] }),
            meshObjectYaml(1200, 'Window', null, { matGuids: [M(3)] }),
            meshObjectYaml(1300, 'FogCard', null, { matGuids: [M(4)] }),
            meshObjectYaml(1400, 'PlainCube', null, { matGuids: [M(5)] }),
            meshObjectYaml(1500, 'water', null, { builtinFileId: 10209, matGuids: [kGlass06Guid] }),
            meshObjectYaml(1550, 'WaterPond', null, { builtinFileId: 10209, matGuids: [M(6)] }),
            meshObjectYaml(1600, 'River', null, { builtinFileId: 10209, matGuids: [M(7)] }),
            meshObjectYaml(1700, 'FallsLip', null, { builtinFileId: 10209, matGuids: [M(8)] }),
            meshObjectYaml(1800, 'Cliff', null, { matGuids: [M(9)] }),
            meshObjectYaml(1900, 'FlatRock', null, { matGuids: [M(10)] }),
            meshObjectYaml(2000, 'AuroraCurtain', null, { builtinFileId: 10209, matGuids: [M(11)] }),
            meshObjectYaml(2100, 'MoonCard', null, { builtinFileId: 10209, matGuids: [M(12)] }),
            meshObjectYaml(2200, 'OddProp', null, { matGuids: [M(13)] }),
            meshObjectYaml(2300, 'AutoNamedProp', null, { matGuids: [M(14)] }),
            meshObjectYaml(2400, 'FireGlow', null, { builtinFileId: 10207, matGuids: [M(15)] }),
            meshObjectYaml(2500, 'DeadWindow', null, { matGuids: [M(16)] }),
            meshObjectYaml(4000, 'UrpFullProp', null, { matGuids: [M(17)] }),
            meshObjectYaml(4100, 'UrpCutout', null, { matGuids: [M(18)] }),
            meshObjectYaml(4200, 'UrpAdditive', null, { builtinFileId: 10209, matGuids: [M(19)] }),
            meshObjectYaml(4300, 'UrpDeadEmission', null, { matGuids: [M(20)] }),
            meshObjectYaml(2600, 'TwoMat', null, { matGuids: [M(1), M(3)] }),
            meshObjectYaml(2700, 'MissingMat', null, { matGuids: ['00000000000000000000000000nosuch'] }),
            meshObjectYaml(2800, 'Hidden', null, { inactive: true }),
            meshObjectYaml(2900, 'DisabledRenderer', null, { disabled: true, noCast: true, noReceive: true }),
            lightYaml(300, 'Sun', 1),
            // Skinned mesh renderer + camera + particles + LODGroup, all counted skips.
            [
                '--- !u!1 &3000', 'GameObject:', '  m_Name: Character', '  m_IsActive: 1',
                '--- !u!4 &3001', 'Transform:', '  m_GameObject: {fileID: 3000}',
                '  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}',
                '  m_LocalPosition: {x: 0, y: 0, z: 0}',
                '  m_LocalScale: {x: 1, y: 1, z: 1}',
                '  m_Father: {fileID: 0}',
                '--- !u!137 &3002', 'SkinnedMeshRenderer:', '  m_GameObject: {fileID: 3000}',
                '--- !u!1 &3100', 'GameObject:', '  m_Name: MainCamera', '  m_IsActive: 1',
                '--- !u!4 &3101', 'Transform:', '  m_GameObject: {fileID: 3100}',
                '  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}',
                '  m_LocalPosition: {x: 0, y: 1, z: -10}',
                '  m_LocalScale: {x: 1, y: 1, z: 1}',
                '  m_Father: {fileID: 0}',
                '--- !u!20 &3102', 'Camera:', '  m_GameObject: {fileID: 3100}',
                '--- !u!198 &3103', 'ParticleSystem:', '  m_GameObject: {fileID: 3100}',
                '--- !u!205 &3104', 'LODGroup:', '  m_GameObject: {fileID: 3100}',
            ].join('\n'),
        ];
        const entries = {
            '00000000000000000000000000ma0001': {
                pathname: 'Assets/Scenes/MatTest.unity',
                asset: sceneYaml(sceneObjects, kDayRenderSettings),
            },
            ...texEntries,
        };
        for (const [guid, yaml] of Object.entries(mats)) {
            const name = /m_Name: (\S+)/.exec(yaml)[1];
            entries[guid] = { pathname: `Assets/Pack/Materials/${name}.mat`, asset: yaml };
        }
        writeExtractedDir(pkg, entries);
        F('materials', { pkgDir: pkg }, [
            { name: 'json', args: ['--pkg', pkg, '--scene', 'MatTest.unity', '--project', '<PROJ>', '--png', '--json'] },
            { name: 'human', args: ['--pkg', pkg, '--scene', 'MatTest.unity', '--project', '<PROJ>', '--png'] },
            { name: 'verbose', args: ['--pkg', pkg, '--scene', 'MatTest.unity', '--project', '<PROJ>', '--png', '--verbose'] },
            { name: 'no-copy', args: ['--pkg', pkg, '--scene', 'MatTest.unity', '--project', '<PROJ>', '--png', '--no-copy-textures'] },
        ]);
    }

    // ---- 9. prefab (PrefabInstance expansion + modifications) ----
    {
        const dir = path.join(root, 'prefab');
        const pkg = path.join(dir, 'pkg');
        const kFbxGuid = '00000000000000000000000000pf00f1';
        const kPrefabGuid = '00000000000000000000000000pf00p1';
        const kMatA = '00000000000000000000000000pf00m1';
        const kMatB = '00000000000000000000000000pf00m2';
        const prefabYaml = sceneYaml([
            meshObjectYaml(5100, 'SM_Prop_Bench_01', kFbxGuid, { matGuids: [kMatA] }),
        ]);
        const instance = (anchor, mods, parentFile) => [
            `--- !u!1001 &${anchor}`,
            'PrefabInstance:',
            '  m_Modification:',
            `    m_TransformParent: {fileID: ${parentFile ?? 0}}`,
            '    m_Modifications:',
            ...mods,
            '  m_SourcePrefab: {fileID: 100100000, guid: ' + kPrefabGuid + ', type: 3}',
        ].join('\n');
        const mod = (target, propPath, value, objRefGuid) => [
            `    - target: {fileID: ${target}, guid: ${kPrefabGuid}, type: 3}`,
            `      propertyPath: ${propPath}`,
            `      value: ${value}`,
            objRefGuid
                ? `      objectReference: {fileID: 2100000, guid: ${objRefGuid}, type: 2}`
                : '      objectReference: {fileID: 0}',
        ];
        const sceneEntries = {
            '00000000000000000000000000pf0001': {
                pathname: 'Assets/Scenes/PrefabTest.unity',
                asset: sceneYaml([
                    instance(9001, [
                        ...mod(5101, 'm_LocalPosition.x', 4),
                        ...mod(5101, 'm_LocalPosition.z', -2.5),
                        ...mod(5101, 'm_LocalRotation.y', 0.7071068),
                        ...mod(5101, 'm_LocalRotation.w', 0.7071068),
                        ...mod(5100, 'm_Name', 'Bench East'),
                    ]),
                    instance(9002, [
                        ...mod(5103, 'm_Materials.Array.data[0]', '', kMatB),
                        ...mod(5100, 'm_Name', 'Bench Recolour'),
                    ]),
                    // Stripped transform aliasing into instance 9001's root.
                    [
                        '--- !u!4 &9101 stripped',
                        'Transform:',
                        '  m_CorrespondingSourceObject: {fileID: 5101, guid: ' + kPrefabGuid + ', type: 3}',
                        '  m_PrefabInstance: {fileID: 9001}',
                    ].join('\n'),
                    lightYaml(300, 'Sun', 1),
                ]),
            },
            [kPrefabGuid]: { pathname: 'Assets/Pack/Prefabs/SM_Prop_Bench_01.prefab', asset: prefabYaml },
            [kFbxGuid]: { pathname: 'Assets/Pack/Models/SM_Prop_Bench_01.fbx', asset: 'FBX-BENCH-TEXT' },
            [kMatA]: {
                pathname: 'Assets/Pack/Materials/Bench_A.mat',
                asset: matYaml('Bench_A', {
                    shaderGuid: '0730dae3aaaaaaaaaaaaaaaaaaaaaaaa',
                    floats: { _Smoothness: 0.4 },
                    colors: { _BaseColor: [0.4, 0.3, 0.2, 1] },
                }),
            },
            [kMatB]: {
                pathname: 'Assets/Pack/Materials/Bench_B.mat',
                asset: matYaml('Bench_B', {
                    shaderGuid: '0730dae3aaaaaaaaaaaaaaaaaaaaaaaa',
                    floats: { _Smoothness: 0.1 },
                    colors: { _BaseColor: [0.7, 0.1, 0.1, 1] },
                }),
            },
        };
        writeExtractedDir(pkg, sceneEntries);
        F('prefab', { pkgDir: pkg }, [
            { name: 'json', args: ['--pkg', pkg, '--scene', 'PrefabTest.unity', '--project', '<PROJ>', '--png', '--json'] },
            { name: 'human', args: ['--pkg', pkg, '--scene', 'PrefabTest.unity', '--project', '<PROJ>', '--png'] },
        ]);
    }

    // ---- 10. fbxbin (binary FBX multi-node scanner) ----
    {
        const dir = path.join(root, 'fbxbin');
        const pkg = path.join(dir, 'pkg');
        const kFbxGuid = '00000000000000000000000000fb00f1';
        // The FBX node scanner runs when the FBX is a PrefabInstance SOURCE
        // (Unity's model-in-scene form), not a direct MeshFilter guid ref.
        const fbxInstance = [
            '--- !u!1001 &9001',
            'PrefabInstance:',
            '  m_Modification:',
            '    m_TransformParent: {fileID: 0}',
            '    m_Modifications:',
            `    - target: {fileID: 400000, guid: ${kFbxGuid}, type: 3}`,
            '      propertyPath: m_LocalPosition.x',
            '      value: 3',
            '      objectReference: {fileID: 0}',
            `    - target: {fileID: 400000, guid: ${kFbxGuid}, type: 3}`,
            '      propertyPath: m_Name',
            '      value: Scope Placement',
            '      objectReference: {fileID: 0}',
            `  m_SourcePrefab: {fileID: 100100000, guid: ${kFbxGuid}, type: 3}`,
        ].join('\n');
        writeExtractedDir(pkg, {
            '00000000000000000000000000fb0001': {
                pathname: 'Assets/Scenes/FbxBinTest.unity',
                asset: sceneYaml([
                    fbxInstance,
                    meshObjectYaml(100, 'DirectRef', kFbxGuid, { pos: [3, 0, 1] }),
                    lightYaml(300, 'Sun', 1),
                ]),
            },
            [kFbxGuid]: { pathname: 'Assets/Pack/Models/SM_Prop_Scope_01.fbx', asset: buildMultiNodeFbx() },
        });
        F('fbxbin', { pkgDir: pkg }, [
            { name: 'json', args: ['--pkg', pkg, '--scene', 'FbxBinTest.unity', '--project', '<PROJ>', '--png', '--json'] },
            { name: 'human', args: ['--pkg', pkg, '--scene', 'FbxBinTest.unity', '--project', '<PROJ>', '--png'] },
        ]);
    }

    // ---- 10b. unityproj (--unity-project pipeline state) ----
    {
        const dir = path.join(root, 'unityproj');
        const pkg = path.join(dir, 'pkg');
        const uproj = path.join(dir, 'unity-project');
        writeExtractedDir(pkg, {
            '00000000000000000000000000up0001': {
                pathname: 'Assets/Scenes/PipeTest.unity',
                asset: sceneYaml([
                    kDaySun(),
                    meshObjectYaml(100, 'Box', null),
                    globalVolumeYaml(400, '00000000000000000000000000up0002'),
                ], kDayRenderSettings),
            },
            '00000000000000000000000000up0002': {
                pathname: 'Assets/Volumes/SceneProfile.asset',
                asset: profileYaml([colAdjDoc({ saturation: 5 })]),
            },
        });
        // ProjectSettings + Assets with .asset/.asset.meta pairs.
        const kRpGuid = 'aaaa0001aaaa0001aaaa0001aaaa0001';
        const kRdGuid = 'bbbb0002bbbb0002bbbb0002bbbb0002';
        const kVolGuid = 'cccc0003cccc0003cccc0003cccc0003';
        fs.mkdirSync(path.join(uproj, 'ProjectSettings'), { recursive: true });
        fs.writeFileSync(path.join(uproj, 'ProjectSettings', 'QualitySettings.asset'), [
            'QualitySettings:',
            '  m_CurrentQuality: 1',
            '  m_QualitySettings:',
            '  - customRenderPipeline: {fileID: 11400000, guid: 00000000000000000000000000000bad, type: 2}',
            `  - customRenderPipeline: {fileID: 11400000, guid: ${kRpGuid}, type: 2}`,
            '',
        ].join('\n'));
        fs.writeFileSync(path.join(uproj, 'ProjectSettings', 'GraphicsSettings.asset'), [
            'GraphicsSettings:',
            `  m_CustomRenderPipeline: {fileID: 11400000, guid: ${kRpGuid}, type: 2}`,
            '',
        ].join('\n'));
        const assetsDir = path.join(uproj, 'Assets', 'Settings');
        fs.mkdirSync(assetsDir, { recursive: true });
        const putAsset = (name, guid, content) => {
            fs.writeFileSync(path.join(assetsDir, name), content);
            fs.writeFileSync(path.join(assetsDir, name + '.meta'), `fileFormatVersion: 2\nguid: ${guid}\n`);
        };
        putAsset('URP-High.asset', kRpGuid, [
            'MonoBehaviour:',
            '  m_SupportsHDR: 1',
            '  m_MSAA: 4',
            '  m_RenderScale: 1',
            '  m_ShadowDistance: 50',
            '  m_ShadowCascadeCount: 3',
            '  m_MainLightShadowmapResolution: 2048',
            '  m_AdditionalLightShadowsSupported: 1',
            '  m_AdditionalLightsShadowmapResolution: 2048',
            '  m_SoftShadowsSupported: 1',
            '  m_SoftShadowQuality: 2',
            `  m_VolumeProfile: {fileID: 11400000, guid: ${kVolGuid}, type: 2}`,
            '  m_RendererDataList:',
            `  - {fileID: 11400000, guid: ${kRdGuid}, type: 2}`,
            '',
        ].join('\n'));
        putAsset('URP-Renderer.asset', kRdGuid, [
            'MonoBehaviour:',
            '  m_RenderingMode: 1',
            '--- !u!114 &2',
            'MonoBehaviour:',
            '  m_Script: {fileID: 11500000, guid: f62c9c65cf3354c93be831c8bc075510, type: 3}',
            '  m_Active: 1',
            '  m_Settings:',
            '    Intensity: 0.6',
            '    Radius: 0.3',
            '    DirectLightingStrength: 0.25',
            '',
        ].join('\n'));
        putAsset('URP-Volume.asset', kVolGuid, profileYaml([
            bloomDoc({ threshold: 0.9, intensity: 0.4 }),
            vignetteDoc({ intensity: 0.2, smoothness: 0.2 }),
        ]));
        F('unityproj', { pkgDir: pkg }, [
            { name: 'pipeline', args: ['--pkg', pkg, '--scene', 'PipeTest.unity', '--project', '<PROJ>', '--unity-project', uproj, '--png'] },
            { name: 'pipeline-json', args: ['--pkg', pkg, '--scene', 'PipeTest.unity', '--project', '<PROJ>', '--unity-project', uproj, '--png', '--json'] },
        ]);
    }

    // ---- 11. wrapper (bin/unity-scene-convert.js sugar) ----
    {
        const dir = path.join(root, 'wrapper');
        const pkg = path.join(dir, 'pkg');
        writeExtractedDir(pkg, {
            '00000000000000000000000000wr0001': {
                pathname: 'Assets/Scenes/OnlyScene.unity',
                asset: sceneYaml([meshObjectYaml(100, 'SoloCube', null, { pos: [1, 0, 0] })]),
            },
        });
        F('wrapper', { pkgDir: pkg }, [
            { name: 'positional-autopick', entry: 'wrapper', args: [pkg, '<PROJ>', '--png'] },
            { name: 'too-many-positionals', entry: 'wrapper', args: [pkg, '<PROJ>', 'extra'], expectFail: true },
        ]);
    }

    return fixtures;
}
