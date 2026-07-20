'use strict';
// Validation for convert.js output:
//  1) structural checks per SceneIO.cpp rules (unique ids, parents exist &
//     precede, tuple shapes, quat norm, asset refs well-formed)
//  2) cross-check: named prefab instances in Demo.unity vs emitted entities
//     (position/rotation/scale within tolerance)
const fs = require('fs');
const path = require('path');
const { parseUnityYaml } = require('./unityyaml');

const sceneFile = process.argv[2];
const unityFile = process.argv[3];

// ---- parse output .scene ----
const text = fs.readFileSync(sceneFile, 'utf8');
const entities = [];
let cur = null;
let lineNo = 0;
const errors = [];
for (const raw of text.split('\n')) {
    lineNo++;
    const line = raw.trim();
    if (!line || line.startsWith(';')) continue;
    const hdr = /^\[entity id="([^"]+)"(?: parent="([^"]+)")?\]$/.exec(line);
    if (hdr) { cur = { id: hdr[1], parent: hdr[2] || null, props: {}, line: lineNo }; entities.push(cur); continue; }
    if (line.startsWith('[')) {
        if (!/^\[scene name="[^"]*" version=1\]$/.test(line)) errors.push(`line ${lineNo}: unexpected section: ${line}`);
        continue;
    }
    if (!cur) { errors.push(`line ${lineNo}: content before entity`); continue; }
    const m = /^([A-Za-z]+)\.([A-Za-z]+) = (.*)$/.exec(line);
    if (!m) { errors.push(`line ${lineNo}: bad component line: ${line}`); continue; }
    cur.props[`${m[1]}.${m[2]}`] = m[3];
}

const byId = new Map();
for (const e of entities) {
    if (byId.has(e.id)) errors.push(`duplicate id ${e.id}`);
    if (e.parent && !byId.has(e.parent)) errors.push(`entity ${e.id}: parent ${e.parent} not defined before use`);
    byId.set(e.id, e);
}

const parseTuple = (s) => {
    const m = /^\(([^)]*)\)$/.exec(s);
    if (!m) return null;
    return m[1].split(',').map(x => parseFloat(x.trim()));
};

let meshCount = 0;
for (const e of entities) {
    const p = parseTuple(e.props['Transform.position'] || '');
    const r = parseTuple(e.props['Transform.rotation'] || '');
    const s = parseTuple(e.props['Transform.scale'] || '');
    if (!p || p.length !== 3 || p.some(Number.isNaN)) errors.push(`${e.id}: bad position`);
    if (!r || r.length !== 4 || r.some(Number.isNaN)) errors.push(`${e.id}: bad rotation`);
    else {
        const n = Math.hypot(r[0], r[1], r[2], r[3]);
        if (Math.abs(n - 1) > 1e-3) errors.push(`${e.id}: quaternion norm ${n}`);
    }
    if (!s || s.length !== 3 || s.some(Number.isNaN)) errors.push(`${e.id}: bad scale`);
    if (!e.props['Name.value']) errors.push(`${e.id}: missing Name.value`);
    const ma = e.props['MeshRenderer.meshAsset'];
    if (ma) {
        meshCount++;
        if (!/^\[path="[^"]+" guid="[0-9a-f-]{36}"\]$/.test(ma)) errors.push(`${e.id}: malformed meshAsset: ${ma}`);
    }
    if (e.props['MeshRenderer.meshPrimitive']) meshCount++;
}

// ---- cross-check against Unity source ----
const nameCount = new Map();
for (const e of entities) {
    const n = e.props['Name.value'].slice(1, -1);
    nameCount.set(n, (nameCount.get(n) || 0) + 1);
}
const byName = new Map();
for (const e of entities) {
    const n = e.props['Name.value'].slice(1, -1);
    if (nameCount.get(n) === 1) byName.set(n, e);
}

const docs = parseUnityYaml(fs.readFileSync(unityFile, 'utf8'), new Set(['1001']));
let checked = 0, mismatches = 0;
const tol = 2e-5;
const TRSP = ['m_LocalPosition.x', 'm_LocalPosition.y', 'm_LocalPosition.z',
    'm_LocalRotation.x', 'm_LocalRotation.y', 'm_LocalRotation.z', 'm_LocalRotation.w',
    'm_LocalScale.x', 'm_LocalScale.y', 'm_LocalScale.z'];
for (const d of docs) {
    if (d.classId !== '1001' || !d.data) continue;
    const mods = (d.data.m_Modification && d.data.m_Modification.m_Modifications) || [];
    // Group by target; only cross-check SIMPLE instances: exactly one group
    // carrying m_Name and exactly one group carrying TRS props (the root).
    const groups = new Map();
    for (const m of mods) {
        if (!m || !m.propertyPath || !m.target) continue;
        const t = m.target.fileID || '0';
        if (!groups.has(t)) groups.set(t, []);
        groups.get(t).push(m);
    }
    const nameGroups = [...groups.values()].filter(g => g.some(m => m.propertyPath === 'm_Name'));
    const trsGroups = [...groups.values()].filter(g => g.some(m => TRSP.includes(m.propertyPath)));
    if (nameGroups.length !== 1 || trsGroups.length !== 1) continue;
    const name = nameGroups[0].find(m => m.propertyPath === 'm_Name').value;
    const vals = {};
    for (const m of trsGroups[0]) vals[m.propertyPath] = parseFloat(m.value);
    if (!name || !byName.has(name)) continue;
    if (!name.startsWith('SM_')) continue;
    const e = byName.get(name);
    const pos = parseTuple(e.props['Transform.position']);
    const rot = parseTuple(e.props['Transform.rotation']);
    const scl = parseTuple(e.props['Transform.scale']);
    const pairs = [
        ['m_LocalPosition.x', pos[0]], ['m_LocalPosition.y', pos[1]], ['m_LocalPosition.z', pos[2]],
        ['m_LocalRotation.x', rot[0]], ['m_LocalRotation.y', rot[1]], ['m_LocalRotation.z', rot[2]], ['m_LocalRotation.w', rot[3]],
        ['m_LocalScale.x', scl[0]], ['m_LocalScale.y', scl[1]], ['m_LocalScale.z', scl[2]],
    ];
    let any = false, bad = false;
    for (const [k, got] of pairs) {
        if (!(k in vals) || Number.isNaN(vals[k])) continue;
        any = true;
        if (Math.abs(vals[k] - got) > tol * Math.max(1, Math.abs(vals[k]))) {
            errors.push(`XCHECK ${name}: ${k} unity=${vals[k]} scene=${got}`);
            bad = true;
        }
    }
    if (any) { checked++; if (bad) mismatches++; }
}

console.log(`entities: ${entities.length}, mesh components: ${meshCount}`);
console.log(`cross-checked ${checked} uniquely-named SM_ prefab instances, ${mismatches} mismatched`);
console.log(`errors: ${errors.length}`);
for (const e of errors.slice(0, 25)) console.log('  ' + e);
process.exit(errors.length ? 1 : 0);
