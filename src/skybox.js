// Faithful Unity skybox -> engine Skybox HDRI pipeline.
//
// Unity night scenes (ElvenRealm Demo.unity) paint their sky with a skybox
// MATERIAL (RenderSettings.m_SkyboxMaterial -> builtin "Skybox/Cubemap",
// fileID 103) sampling a DDS cubemap. The engine's sky is either procedural
// (SkyEnvironment) or an equirectangular HDRI dome (Components::Skybox, which
// takes priority in SkyEnvironmentSystem and also drives IBL). This module
// converts the Unity cubemap into the engine's equirect .hdr so the converted
// scene shows Unity's ACTUAL sky instead of a procedural stand-in.
//
// Pipeline choice (2026-07-21): the engine's texture import cook (feat/
// texture-cook, on main) ingests Radiance .hdr through a float path and cooks
// BC6H + mips into the derived cache — so the converter emits an equirect
// .hdr into the project's Textures_Unity/ and lets the ENGINE own compression.
// TextureCompiler.exe was considered and rejected: it is an LDR (stbi_load)
// UASTC encoder with no DDS-cubemap or HDR ingest. The DDS -> equirect resample
// happens here in node, mirroring the runtime-proven starfield mock.
//
// Direction conventions (all verified against source):
//   - Engine equirect sampling (sky_render.frag EncodeDirToLatLongUv):
//       u = atan2(z, x) / 2pi + 0.5,  v = acos(y) / pi   (world dir, LH +Y up)
//     The bake writes each texel from the INVERSE of that mapping, so the
//     engine reconstructs exactly the direction the texel was baked for.
//   - Unity/D3D cubemap lookup (DDS face order +X -X +Y -Y +Z -Z, face rows
//     top-down): major-axis select + the standard RenderMan-derived face UV
//     math. Unity's world axes match the engine's (LH, +Y up, +Z forward), so
//     a world direction needs no basis change between the two.
//
// Colour: the DDS is 8-bit sRGB; texels decode to linear before filtering
// (bilinear in linear space) and are written as linear Radiance RGBE. Unity's
// dome multiplier _Tint * unity_ColorSpaceDouble(4.59479) * _Exposure is baked
// per channel, EXCEPT that the neutral authoring default (#808080, exposure 1
// -> 0.98347) snaps to exactly 1.0: Unity designed that tint as identity, and
// keeping the bake identity preserves the source texels bit-faithfully
// (ground-truthed against the ElvenRealm skybox material).

'use strict';

const fs = require('fs');

const kUnityColorSpaceDouble = 4.59479380; // unity_ColorSpaceDouble.x, linear pipeline
const kIdentitySnapTolerance = 0.02;       // |mult-1| within this on ALL channels -> 1.0
const kBuiltinSkyboxCubemapFileId = 103;   // builtin "Skybox/Cubemap" shader

