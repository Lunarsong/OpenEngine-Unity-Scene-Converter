// Guards for Unity colour-grade -> native ColorGradeEffect mapping (convert.js).
//
// Slice 1 replaced the single-range ColorGradeEffect (brightness/contrast/gamma/
// hue/saturation) with a unified three-way log corrector: per-band RGB chroma
// offset + master lightness (shadowsColorR/G/B + shadowsLightness, ...), global
// contrast/saturation, gradeInLog. The converter must emit ONLY those keys — a
// stray old key (brightness/gamma/hue) is consume-DROPPED by the new schema, i.e.
// the grade would silently vanish. These tests lock:
//   - Unity ShadowsMidtonesHighlights -> the three native bands (not a .cube LUT),
//     numbers matching URP's PrepareShadowsMidtonesHighlights remap;
//   - Unity LiftGammaGain -> bands via ASC CDL (Lift->Shadows, Gamma->Midtones,
//     Gain->Highlights), replicating PrepareLiftGammaGain;
//   - ColorAdjustments contrast recalibrated to the log-space /100 (was /200) and
//     saturation carried 1:1; gradeInLog = true;
//   - no old keys emitted; HueShift now honestly reported as dropped;
//   - the --grade-lut opt-in still bakes the legacy CubeLutEffect.
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
const kUrpVolumeScriptGuid = '172515602e62fb746b5d573b38a5fe58';

function put(dir, guid, pathname, content) {
    const gdir = path.join(dir, guid);
    fs.mkdirSync(gdir, { recursive: true });
    fs.writeFileSync(path.join(gdir, 'pathname'), pathname + '\n');
    fs.writeFileSync(path.join(gdir, 'asset'), content);
}

