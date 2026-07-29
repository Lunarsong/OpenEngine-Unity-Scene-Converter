using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace GameEngine.UnityConverter;

/// Unity .mat -> engine .material generation — port of the convert.js
/// material section: m_SavedProperties parsing, Synty shader-family dispatch,
/// StandardPBR / triplanar / water / falls document builders, texture
/// resolution (assetdb-first, pack copy-fallback, optional KTX2 encode), and
/// the project-side surface-shader copy/refresh policy.
internal static class Materials
{
    public const string kMatOutRel = "Materials_Unity";
    public const string kTexCopyRel = "Textures_Unity";
    public const string kModelSeedRel = "Models_Unity";
    public const double kEmissionPaperwhiteNits = 203;

    // ------------------------------------------------- deterministic guid --
    public static string DeterministicGuid(string seed)
    {
        const ulong prime = 1099511628211UL;
        ulong a = 14695981039346656037UL;
        ulong b = 1099511628211UL;
        foreach (char c in seed)
        {
            ulong cv = c;
            unchecked
            {
                a = (a ^ cv) * prime;
                b = (b ^ (cv * 3 + 7)) * prime;
            }
        }
        string hex = a.ToString("x16", System.Globalization.CultureInfo.InvariantCulture)
                   + b.ToString("x16", System.Globalization.CultureInfo.InvariantCulture);
        return $"{hex[..8]}-{hex[8..12]}-{hex[12..16]}-{hex[16..20]}-{hex[20..32]}";
    }

    private static readonly Regex kSanitizeFileNameRe = new("[^A-Za-z0-9._-]+", RegexOptions.Compiled);
    private static readonly Regex kSanitizeEdgeRe = new("^_+|_+$", RegexOptions.Compiled);

    public static string SanitizeFileName(string? s)
    {
        string name = kSanitizeEdgeRe.Replace(kSanitizeFileNameRe.Replace(s ?? "Material", "_"), "");
        return name.Length > 0 ? name : "Material";
    }

    // ------------------------------------------------------ .mat parsing ---
    public sealed class UnityMatInfo
    {
        public string? ShaderGuid;
        public readonly HashSet<string> Keywords = [];
        public string RenderType = "";
        public readonly Dictionary<string, string> TexEnvs = [];
        public readonly List<string> TexEnvOrder = [];
        // Per-slot UV transform [sx, sy, ox, oy]; identity slots are omitted.
        public readonly Dictionary<string, double[]> TexST = [];
        public readonly Dictionary<string, double> Floats = [];
        public readonly List<string> FloatOrder = [];
        public readonly Dictionary<string, double[]> Colors = [];
        public readonly List<string> ColorOrder = [];

        public double? Float(string key) => Floats.TryGetValue(key, out double v) ? v : null;
        public double[]? Color(string key) => Colors.GetValueOrDefault(key);
        public string? Tex(string key) => TexEnvs.GetValueOrDefault(key);
    }

    private static readonly Regex kMatShaderRe = new(
        @"m_Shader:\s*\{fileID:\s*[-0-9]+,\s*guid:\s*([0-9a-fA-F]{32})", RegexOptions.Compiled);
    private static readonly Regex kKeywordsBlockRe = new(
        @"m_ValidKeywords:\s*([\s\S]*?)\n\s*m_InvalidKeywords:", RegexOptions.Compiled);
    private static readonly Regex kKeywordRe = new(@"-\s*([A-Za-z0-9_]+)", RegexOptions.Compiled);
    private static readonly Regex kRenderTypeRe = new(@"RenderType:\s*([A-Za-z0-9_]+)", RegexOptions.Compiled);
    private static readonly Regex kTexBlockRe = new(@"m_TexEnvs:\s*([\s\S]*?)\n\s*m_Ints:", RegexOptions.Compiled);
    private static readonly Regex kTexEnvRe = new(
        @"-\s*([A-Za-z0-9_]+):\s*\n\s*m_Texture:\s*\{fileID:\s*([0-9]+)(?:,\s*guid:\s*([0-9a-f]{32}))?", RegexOptions.Compiled);
    private static readonly Regex kTexStRe = new(
        @"-\s*([A-Za-z0-9_]+):\s*\n\s*m_Texture:\s*\{[^}]*\}\s*\n\s*m_Scale:\s*\{x:\s*([-0-9.eE]+),\s*y:\s*([-0-9.eE]+)\}\s*\n\s*m_Offset:\s*\{x:\s*([-0-9.eE]+),\s*y:\s*([-0-9.eE]+)\}", RegexOptions.Compiled);
    private static readonly Regex kFloatRe = new(
        @"-\s*(_[A-Za-z0-9_]+):\s*([-0-9.eE]+)\s*$", RegexOptions.Multiline | RegexOptions.Compiled);
    private static readonly Regex kColorRe = new(
        @"-\s*(_[A-Za-z0-9_]+):\s*\{r:\s*([-0-9.eE]+),\s*g:\s*([-0-9.eE]+),\s*b:\s*([-0-9.eE]+),\s*a:\s*([-0-9.eE]+)\}", RegexOptions.Compiled);

    public static UnityMatInfo? ParseUnityMat(string text)
    {
        if (!text.Contains("m_SavedProperties:")) return null;
        var info = new UnityMatInfo();
        Match sh = kMatShaderRe.Match(text);
        if (sh.Success) info.ShaderGuid = sh.Groups[1].Value.ToLowerInvariant();
        Match kw = kKeywordsBlockRe.Match(text);
        if (kw.Success)
            foreach (Match m in kKeywordRe.Matches(kw.Groups[1].Value))
                info.Keywords.Add(m.Groups[1].Value);
        Match rt = kRenderTypeRe.Match(text);
        if (rt.Success) info.RenderType = rt.Groups[1].Value;
        Match texBlock = kTexBlockRe.Match(text);
        if (texBlock.Success)
        {
            foreach (Match m in kTexEnvRe.Matches(texBlock.Groups[1].Value))
            {
                if (!m.Groups[3].Success) continue;
                string key = m.Groups[1].Value;
                if (!info.TexEnvs.ContainsKey(key)) info.TexEnvOrder.Add(key);
                info.TexEnvs[key] = m.Groups[3].Value;
            }
            // Per-slot UV transform (m_Scale/m_Offset), recorded whether or not the
            // slot binds a texture: URP Lit's shared _BaseMap ST transforms EVERY
            // sample, so it matters even when _BaseMap itself is empty.
            foreach (Match m in kTexStRe.Matches(texBlock.Groups[1].Value))
            {
                double sx = Js.ParseFloat(m.Groups[2].Value);
                double sy = Js.ParseFloat(m.Groups[3].Value);
                double ox = Js.ParseFloat(m.Groups[4].Value);
                double oy = Js.ParseFloat(m.Groups[5].Value);
                if (sx != 1 || sy != 1 || ox != 0 || oy != 0)
                    info.TexST[m.Groups[1].Value] = [sx, sy, ox, oy];
            }
        }
        foreach (Match m in kFloatRe.Matches(text))
        {
            string key = m.Groups[1].Value;
            if (!info.Floats.ContainsKey(key)) info.FloatOrder.Add(key);
            info.Floats[key] = Js.ParseFloat(m.Groups[2].Value);
        }
        foreach (Match m in kColorRe.Matches(text))
        {
            string key = m.Groups[1].Value;
            if (!info.Colors.ContainsKey(key)) info.ColorOrder.Add(key);
            info.Colors[key] =
            [
                Js.ParseFloat(m.Groups[2].Value),
                Js.ParseFloat(m.Groups[3].Value),
                Js.ParseFloat(m.Groups[4].Value),
                Js.ParseFloat(m.Groups[5].Value),
            ];
        }
        return info;
    }

