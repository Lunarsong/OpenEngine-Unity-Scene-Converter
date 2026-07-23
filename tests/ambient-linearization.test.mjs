// Regression guards for the AmbientLight colour-space conversion.
//
// Unity's RenderSettings m_Ambient*Color fields serialize the colour picker's
// sRGB-ENCODED floats, not linear light. (Established against a licensed
// reference scene whose values are not reproduced here: its serialized floats
// were EXACTLY 8-bit picker swatch fractions n/255, which only happens when
// the stored values are display-referred.) The engine's AmbientLight colours
// are authored-linear (AmbientLight.h), so the converter must decode
// sRGB->linear at emission. A prior converter revision emitted the sRGB floats
// as linear (the comment even asserted pass-through was correct); these tests
// fail loudly if that regresses.
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

// Synthesized trilight (no scene-recorded values). Sky uses exact binary
// fractions; equator is an exact 8-bit picker swatch {200,64,32}/255
// serialized Unity-style (8 significant digits) to mirror the real
// serialization shape; ground exercises the EOTF's linear segment
// (0.003 <= 0.04045 -> x/12.92) and the exact-1 endpoint.
const kTriSky = [0.5, 0.25, 0.125];
const kTriEquator = [0.78431373, 0.25098039, 0.1254902]; // picker {200, 64, 32}
const kTriGround = [0.003, 0.6, 1];

// IEC 61966-2-1 sRGB EOTF of the exact literals above, computed INDEPENDENTLY
// of convert.js (x <= 0.04045 ? x/12.92 : ((x+0.055)/1.055)^2.4, evaluated in
// a separate scratch implementation) and hardcoded so a formula regression in
// the converter cannot self-confirm.
const kTriSkyLinear = [0.21404114, 0.05087609, 0.01434987];
const kTriEquatorLinear = [0.57758045, 0.05126946, 0.01444384];
const kTriGroundLinear = [0.00023220, 0.31854678, 1];

test('srgbToLinear implements the piecewise IEC 61966-2-1 EOTF', () => {
    assert.equal(srgbToLinear(0), 0);
    assert.equal(srgbToLinear(1), 1);
    assert.ok(approx(srgbToLinear(0.04045), 0.04045 / 12.92)); // linear-segment boundary
    assert.ok(approx(srgbToLinear(0.5), 0.21404114));
    assert.ok(approx(srgbToLinear(0.78431373), kTriEquatorLinear[0]));
});

test('LDR ambient swatches decode sRGB->linear per channel', () => {
    const cases = [
        [kTriSky, kTriSkyLinear],
        [kTriEquator, kTriEquatorLinear],
        [kTriGround, kTriGroundLinear],
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

test('trilight emission carries the LINEAR values for a night ambient', () => {
    const rs = {
        ambientMode: 1,
        ambientSky: kTriSky,
        ambientEquator: kTriEquator,
        ambientGround: kTriGround,
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
        SkyColor: kTriSkyLinear,
        EquatorColor: kTriEquatorLinear,
        GroundColor: kTriGroundLinear,
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