// A minimal day scene (directional sun so the post-FX volume block runs) + a
// global Volume whose profile carries `profileDocs` (an array of MonoBehaviour
// YAML doc bodies). Returns the pkg dir.
function buildFixture(dir, profileDocs) {
    const sceneGuid = '00000000000000000000000000cg0001';
    const profGuid = '00000000000000000000000000cg0002';
    put(dir, sceneGuid, 'Assets/Scenes/GradeTest.unity', [
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
    const profile = ['%YAML 1.1', '%TAG !u! tag:unity3d.com,2011:'];
    profileDocs.forEach((body, i) => {
        profile.push(`--- !u!114 &${i + 1}`, 'MonoBehaviour:', ...body);
    });
    profile.push('');
    put(dir, profGuid, 'Assets/Volumes/GradeProfile.asset', profile.join('\n'));
    return dir;
}

function runConvert(tmp, profileDocs, extraArgs = []) {
    const pkgDir = buildFixture(path.join(tmp, 'pkg'), profileDocs);
    const projDir = path.join(tmp, 'proj');
    fs.mkdirSync(projDir, { recursive: true });
    const res = spawnSync(process.execPath,
        [CONVERT, '--pkg', pkgDir, '--scene', 'GradeTest.unity', '--project', projDir, '--png', ...extraArgs],
        { encoding: 'utf8' });
    assert.equal(res.status, 0, `convert.js exited ${res.status}\nstderr:\n${res.stderr}`);
    const scene = fs.readFileSync(path.join(projDir, 'assets', 'GradeTest_unity.scene'), 'utf8');
    return { res, scene };
}

// YAML doc-body helpers.
const smhDoc = (shadows, midtones, highlights, limits = {}) => [
    '  m_Name: ShadowsMidtonesHighlights', '  active: 1',
    '  shadows:', '    m_OverrideState: 1', `    m_Value: {x: ${shadows[0]}, y: ${shadows[1]}, z: ${shadows[2]}, w: ${shadows[3]}}`,
    '  midtones:', '    m_OverrideState: 1', `    m_Value: {x: ${midtones[0]}, y: ${midtones[1]}, z: ${midtones[2]}, w: ${midtones[3]}}`,
    '  highlights:', '    m_OverrideState: 1', `    m_Value: {x: ${highlights[0]}, y: ${highlights[1]}, z: ${highlights[2]}, w: ${highlights[3]}}`,
    ...Object.entries(limits).flatMap(([k, v]) =>
        [`  ${k}:`, '    m_OverrideState: 1', `    m_Value: ${v}`]),
];
const lggDoc = (lift, gamma, gain) => [
    '  m_Name: LiftGammaGain', '  active: 1',
    '  lift:', '    m_OverrideState: 1', `    m_Value: {x: ${lift[0]}, y: ${lift[1]}, z: ${lift[2]}, w: ${lift[3]}}`,
    '  gamma:', '    m_OverrideState: 1', `    m_Value: {x: ${gamma[0]}, y: ${gamma[1]}, z: ${gamma[2]}, w: ${gamma[3]}}`,
    '  gain:', '    m_OverrideState: 1', `    m_Value: {x: ${gain[0]}, y: ${gain[1]}, z: ${gain[2]}, w: ${gain[3]}}`,
];
const colAdjDoc = (fields) => ['  m_Name: ColorAdjustments', '  active: 1',
    ...Object.entries(fields).flatMap(([k, v]) => [`  ${k}:`, '    m_OverrideState: 1', `    m_Value: ${v}`])];

function withTmp(fn) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cgmap-'));
    try { return fn(tmp); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// Read one ColorGradeEffect key's numeric value from the emitted scene.
function grade(scene, key) {
    const m = scene.match(new RegExp(`ColorGradeEffect\\.${key} = ([-\\d.eE]+)`));
    return m ? Number(m[1]) : undefined;
}

test('ShadowsMidtonesHighlights -> native three-way bands (URP prep numbers), no .cube LUT', () => {
    withTmp((tmp) => {
        // Midtones white w=0.176 -> URP prep multiplier x1.704 -> pure lightness
        // log2(1.704)/17.52/0.5 = 0.0877769 (chroma 0). Shadows blue-tinted.
        const { scene } = runConvert(tmp, [smhDoc([0.5, 0.6, 1.0, 0], [1, 1, 1, 0.176], [1, 1, 1, 0])]);
        // Exact schema key names (BuiltInSceneSchemas.cpp), split-vector convention.
        assert.match(scene, /ColorGradeEffect\.enabled = true/);
        assert.match(scene, /ColorGradeEffect\.gradeInLog = true/);
        assert.equal(grade(scene, 'midtonesLightness'), 0.0877769);
        // Shadows blue wheel: +blue chroma, -red/-green, net darkening.
        assert.ok(grade(scene, 'shadowsColorB') > 0.1, 'shadows blue chroma positive');
        assert.ok(grade(scene, 'shadowsColorR') < 0, 'shadows red chroma negative');
        assert.ok(grade(scene, 'shadowsLightness') < 0, 'blue-tint shadow darkens');
        // Highlights wheel was neutral -> no highlights offset lines emitted
        // (highlightsStart/End band limits still carry the URP partition).
        assert.doesNotMatch(scene, /ColorGradeEffect\.highlights(Color[RGB]|Lightness)/);
        // NOT the legacy LUT path, and NONE of the removed single-range keys.
        assert.doesNotMatch(scene, /CubeLutEffect\./);
        assert.doesNotMatch(scene, /ColorGradeEffect\.(brightness|gamma|hue)\b/);
    });
});

// Band limits: URP smoothstep edges over LINEAR luminance map through
// EncodeGradeLog onto the engine's encoded-log axis (see smhLimitsToNative).
const encodeGradeLog = (x) => x <= 0.0078125 ? x * 10.5402 + 0.0729
                                             : (Math.log2(Math.max(x, 1e-10)) + 9.72) / 17.52;
const near = (actual, expected, msg) => {
    assert.ok(typeof actual === 'number' && Math.abs(actual - expected) < 1e-6,
        `${msg}: ${actual} != ~${expected}`);
};

test('SMH band limits carry through EncodeGradeLog; URP defaults emitted when unoverridden', () => {
    withTmp((tmp) => {
        // Live SMH (blue shadows) with NO limit overrides -> URP's default
        // partition (shadows 0->0.3, highlights 0.55->1 linear) must be emitted
        // in the encoded domain, NOT dropped to the native defaults (0/0.45/
        // 0.45/0.95) — that is where URP's band placement actually lives.
        const { scene } = runConvert(tmp, [smhDoc([0.5, 0.6, 1.0, 0], [1, 1, 1, 0], [1, 1, 1, 0])]);
        near(grade(scene, 'shadowsStart'), encodeGradeLog(0), 'shadowsStart');
        near(grade(scene, 'shadowsEnd'), encodeGradeLog(0.3), 'shadowsEnd');
        near(grade(scene, 'highlightsStart'), encodeGradeLog(0.55), 'highlightsStart');
        near(grade(scene, 'highlightsEnd'), encodeGradeLog(1), 'highlightsEnd');
    });
});

test('SMH explicit band limits map through EncodeGradeLog (clamped to [0,1] encoded)', () => {
    withTmp((tmp) => {
        const { scene } = runConvert(tmp, [smhDoc([0.5, 0.6, 1.0, 0], [1, 1, 1, 0], [1, 1, 1, 0],
            { shadowsStart: 0.05, shadowsEnd: 0.4, highlightsStart: 0.6, highlightsEnd: 2 })]);
        near(grade(scene, 'shadowsStart'), encodeGradeLog(0.05), 'shadowsStart');
        near(grade(scene, 'shadowsEnd'), encodeGradeLog(0.4), 'shadowsEnd');
        near(grade(scene, 'highlightsStart'), encodeGradeLog(0.6), 'highlightsStart');
        near(grade(scene, 'highlightsEnd'), encodeGradeLog(2), 'highlightsEnd');
    });
});

test('LGG-only volumes emit no band limits (URP LGG is unbanded -> native defaults)', () => {
    withTmp((tmp) => {
        const { scene } = runConvert(tmp, [lggDoc([1, 0.9, 0.85, 0.02], [1, 1, 1, 0], [1, 1, 1, 0])]);
        assert.doesNotMatch(scene, /ColorGradeEffect\.(shadowsStart|shadowsEnd|highlightsStart|highlightsEnd)/);
    });
});

test('LiftGammaGain -> bands via ASC CDL: Lift->Shadows, Gamma->Midtones, Gain->Highlights', () => {
    withTmp((tmp) => {
        // Distinct hue per wheel so band assignment is unambiguous.
        const { scene } = runConvert(tmp, [lggDoc(
            [1.0, 0.8, 0.7, 0.05],  // lift  warm  -> shadows
            [0.8, 1.0, 0.8, 0.0],   // gamma green -> midtones
            [0.9, 0.9, 1.0, 0.0],   // gain  blue  -> highlights
        )]);
        assert.match(scene, /ColorGradeEffect\.enabled = true/);
        assert.match(scene, /ColorGradeEffect\.gradeInLog = true/);
        // Lift landed in the shadows band (warm: red chroma > blue chroma).
        assert.ok(grade(scene, 'shadowsColorR') > grade(scene, 'shadowsColorB'), 'lift warm -> shadows red>blue');
        // Gamma landed in the midtones band (green: green chroma highest).
        assert.ok(grade(scene, 'midtonesColorG') > grade(scene, 'midtonesColorR'), 'gamma green -> midtones green>red');
        // Gain landed in the highlights band (blue: blue chroma highest).
        assert.ok(grade(scene, 'highlightsColorB') > grade(scene, 'highlightsColorR'), 'gain blue -> highlights blue>red');
        assert.doesNotMatch(scene, /CubeLutEffect\./);
        assert.doesNotMatch(scene, /ColorGradeEffect\.(brightness|gamma|hue)\b/);
    });
});

test('ColorAdjustments contrast recalibrated to log-space /100 (was /200); saturation 1:1; gradeInLog', () => {
    withTmp((tmp) => {
        const { scene } = runConvert(tmp, [colAdjDoc({ contrast: 20, saturation: 10 })]);
        // contrast 20 -> 1 + 20/100 = 1.2 (the OLD /200 would have emitted 1.1).
        assert.equal(grade(scene, 'contrast'), 1.2);
        // saturation 10 -> 1 + 10/100 = 1.1 (unchanged mapping).
        assert.equal(grade(scene, 'saturation'), 1.1);
        assert.match(scene, /ColorGradeEffect\.gradeInLog = true/);
        assert.match(scene, /ColorGradeEffect\.enabled = true/);
    });
});

test('ColorAdjustments Hue Shift is no longer emitted (new schema has no hue) and is reported as dropped', () => {
    withTmp((tmp) => {
        const { res, scene } = runConvert(tmp, [colAdjDoc({ hueShift: 25, saturation: 5 })]);
        // Old code emitted ColorGradeEffect.hue -> the new schema consume-drops it.
        assert.doesNotMatch(scene, /ColorGradeEffect\.hue\b/);
        // Honestly reported instead of silently swallowed.
        assert.match(res.stdout, /recognized settings dropped/);
        assert.match(res.stdout, /hueShift/);
        // The mappable part of ColorAdjustments still carries.
        assert.match(scene, /ColorGradeEffect\.saturation = 1\.05/);
    });
});

test('LiftGammaGain is no longer in the dropped-settings summary (it now maps)', () => {
    withTmp((tmp) => {
        const { res } = runConvert(tmp, [lggDoc([1, 0.9, 0.85, 0.02], [1, 1, 1, 0], [1, 1, 1, 0])]);
        assert.doesNotMatch(res.stdout + res.stderr, /LiftGammaGain.*(no engine mapping|no engine equivalent|dropped)/i);
    });
});

test('--grade-lut opt-in bakes the legacy CubeLutEffect instead of native bands', () => {
    withTmp((tmp) => {
        const { scene } = runConvert(tmp, [smhDoc([0.5, 0.6, 1.0, 0], [1, 1, 1, 0.176], [1, 1, 1, 0])], ['--grade-lut']);
        assert.match(scene, /CubeLutEffect\.enabled = true/);
        assert.match(scene, /CubeLutEffect\.lutAsset = \[path="GradeTest_smh_lut\.cube"/);
        // With the LUT fallback, SMH does NOT also emit native bands.
        assert.doesNotMatch(scene, /ColorGradeEffect\.(shadows|midtones|highlights)/);
    });
});

test('a colour-grade-free scene emits no ColorGradeEffect block', () => {
    withTmp((tmp) => {
        const { scene } = runConvert(tmp, [colAdjDoc({ postExposure: 0.5 })]);
        // postExposure folds into ExposureAdjustmentEffect, not ColorGradeEffect.
        assert.doesNotMatch(scene, /ColorGradeEffect\./);
    });
});
