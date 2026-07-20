// Surface shader: Stylized Water FLOW front-end (Synty ElvenRealm "Waterfall_Emissive", GUID 88fd8f21).
//
// THIS FILE IS PROJECT/EXAMPLE-SIDE, NOT AN ENGINE BUILT-IN. It demonstrates that a user can author
// a new lit surface entirely with the shipped material APIs — no engine C++ table edits. It reads
// ONLY: the generic user-param block (Mat.uUser0/uUser1), the base tint (Mat.uBaseColor), the two
// standard bindless slots (albedoMap = Color_Mask, normalMap = Normals), and the always-bound
// per-view time (Light.uTimeParams.y, the bounded scroll clock). Nothing in the engine's MaterialRegistry / param lanes /
// texture-slot tables knows the word "water". The composer resolves this file from the material's
// own directory (ShaderComposer::ResolveSurfaceShaderPath, materialDir first), so dropping it next
// to a .material and referencing "surfaceShader": "water_stylized.glsl" is all it takes.
//
// Look (the Synty stylized water): a scrolling Color_Mask Screen-blended OVER Water_Color — the
// ground-truth BaseColor block is lerp(Base, Screen(Base, Water_Color), Water_Overlay_Power), so
// mask-black texels floor at overlayPower * Water_Color (the mask brightens the water; it never
// multiplies it toward black); a scrolling Normals ripple that catches the light; a fresnel rim +
// a second, faster scroll layer added as a subtle emissive accent. It writes SurfaceOutput and
// hands off to the UNCHANGED OpenPBR BRDF — it is a front-end, not a lighting model (same
// discipline as triplanar_pbr.glsl / standard_pbr.glsl).
//
// Blend: authored OPAQUE (matches every shipped Synty 88fd8f21 material — see
// user-shader-extensibility-2026-07.html §5). The material's "alphaMode" owns the blend; flip it to
// "Blend" for the translucent Water_01 look — the shader already writes opacity, so it is one field.
//
// Generic user-param mapping (authored by NAME in the .material, no engine lane per property):
//   Mat.uUser0 = (scrollSpeedX, scrollSpeedY, overlayPower, fresnelPower)   -> "user0".."user3"
//   Mat.uUser1 = (fresnelColor.r, .g, .b, emissionStrength)                 -> "user4".."user7" / "userVec1"
//   Mat.uUser2.x = fresnelRimCap (authored _Fresnel_Power)                  -> "user8"
//   Mat.uBaseColor = Water_Color (rgb tint; a = opacity, used only when alphaMode = Blend)
//   metallic / roughness via the standard "metallic" / "roughness" props (Mat.uParams0.x / .y)
//
// FALLS extension: the vertical 3-texture waterfall (GUID 87c14512) is a runtime branch away — no
// keyword needed (see the assessment doc §3·D). Add a "user8" mode flag and sample slots 2/3 for the
// extra flow layers. Left out here to keep the FLOW slice focused and verifiable.
//
// Declared texture set (named-slot resolution). Both are engine WELL-KNOWN names, so they keep their
// canonical ordinals (albedoMap = 0, normalMap = 1) — declaring them opts this surface into the
// @texture resolver with ZERO behavior change and no raw-ordinal aliasing. A project surface adds its
// own USER names alongside these (e.g. `// @texture flowMask linear`) and reads them via
// GE_USER_TEXTURE(flowMask); the composer packs each user name into the lowest free slot.
// @texture albedoMap  srgb
// @texture normalMap  linear

// Tangent-free ripple: Synty water FBX meshes carry no tangent stream (the reason triplanar_pbr
// sidesteps tangents too). Build a cotangent frame from screen-space position/UV gradients
// (Schuler, "Followup: Normal Mapping Without Precomputed Tangents") so the Normals map perturbs
// the geometric normal without depending on the HAS_TANGENT vertex path.
vec3 GE_WaterPerturbNormal(vec3 N, vec3 posWS, vec2 uv, vec3 tangentNormal)
{
    vec3 dpx = dFdx(posWS);
    vec3 dpy = dFdy(posWS);
    vec2 duvx = dFdx(uv);
    vec2 duvy = dFdy(uv);

    vec3 dpyPerp = cross(dpy, N);
    vec3 dpxPerp = cross(N, dpx);
    vec3 T = dpyPerp * duvx.x + dpxPerp * duvy.x;
    vec3 B = dpyPerp * duvx.y + dpxPerp * duvy.y;

    float invMax = inversesqrt(max(dot(T, T), dot(B, B)));
    mat3 tbn = mat3(T * invMax, B * invMax, N);
    return normalize(tbn * tangentNormal);
}