    // --------------------------------------------------- texture resolve ---
    public static string? FindTexc(string? explicitPath)
    {
        var candidates = new List<string>();
        if (explicitPath != null) candidates.Add(explicitPath);
        string? env = Environment.GetEnvironmentVariable("GE_TEXC");
        if (!string.IsNullOrEmpty(env)) candidates.Add(env);
        foreach (string preset in (string[])["vs2026-x64-local", "vs2026-x64-local-unity", "vs2022-x64-local"])
            foreach (string config in (string[])["DebugFast", "Release", "RelWithDebInfo", "Debug"])
                candidates.Add(Js.PathJoin(Directory.GetCurrentDirectory(), "build", preset, "bin", config, "Tools", "TextureCompiler.exe"));
        foreach (string c in candidates)
        {
            try
            {
                if (File.Exists(c)) return c;
            }
            catch
            {
                // keep probing
            }
        }
        return null;
    }

    public static bool EncodeKtx2(Ctx ctx, string sourceAbs, string dest, string kind)
    {
        string[] flags = kind == "normal" ? ["--normal-map"]
            : kind == "linear" ? ["--linear"]
            : ["--srgb"];
        try
        {
            var psi = new System.Diagnostics.ProcessStartInfo(ctx.Texc!)
            {
                RedirectStandardError = true,
                RedirectStandardOutput = true,
                UseShellExecute = false,
            };
            psi.ArgumentList.Add(sourceAbs);
            psi.ArgumentList.Add(dest);
            foreach (string f in flags) psi.ArgumentList.Add(f);
            using var proc = System.Diagnostics.Process.Start(psi)!;
            string stderr = proc.StandardError.ReadToEnd();
            proc.StandardOutput.ReadToEnd();
            proc.WaitForExit();
            if (proc.ExitCode != 0)
            {
                string err = stderr.Trim().Split('\n')[0];
                if (err.Length == 0) err = $"exit {proc.ExitCode}";
                G.Warn($"ktx2 encode failed for {sourceAbs}: {err}", ctx.Verbose);
                return false;
            }
            return true;
        }
        catch (Exception e)
        {
            G.Warn($"ktx2 encode failed for {sourceAbs}: {e.Message}", ctx.Verbose);
            return false;
        }
    }

    public static AssetRef? ResolveTexture(Ctx ctx, string? unityTexGuid, string? texKind)
    {
        if (string.IsNullOrEmpty(unityTexGuid)) return null;
        string kind = texKind ?? "color";
        string cacheKey = ctx.Texc != null ? $"{unityTexGuid}|{kind}" : unityTexGuid;
        if (G.TexRefCache.TryGetValue(cacheKey, out AssetRef? cached)) return cached;
        AssetRef? result = null;
        PkgEntry? e = ctx.PkgGet(unityTexGuid.ToLowerInvariant());
        if (e != null)
        {
            string stem = Js.PathBasename(e.AssetPath, Js.PathExtname(e.AssetPath)).ToLowerInvariant();
            List<AssetRef> candidates = ctx.AssetDbIndex?.TexByStem.GetValueOrDefault(stem) ?? [];
            if (candidates.Count == 0 && ctx.AssetDbIndex != null)
                candidates = ctx.AssetDbIndex.TexByNormStem.GetValueOrDefault(AssetDb.NormalizeStem(stem)) ?? [];

            AssetRef? best = null;
            if (candidates.Count > 0)
            {
                best = candidates.OrderBy(c => c.Path.Length).First();
                if (candidates.Count > 1)
                    G.Warn($"ambiguous texture stem '{stem}': {candidates.Count} entries; using {best.Path}", ctx.Verbose);
            }

            if (ctx.Texc != null && ctx.TexCopyDir != null)
            {
                string ProjectAbs(string p)
                {
                    if (Js.PathIsAbsolute(p)) return p;
                    string underAssets = Js.PathJoin(ctx.ProjectDir!, "assets", p);
                    return File.Exists(underAssets) || Directory.Exists(underAssets)
                        ? underAssets : Js.PathJoin(ctx.ProjectDir!, p);
                }
                string sourceAbs = best != null ? ProjectAbs(best.Path) : Js.PathJoin(e.Dir, "asset");
                string baseStem = Js.PathBasename(e.AssetPath, Js.PathExtname(e.AssetPath));
                string destName = (kind == "color" ? baseStem : $"{baseStem}_{kind}") + ".ktx2";
                string rel = kTexCopyRel + "/" + destName;
                string dest = Js.PathJoin(ctx.TexCopyDir, destName);
                bool ok = File.Exists(dest);
                if (!ok)
                {
                    try
                    {
                        ok = EncodeKtx2(ctx, sourceAbs, dest, kind);
                    }
                    catch (Exception err)
                    {
                        G.Warn($"ktx2 encode threw for {sourceAbs}: {err.Message}", ctx.Verbose);
                    }
                }
                if (ok)
                {
                    result = new AssetRef { Guid = DeterministicGuid(rel), Path = rel };
                    ctx.MatStats.TexEncoded++;
                    ConvertCli.RecordOutput(ctx, dest, "texture");
                    G.ProgressItem("textures", rel);
                    G.TexRefCache[cacheKey] = result;
                    return result;
                }
                // Encode failed — fall through to the PNG reference/copy path.
            }

            if (best != null)
            {
                result = new AssetRef { Guid = best.Guid, Path = Resolvers.RelativizeToProject(ctx, best.Path) };
                ctx.MatStats.TexResolved++;
            }
            else if (ctx.TexCopyDir != null)
            {
                string destName = Js.PathBasename(e.AssetPath);
                string rel = kTexCopyRel + "/" + destName;
                string dest = Js.PathJoin(ctx.TexCopyDir, destName);
                try
                {
                    if (!File.Exists(dest)) File.Copy(Js.PathJoin(e.Dir, "asset"), dest);
                    result = new AssetRef { Guid = DeterministicGuid(rel), Path = rel };
                    ctx.MatStats.TexCopied++;
                    ConvertCli.RecordOutput(ctx, dest, "texture");
                    G.ProgressItem("textures", rel);
                }
                catch (Exception err)
                {
                    G.Warn($"failed to copy texture {e.AssetPath}: {err.Message}", ctx.Verbose);
                    ctx.MatStats.TexUnresolved++;
                }
            }
            else
            {
                G.Warn($"unresolved texture: {e.AssetPath} (stem '{stem}')", ctx.Verbose);
                ctx.MatStats.TexUnresolved++;
            }
        }
        else
        {
            ctx.MatStats.TexUnresolved++;
        }
        G.TexRefCache[cacheKey] = result;
        return result;
    }

