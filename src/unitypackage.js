'use strict';
// Minimal .unitypackage reader — pure Node builtins (zlib + fs), no deps.
//
// A .unitypackage is a gzipped ustar archive whose entries are
//   <guid>/pathname     (first line = the asset's Unity project path)
//   <guid>/asset        (the raw asset bytes; absent for folder assets)
//   <guid>/asset.meta   (importer settings; not needed by the converter)
// This module indexes or extracts ONLY those entries, so the converter and the
// editor UI can accept a raw .unitypackage anywhere an extracted --pkg dir is
// accepted. The archive is gunzipped in memory (Node buffers cap at ~4 GB);
// packs beyond roughly that extracted size must be pre-extracted with tar.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function isUnityPackageFile(p) {
    try { if (!fs.statSync(p).isFile()) return false; } catch { return false; }
    return /\.(unitypackage|tgz|tar\.gz)$/i.test(p);
}

// Iterate tar entries, invoking onEntry(name, body:Buffer). Handles ustar
// name+prefix, GNU 'L' longnames, and pax 'x' path overrides — enough for
// every .unitypackage packer observed (Unity's own emits plain ustar).
function walkTar(buf, onEntry) {
    let off = 0;
    let pendingLongName = null;
    let pendingPaxPath = null;
    while (off + 512 <= buf.length) {
        const header = buf.subarray(off, off + 512);
        if (header.every((b) => b === 0)) break; // end-of-archive
        const sizeField = header.toString('ascii', 124, 136).replace(/[^0-7]/g, '');
        const size = sizeField ? parseInt(sizeField, 8) : 0;
        const type = String.fromCharCode(header[156] || 48);
        const body = buf.subarray(off + 512, off + 512 + size);
        off += 512 + Math.ceil(size / 512) * 512;

        if (type === 'L') { pendingLongName = body.toString('utf8').replace(/\0+$/, ''); continue; }
        if (type === 'x' || type === 'g') {
            // pax records: "<len> key=value\n"
            for (const m of body.toString('utf8').matchAll(/\d+ ([^=]+)=([^\n]*)\n/g))
                if (m[1] === 'path') pendingPaxPath = m[2];
            continue;
        }
        if (type !== '0' && type !== '\0') { pendingLongName = pendingPaxPath = null; continue; }

        let name = header.toString('utf8', 0, 100).replace(/\0.*$/, '');
        if (header.toString('ascii', 257, 262) === 'ustar') {
            const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/, '');
            if (prefix) name = prefix + '/' + name;
        }
        if (pendingLongName) { name = pendingLongName; pendingLongName = null; }
        if (pendingPaxPath) { name = pendingPaxPath; pendingPaxPath = null; }
        name = name.replace(/^\.\//, '');
        onEntry(name, body);
    }
}

function gunzipPackage(file) {
    try {
        return zlib.gunzipSync(fs.readFileSync(file), { maxOutputLength: 0xfffffffe });
    } catch (e) {
        throw new Error(`cannot read ${file} as a .unitypackage (gzipped tar): ${e.message}`
            + ' — for very large packs, pre-extract with tar -xzf and pass the directory');
    }
}

// Index without extraction: guid -> { assetPath, assetSize } (pathname entries
// with their asset payload sizes). Fast path for --list-scenes.
function indexUnityPackage(file) {
    const byGuid = new Map();
    const rec = (guid) => {
        if (!byGuid.has(guid)) byGuid.set(guid, { assetPath: null, assetSize: 0 });
        return byGuid.get(guid);
    };
    walkTar(gunzipPackage(file), (name, body) => {
        const m = /^([^/]+)\/(pathname|asset)$/.exec(name);
        if (!m) return;
        if (m[2] === 'pathname') rec(m[1].toLowerCase()).assetPath = body.toString('utf8').split('\n')[0].trim();
        else rec(m[1].toLowerCase()).assetSize = body.length;
    });
    for (const [guid, e] of byGuid) if (!e.assetPath) byGuid.delete(guid);
    return byGuid;
}

// Extract to the <guid>/{pathname,asset,asset.meta} layout buildPackageIndex
// expects. Returns destDir.
function extractUnityPackage(file, destDir) {
    fs.mkdirSync(destDir, { recursive: true });
    walkTar(gunzipPackage(file), (name, body) => {
        const m = /^([^/]+)\/(pathname|asset|asset\.meta)$/.exec(name);
        if (!m) return;
        const dir = path.join(destDir, m[1].toLowerCase());
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, m[2]), body);
    });
    return destDir;
}

module.exports = { isUnityPackageFile, indexUnityPackage, extractUnityPackage, walkTar };
