// Unity's Tonemapping override -> the engine's look (PostProcessVolume.look, by name).
// The engine never carries a source operator: each mode becomes the nearest look,
// and a mode with no exact look is reported in the dropped-settings summary.
// All fixtures are synthetic — no licensed content.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONVERT = path.join(__dirname, '..', 'src', 'convert.js');
const require = createRequire(import.meta.url);
const { lookForTonemapping } = require(CONVERT);

// URP core Volume MonoBehaviour script guid (must match convert.js).
const kUrpVolumeScriptGuid = '172515602e62fb746b5d573b38a5fe58';

test('every Tonemapping mode maps to one of the three looks', () => {
    const cases = [
        [undefined, 'Neutral'],                    // no override: Unity's None
        [{ active: false, mode: 2 }, 'Neutral'],   // an inactive override applies nothing
        [{ active: true }, 'Neutral'],             // active, mode not overridden: None
        [{ active: true, mode: 0 }, 'Neutral'],    // None
        [{ active: true, mode: 1 }, 'Neutral'],    // Neutral
        [{ active: true, mode: 2 }, 'Filmic'],     // ACES
        [{ active: true, mode: 3 }, 'Filmic'],     // HDRP Custom
        [{ active: true, mode: 4 }, 'Neutral'],    // HDRP External
    ];
    for (const [tonemapping, look] of cases)
        assert.equal(lookForTonemapping(tonemapping, false), look, JSON.stringify(tonemapping));
});

function put(dir, guid, pathname, content) {
    const gdir = path.join(dir, guid);
    fs.mkdirSync(gdir, { recursive: true });
    fs.writeFileSync(path.join(gdir, 'pathname'), pathname + '\n');
    fs.writeFileSync(path.join(gdir, 'asset'), content);
}

// A minimal day scene with a directional sun (so the post-process volume block runs) and a
// global Volume whose profile carries one Tonemapping override.
function buildFixture(dir, mode) {
    const sceneGuid = '00000000000000000000000000lk0001';
    const profGuid = '00000000000000000000000000lk0002';
    put(dir, sceneGuid, 'Assets/Scenes/LookTest.unity', [
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
    put(dir, profGuid, 'Assets/Volumes/LookProfile.asset', [
        '%YAML 1.1',
        '%TAG !u! tag:unity3d.com,2011:',
        '--- !u!114 &1',
        'MonoBehaviour:',
        '  m_Name: Tonemapping',
        '  active: 1',
        '  mode:',
        '    m_OverrideState: 1',
        `    m_Value: ${mode}`,
        '',
    ].join('\n'));
}

function convert(mode) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lookmap-'));
    try {
        const pkgDir = path.join(tmp, 'pkg');
        buildFixture(pkgDir, mode);
        const projDir = path.join(tmp, 'proj');
        fs.mkdirSync(projDir, { recursive: true });
        const res = spawnSync(process.execPath,
            [CONVERT, '--pkg', pkgDir, '--scene', 'LookTest.unity', '--project', projDir, '--png'],
            { encoding: 'utf8' });
        assert.equal(res.status, 0, `convert.js exited ${res.status}\nstderr:\n${res.stderr}`);
        const scene = fs.readFileSync(path.join(projDir, 'assets', 'LookTest_unity.scene'), 'utf8');
        return { res, scene };
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

test('a scene volume with ACES converts to the Filmic look, by name', () => {
    const { scene } = convert(2);
    assert.match(scene, /^PostProcessVolume\.look = Filmic$/m);
    assert.doesNotMatch(scene, /PostProcessVolume\.tonemap/);
});

test('a scene volume with Neutral converts to the Neutral look', () => {
    const { scene } = convert(1);
    assert.match(scene, /^PostProcessVolume\.look = Neutral$/m);
});

test('a custom curve is reported as dropped and converts to Filmic', () => {
    const { res, scene } = convert(3);
    assert.match(scene, /^PostProcessVolume\.look = Filmic$/m);
    assert.match(res.stdout, /Tonemapping custom curve/);
});