    public static AssetRef? PickTexture(Ctx ctx, UnityMatInfo info, string[] candidates, string texKind)
    {
        foreach (string key in candidates)
        {
            string? g = info.Tex(key);
            if (g == null) continue;
            AssetRef? r = ResolveTexture(ctx, g, texKind);
            if (r != null) return r;
        }
        return null;
    }

    public static double Round7(double v) => Js.MathRound(v * 1e7) / 1e7;

    // ------------------------------------------------------ classification --
    public sealed class ShaderDispatch
    {
        public required string Name;
        public required string Surface;
        public string? Note;
        public string? Reason;
        public bool HideMesh;
        public bool UrpLit;
    }

    public static readonly Dictionary<string, ShaderDispatch> kShaderDispatch = new()
    {
        // Stock URP Lit.shader (933532a4fcc9baf4fa0491de14d08ed7 in every URP
        // install). aoMap carries over but is sampled from .r where URP reads .g —
        // identical for grayscale AO maps, wrong for channel-packed ones.
        ["933532a4"] = new ShaderDispatch { Name = "URP_Lit", Surface = "standard_pbr", UrpLit = true,
                                            Note = "stock URP Lit; aoMap read .r vs URP .g (grayscale AO identical)" },
        ["0730dae3"] = new ShaderDispatch { Name = "Generic_Basic", Surface = "standard_pbr" },
        ["baa0a858"] = new ShaderDispatch { Name = "Generic_Decals", Surface = "standard_pbr" },
        ["3b44a38e"] = new ShaderDispatch { Name = "Generic_Standard", Surface = "standard_pbr", Note = "character hair/skin masks dropped" },
        ["d79125f9"] = new ShaderDispatch { Name = "Generic_Basic_Specular", Surface = "standard_pbr", Note = "Bronze/Gold — the only real metals" },
        ["19e269a3"] = new ShaderDispatch { Name = "PolygonShader", Surface = "triplanar_pbr", Note = "world-space 3-axis projection; snow/emission/overlay deferred" },
        ["0736e099"] = new ShaderDispatch { Name = "Generic_ParticlesUnlit", Surface = "standard_pbr", Note = "unlit deferred" },
        ["dfec08fb"] = new ShaderDispatch { Name = "Generic_ParticlesLit", Surface = "standard_pbr", Note = "unlit deferred" },
        ["00000000"] = new ShaderDispatch { Name = "Builtin_FX", Surface = "standard_pbr", Note = "unlit deferred" },
        ["88fd8f21"] = new ShaderDispatch { Name = "Waterfall", Surface = "water_stylized", Note = "FLOW: panned Color_Mask + Normals ripple + fresnel rim" },
        ["87c14512"] = new ShaderDispatch { Name = "Waterfall_Top_FX", Surface = "waterfall_fx", Note = "FALLS: panned churn ribbons through the emission lobe (premultiplied blend)" },
        ["de1d8687"] = new ShaderDispatch { Name = "SkyDome", Surface = "standard_pbr", Note = "engine owns sky — degraded" },
        ["e8644287"] = new ShaderDispatch { Name = "Moon", Surface = "standard_pbr", Note = "engine owns sky — hidden", HideMesh = true },
        ["3d532bc2"] = new ShaderDispatch { Name = "Skybox_Generic", Surface = "standard_pbr", Note = "engine owns sky — degraded" },
        ["6b091954"] = new ShaderDispatch { Name = "Aurora", Surface = "unmappable", Reason = "ShaderGraph FX — no OpenPBR analogue", HideMesh = true },
    };

    private static readonly Regex kAutoNamedProp = new(
        "_SampleTexture2D|_[0-9a-fA-F]{16,}", RegexOptions.Compiled);

    public static bool HasAutoNamedProps(UnityMatInfo info)
    {
        foreach (string k in info.TexEnvOrder)
            if (kAutoNamedProp.IsMatch(k)) return true;
        foreach (string k in info.ColorOrder)
            if (kAutoNamedProp.IsMatch(k)) return true;
        foreach (string k in info.FloatOrder)
            if (kAutoNamedProp.IsMatch(k)) return true;
        return false;
    }

    public static bool HasRecognizableSlot(UnityMatInfo info)
    {
        return info.Colors.ContainsKey("_BaseColor") || info.Colors.ContainsKey("_Color")
            || info.TexEnvs.ContainsKey("_Albedo_Map") || info.TexEnvs.ContainsKey("_Base_Map")
            || info.TexEnvs.ContainsKey("_BaseMap") || info.TexEnvs.ContainsKey("_MainTex")
            || info.Floats.ContainsKey("_Metallic") || info.Floats.ContainsKey("_Smoothness");
    }

    private static readonly Dictionary<string, double> kTriplanarToggleDefaults = new()
    {
        ["_Enable_Triplanar_Texture"] = 0,
        ["_Enable_Triplanar_Normals"] = 0,
    };

    public static bool TriplanarToggleOn(UnityMatInfo info, string name)
    {
        double? v = info.Float(name) ?? (kTriplanarToggleDefaults.TryGetValue(name, out double d) ? d : null);
        return v == 1;
    }

    public sealed class MatClass
    {
        public required string Family;
        public bool Mappable;
        public string? Surface;
        public string? Note;
        public string? Reason;
        public bool HideMesh;
        public bool UrpLit;
    }

