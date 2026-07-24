// Extraction-path containment guards for src/unitypackage.js.
//
// A .unitypackage is untrusted input: the converter accepts one straight off
// disk (editor modal, CLI positional) and extracts it into a temp dir. Entry
// names inside the archive are attacker-controlled, and the extractor derives
// the destination directory from the entry's guid segment. A crafted segment
// must never place a write outside the extraction root.
//
// Two escape classes exist in principle; this file pins BOTH, including which
// one Node's path semantics already close, so a future refactor can't quietly
// open it:
//   1. relative traversal ("../evil/asset") — DOES escape path.join, and is
//      what the containment assertion rejects. The failure direction matters:
//      the extraction must FAIL LOUDLY, not silently clamp the write into the
//      root (a clamp hides a hostile pack from the operator, and the C# port's
//      guard throws for the same reason).
//   2. rooted segment ("\evil/asset") — does NOT escape, because path.join
//      concatenates where path.resolve would re-root. The test pins the
//      contained-and-extracted outcome, so swapping join for resolve trips
//      here instead of shipping a hole. (The C# port had to reimplement
//      path.win32.join to get this right; Node's is faithful by definition.)
//
// All fixtures are synthetic — no licensed content.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONVERT = path.join(__dirname, '..', 'src', 'convert.js');
const require_ = createRequire(import.meta.url);
const unitypackage = require_(path.join(__dirname, '..', 'src', 'unitypackage.js'));

const kGoodGuid = '000000000000000000000000000000aa';

// Minimal ustar writer (same shape as editor-protocol.test.mjs) — entry names
// are written verbatim so traversal segments survive into the archive.
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

// entries: [[entryName, body], ...] written verbatim, in order.
function writePackage(file, entries) {
    const parts = [];
    for (const [name, body] of entries) {
        const buf = Buffer.from(body);
        parts.push(tarHeader(name, buf.length), buf, Buffer.alloc((512 - (buf.length % 512)) % 512));
    }
    parts.push(Buffer.alloc(1024)); // end-of-archive
    fs.writeFileSync(file, zlib.gzipSync(Buffer.concat(parts)));
    return file;
}

// A legitimate entry pair, so every fixture also carries content that MUST
// extract when nothing hostile is present.
function goodEntries() {
    return [
        [`${kGoodGuid}/pathname`, 'Assets/Scenes/AlphaTown.unity\n'],
        [`${kGoodGuid}/asset`, 'scene-bytes'],
    ];
}

function withTmp(fn) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pkgtraversal-'));
    try { return fn(tmp); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// ------------------------------------------------------ relative traversal --

test('a "../" guid segment is REJECTED, not silently contained', () => {
    withTmp((tmp) => {
        const pkg = writePackage(path.join(tmp, 'evil.unitypackage'), [
            ...goodEntries(),
            ['../pathname', 'Assets/Escaped.unity\n'],
            ['../asset', 'escaped-bytes'],
        ]);
        const dest = path.join(tmp, 'dest');

        assert.throws(() => unitypackage.extractUnityPackage(pkg, dest),
                      /escapes extraction dir/,
                      'crafted entry must fail the extraction, not be clamped into the root');

        // Nothing landed in the parent of the extraction root...
        assert.equal(fs.existsSync(path.join(tmp, 'pathname')), false, 'wrote outside the extraction root');
        assert.equal(fs.existsSync(path.join(tmp, 'asset')), false, 'wrote outside the extraction root');
        // ...and the escape was not "handled" by dropping the bytes inside it.
        assert.equal(fs.existsSync(path.join(dest, 'pathname')), false, 'silently clamped into the root');
    });
});

test('a deeper "..\\..\\evil" guid segment is REJECTED (Windows separators)', (t) => {
    if (process.platform !== 'win32') {
        // On POSIX a backslash is an ordinary filename character, so this name
        // is a single contained directory — nothing to escape.
        t.skip('backslash traversal is win32-only');
        return;
    }
    withTmp((tmp) => {
        const pkg = writePackage(path.join(tmp, 'evil2.unitypackage'), [
            ...goodEntries(),
            ['..\\..\\evil/asset', 'escaped-bytes'],
        ]);
        const dest = path.join(tmp, 'sub', 'dest');

        assert.throws(() => unitypackage.extractUnityPackage(pkg, dest), /escapes extraction dir/);
        assert.equal(fs.existsSync(path.join(tmp, 'evil')), false, 'wrote outside the extraction root');
    });
});

test('the CLI fails loudly on a crafted package instead of converting', () => {
    withTmp((tmp) => {
        const pkg = writePackage(path.join(tmp, 'evil-cli.unitypackage'), [
            ...goodEntries(),
            ['../pathname', 'Assets/Escaped.unity\n'],
        ]);
        const proj = fs.mkdirSync(path.join(tmp, 'proj'), { recursive: true }) || path.join(tmp, 'proj');
        const res = spawnSync(process.execPath,
            [CONVERT, '--pkg', pkg, '--scene', 'alphatown.unity', '--project', proj],
            { encoding: 'utf8' });

        assert.notEqual(res.status, 0, 'converter must not proceed past a hostile package');
        assert.match(res.stderr, /escapes extraction dir/);
        // The extraction temp dir is under os.tmpdir(); the escape target would
        // be its parent — assert the converter produced no scene either way.
        assert.doesNotMatch(res.stdout, /scene written/i);
    });
});

// -------------------------------------------------------- rooted segments --

test('a rooted "\\evil" guid segment stays inside the root (path.join does not re-root)', () => {
    withTmp((tmp) => {
        const pkg = writePackage(path.join(tmp, 'rooted.unitypackage'), [
            ...goodEntries(),
            ['\\evil/asset', 'rooted-bytes'],
        ]);
        const dest = path.join(tmp, 'dest');

        // Contained, so it extracts: path.join(dest, '\\evil') === dest\evil.
        // If this ever throws, someone swapped join for resolve (or Path.Combine
        // semantics crept in) and the entry is being re-rooted.
        unitypackage.extractUnityPackage(pkg, dest);
        const insideRooted = process.platform === 'win32'
            ? path.join(dest, 'evil', 'asset')
            : path.join(dest, '\\evil', 'asset');
        assert.equal(fs.readFileSync(insideRooted, 'utf8'), 'rooted-bytes');
        assert.equal(fs.existsSync(path.join(path.parse(dest).root, 'evil')), false,
                     'rooted segment must not re-root the write');
    });
});

// ----------------------------------------------------------------- control --

test('a well-formed package still extracts every entry', () => {
    withTmp((tmp) => {
        const pkg = writePackage(path.join(tmp, 'clean.unitypackage'), [
            ...goodEntries(),
            [`${kGoodGuid}/asset.meta`, 'meta-bytes'],
            ['000000000000000000000000000000BB/pathname', 'Assets/Models/Rock.fbx\n'],
        ]);
        const dest = path.join(tmp, 'dest');

        unitypackage.extractUnityPackage(pkg, dest);
        assert.equal(fs.readFileSync(path.join(dest, kGoodGuid, 'pathname'), 'utf8'),
                     'Assets/Scenes/AlphaTown.unity\n');
        assert.equal(fs.readFileSync(path.join(dest, kGoodGuid, 'asset'), 'utf8'), 'scene-bytes');
        assert.equal(fs.readFileSync(path.join(dest, kGoodGuid, 'asset.meta'), 'utf8'), 'meta-bytes');
        // guid dirs are lowercased, as buildPackageIndex expects.
        assert.equal(fs.existsSync(path.join(dest, '000000000000000000000000000000bb', 'pathname')), true);
    });
});
