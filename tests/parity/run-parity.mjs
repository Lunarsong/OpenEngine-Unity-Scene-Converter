'use strict';
// C#/JS converter parity gate: runs the JS reference (src/convert.js) and the
// C# port (UnityConverter.dll) over the synthesized fixture corpus with
// identical argv, then byte-compares
//   - the full output trees (scenes, materials, staged textures/models,
//     shaders, LUTs, .hdr bakes),
//   - stdout (the --json protocol / --list-scenes JSON / human report),
//   - stderr after normalizing genuinely nondeterministic content (timing
//     numbers, temp-extraction dirs, per-side scratch roots),
//   - exit codes.
// No stored goldens: the JS reference generates the expectation at run time.
//
// Usage:
//   node run-parity.mjs --csharp <path-to-UnityConverter.dll> [--only <fixture>] [--keep]
//   node run-parity.mjs --self          # JS-vs-JS harness sanity (normalization proof)
//
// Exit 0 = every run byte-identical; 1 = any divergence (table printed).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildCorpus } from './fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONVERT = path.join(__dirname, '..', '..', 'src', 'convert.js');
const WRAPPER = path.join(__dirname, '..', '..', 'bin', 'unity-scene-convert.js');

// ------------------------------------------------------------------- args --
const argv = process.argv.slice(2);
let csharpDll = null, selfMode = false, keep = false, only = null;
for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--csharp') csharpDll = argv[++i];
    else if (argv[i] === '--self') selfMode = true;
    else if (argv[i] === '--keep') keep = true;
    else if (argv[i] === '--only') only = argv[++i];
    else { console.error(`unknown arg ${argv[i]}`); process.exit(2); }
}
if (!selfMode && !csharpDll) {
    console.error('usage: node run-parity.mjs --csharp <UnityConverter.dll> [--only <fixture>] [--keep] | --self');
    process.exit(2);
}
if (csharpDll && !fs.existsSync(csharpDll)) {
    console.error(`C# converter not found: ${csharpDll}`);
    process.exit(2);
}

// -------------------------------------------------------------- execution --
function substituteArgs(args, side) {
    return args.map((a) => a
        .replaceAll('<PROJ>', side.proj)
        .replaceAll('<OUT>', side.out));
}

function runSide(side, run) {
    fs.mkdirSync(side.proj, { recursive: true });
    fs.mkdirSync(side.out, { recursive: true });
    const args = substituteArgs(run.args, side);
    const entryJs = run.entry === 'wrapper' ? WRAPPER : CONVERT;
    const cmd = side.kind === 'js'
        ? { exe: process.execPath, argv: [entryJs, ...args] }
        : { exe: 'dotnet', argv: [csharpDll, ...(run.entry === 'wrapper' ? [] : []), ...args] };
    const env = { ...process.env };
    delete env.GE_TEXC; // never let a machine-local TextureCompiler flip ktx2 mode
    const res = spawnSync(cmd.exe, cmd.argv, {
        encoding: 'buffer',
        cwd: side.cwd,
        env,
        maxBuffer: 512 * 1024 * 1024,
        // Watchdog: hostile-input fixtures must TERMINATE. A wedged converter
        // (e.g. a signed-length PNG chunk loop) surfaces as status null +
        // TIMEOUT in stderr — a visible FAIL, not a hung parity run.
        timeout: 120000,
    });
    return {
        status: res.status,
        stdout: res.stdout ? res.stdout.toString('utf8') : '',
        stderr: (res.stderr ? res.stderr.toString('utf8') : '')
            + (res.error ? `\n[runner] spawn error: ${res.error.code || res.error.message}\n` : ''),
    };
}

// --------------------------------------------------------- normalization ---
// Only genuinely nondeterministic content is normalized:
//   - per-side scratch roots (proj/out/cwd differ by construction),
//   - wall-clock timings in stderr diagnostics,
//   - mkdtemp extraction dirs for raw .unitypackage inputs.
function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function normText(text, side) {
    let t = text;
    const roots = [
        [side.proj, '<PROJ>'],
        [side.out, '<OUT>'],
        [side.cwd, '<CWD>'],
    ];
    for (const [root, token] of roots) {
        const forms = [
            root,
            root.replaceAll('\\', '/'),
            root.replaceAll('\\', '\\\\'), // JSON-escaped
        ];
        for (const f of forms) t = t.replaceAll(f, token);
    }
    // Raw-package extraction dir (os.tmpdir()/unitypkg-XXXX or the C# analogue).
    t = t.replace(/[A-Za-z]:[^\s"']*unitypkg-[A-Za-z0-9._-]+/g, '<PKGTMP>');
    t = t.replace(/unitypkg-[A-Za-z0-9._-]+/g, '<PKGTMP>');
    // Timing diagnostics (stderr only, but harmless to apply everywhere).
    t = t.replace(/Expanded (\d+) nodes in \d+ ms/g, 'Expanded $1 nodes in <MS> ms');
    t = t.replace(/baked (\d+)px\/face -> (\d+)x(\d+) in [\d.]+s/g, 'baked $1px/face -> $2x$3 in <S>s');
    return t;
}

// ----------------------------------------------------------- tree compare --
function walkTree(root) {
    const files = new Map(); // rel (fwd slashes) -> abs
    if (!fs.existsSync(root)) return files;
    const rec = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) rec(p);
            else files.set(path.relative(root, p).replaceAll('\\', '/'), p);
        }
    };
    rec(root);
    return files;
}

