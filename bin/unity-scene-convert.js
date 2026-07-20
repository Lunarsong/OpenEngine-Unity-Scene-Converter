#!/usr/bin/env node
'use strict';
// CLI entry: `unity-scene-convert [<pkg-dir> [<project-dir>]] [options]`.
//
// Thin wrapper over src/convert.js that adds two conveniences and forwards
// everything else verbatim (all of convert.js's flags work unchanged):
//   - positional sugar: the first positional arg maps to --pkg, the second
//     to --project (flags always win over positionals);
//   - scene auto-pick: when --scene is omitted and the package contains
//     exactly ONE .unity scene, it is selected automatically (with a log
//     line); zero or multiple scenes list the candidates and exit.

const fs = require('fs');
const path = require('path');
const { main } = require('../src/convert.js');

function listScenes(pkgDir) {
    const scenes = [];
    let entries;
    try { entries = fs.readdirSync(pkgDir); } catch { return scenes; }
    for (const entry of entries) {
        const pn = path.join(pkgDir, entry, 'pathname');
        try {
            const assetPath = fs.readFileSync(pn, 'utf8').split('\n')[0].trim();
            if (assetPath.toLowerCase().endsWith('.unity')) scenes.push(assetPath);
        } catch { /* not a package entry dir */ }
    }
    return scenes;
}

const kValueFlags = new Set([
    '--pkg', '--scene', '--project', '--assetdb', '--unity-project', '--out',
    '--local-shadows', '--texc',
]);

const argv = process.argv.slice(2);
const flags = [];
const positionals = [];
const seen = new Set();
for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
        seen.add(a);
        flags.push(a);
        if (kValueFlags.has(a) && i + 1 < argv.length) flags.push(argv[++i]);
    } else {
        positionals.push(a);
    }
}

if (positionals.length > 2) {
    console.error(`ERROR: at most two positional args (<pkg-dir> <project-dir>), got: ${positionals.join(' ')}`);
    process.exit(2);
}
if (positionals[0] && !seen.has('--pkg')) flags.push('--pkg', positionals[0]);
if (positionals[1] && !seen.has('--project')) flags.push('--project', positionals[1]);

if (!seen.has('--scene')) {
    const pkgIdx = flags.indexOf('--pkg');
    const pkgDir = pkgIdx >= 0 ? flags[pkgIdx + 1] : null;
    const scenes = pkgDir ? listScenes(pkgDir) : [];
    if (scenes.length === 1) {
        console.error(`scene auto-picked: ${scenes[0]} (only .unity in package)`);
        flags.push('--scene', scenes[0].toLowerCase());
    } else if (scenes.length > 1) {
        console.error('ERROR: --scene required; the package contains multiple scenes:');
        for (const s of scenes.sort()) console.error('  ' + s);
        process.exit(2);
    }
    // scenes.length === 0 falls through to convert.js's usage error.
}

main([process.argv[0], process.argv[1], ...flags]);