    public static MatClass ClassifyMaterial(UnityMatInfo info, string? name)
    {
        string prefix = (info.ShaderGuid ?? "");
        prefix = prefix.Length > 8 ? prefix[..8] : prefix;
        ShaderDispatch? disp = kShaderDispatch.GetValueOrDefault(prefix);
        if (disp != null)
        {
            if (disp.Surface == "unmappable")
                return new MatClass { Family = disp.Name, Mappable = false, Reason = disp.Reason, HideMesh = disp.HideMesh };
            if (disp.Name == "Generic_Basic" && Regex.IsMatch(name ?? "", "^water", RegexOptions.IgnoreCase))
                return new MatClass
                {
                    Family = disp.Name, Mappable = true, Surface = "water_stylized",
                    Note = "Generic_Basic water body -> stylized water",
                };
            if (disp.Surface == "triplanar_pbr"
                && !TriplanarToggleOn(info, "_Enable_Triplanar_Texture")
                && !TriplanarToggleOn(info, "_Enable_Triplanar_Normals"))
                return new MatClass
                {
                    Family = disp.Name, Mappable = true, Surface = "standard_pbr",
                    Note = "triplanar disabled -> flat base-map map",
                };
            return new MatClass { Family = disp.Name, Mappable = true, Surface = disp.Surface, Note = disp.Note,
                                  HideMesh = disp.HideMesh, UrpLit = disp.UrpLit };
        }
        string guidLabel = info.ShaderGuid ?? "null";
        string label = "Unknown(" + (guidLabel.Length > 8 ? guidLabel[..8] : guidLabel) + ")";
        if (HasAutoNamedProps(info) && !HasRecognizableSlot(info))
            return new MatClass { Family = label, Mappable = false, Reason = "auto-named ShaderGraph properties" };
        return new MatClass { Family = label, Mappable = true, Surface = "standard_pbr", Note = "unknown shader — blind standard_pbr map" };
    }

    public static double[] LinearizeUnityTint(double[] rgba)
    {
        if (rgba[0] > 1 || rgba[1] > 1 || rgba[2] > 1) return rgba;
        return [Skybox.SrgbToLinear(rgba[0]), Skybox.SrgbToLinear(rgba[1]), Skybox.SrgbToLinear(rgba[2]), rgba[3]];
    }

    public sealed class BuiltDoc
    {
        public required JsonObj Doc;
        public bool NeedsFidelity;
    }

