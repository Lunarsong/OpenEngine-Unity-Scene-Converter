// Regression guards for the AmbientLight colour-space conversion.
//
// Unity's RenderSettings m_Ambient*Color fields serialize the colour picker's
// sRGB-ENCODED floats, not linear light. Ground truth: ElvenRealm Demo.unity's
// trilight sky serializes {r: 0.5082908, g: 0.39215687, b: 0.85882354} — g and
// b are EXACTLY the 8-bit picker swatch {130,100,219}/255, which only happens
// when the stored floats are the display-referred values. The engine's
// AmbientLight colours are authored-linear (AmbientLight.h), so the converter
// must decode sRGB->linear at emission. A prior converter revision emitted the
// sRGB floats as linear (the comment even asserted pass-through was correct);
// these tests fail loudly if that regresses.
//
// Run:  npm test    (from the package root)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const convert = require(path.join(__dirname, '..', 'src', 'convert.js'));

const { srgbToLinear, linearizeAmbientColor, emitAmbientLightLines } = convert;

const approx = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

// The ElvenRealm Demo.unity night trilight, exactly as serialized in the scene.
const kDemoSky = [0.5082908, 0.39215687, 0.85882354];   // picker {130,100,219}
const kDemoEquator = [0.5566038, 0.128649, 0.3665028];  // picker {142, 33, 93}
const kDemoGround = [0.21960783, 0.6713297, 1];         // picker { 56,171,255}

// IEC 61966-2-1 sRGB EOTF of the exact serialized floats (computed with the
// piecewise transform; hardcoded so a formula regression cannot self-confirm).
const kDemoSkyLinear = [0.22179537, 0.12743769, 0.70837580];
const kDemoEquatorLinear = [0.27022313, 0.01505798, 0.11058984];
const kDemoGroundLinear = [0.03954623, 0.40823969, 1];

test('srgbToLinear implements the piecewise IEC 61966-2-1 EOTF', () => {
    assert.equal(srgbToLinear(0), 0);
    assert.equal(srgbToLinear(1), 1);
    assert.ok(approx(srgbToLinear(0.04045), 0.04045 / 12.92)); // linear-segment boundary
    assert.ok(approx(srgbToLinear(0.5), 0.21404114));
    assert.ok(approx(srgbToLinear(0.5082908), kDemoSkyLinear[0]));
});

test('LDR ambient swatches decode sRGB->linear per channel', () => {
    const cases = [
        [kDemoSky, kDemoSkyLinear],
        [kDemoEquator, kDemoEquatorLinear],
        [kDemoGround, kDemoGroundLinear],
    ];
    for (const [input, expected] of cases) {
        const got = linearizeAmbientColor(input);
        for (let i = 0; i < 3; i++)
            assert.ok(approx(got[i], expected[i]),
                `channel ${i}: got ${got[i]}, want ${expected[i]}`);
    }
});

test('HDR ambient values (any channel > 1) pass through unchanged', () => {
    const hdr = [1.844, 0.3, 0.2];
    assert.deepEqual(linearizeAmbientColor(hdr), hdr);
});

test('trilight emission carries the LINEAR values for the Demo.unity night ambient', () => {
    const rs = {
        ambientMode: 1,
        ambientSky: kDemoSky,
        ambientEquator: kDemoEquator,
        ambientGround: kDemoGround,
        isNight: true,
    };
    const lines = emitAmbientLightLines(rs, false);
    assert.deepEqual(lines.filter(l => !l.includes('=')).length, 0);
    assert.ok(lines.includes('AmbientLight.Mode = 1'), lines.join('\n'));
    assert.ok(lines.includes('AmbientLight.Intensity = 60'), lines.join('\n'));

    const grab = (key) => {
        const line = lines.find(l => l.startsWith(`AmbientLight.${key} = `));
        assert.ok(line, `missing ${key} in:\n${lines.join('\n')}`);
        const m = line.match(/\(([-\d.e]+), ([-\d.e]+), ([-\d.e]+)\)/);
        assert.ok(m, `unparseable ${key} line: ${line}`);
        return [+m[1], +m[2], +m[3]];
    };
    const expect = {
        SkyColor: kDemoSkyLinear,
        EquatorColor: kDemoEquatorLinear,
        GroundColor: kDemoGroundLinear,
    };
    for (const [key, want] of Object.entries(expect)) {
        const got = grab(key);
        for (let i = 0; i < 3; i++)
            assert.ok(approx(got[i], want[i], 5e-7),
                `${key}[${i}]: emitted ${got[i]}, want linear ${want[i]} — ` +
                `an sRGB value leaking through reads ~2-4x too bright`);
    }
});

test('flat ambient (mode 3) also decodes to linear', () => {
    const rs = { ambientMode: 3, ambientSky: [0.5, 0.5, 0.5], isNight: true };
    const lines = emitAmbientLightLines(rs, false);
    assert.ok(lines.includes('AmbientLight.Mode = 0'), lines.join('\n'));
    const line = lines.find(l => l.startsWith('AmbientLight.Color = '));
    assert.ok(line);
    const m = line.match(/\(([-\d.e]+), /);
    assert.ok(approx(+m[1], 0.21404114, 1e-6),
        `flat ambient emitted ${m[1]}, want srgbToLinear(0.5)=0.21404114`);
});

test('skybox ambient mode (0) emits no AmbientLight', () => {
    const rs = { ambientMode: 0, ambientSky: [0.5, 0.5, 0.5], isNight: true };
    assert.deepEqual(emitAmbientLightLines(rs, false), []);
});
