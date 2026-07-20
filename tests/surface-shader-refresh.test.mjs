// Guards for the surface-shader hash-compare refresh (ensureSurfaceShaderCopied).
//
// The old behavior was copy-if-missing: once a shader landed in a project it
// was never updated, so projects silently kept stale shipped versions forever.
// The refresh policy fixes that without ever clobbering user edits:
//   - dest missing                          -> copy
//   - dest == current bundled version       -> up-to-date (no-op)
//   - dest == a KNOWN shipped version       -> auto-overwrite (refresh)
//   - dest == anything else (user-edited)   -> warn-and-skip
// Known shipped versions live in shaders/shipped-hashes.json, hashed over
// LF-normalized content so CRLF checkouts don't read as user edits.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { ensureSurfaceShaderCopied, classifySurfaceShaderDest, hashShaderText } =
    require(path.join(__dirname, '..', 'src', 'convert.js'));

const kCurrent = '// current shader v3\nvec3 F(vec3 n) { return n; }\n';
const kOldV1 = '// shipped shader v1\n';
const kOldV2 = '// shipped shader v2\nvec3 F(vec3 n) { return n * 0.5; }\n';
const kUserEdit = kCurrent + '// my tweak\n';

// ---------------------------------------------- pure decision function ------
test('classify: null dest -> copy', () => {
    assert.equal(classifySurfaceShaderDest(kCurrent, null, []), 'copy');
});
test('classify: dest identical to source -> up-to-date', () => {
    assert.equal(classifySurfaceShaderDest(kCurrent, kCurrent, []), 'up-to-date');
});
test('classify: CRLF dest of the same content -> up-to-date (LF-normalized hash)', () => {
    const crlf = kCurrent.replace(/\n/g, '\r\n');
    assert.equal(classifySurfaceShaderDest(kCurrent, crlf, []), 'up-to-date');
    assert.equal(hashShaderText(crlf), hashShaderText(kCurrent));
});
test('classify: dest matches a known shipped hash -> refresh', () => {
    const shipped = [hashShaderText(kOldV1), hashShaderText(kOldV2)];
    assert.equal(classifySurfaceShaderDest(kCurrent, kOldV2, shipped), 'refresh');
    // CRLF copy of a shipped version still counts as pristine.
    assert.equal(classifySurfaceShaderDest(kCurrent, kOldV2.replace(/\n/g, '\r\n'), shipped), 'refresh');
});
test('classify: unknown dest content -> user-modified', () => {
    const shipped = [hashShaderText(kOldV1), hashShaderText(kOldV2)];
    assert.equal(classifySurfaceShaderDest(kCurrent, kUserEdit, shipped), 'user-modified');
    // No manifest at all: anything not current is treated as user-modified (safe default).
    assert.equal(classifySurfaceShaderDest(kCurrent, kOldV2, undefined), 'user-modified');
});

// ------------------------------------------------ filesystem behavior -------
// Fixture: a private shader source dir (ctx.shaderSrcDir) with a fake shader
// and a manifest listing two older shipped versions, plus a matOutDir dest.
function makeFixture(tmp) {
    const srcDir = path.join(tmp, 'shaders');
    const matOutDir = path.join(tmp, 'Materials_Unity');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(matOutDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'test_shader.glsl'), kCurrent);
    fs.writeFileSync(path.join(srcDir, 'shipped-hashes.json'), JSON.stringify({
        'test_shader.glsl': [hashShaderText(kCurrent), hashShaderText(kOldV1), hashShaderText(kOldV2)],
    }));
    return { srcDir, matOutDir, dest: path.join(matOutDir, 'test_shader.glsl') };
}
const ctxFor = (fx) => ({ matOutDir: fx.matOutDir, shaderSrcDir: fx.srcDir, verbose: false });

test('fs: missing dest is copied; second call in the same run is memoized', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shref-'));
    try {
        const fx = makeFixture(tmp);
        const ctx = ctxFor(fx);
        assert.equal(ensureSurfaceShaderCopied(ctx, 'test_shader.glsl'), 'copied');
        assert.equal(fs.readFileSync(fx.dest, 'utf8'), kCurrent);
        assert.equal(ensureSurfaceShaderCopied(ctx, 'test_shader.glsl'), undefined, 'memoized');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('fs: pristine current dest is a no-op', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shref-'));
    try {
        const fx = makeFixture(tmp);
        fs.writeFileSync(fx.dest, kCurrent);
        assert.equal(ensureSurfaceShaderCopied(ctxFor(fx), 'test_shader.glsl'), 'up-to-date');
        assert.equal(fs.readFileSync(fx.dest, 'utf8'), kCurrent);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('fs: stale shipped version is auto-refreshed to current', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shref-'));
    try {
        const fx = makeFixture(tmp);
        fs.writeFileSync(fx.dest, kOldV1);
        assert.equal(ensureSurfaceShaderCopied(ctxFor(fx), 'test_shader.glsl'), 'refreshed');
        assert.equal(fs.readFileSync(fx.dest, 'utf8'), kCurrent, 'dest must now be the current version');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('fs: user-edited dest is kept (warn-and-skip)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shref-'));
    try {
        const fx = makeFixture(tmp);
        fs.writeFileSync(fx.dest, kUserEdit);
        assert.equal(ensureSurfaceShaderCopied(ctxFor(fx), 'test_shader.glsl'), 'skipped-user-modified');
        assert.equal(fs.readFileSync(fx.dest, 'utf8'), kUserEdit, 'user edits must survive');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('fs: missing bundled source warns and reports error', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shref-'));
    try {
        const fx = makeFixture(tmp);
        assert.equal(ensureSurfaceShaderCopied(ctxFor(fx), 'no_such_shader.glsl'), 'error');
        assert.ok(!fs.existsSync(path.join(fx.matOutDir, 'no_such_shader.glsl')));
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// ------------------------------------------- manifest covers the bundle -----
// The REAL manifest must list the hash of every REAL bundled shader (newest
// first), or refreshes would misclassify pristine current copies after the
// next shader edit forgets to append its hash.
test('bundled shaders: every shaders/*.glsl hash is in shipped-hashes.json', () => {
    const shadersDir = path.join(__dirname, '..', 'shaders');
    const manifest = JSON.parse(fs.readFileSync(path.join(shadersDir, 'shipped-hashes.json'), 'utf8'));
    const glsl = fs.readdirSync(shadersDir).filter(f => f.endsWith('.glsl'));
    assert.ok(glsl.length >= 2, 'expected the two bundled water shaders');
    for (const f of glsl) {
        const hash = hashShaderText(fs.readFileSync(path.join(shadersDir, f), 'utf8'));
        assert.ok(Array.isArray(manifest[f]), `${f} missing from shipped-hashes.json`);
        assert.ok(manifest[f].includes(hash),
            `${f}: current content hash ${hash} not in shipped-hashes.json — append it when shipping a shader change`);
    }
});