    // ---------------------------------------------------------- StandardPBR
    // `cls` is the dispatch classification: its UrpLit flag switches the
    // URP-Lit-exact branches (keyword-gated emission, shared _BaseMap ST
    // tiling, honest per-material drops for what the schema cannot express).
    public static BuiltDoc BuildMaterialDoc(Ctx ctx, UnityMatInfo info, string materialName, MatClass? cls = null)
    {
        UnityMatInfo f = info;
        HashSet<string> kw = info.Keywords;
        string rt = info.RenderType;
        bool urp = cls is { UrpLit: true };
        void DropUrp(string detail) => G.NoteDropped("material", $"URP/Lit {materialName}: {detail}", ctx.Verbose);
        var doc = new JsonObj();
        doc["schemaVersion"] = 3.0;
        doc["materialName"] = materialName;
        doc["lightingModel"] = "StandardPBR";
        doc["surfaceShader"] = "Surfaces/standard_pbr.glsl";
        doc["ignoreVertexColor"] = true;

        double[] baseCol = f.Color("_BaseColor") ?? f.Color("_Color") ?? [1, 1, 1, 1];
        bool hasUrpAuthoring = f.Float("_Surface") != null || f.Float("_AlphaClip") != null;
        bool transparent = kw.Contains("_SURFACE_TYPE_TRANSPARENT") || kw.Contains("_ALPHABLEND_ON")
            || kw.Contains("_ALPHAPREMULTIPLY_ON") || kw.Contains("_BUILTIN_SURFACE_TYPE_TRANSPARENT")
            || f.Float("_Surface") == 1 || rt == "Transparent"
            || (!hasUrpAuthoring && f.Float("_Mode") != null && f.Float("_Mode") >= 2 && !kw.Contains("_ALPHATEST_ON"));
        bool cutout = kw.Contains("_ALPHATEST_ON") || kw.Contains("_BUILTIN_ALPHATEST_ON")
            || rt == "TransparentCutout" || f.Float("_AlphaClip") == 1 || f.Float("_Mode") == 1;

        if (transparent) doc["alphaMode"] = "Blend";
        else if (cutout) doc["alphaMode"] = "Mask";
        else doc["alphaMode"] = "Opaque";

        // URP _Blend (0 alpha / 1 premultiply / 2 additive / 3 multiply). Additive is
        // exactly representable as T1 blend state (no shader coupling). Premultiply and
        // multiply are NOT: URP folds them into the fragment shader (_ALPHAPREMULTIPLY_ON
        // premultiplies the diffuse base, _ALPHAMODULATE_ON modulates colour by alpha),
        // which stock standard_pbr does not do — those render as straight alpha and are
        // reported, never silently re-derived.
        if (urp && (string)doc["alphaMode"]! == "Blend" && f.Float("_Blend") is double blendMode)
        {
            if (blendMode == 2)
            {
                var blend = new JsonObj();
                blend["srcColor"] = "SrcAlpha";
                blend["dstColor"] = "One";
                blend["srcAlpha"] = "One";
                blend["dstAlpha"] = "One";
                doc["blend"] = blend;
            }
            else if (blendMode == 1)
                DropUrp("_Blend premultiply approximated as straight alpha (standard_pbr does not premultiply the base)");
            else if (blendMode == 3)
                DropUrp("_Blend multiply approximated as straight alpha (no alpha-modulate path)");
        }

        if (f.Float("_Cull") == 0) doc["doubleSided"] = true;
        if (urp && f.Float("_Cull") == 1) DropUrp("_Cull 1 (front-face culling) has no engine mapping");

        var props = new JsonObj();
        double[] tint = LinearizeUnityTint(baseCol);
        props["baseColor"] = new JsonArr([Round7(tint[0]), Round7(tint[1]), Round7(tint[2]), Round7(tint[3])]);
        if (f.Float("_Metallic") is double metallic)
            props["metallic"] = Math.Max(0, Math.Min(1, metallic));
        // URP specular workflow (_WorkflowMode 0) drives F0 from _SpecColor/_SpecGlossMap
        // and hides the metallic slider (its serialized value is stale). No specular-color
        // lobe mapping exists — treat as dielectric and report.
        if (urp && f.Float("_WorkflowMode") == 0)
        {
            props["metallic"] = 0.0;
            DropUrp("specular workflow (_WorkflowMode 0) has no mapping — treated as dielectric (metallic 0)");
        }
        double? gloss = f.Float("_Smoothness") ?? f.Float("_Glossiness");
        if (gloss != null) props["roughness"] = Math.Max(0.04, Math.Min(1, 1 - gloss.Value));
        if (urp && f.Float("_SmoothnessTextureChannel") == 1)
            DropUrp("smoothness from albedo alpha (_SmoothnessTextureChannel 1) not representable; scalar _Smoothness used");
        if ((string)doc["alphaMode"]! == "Blend") props["opacity"] = Round7(baseCol[3]);
        if ((string)doc["alphaMode"]! == "Mask")
        {
            double cutoff = f.Float("_Cutoff") ?? f.Float("_Alpha_Clip_Threshold") ?? 0.5;
            props["alphaCutoff"] = Math.Max(0, Math.Min(1, cutoff));
        }

        var textures = new JsonObj();
        bool hasTexture = false;
        void Bind(string slot, AssetRef? r)
        {
            if (r == null) return;
            var t = new JsonObj();
            t["guid"] = r.Guid;
            t["path"] = r.Path;
            textures[slot] = t;
            hasTexture = true;
        }
        Bind("albedoMap", PickTexture(ctx, info, ["_Albedo_Map", "_Base_Map", "_BaseMap", "_MainTex", "_Color_Mask"], "color"));
        AssetRef? normal = PickTexture(ctx, info, ["_Normal_Map", "_Normals", "_BumpMap", "_NormalMap"], "normal");
        Bind("normalMap", normal);
        // URP metallic/spec-gloss maps pack R=metallic (or specular RGB) with smoothness
        // in ALPHA; the engine's metallicRoughnessMap is glTF G=roughness/B=metallic, so
        // binding one would shade from garbage channels. Drop the map (reported) and let
        // the scalar _Metallic/_Smoothness carry the material. Non-URP families keep the
        // bind: the Synty census has zero metallic-gloss map users, and an unknown shader
        // naming a slot _MetallicRoughnessMap is already declaring glTF layout.
        Bind("metallicRoughnessMap", urp ? null
            : PickTexture(ctx, info, ["_MetallicGlossMap", "_SpecGlossMap", "_MetallicRoughnessMap"], "linear"));
        if (urp && (info.TexEnvs.ContainsKey("_MetallicGlossMap") || info.TexEnvs.ContainsKey("_SpecGlossMap")))
            DropUrp("metallic/spec-gloss map dropped (URP packs smoothness in alpha — no glTF G/B channel equivalent); scalar _Metallic/_Smoothness used");
        AssetRef? ao = PickTexture(ctx, info, ["_OcclusionMap", "_AO_Map"], "linear");
        Bind("aoMap", ao);
        if (urp)
        {
            if (normal != null && f.Float("_BumpScale") is double bumpScale && bumpScale != 1)
                DropUrp("_BumpScale != 1 dropped (no normal-strength lane; normal map applied at 1.0)");
            if (ao != null && f.Float("_OcclusionStrength") is double occlusionStrength && occlusionStrength != 1)
                DropUrp("_OcclusionStrength != 1 dropped (aoMap applied at full strength)");
            if (info.TexEnvs.ContainsKey("_DetailAlbedoMap") || info.TexEnvs.ContainsKey("_DetailNormalMap"))
                DropUrp("detail layer dropped (_DetailAlbedoMap/_DetailNormalMap)");
            if (info.TexEnvs.ContainsKey("_ParallaxMap"))
                DropUrp("_ParallaxMap dropped (no height/parallax support)");
        }

        double[]? emCol = f.Color("_Emission_Color") ?? f.Color("_EmissionColor");
        AssetRef? emMap = PickTexture(ctx, info, ["_Emission_Map", "_EmissionMap"], "color");
        double emMax = emCol != null ? Math.Max(emCol[0], Math.Max(emCol[1], emCol[2])) : 0;
        // Dispatched URP/Lit is stricter and exact: URP gates ALL emission (map or
        // colour-only) on the _EMISSION keyword, and any keyword-on non-black colour
        // emits — no HDR threshold heuristic.
        bool emissionEnabled = f.Float("_Enable_Emission") is double enableEm
            ? enableEm == 1
            : (urp || emMap != null ? kw.Contains("_EMISSION") : true);
        if (emMap != null && emMax < 0.004) emissionEnabled = false;
        bool hasEmission = false;
        if (emissionEnabled && (emMap != null || emMax > (urp ? 0.004 : 1.01)))
        {
            double lum = kEmissionPaperwhiteNits * Math.Max(1, emMax);
            if (emMap != null)
            {
                var t = new JsonObj();
                t["guid"] = emMap.Guid;
                t["path"] = emMap.Path;
                textures["emissiveMap"] = t;
                props["emissive"] = new JsonArr([0.0, 0.0, 0.0]);
                hasTexture = true;
            }
            else
            {
                double s = Math.Max(1, emMax);
                props["emissive"] = new JsonArr([Round7(emCol![0] / s), Round7(emCol[1] / s), Round7(emCol[2] / s)]);
            }
            props["emissionLuminance"] = Round7(lum);
            hasEmission = true;
        }

        // URP Lit transforms EVERY texture sample by the shared _BaseMap ST (_MainTex is
        // the pre-upgrade alias), so the one transform applies to all bound slots. The
        // engine's per-slot transforms operate on the FBX importer's flipped V axis
        // (TexCoords[1] = 1 - v): identity cancels via texture row order (see the water
        // scroll note), a general transform does not. Solving 1 - v' = sy*(1 - v) + oy
        // gives the engine V row {sy, 1 - sy - oy}; the map commutes with clamping
        // (1 - clamp01(x) = clamp01(1 - x)), so it is exact under wrap AND clamp.
        if (urp)
        {
            double[]? st = info.TexST.GetValueOrDefault("_BaseMap") ?? info.TexST.GetValueOrDefault("_MainTex");
            if (st != null)
            {
                foreach (string slotName in textures.Keys)
                {
                    var t = (JsonObj)textures[slotName]!;
                    t["tiling"] = new JsonArr([Round7(st[0]), Round7(st[1])]);
                    t["offset"] = new JsonArr([Round7(st[2]), Round7(1 - st[1] - st[3])]);
                }
            }
        }

        doc["properties"] = props;
        if (textures.Count > 0) doc["textures"] = textures;

        var baseColorArr = (JsonArr)props["baseColor"]!;
        bool baseColorNotWhite = baseColorArr.Take(3).Any(v => Math.Abs((double)v! - 1) > 0.01);
        bool needsFidelity = hasTexture || hasEmission || (string)doc["alphaMode"]! != "Opaque" || baseColorNotWhite;
        return new BuiltDoc { Doc = doc, NeedsFidelity = needsFidelity };
    }