function compareTrees(aRoot, bRoot, label, diffs) {
    const a = walkTree(aRoot);
    const b = walkTree(bRoot);
    for (const rel of a.keys())
        if (!b.has(rel)) diffs.push(`${label}: only in JS tree: ${rel}`);
    for (const rel of b.keys())
        if (!a.has(rel)) diffs.push(`${label}: only in C# tree: ${rel}`);
    for (const [rel, ap] of a) {
        if (!b.has(rel)) continue;
        const ab = fs.readFileSync(ap);
        const bb = fs.readFileSync(b.get(rel));
        if (!ab.equals(bb)) {
            let detail = `${ab.length} vs ${bb.length} bytes`;
            const n = Math.min(ab.length, bb.length);
            for (let i = 0; i < n; i++) {
                if (ab[i] !== bb[i]) { detail += `, first diff @${i}`; break; }
            }
            diffs.push(`${label}: content differs: ${rel} (${detail})`);
        }
    }
}

function firstDiffLine(aText, bText) {
    const a = aText.split('\n'), b = bText.split('\n');
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
        if (a[i] !== b[i])
            return `line ${i + 1}:\n  JS: ${JSON.stringify(a[i] ?? '<missing>')}\n  C#: ${JSON.stringify(b[i] ?? '<missing>')}`;
    }
    return null;
}

// ------------------------------------------------------------------ main ---
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-parity-'));
const fixturesRoot = path.join(work, 'fixtures');
fs.mkdirSync(fixturesRoot, { recursive: true });
const corpus = buildCorpus(fixturesRoot);

const rows = [];
let anyFail = false;

for (const fixture of corpus) {
    if (only && fixture.name !== only) continue;
    // <PROJ>/<OUT> are per-fixture-side (NOT per-run): sky's rebake-reuse run
    // deliberately hits the same project dir as its bake run, on both sides.
    const sides = {
        js: { kind: 'js', proj: path.join(work, fixture.name, 'js', 'proj'), out: path.join(work, fixture.name, 'js', 'out'), cwd: path.join(work, fixture.name, 'js', 'cwd') },
        cs: selfMode
            ? { kind: 'js', proj: path.join(work, fixture.name, 'js2', 'proj'), out: path.join(work, fixture.name, 'js2', 'out'), cwd: path.join(work, fixture.name, 'js2', 'cwd') }
            : { kind: 'cs', proj: path.join(work, fixture.name, 'cs', 'proj'), out: path.join(work, fixture.name, 'cs', 'out'), cwd: path.join(work, fixture.name, 'cs', 'cwd') },
    };
    fs.mkdirSync(sides.js.cwd, { recursive: true });
    fs.mkdirSync(sides.cs.cwd, { recursive: true });

    for (const run of fixture.runs) {
        const label = `${fixture.name}/${run.name}`;
        const a = runSide(sides.js, run);
        const b = runSide(sides.cs, run);
        const diffs = [];

        if (a.status !== b.status)
            diffs.push(`exit code: JS ${a.status} vs C# ${b.status}`);
        if (run.expectFail && a.status === 0)
            diffs.push(`expected the JS reference to fail but it exited 0 (fixture bug)`);

        const aOut = normText(a.stdout, sides.js);
        const bOut = normText(b.stdout, sides.cs);
        if (aOut !== bOut) {
            const d = firstDiffLine(aOut, bOut);
            diffs.push(`stdout differs at ${d}`);
        }
        const aErr = normText(a.stderr, sides.js);
        const bErr = normText(b.stderr, sides.cs);
        if (aErr !== bErr) {
            const d = firstDiffLine(aErr, bErr);
            diffs.push(`stderr differs at ${d}`);
        }
        rows.push({ label, diffs, deferredTree: true });
        if (diffs.length) anyFail = true;
    }

    // Tree comparison once per fixture (after all its runs, since runs share
    // the side project dirs).
    const treeDiffs = [];
    compareTrees(sides.js.proj, sides.cs.proj, `${fixture.name}/proj`, treeDiffs);
    compareTrees(sides.js.out, sides.cs.out, `${fixture.name}/out`, treeDiffs);
    if (treeDiffs.length) {
        anyFail = true;
        rows.push({ label: `${fixture.name}/(output-tree)`, diffs: treeDiffs });
    } else {
        rows.push({ label: `${fixture.name}/(output-tree)`, diffs: [] });
    }
}

// --------------------------------------------------------------- report ----
const mode = selfMode ? 'JS-vs-JS (self check)' : `JS-vs-C# (${csharpDll})`;
console.log(`\nconverter parity — ${mode}`);
console.log('-'.repeat(72));
let pass = 0, fail = 0;
for (const r of rows) {
    const ok = r.diffs.length === 0;
    if (ok) pass++; else fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${r.label}`);
    for (const d of r.diffs) console.log(`      ${d.split('\n').join('\n      ')}`);
}
console.log('-'.repeat(72));
console.log(`${pass} pass, ${fail} fail  (${rows.length} checks)`);

if (!keep) fs.rmSync(work, { recursive: true, force: true });
else console.log(`work dir kept: ${work}`);
process.exit(anyFail ? 1 : 0);