function srgbToLinear(c) {
    if (c <= 0) return 0;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

// 8-bit sRGB -> linear LUT (the bake decodes every tap through this).
const kSrgbLut = new Float32Array(256);
for (let i = 0; i < 256; i++) kSrgbLut[i] = srgbToLinear(i / 255);

// ---------------------------------------------------- Unity material parse --
// Parse a Unity skybox .mat (YAML text). Returns null when it is not the
// builtin Skybox/Cubemap shader — the caller keeps the procedural sky and
// warns, rather than guessing at 6-sided/procedural/panoramic variants.
function parseUnitySkyboxMat(text) {
    const sh = text.match(/m_Shader:\s*\{fileID:\s*(-?\d+)(?:,\s*guid:\s*([0-9a-fA-F]{32}))?/);
    if (!sh) return null;
    const shaderFileId = parseInt(sh[1], 10);
    const shaderGuid = sh[2] ? sh[2].toLowerCase() : null;
    // Builtin shaders live under the sentinel guid 0000000000000000f000000000000000.
    const isBuiltinCubemap = shaderFileId === kBuiltinSkyboxCubemapFileId
        && (!shaderGuid || /^0+f0+$/.test(shaderGuid));
    const tex = text.match(/_Tex:\s*\n\s*m_Texture:\s*\{fileID:\s*\d+,\s*guid:\s*([0-9a-f]{32})/);
    const num = (name, dflt) => {
        const m = text.match(new RegExp(`-\\s*${name}:\\s*(-?[\\d.eE]+)\\s*$`, 'm'));
        return m ? parseFloat(m[1]) : dflt;
    };
    const tint = text.match(/_Tint:\s*\{r:\s*([-\d.eE]+),\s*g:\s*([-\d.eE]+),\s*b:\s*([-\d.eE]+)/);
    return {
        shaderFileId,
        isBuiltinCubemap,
        texGuid: tex ? tex[1].toLowerCase() : null,
        exposure: num('_Exposure', 1),
        rotationDegrees: num('_Rotation', 0),
        tint: tint ? [+tint[1], +tint[2], +tint[3]] : [0.5, 0.5, 0.5],
    };
}

// Unity's Skybox/Cubemap dome colour is tex * linear(_Tint) * 4.59479 *
// _Exposure. Returns the per-channel multiplier, snapped to exact identity
// when every channel lands within kIdentitySnapTolerance of 1 (the authoring
// default #808080 at exposure 1 computes 0.98347 — designed-as-neutral).
function computeSkyboxMultiplier(tint, exposure) {
    const m = tint.map((c) => srgbToLinear(c) * kUnityColorSpaceDouble * exposure);
    return m.every((c) => Math.abs(c - 1) <= kIdentitySnapTolerance) ? [1, 1, 1] : m;
}

// ------------------------------------------------------------- DDS ingest --
// Minimal DDS reader for the exact class Unity skyboxes ship as: uncompressed
// 32-bit RGB(A) cubemaps (fourCC 0). Returns { size, faces[6] } of BGRA-order
// byte views (channel byte offsets derived from the masks), mip 0 only.
function readDdsCubemap(buf) {
    if (buf.length < 128 || buf.readUInt32LE(0) !== 0x20534444) // "DDS "
        throw new Error('not a DDS file');
    const height = buf.readUInt32LE(12);
    const width = buf.readUInt32LE(16);
    const mipCount = Math.max(1, buf.readUInt32LE(28));
    const pfFlags = buf.readUInt32LE(80);
    const fourCC = buf.readUInt32LE(84);
    const bitCount = buf.readUInt32LE(88);
    const maskR = buf.readUInt32LE(92);
    const maskG = buf.readUInt32LE(96);
    const maskB = buf.readUInt32LE(100);
    const caps2 = buf.readUInt32LE(112);
    if ((caps2 & 0x200) === 0 || (caps2 & 0xFC00) !== 0xFC00)
        throw new Error('DDS is not a full 6-face cubemap');
    if (fourCC !== 0 || (pfFlags & 0x40) === 0 || bitCount !== 32)
        throw new Error(`unsupported DDS pixel format (fourCC ${fourCC}, ${bitCount}bpp) — only uncompressed 32-bit supported`);
    if (width !== height)
        throw new Error(`cubemap faces must be square (got ${width}x${height})`);
    const maskToByte = (mask) => {
        switch (mask) {
            case 0x000000FF: return 0;
            case 0x0000FF00: return 1;
            case 0x00FF0000: return 2;
            case 0xFF000000: return 3;
            default: throw new Error(`non-byte-aligned DDS channel mask 0x${mask.toString(16)}`);
        }
    };
    const off = { r: maskToByte(maskR), g: maskToByte(maskG), b: maskToByte(maskB) };
    let faceStride = 0;
    for (let m = 0; m < mipCount; m++) {
        const w = Math.max(1, width >> m), h = Math.max(1, height >> m);
        faceStride += w * h * 4;
    }
    const expected = 128 + 6 * faceStride;
    if (buf.length < expected)
        throw new Error(`DDS truncated: ${buf.length} bytes, need ${expected} (6 faces x ${mipCount} mips)`);
    const faces = [];
    for (let f = 0; f < 6; f++) {
        const start = 128 + f * faceStride; // mip 0 leads each face's mip chain
        faces.push(buf.subarray(start, start + width * width * 4));
    }
    return { size: width, faces, channelOffsets: off };
}

// -------------------------------------------------------- cubemap sampling --
// D3D/RenderMan cube face selection + face UV. Faces are DDS order
// (+X -X +Y -Y +Z -Z), rows top-down. Returns linear RGB via bilinear
// filtering in LINEAR space (decode-then-lerp), edge-clamped.
function sampleCubemapLinear(cube, dir, outRgb) {
    const ax = Math.abs(dir[0]), ay = Math.abs(dir[1]), az = Math.abs(dir[2]);
    let face, sc, tc, ma;
    if (ax >= ay && ax >= az) {
        ma = ax;
        if (dir[0] >= 0) { face = 0; sc = -dir[2]; tc = -dir[1]; }
        else             { face = 1; sc =  dir[2]; tc = -dir[1]; }
    } else if (ay >= az) {
        ma = ay;
        if (dir[1] >= 0) { face = 2; sc =  dir[0]; tc =  dir[2]; }
        else             { face = 3; sc =  dir[0]; tc = -dir[2]; }
    } else {
        ma = az;
        if (dir[2] >= 0) { face = 4; sc =  dir[0]; tc = -dir[1]; }
        else             { face = 5; sc = -dir[0]; tc = -dir[1]; }
    }
    const n = cube.size;
    const data = cube.faces[face];
    const { r: or_, g: og, b: ob } = cube.channelOffsets;
    // Face UV in [0,1] -> texel space, clamped bilinear.
    const u = (sc / ma + 1) * 0.5 * n - 0.5;
    const v = (tc / ma + 1) * 0.5 * n - 0.5;
    let x0 = Math.floor(u), y0 = Math.floor(v);
    const fx = u - x0, fy = v - y0;
    let x1 = x0 + 1, y1 = y0 + 1;
    if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0;
    if (x1 > n - 1) x1 = n - 1; if (y1 > n - 1) y1 = n - 1;
    if (x0 > n - 1) x0 = n - 1; if (y0 > n - 1) y0 = n - 1;
    const i00 = (y0 * n + x0) * 4, i10 = (y0 * n + x1) * 4;
    const i01 = (y1 * n + x0) * 4, i11 = (y1 * n + x1) * 4;
    const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy);
    const w01 = (1 - fx) * fy, w11 = fx * fy;
    outRgb[0] = kSrgbLut[data[i00 + or_]] * w00 + kSrgbLut[data[i10 + or_]] * w10
              + kSrgbLut[data[i01 + or_]] * w01 + kSrgbLut[data[i11 + or_]] * w11;
    outRgb[1] = kSrgbLut[data[i00 + og]] * w00 + kSrgbLut[data[i10 + og]] * w10
              + kSrgbLut[data[i01 + og]] * w01 + kSrgbLut[data[i11 + og]] * w11;
    outRgb[2] = kSrgbLut[data[i00 + ob]] * w00 + kSrgbLut[data[i10 + ob]] * w10
              + kSrgbLut[data[i01 + ob]] * w01 + kSrgbLut[data[i11 + ob]] * w11;
}

// ---------------------------------------------------------- equirect bake --
// Bake the cubemap to the engine's equirect parameterization. For texel
// (px,py): u=(px+.5)/W, v=(py+.5)/H, then the INVERSE of the engine's
// EncodeDirToLatLongUv: azimuth = (u-.5)*2pi (== atan2(z,x)), y = cos(v*pi).
// Returns Float32Array RGB (linear, multiplier applied).
function bakeEquirect(cube, width, height, mult) {
    const out = new Float32Array(width * height * 3);
    const dir = [0, 0, 0];
    const rgb = [0, 0, 0];
    const mr = mult[0], mg = mult[1], mb = mult[2];
    for (let py = 0; py < height; py++) {
        const theta = ((py + 0.5) / height) * Math.PI; // polar: 0=zenith
        const y = Math.cos(theta);
        const r = Math.sin(theta);
        let o = py * width * 3;
        for (let px = 0; px < width; px++, o += 3) {
            const phi = (((px + 0.5) / width) - 0.5) * 2 * Math.PI; // atan2(z,x)
            dir[0] = r * Math.cos(phi);
            dir[1] = y;
            dir[2] = r * Math.sin(phi);
            sampleCubemapLinear(cube, dir, rgb);
            out[o] = rgb[0] * mr;
            out[o + 1] = rgb[1] * mg;
            out[o + 2] = rgb[2] * mb;
        }
    }
    return out;
}

// ------------------------------------------------------------ Radiance IO --
// Radiance RGBE writer, new-style RLE scanlines (the format stb_image — the
// engine's decoder — reads). Encode matches the classic frexp scheme.
function rgbeEncode(r, g, b, out, o) {
    const m = Math.max(r, g, b);
    if (m < 1e-32) { out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0; return; }
    let e = Math.floor(Math.log2(m)) + 1;
    let scale = Math.pow(2, -e) * 256;
    if (m * scale >= 256) { e += 1; scale *= 0.5; } // float edge: m exactly 2^k
    out[o] = Math.min(255, Math.floor(r * scale));
    out[o + 1] = Math.min(255, Math.floor(g * scale));
    out[o + 2] = Math.min(255, Math.floor(b * scale));
    out[o + 3] = e + 128;
}

function rlePlane(src, w, push) {
    let i = 0;
    while (i < w) {
        // Find a run of >= 4 identical bytes.
        let runStart = i;
        while (runStart < w) {
            let runLen = 1;
            while (runLen < 127 && runStart + runLen < w && src[runStart + runLen] === src[runStart]) runLen++;
            if (runLen >= 4) break;
            runStart += runLen;
        }
        // Literals up to the run (chunks of <= 128).
        let lit = runStart - i;
        while (lit > 0) {
            const n = Math.min(128, lit);
            push(n);
            for (let k = 0; k < n; k++) push(src[i + k]);
            i += n; lit -= n;
        }
        if (i >= w) break;
        // Emit the run.
        let runLen = 1;
        while (runLen < 127 && i + runLen < w && src[i + runLen] === src[i]) runLen++;
        push(128 + runLen);
        push(src[i]);
        i += runLen;
    }
}

function writeRadianceHdr(filePath, width, height, rgbFloat) {
    const header = Buffer.from(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`, 'ascii');
    const chunks = [header];
    const line = new Uint8Array(width * 4);
    const plane = new Uint8Array(width);
    const rleCapable = width >= 8 && width < 32768; // Radiance new-RLE validity range
    const bytes = [];
    const push = (b) => bytes.push(b);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const o = (y * width + x) * 3;
            rgbeEncode(rgbFloat[o], rgbFloat[o + 1], rgbFloat[o + 2], line, x * 4);
        }
        if (!rleCapable) { chunks.push(Buffer.from(line)); continue; }
        bytes.length = 0;
        push(2); push(2); push((width >> 8) & 0xFF); push(width & 0xFF);
        for (let c = 0; c < 4; c++) {
            for (let x = 0; x < width; x++) plane[x] = line[x * 4 + c];
            rlePlane(plane, width, push);
        }
        chunks.push(Buffer.from(bytes));
    }
    fs.writeFileSync(filePath, Buffer.concat(chunks));
}

// Radiance reader (flat + new-RLE scanlines) — the inverse pair for the writer,
// used by the guard tests and the mock-parity harness. Decode matches
// stb_image: c = byte * 2^(E-136).
function readRadianceHdr(filePath) {
    const buf = fs.readFileSync(filePath);
    let pos = 0;
    const readLine = () => {
        let end = pos;
        while (end < buf.length && buf[end] !== 0x0A) end++;
        const s = buf.toString('ascii', pos, end);
        pos = end + 1;
        return s;
    };
    if (!readLine().startsWith('#?')) throw new Error('not a Radiance file');
    for (;;) {
        const l = readLine();
        if (l === '') break;
        if (l.startsWith('FORMAT=') && !l.includes('32-bit_rle_rgbe'))
            throw new Error(`unsupported Radiance format: ${l}`);
    }
    const dim = readLine().match(/^-Y (\d+) \+X (\d+)$/);
    if (!dim) throw new Error('unsupported Radiance orientation (need -Y H +X W)');
    const height = parseInt(dim[1], 10), width = parseInt(dim[2], 10);
    const out = new Float32Array(width * height * 3);
    const rgbe = new Uint8Array(width * 4);
    for (let y = 0; y < height; y++) {
        if (width >= 8 && width < 32768 && buf[pos] === 2 && buf[pos + 1] === 2
            && ((buf[pos + 2] << 8) | buf[pos + 3]) === width) {
            pos += 4;
            for (let c = 0; c < 4; c++) {
                let x = 0;
                while (x < width) {
                    const n = buf[pos++];
                    if (n > 128) { // run
                        const v = buf[pos++];
                        for (let k = 0; k < n - 128; k++) rgbe[(x++) * 4 + c] = v;
                    } else {
                        for (let k = 0; k < n; k++) rgbe[(x++) * 4 + c] = buf[pos++];
                    }
                }
            }
        } else {
            for (let x = 0; x < width; x++)
                for (let c = 0; c < 4; c++) rgbe[x * 4 + c] = buf[pos++];
        }
        for (let x = 0; x < width; x++) {
            const e = rgbe[x * 4 + 3];
            const o = (y * width + x) * 3;
            if (e === 0) { out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; continue; }
            const f = Math.pow(2, e - 136); // 2^(E-128) / 256
            out[o] = rgbe[x * 4] * f;
            out[o + 1] = rgbe[x * 4 + 1] * f;
            out[o + 2] = rgbe[x * 4 + 2] * f;
        }
    }
    return { width, height, rgb: out };
}

// -------------------------------------------------------------- top level --
// DDS cubemap buffer -> equirect Radiance .hdr on disk. The equirect width is
// min(maxWidth, 4 * faceSize): four faces span the horizon, so 4x face width
// captures the source fully at the equator and anything wider is pure
// oversampling. Returns the actual dimensions + luminance stats for the
// conversion log / verification report.
function convertDdsCubemapToEquirectHdr(ddsBuffer, outPath, maxWidth, mult) {
    const cube = readDdsCubemap(ddsBuffer);
    const width = Math.min(maxWidth, cube.size * 4);
    const height = width / 2;
    const rgb = bakeEquirect(cube, width, height, mult);
    writeRadianceHdr(outPath, width, height, rgb);
    let maxL = 0, sumL = 0;
    for (let i = 0; i < rgb.length; i += 3) {
        const l = 0.2126 * rgb[i] + 0.7152 * rgb[i + 1] + 0.0722 * rgb[i + 2];
        if (l > maxL) maxL = l;
        sumL += l;
    }
    return { faceSize: cube.size, width, height, meanLuminance: sumL / (rgb.length / 3), maxLuminance: maxL };
}

module.exports = {
    kUnityColorSpaceDouble,
    kBuiltinSkyboxCubemapFileId,
    parseUnitySkyboxMat,
    computeSkyboxMultiplier,
    readDdsCubemap,
    sampleCubemapLinear,
    bakeEquirect,
    writeRadianceHdr,
    readRadianceHdr,
    convertDdsCubemapToEquirectHdr,
};