    // ------------------------------------------------------------ triplanar
    public static BuiltDoc BuildTriplanarDoc(Ctx ctx, UnityMatInfo info, string materialName)
    {
        UnityMatInfo f = info;
        double Clamp01(double v) => Math.Max(0, Math.Min(1, v));
        var doc = new JsonObj();
        doc["schemaVersion"] = 3.0;
        doc["materialName"] = materialName;
        doc["lightingModel"] = "StandardPBR";
        doc["surfaceShader"] = "Surfaces/triplanar_pbr.glsl";
        doc["ignoreVertexColor"] = true;

        doc["alphaMode"] = "Opaque";
        if (f.Float("_Cull") == 0) doc["doubleSided"] = true;

        bool texturesOn = TriplanarToggleOn(info, "_Enable_Triplanar_Texture");
        bool normalsOn = TriplanarToggleOn(info, "_Enable_Triplanar_Normals");

        string? albTop = texturesOn ? info.Tex("_Triplanar_Texture_Top") : null;
        string? albSide = texturesOn ? info.Tex("_Triplanar_Texture_Side") : null;
        string? albBottom = texturesOn ? info.Tex("_Triplanar_Texture_Bottom") : null;
        string? nrmTop = normalsOn ? info.Tex("_Triplanar_Normal_Texture_Top") : null;
        string? nrmSide = normalsOn ? info.Tex("_Triplanar_Normal_Texture_Side") : null;
        string? nrmBottom = normalsOn ? info.Tex("_Triplanar_Normal_Texture_Bottom") : null;

        string? aTop = albTop ?? albSide ?? albBottom;
        string? aSide = albSide ?? albTop ?? albBottom;
        string? aBottom = albBottom ?? albSide ?? albTop;
        string? nTop = nrmTop ?? nrmSide ?? nrmBottom;
        string? nSide = nrmSide ?? nrmTop ?? nrmBottom;
        string? nBottom = nrmBottom ?? nrmSide ?? nrmTop;

        bool albedoLayered = !(aTop == aSide && aSide == aBottom);
        bool normalLayered = !(nTop == nSide && nSide == nBottom);

        var textures = new JsonObj();
        void Bind(string slot, string? unityGuid, string texKind)
        {
            AssetRef? r = unityGuid != null ? ResolveTexture(ctx, unityGuid, texKind) : null;
            if (r == null) return;
            var t = new JsonObj();
            t["guid"] = r.Guid;
            t["path"] = r.Path;
            textures[slot] = t;
        }
        Bind("triplanarAlbedoTop", aTop, "color");
        Bind("triplanarNormalTop", nTop, "normal");
        if (albedoLayered)
        {
            Bind("triplanarAlbedoSide", aSide, "color");
            Bind("triplanarAlbedoBottom", aBottom, "color");
        }
        if (normalLayered)
        {
            Bind("triplanarNormalSide", nSide, "normal");
            Bind("triplanarNormalBottom", nBottom, "normal");
        }

        if (!textures.Has("triplanarAlbedoTop"))
        {
            AssetRef? baseTex = PickTexture(ctx, info, ["_Albedo_Map", "_Base_Map", "_BaseMap", "_MainTex"], "color");
            if (baseTex != null)
            {
                var t = new JsonObj();
                t["guid"] = baseTex.Guid;
                t["path"] = baseTex.Path;
                textures["triplanarAlbedoTop"] = t;
            }
        }

        double tiling = f.Float("_Tiling") ?? f.Float("_TilingTop") ?? f.Float("_TilingBottom") ?? 1.0;
        var props = new JsonObj();
        props["triplanarTilingTop"] = Round7(f.Float("_TilingTop") ?? tiling);
        props["triplanarTilingSide"] = Round7(tiling);
        props["triplanarTilingBottom"] = Round7(f.Float("_TilingBottom") ?? tiling);
        props["triplanarBlendSharpness"] = Round7(f.Float("_Triplanar_Fade") is double fade ? Clamp01(fade) : 0.5);
        props["triplanarLayered"] = albedoLayered ? 1.0 : 0.0;
        props["triplanarNormalLayered"] = normalLayered ? 1.0 : 0.0;

        double metal = f.Float("_Metallic") ?? 0;
        props["triplanarMetallicTop"] = Round7(Clamp01(f.Float("_Top_Metallic") ?? metal));
        props["triplanarMetallicSide"] = Round7(Clamp01(f.Float("_Side_Metallic") ?? metal));
        props["triplanarMetallicBottom"] = Round7(Clamp01(f.Float("_Bottom_Metallic") ?? metal));

        double gloss = f.Float("_Smoothness") ?? 0.5;
        double RoughFrom(double? s) => Math.Max(0.04, Math.Min(1, 1 - (s ?? gloss)));
        props["triplanarRoughnessTop"] = Round7(RoughFrom(f.Float("_Top_Smoothness")));
        props["triplanarRoughnessSide"] = Round7(RoughFrom(f.Float("_Side_Smoothness")));
        props["triplanarRoughnessBottom"] = Round7(RoughFrom(f.Float("_Bottom_Smoothness")));

        double[]? tintCol = f.Color("_Color_Tint") ?? f.Color("_BaseColor") ?? f.Color("_Color");
        if (tintCol != null)
        {
            double[] tint = LinearizeUnityTint(tintCol);
            props["baseColor"] = new JsonArr([Round7(tint[0]), Round7(tint[1]), Round7(tint[2]), 1.0]);
        }

        doc["properties"] = props;
        if (textures.Count > 0) doc["textures"] = textures;
        return new BuiltDoc { Doc = doc, NeedsFidelity = true };
    }

    // ------------------------------------------------------- water (FLOW) --
    public const string kWaterShaderRel = "water_stylized.glsl";
    public const string kFallsShaderRel = "waterfall_fx.glsl";
    public const string kShippedHashesFile = "shipped-hashes.json";