SurfaceOutput EvaluateSurface(SurfaceInput sIn)
{
    SurfaceOutput o = DefaultSurfaceOutput();

    float elapsed = Light.uTimeParams.y;               // bounded scroll clock (wraps per tile period; keeps UV precision on long sessions)
    vec2  scrollSpeed   = Mat.uUser0.xy;
    float overlayPower  = Mat.uUser0.z;
    float fresnelPower  = Mat.uUser0.w;
    vec3  fresnelColor  = Mat.uUser1.rgb;
    float emissionScale = Mat.uUser1.w;
    float fresnelRimCap = Mat.uUser2.x;

    // Panner: the material's slot-0 tiling/offset, then scroll by time * speed (Synty "_UVScroll_Speed").
    vec2 uvBase = GE_TransformUV(sIn.uv0, sIn.textureST[0], sIn.textureST2[0]);
    vec2 uvMain = uvBase + scrollSpeed * elapsed;

    // --- Albedo: Unity ground truth (Waterfall_Emissive 88fd8f21 BaseColor block):
    //   Base      = Emission * (Water_Color * Color_Mask)                       (Multiply 39902b / 4cd40e)
    //   BaseColor = lerp(Base, Screen(Base, Water_Color), Water_Overlay_Power)  (Blend node, m_BlendMode 17)
    // The mask BRIGHTENS via Screen; it never multiplies the floor toward black — mask-black texels
    // resolve to overlayPower * Water_Color, not black (WaterFallMask is ~80% black, so a straight
    // mask multiply rendered every flat water surface as black).
    vec4 colorMask  = texture(albedoMap, uvMain);
    vec3 maskedBase = colorMask.rgb * Mat.uBaseColor.rgb * emissionScale;
    vec3 screened   = 1.0 - (1.0 - maskedBase) * (1.0 - Mat.uBaseColor.rgb);
    o.baseColor = mix(maskedBase, screened, overlayPower) * sIn.vertexColor.rgb;
    o.opacity   = colorMask.a * Mat.uBaseColor.a * sIn.vertexColor.a; // consumed only when alphaMode = Blend

    // --- Metallic / roughness (standard scalar lanes) ---
    o.metallic  = clamp(Mat.uParams0.x, 0.0, 1.0);
    o.roughness = clamp(Mat.uParams0.y, 0.04, 1.0);

    // --- Ripple normal: scrolling Normals through the tangent-free frame ---
    vec3 rippleTS = texture(normalMap, uvMain).xyz * 2.0 - 1.0;
    o.normalWS = GE_WaterPerturbNormal(normalize(sIn.normalWS), sIn.positionWS, uvMain, rippleTS);
    o.coatNormalWS = o.normalWS;

    // --- Emissive: the authored luminous overlay, UNCONDITIONAL ---
    // Unity ground truth: the FLOW graph's Water_Color x Color_Mask x Emission product is
    // authored bright unconditionally (it Screen-blends into BaseColor at Water_Overlay_Power,
    // and the sibling FALLS graph 87c14512 routes the same shape straight through
    // surface.Emission). Unity's display-referred night reads that overlay as luminous; under
    // our physically exposed night a lit albedo cannot glow, so the faithful translation
    // expresses it through the OpenPBR emission lobe: scene-linear 1.0 == 203 nits
    // (GE_EMISSION_PAPERWHITE_NITS), emissionScale ("Emission" in the .mat) carried 1:1.
    // The streak/overlay layer still SHAPES the lobe (brightens where the fast layer crosses)
    // but no longer GATES it — the old (fresnel + overlay*power) gate multiplied the whole
    // term toward zero and left night water near-black.
    float ndv = clamp(dot(o.normalWS, sIn.viewDirWS), 0.0, 1.0);
    float fresnel = pow(1.0 - ndv, max(fresnelPower, 1e-3));

    vec2  uvStreak = uvBase + scrollSpeed * (elapsed * 1.7);        // same direction, faster layer
    float streak   = texture(albedoMap, uvStreak).r;
    float overlay  = 1.0 - (1.0 - colorMask.r) * (1.0 - streak);    // Screen(base, streak)
    // Rim: Unity's FLOW Emission block is exactly Fresnel_Color * min(fresnelEffect,
    // _Fresnel_Power) — the authored cap (user8, 0.01..0.012 in the corpus) bounds it to a
    // subtle sheen; the pow-3 falloff (user3) keeps the port's verified rim shape.
    vec3 rim = fresnelColor * min(fresnel, fresnelRimCap);
    o.emissive = colorMask.rgb * Mat.uBaseColor.rgb * (1.0 + overlay * overlayPower) * emissionScale + rim;

    return o;
}
