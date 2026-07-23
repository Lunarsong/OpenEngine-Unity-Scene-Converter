// Guards for HONEST drop reporting of Unity post-processing volume grades
// (convert.js emitScene): every recognized-but-untranslated override must be
// reported in the final conversion summary rather than silently swallowed, the
// stale "no engine equivalent" deny-list must be gone, and ChromaticAberration
// (which now HAS an engine effect) must map to ChromaticAberrationEffect.
// All fixtures are synthetic — no licensed content.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONVERT = path.join(__dirname, '..', 'src', 'convert.js');

// URP core Volume MonoBehaviour script guid (must match convert.js).
const kUrpVolumeScriptGuid = '172515602e62fb746b5d573b38a5fe58';

function put(dir, guid, pathname, content) {
    const gdir = path.join(dir, guid);
    fs.mkdirSync(gdir, { recursive: true });
    fs.writeFileSync(path.join(gdir, 'pathname'), pathname + '\n');
    fs.writeFileSync(path.join(gdir, 'asset'), content);
}

// A minimal day scene with a directional sun (so the post-FX volume block runs)
// and a global Volume whose profile carries: a translated component
// (ColorAdjustments), a translated-with-a-dropped-subfield (colorFilter), a
// now-mappable component (ChromaticAberration) and a genuinely unmapped grade
// (SplitToning).
function buildVolumeFixture(dir) {
    const sceneGuid = '00000000000000000000000000dr0001';
    const profGuid = '00000000000000000000000000dr0002';
    put(dir, sceneGuid, 'Assets/Scenes/DropTest.unity', [
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
    put(dir, profGuid, 'Assets/Volumes/DropProfile.asset', [
        '%YAML 1.1',
        '%TAG !u! tag:unity3d.com,2011:',
        '--- !u!114 &1',
        'MonoBehaviour:',
        '  m_Name: ColorAdjustments',
        '  active: 1',
        '  postExposure:',
        '    m_OverrideState: 1',
        '    m_Value: 0.2',
        '  colorFilter:',
        '    m_OverrideState: 1',
        '    m_Value: {r: 1, g: 0.8, b: 0.6, a: 1}',
        '  saturation:',
        '    m_OverrideState: 1',
        '    m_Value: 10',
        '--- !u!114 &2',
        'MonoBehaviour:',
        '  m_Name: ChromaticAberration',
        '  active: 1',
        '  intensity:',
        '    m_OverrideState: 1',
        '    m_Value: 0.5',
        '--- !u!114 &3',
        'MonoBehaviour:',
        '  m_Name: SplitToning',
        '  active: 1',
        '  shadows:',
        '    m_OverrideState: 1',
        '    m_Value: {r: 0.2, g: 0.3, b: 0.5, a: 0}',
        '  balance:',
        '    m_OverrideState: 1',
        '    m_Value: 20',
        '',
    ].join('\n'));
    return dir;
}

function runConvert(tmp) {
    const pkgDir = buildVolumeFixture(path.join(tmp, 'pkg'));
    const projDir = path.join(tmp, 'proj');
    fs.mkdirSync(projDir, { recursive: true });
    const res = spawnSync(process.execPath,
        [CONVERT, '--pkg', pkgDir, '--scene', 'DropTest.unity', '--project', projDir, '--png'],
        { encoding: 'utf8' });
    assert.equal(res.status, 0, `convert.js exited ${res.status}\nstderr:\n${res.stderr}`);
    const scene = fs.readFileSync(path.join(projDir, 'assets', 'DropTest_unity.scene'), 'utf8');
    return { res, scene };
}

test('ChromaticAberration maps to ChromaticAberrationEffect (normalized -> full pixel range)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dropguard-'));
    try {
        const { scene } = runConvert(tmp);
        assert.match(scene, /ChromaticAberrationEffect\.enabled = true/);
        // Unity intensity 0.5 -> 0.5 * kIntensityMax(12) = 6 px.
        assert.match(scene, /ChromaticAberrationEffect\.intensity = 6\b/);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('the stale "no engine equivalent" ChromaticAberration warning is gone', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dropguard-'));
    try {
        const { res } = runConvert(tmp);
        const all = res.stdout + res.stderr;
        assert.doesNotMatch(all, /ChromaticAberration.*no engine equivalent/i);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('unmapped grade (SplitToning) is reported in the dropped-settings summary', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dropguard-'));
    try {
        const { res } = runConvert(tmp);
        assert.match(res.stdout, /recognized settings dropped \(no engine mapping\)/);
        assert.match(res.stdout, /SplitToning/);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('a partially-translated component reports its dropped sub-setting (ColorAdjustments.colorFilter)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dropguard-'));
    try {
        const { res, scene } = runConvert(tmp);
        assert.match(res.stdout, /ColorAdjustments\.colorFilter/);
        // colorFilter placement is a judgment call (plan) — do NOT emit ColorFilterEffect.
        assert.doesNotMatch(scene, /ColorFilterEffect\./);
        // ...but the translated part of ColorAdjustments still carries over.
        assert.match(scene, /ColorGradeEffect\.saturation/);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('the dropped summary prints even without --verbose (conversions are self-documenting)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dropguard-'));
    try {
        const { res } = runConvert(tmp);
        // No --verbose was passed; the report line must still appear on stdout.
        assert.match(res.stdout, /--- recognized settings dropped/);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});