    public static string HashShaderText(string text) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(text.Replace("\r\n", "\n"))));

    // Bundled shader payload (embedded from the JS package's shaders/ dir).
    private static byte[]? ReadBundledShaderBytes(string rel)
    {
        using Stream? s = typeof(Materials).Assembly.GetManifestResourceStream("shaders/" + rel);
        if (s == null) return null;
        using var ms = new MemoryStream();
        s.CopyTo(ms);
        return ms.ToArray();
    }

    private static JsonObj LoadShippedHashes()
    {
        if (G.ShippedHashesCache.TryGetValue("embedded", out JsonObj? cached)) return cached;
        var manifest = new JsonObj();
        try
        {
            byte[]? bytes = ReadBundledShaderBytes(kShippedHashesFile);
            if (bytes != null)
            {
                using var doc = System.Text.Json.JsonDocument.Parse(bytes);
                foreach (System.Text.Json.JsonProperty prop in doc.RootElement.EnumerateObject())
                {
                    if (prop.Value.ValueKind != System.Text.Json.JsonValueKind.Array) continue;
                    var arr = new JsonArr();
                    foreach (System.Text.Json.JsonElement el in prop.Value.EnumerateArray())
                        if (el.ValueKind == System.Text.Json.JsonValueKind.String) arr.Add(el.GetString());
                    manifest[prop.Name] = arr;
                }
            }
        }
        catch
        {
            // no manifest -> nothing auto-refreshes, user copies stay safe
        }
        G.ShippedHashesCache["embedded"] = manifest;
        return manifest;
    }

    public static string ClassifySurfaceShaderDest(string srcText, string? destText, JsonArr? shippedHashes)
    {
        if (destText == null) return "copy";
        string destHash = HashShaderText(destText);
        if (destHash == HashShaderText(srcText)) return "up-to-date";
        if (shippedHashes != null && shippedHashes.Any(h => (h as string) == destHash)) return "refresh";
        return "user-modified";
    }

    public static string? EnsureSurfaceShaderCopied(Ctx ctx, string rel)
    {
        if (ctx.MatOutDir == null) return null;
        ctx.CopiedSurfaceShaders ??= [];
        if (ctx.CopiedSurfaceShaders.Contains(rel)) return null;
        ctx.CopiedSurfaceShaders.Add(rel);
        string dest = Js.PathJoin(ctx.MatOutDir, rel);
        try
        {
            byte[]? srcBytes = ReadBundledShaderBytes(rel)
                ?? throw new FileNotFoundException($"bundled shader missing: {rel}");
            string srcText = Encoding.UTF8.GetString(srcBytes);
            string? destText = File.Exists(dest) ? Js.ReadFileUtf8(dest) : null;
            string action = ClassifySurfaceShaderDest(srcText, destText, LoadShippedHashes()[rel] as JsonArr);
            switch (action)
            {
                case "copy":
                    File.WriteAllBytes(dest, srcBytes);
                    ConvertCli.RecordOutput(ctx, dest, "shader");
                    return "copied";
                case "up-to-date":
                    return "up-to-date";
                case "refresh":
                    File.WriteAllBytes(dest, srcBytes);
                    ConvertCli.RecordOutput(ctx, dest, "shader");
                    G.LogErr($"surface shader refreshed: {dest} (pristine shipped version -> current)");
                    return "refreshed";
                case "user-modified":
                    G.Warn($"surface shader NOT refreshed ({dest}): existing copy differs from every shipped version — "
                        + "treating as user-edited and keeping it. Delete the file to get the current version.", ctx.Verbose);
                    return "skipped-user-modified";
            }
            return null;
        }
        catch (Exception err)
        {
            G.Warn($"surface shader not copied ({rel}): {err.Message} — the referencing .material will not resolve its surface", ctx.Verbose);
            return "error";
        }
    }

    public static BuiltDoc BuildWaterDoc(Ctx ctx, UnityMatInfo info, string materialName)
    {
        EnsureSurfaceShaderCopied(ctx, kWaterShaderRel);
        UnityMatInfo f = info;
        HashSet<string> kw = info.Keywords;
        var doc = new JsonObj();
        doc["schemaVersion"] = 3.0;
        doc["materialName"] = materialName;
        doc["lightingModel"] = "StandardPBR";
        doc["surfaceShader"] = kWaterShaderRel;
        doc["ignoreVertexColor"] = true;

        bool transparent = f.Float("_Surface") == 1 || kw.Contains("_SURFACE_TYPE_TRANSPARENT") || kw.Contains("_ALPHABLEND_ON");
        doc["alphaMode"] = transparent ? "Blend" : "Opaque";
        if (f.Float("_Cull") == 0) doc["doubleSided"] = true;

        double[] waterCol = f.Color("_Water_Color") ?? f.Color("_Color") ?? f.Color("_BaseColor") ?? [1, 1, 1, 1];
        double[] tint = LinearizeUnityTint(waterCol);
        double metallic = f.Float("_Metallic") is double met ? Math.Max(0, Math.Min(1, met)) : 0.1;
        double gloss = f.Float("_Smoothness") ?? f.Float("_Glossiness") ?? 0.7;
        double roughness = Math.Max(0.04, Math.Min(1, 1 - gloss));

        double sp = f.Float("_UVScroll_Speed") ?? f.Float("_Scoll_Speed") ?? 0.5;
        double overlayPower = f.Float("_Water_Overlay_Power") ?? 0.3;
        const double kFresnelExponent = 3.0;
        double fresnelRimCap = f.Float("_Fresnel_Power") ?? 0.012;
        double[] fresnelCol = LinearizeUnityTint(f.Color("_Fresnel_Color") ?? f.Color("_FresnelColour") ?? [1, 1, 1, 0]);
        double emissionStrength = Math.Max(0, f.Float("_Emission") ?? 1);

        var props = new JsonObj();
        props["baseColor"] = new JsonArr([Round7(tint[0]), Round7(tint[1]), Round7(tint[2]), Round7(waterCol[3])]);
        props["metallic"] = Round7(metallic);
        props["roughness"] = Round7(roughness);
        props["user0"] = 0.0;
        props["user1"] = Round7(-sp);
        props["user2"] = Round7(overlayPower);
        props["user3"] = kFresnelExponent;
        props["user4"] = Round7(fresnelCol[0]);
        props["user5"] = Round7(fresnelCol[1]);
        props["user6"] = Round7(fresnelCol[2]);
        props["user7"] = Round7(emissionStrength);
        props["user8"] = Round7(fresnelRimCap);
        doc["properties"] = props;

        var textures = new JsonObj();
        AssetRef? albedo = PickTexture(ctx, info, ["_Color_Mask", "_Albedo_Map", "_Base_Map", "_BaseMap", "_MainTex"], "color");
        if (albedo != null)
        {
            var t = new JsonObj();
            t["guid"] = albedo.Guid;
            t["path"] = albedo.Path;
            t["tiling"] = new JsonArr([2.0, 1.0]);
            textures["albedoMap"] = t;
        }
        AssetRef? normal = PickTexture(ctx, info, ["_Normals", "_Normal_Map", "_BumpMap", "_NormalMap"], "normal");
        if (normal != null)
        {
            var t = new JsonObj();
            t["guid"] = normal.Guid;
            t["path"] = normal.Path;
            textures["normalMap"] = t;
        }
        if (textures.Count > 0) doc["textures"] = textures;

        return new BuiltDoc { Doc = doc, NeedsFidelity = true };
    }

    // ------------------------------------------------------- falls (FX) ----
    public static BuiltDoc BuildFallsDoc(Ctx ctx, UnityMatInfo info, string materialName)
    {
        EnsureSurfaceShaderCopied(ctx, kFallsShaderRel);
        UnityMatInfo f = info;
        HashSet<string> kw = info.Keywords;
        var doc = new JsonObj();
        doc["schemaVersion"] = 3.0;
        doc["materialName"] = materialName;
        doc["lightingModel"] = "StandardPBR";
        doc["surfaceShader"] = kFallsShaderRel;
        doc["ignoreVertexColor"] = true;

        bool transparent = f.Float("_Surface") == 1 || kw.Contains("_SURFACE_TYPE_TRANSPARENT") || kw.Contains("_ALPHABLEND_ON");
        doc["alphaMode"] = transparent ? "Blend" : "Opaque";
        if (transparent)
        {
            var blend = new JsonObj();
            blend["srcColor"] = "One";
            blend["dstColor"] = "OneMinusSrcAlpha";
            blend["srcAlpha"] = "One";
            blend["dstAlpha"] = "OneMinusSrcAlpha";
            doc["blend"] = blend;
        }
        if (f.Float("_Cull") == 0) doc["doubleSided"] = true;

        const double kFallsPanDamping = 0.01;
        double[] speed = f.Color("_Speed") ?? [0, 0, 0, 0];
        double[] waterCol = LinearizeUnityTint(f.Color("_Water_Color") ?? [1, 1, 1, 1]);
        double brightness = Math.Max(0, f.Float("_Brightness") ?? 1);

        var props = new JsonObj();
        props["user0"] = Round7(kFallsPanDamping * speed[0]);
        props["user1"] = Round7(-kFallsPanDamping * speed[1]);
        props["user2"] = Round7(brightness);
        props["user4"] = Round7(waterCol[0]);
        props["user5"] = Round7(waterCol[1]);
        props["user6"] = Round7(waterCol[2]);
        doc["properties"] = props;

        var textures = new JsonObj();
        void Bind(string slot, string? guid)
        {
            AssetRef? r = ResolveTexture(ctx, guid, "color");
            if (r == null) return;
            var t = new JsonObj();
            t["guid"] = r.Guid;
            t["path"] = r.Path;
            textures[slot] = t;
        }
        Bind("albedoMap", info.Tex("_Texture_01"));
        Bind("churnDetail", info.Tex("_Texture_02"));
        Bind("fadeMask", info.Tex("_Texture_03"));
        if (textures.Count > 0) doc["textures"] = textures;

        return new BuiltDoc { Doc = doc, NeedsFidelity = true };
    }

    // ------------------------------------------------ birdbath water remap --
    public const string kGlass06MatGuid = "b253cb5ee0fc4a047be47d7b7a1c42dc";
    public const string kWaterBodyMatGuid = "6d24c2fc3a1139d4ab252fdaf2d031d2";

    public static string? RemapPropWaterSubmesh(SceneNode node, string? unityMatGuid)
    {
        if (unityMatGuid == kGlass06MatGuid && (node.Name ?? "").ToLowerInvariant() == "water")
            return kWaterBodyMatGuid;
        return unityMatGuid;
    }

    public static FamilyStat FamStat(Ctx ctx, string family)
    {
        if (!ctx.MatStats.ByFamily.TryGetValue(family, out FamilyStat? s))
        {
            s = new FamilyStat();
            ctx.MatStats.ByFamily[family] = s;
            ctx.MatStats.FamilyOrder.Add(family);
        }
        return s;
    }

    // Generate (once) the .material for a Unity material guid.
    public static AssetRef? ResolveMaterial(Ctx ctx, string unityMatGuid)
    {
        if (ctx.MatOutDir == null) return null;
        if (ctx.MaterialCache.TryGetValue(unityMatGuid, out AssetRef? cached)) return cached;
        AssetRef? result = null;
        PkgEntry? e = ctx.PkgGet(unityMatGuid);
        if (e != null && Js.PathExtname(e.AssetPath).ToLowerInvariant() == ".mat")
        {
            string? text = null;
            try
            {
                text = Js.ReadFileUtf8(Js.PathJoin(e.Dir, "asset"));
            }
            catch
            {
                // unreadable
            }
            UnityMatInfo? info = text != null ? ParseUnityMat(text) : null;
            if (info != null)
            {
                string name = Js.PathBasename(e.AssetPath, ".mat");
                MatClass cls = ClassifyMaterial(info, name);
                FamilyStat fam = FamStat(ctx, cls.Family);
                if (cls.Note != null) fam.Note = cls.Note;
                if (cls.HideMesh) ctx.MatHide.Add(unityMatGuid);
                if (!cls.Mappable)
                {
                    fam.Fallback++;
                    ctx.MatStats.FallbackUnmappable++;
                    ctx.MatStats.FallbackList.Add((name, info.ShaderGuid ?? "null", cls.Reason));
                }
                else
                {
                    BuiltDoc built = cls.Surface == "triplanar_pbr"
                        ? BuildTriplanarDoc(ctx, info, name)
                        : cls.Surface == "water_stylized"
                        ? BuildWaterDoc(ctx, info, name)
                        : cls.Surface == "waterfall_fx"
                        ? BuildFallsDoc(ctx, info, name)
                        : BuildMaterialDoc(ctx, info, name, cls);
                    if (built.NeedsFidelity)
                    {
                        string baseName = SanitizeFileName(name) + "__" + unityMatGuid[..8];
                        string rel = kMatOutRel + "/" + baseName + ".material";
                        string matAbs = Js.PathJoin(ctx.MatOutDir, baseName + ".material");
                        Js.WriteFileUtf8(matAbs, Json.Stringify(built.Doc, 2) + "\n");
                        ConvertCli.RecordOutput(ctx, matAbs, "material");
                        result = new AssetRef { Guid = DeterministicGuid(rel), Path = rel };
                        ctx.MatStats.Generated++;
                        fam.Generated++;
                    }
                    else
                    {
                        ctx.MatStats.SkippedPlain++;
                        fam.Plain++;
                    }
                }
            }
            else
            {
                ctx.MatStats.UnresolvedMat++;
            }
        }
        else
        {
            ctx.MatStats.UnresolvedMat++;
        }
        ctx.MaterialCache[unityMatGuid] = result;
        return result;
    }
}
