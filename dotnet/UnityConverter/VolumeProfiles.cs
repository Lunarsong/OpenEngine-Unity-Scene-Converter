using System.Text.RegularExpressions;

namespace GameEngine.UnityConverter;

/// URP VolumeProfile parsing and layering + --unity-project pipeline state —
/// port of parseVolumeProfile / layerVolumeOverrides / loadUnityProjectPipeline.
/// Components are insertion-ordered maps: name -> fields
/// ("active" -> bool, field -> double | double[] | string).
internal static class VolumeProfiles
{
    public const string kUrpVolumeScriptGuid = "172515602e62fb746b5d573b38a5fe58";

    private static readonly Regex kSplitDocRe = new(@"^--- !u!", RegexOptions.Multiline | RegexOptions.Compiled);
    private static readonly Regex kNameRe = new(@"m_Name:\s*([A-Za-z][A-Za-z0-9_]*)\s*$", RegexOptions.Multiline | RegexOptions.Compiled);
    private static readonly Regex kInactiveRe = new(@"active:\s*0\s*$", RegexOptions.Multiline | RegexOptions.Compiled);
    private static readonly Regex kFieldRe = new(
        @"^\s{2}([A-Za-z0-9_]+):\s*\n\s*m_OverrideState:\s*([0-9])\s*\n\s*m_Value:\s*([^\n]+)",
        RegexOptions.Multiline | RegexOptions.Compiled);
    private static readonly Regex kRgbRe = new(
        @"\{r:\s*([-0-9.eE]+),\s*g:\s*([-0-9.eE]+),\s*b:\s*([-0-9.eE]+)(?:,\s*a:\s*([-0-9.eE]+))?", RegexOptions.Compiled);
    private static readonly Regex kXyzRe = new(
        @"\{x:\s*([-0-9.eE]+),\s*y:\s*([-0-9.eE]+),\s*z:\s*([-0-9.eE]+)(?:,\s*w:\s*([-0-9.eE]+))?", RegexOptions.Compiled);
    private static readonly Regex kNumRe = new(@"^[-0-9.eE]+$", RegexOptions.Compiled);

    public static JsonObj ParseVolumeProfile(string text)
    {
        var overrides = new JsonObj();
        string[] docs = kSplitDocRe.Split(text);
        for (int di = 1; di < docs.Length; di++)
        {
            string doc = docs[di];
            Match nameMatch = kNameRe.Match(doc);
            if (!nameMatch.Success) continue;
            string name = nameMatch.Groups[1].Value;
            if (name.Contains("Profile")) continue;
            var fields = new JsonObj();
            fields["active"] = !kInactiveRe.IsMatch(doc);
            foreach (Match m in kFieldRe.Matches(doc))
            {
                if (m.Groups[2].Value != "1") continue;
                string raw = m.Groups[3].Value.Trim();
                Match rgb = kRgbRe.Match(raw);
                Match xyz = kXyzRe.Match(raw);
                if (rgb.Success)
                {
                    fields[m.Groups[1].Value] = new double[]
                    {
                        Js.ParseFloat(rgb.Groups[1].Value),
                        Js.ParseFloat(rgb.Groups[2].Value),
                        Js.ParseFloat(rgb.Groups[3].Value),
                    };
                }
                else if (xyz.Success)
                {
                    fields[m.Groups[1].Value] = xyz.Groups[4].Success
                        ? new double[]
                        {
                            Js.ParseFloat(xyz.Groups[1].Value),
                            Js.ParseFloat(xyz.Groups[2].Value),
                            Js.ParseFloat(xyz.Groups[3].Value),
                            Js.ParseFloat(xyz.Groups[4].Value),
                        }
                        : [
                            Js.ParseFloat(xyz.Groups[1].Value),
                            Js.ParseFloat(xyz.Groups[2].Value),
                            Js.ParseFloat(xyz.Groups[3].Value),
                        ];
                }
                else if (kNumRe.IsMatch(raw))
                {
                    fields[m.Groups[1].Value] = Js.ParseFloat(raw);
                }
                else
                {
                    fields[m.Groups[1].Value] = raw; // texture refs etc.
                }
            }
            overrides[name] = fields;
        }
        return overrides;
    }

    // Flatten URP's volume-stack semantics: `over` applies on top of `base`.
    public static JsonObj LayerVolumeOverrides(JsonObj? baseOv, JsonObj? overOv)
    {
        var merged = new JsonObj();
        var names = new List<string>();
        var seen = new HashSet<string>();
        foreach (string n in (baseOv?.Keys ?? []).Concat(overOv?.Keys ?? []))
            if (seen.Add(n)) names.Add(n);
        foreach (string n in names)
        {
            var b = baseOv?[n] as JsonObj;
            var o = overOv?[n] as JsonObj;
            var fields = new JsonObj();
            bool bActive = b?["active"] is true;
            bool oActive = o?["active"] is true;
            if (b != null && bActive)
                foreach (string k in b.Keys) fields[k] = b[k];
            if (o != null && oActive)
                foreach (string k in o.Keys) fields[k] = o[k];
            fields["active"] = bActive || oActive;
            merged[n] = fields;
        }
        return merged;
    }

    // ---------------------------------------------------- --unity-project --
    public sealed class SsaoInfo
    {
        public bool Enabled;
        public double? Intensity;
        public double? Radius;
        public double? DirectLightingStrength;
    }

    public sealed class RpFacts
    {
        public required string AssetPath;
        public double? SupportsHdr;
        public double? Msaa;
        public double? RenderScale;
        public double? ShadowDistance;
        public double? CascadeCount;
        public double? MainShadowRes;
        public double? AdditionalShadowsSupported;
        public double? AdditionalShadowAtlas;
        public double? SoftShadows;
        public double? SoftShadowQuality;
    }

    public sealed class PipelineInfo
    {
        public required RpFacts Facts;
        public JsonObj? RpVolumeOverrides;
        public SsaoInfo? Ssao;
        public double? RenderingMode;
    }

    private static string NumOrNull(double? v) => v == null ? "null" : Js.NumberToString(v.Value);

    public static PipelineInfo? LoadUnityProjectPipeline(string projDir, bool verbose)
    {
        string? ReadIf(string f)
        {
            try
            {
                return Js.ReadFileUtf8(f);
            }
            catch
            {
                return null;
            }
        }
        string? qs = ReadIf(Js.PathJoin(projDir, "ProjectSettings", "QualitySettings.asset"));
        string? gs = ReadIf(Js.PathJoin(projDir, "ProjectSettings", "GraphicsSettings.asset"));
        Regex GuidRe(string g) => new(g + @":\s*\{fileID:\s*[0-9]+,\s*guid:\s*([0-9a-f]{32})");

        string? rpGuid = null;
        if (qs != null)
        {
            Match curMatch = Regex.Match(qs, @"m_CurrentQuality:\s*([0-9]+)");
            double cur = Js.ParseFloat(curMatch.Success ? curMatch.Groups[1].Value : "0");
            if (double.IsNaN(cur)) cur = 0;
            var perLevel = Regex.Matches(qs, @"customRenderPipeline:\s*\{fileID:\s*[0-9]+,\s*guid:\s*([0-9a-f]{32})");
            int curIdx = (int)cur;
            if (curIdx >= 0 && curIdx < perLevel.Count) rpGuid = perLevel[curIdx].Groups[1].Value;
        }
        if (rpGuid == null && gs != null)
        {
            Match m = GuidRe("m_CustomRenderPipeline").Match(gs);
            if (m.Success) rpGuid = m.Groups[1].Value;
        }
        if (rpGuid == null)
        {
            G.Warn($"--unity-project: no active render pipeline asset found under {projDir}", verbose);
            return null;
        }

        var guidToFile = new Dictionary<string, string>();
        void Walk(string dir)
        {
            string[] entries;
            try
            {
                entries = Directory.GetFileSystemEntries(dir);
            }
            catch
            {
                return;
            }
            foreach (string p in entries)
            {
                if (Directory.Exists(p))
                {
                    Walk(p);
                }
                else if (p.EndsWith(".asset.meta", StringComparison.Ordinal))
                {
                    Match m = Regex.Match(ReadIf(p) ?? "", @"^guid:\s*([0-9a-f]{32})", RegexOptions.Multiline);
                    if (m.Success) guidToFile[m.Groups[1].Value] = p[..^".meta".Length];
                }
            }
        }
        Walk(Js.PathJoin(projDir, "Assets"));

        string? rpFile = guidToFile.GetValueOrDefault(rpGuid);
        string? rpText = rpFile != null ? ReadIf(rpFile) : null;
        if (rpText == null)
        {
            G.Warn($"--unity-project: RP asset {rpGuid} not found under Assets/", verbose);
            return null;
        }

        double? Num(string re)
        {
            Match m = Regex.Match(rpText, re);
            return m.Success ? Js.ParseFloat(m.Groups[1].Value) : null;
        }
        var facts = new RpFacts
        {
            AssetPath = Js.PathRelative(projDir, rpFile!).Replace('\\', '/'),
            SupportsHdr = Num(@"m_SupportsHDR:\s*([0-9]+)"),
            Msaa = Num(@"m_MSAA:\s*([0-9]+)"),
            RenderScale = Num(@"m_RenderScale:\s*([0-9.]+)"),
            ShadowDistance = Num(@"m_ShadowDistance:\s*([0-9.]+)"),
            CascadeCount = Num(@"m_ShadowCascadeCount:\s*([0-9]+)"),
            MainShadowRes = Num(@"m_MainLightShadowmapResolution:\s*([0-9]+)"),
            AdditionalShadowsSupported = Num(@"m_AdditionalLightShadowsSupported:\s*([0-9]+)"),
            AdditionalShadowAtlas = Num(@"m_AdditionalLightsShadowmapResolution:\s*([0-9]+)"),
            SoftShadows = Num(@"m_SoftShadowsSupported:\s*([0-9]+)"),
            SoftShadowQuality = Num(@"m_SoftShadowQuality:\s*([0-9]+)"),
        };

        JsonObj? rpVolumeOverrides = null;
        Match volMatch = GuidRe("m_VolumeProfile").Match(rpText);
        string? volFile = volMatch.Success ? guidToFile.GetValueOrDefault(volMatch.Groups[1].Value) : null;
        if (volFile != null)
        {
            rpVolumeOverrides = ParseVolumeProfile(ReadIf(volFile) ?? "");
            if (verbose)
                G.LogErr($"pipeline volume profile: {Js.PathBasename(volFile)} -> "
                    + string.Join(", ", rpVolumeOverrides.Keys));
        }

        SsaoInfo? ssao = null;
        double? renderingMode = null;
        Match rdMatch = Regex.Match(rpText,
            @"m_RendererDataList:\s*\r?\n\s*-\s*\{fileID:\s*[0-9]+,\s*guid:\s*([0-9a-f]{32})");
        string? rdFile = rdMatch.Success ? guidToFile.GetValueOrDefault(rdMatch.Groups[1].Value) : null;
        if (rdFile != null)
        {
            string rd = ReadIf(rdFile) ?? "";
            Match rmMatch = Regex.Match(rd, @"m_RenderingMode:\s*([0-9]+)");
            renderingMode = Js.ParseFloat(rmMatch.Success ? rmMatch.Groups[1].Value : "0");
            if (double.IsNaN(renderingMode.Value)) renderingMode = 0;
            const string kSsaoScriptGuid = "f62c9c65cf3354c93be831c8bc075510";
            string? feat = Regex.Split(rd, @"^--- ", RegexOptions.Multiline)
                .FirstOrDefault(b => b.Contains(kSsaoScriptGuid));
            if (feat != null)
            {
                double? FNum(string re)
                {
                    Match m = Regex.Match(feat, re);
                    return m.Success ? Js.ParseFloat(m.Groups[1].Value) : null;
                }
                ssao = new SsaoInfo
                {
                    Enabled = FNum(@"m_Active:\s*([0-9]+)") == 1,
                    Intensity = FNum("\\n\\s*Intensity:\\s*([0-9.eE+-]+)"),
                    Radius = FNum("\\n\\s*Radius:\\s*([0-9.eE+-]+)"),
                    DirectLightingStrength = FNum("\\n\\s*DirectLightingStrength:\\s*([0-9.eE+-]+)"),
                };
            }
        }

        G.LogErr($"Pipeline: {facts.AssetPath} — shadows {NumOrNull(facts.ShadowDistance)}m/{NumOrNull(facts.CascadeCount)} cascades/"
            + $"{NumOrNull(facts.MainShadowRes)}px main, addl shadows {(Truthy(facts.AdditionalShadowsSupported) ? NumOrNull(facts.AdditionalShadowAtlas) + "px" : "off")}, "
            + $"soft {(Truthy(facts.SoftShadows) ? "on(q" + NumOrNull(facts.SoftShadowQuality) + ")" : "off")}, HDR {(Truthy(facts.SupportsHdr) ? "on" : "off")}, "
            + $"MSAA {NumOrNull(facts.Msaa)}x, scale {NumOrNull(facts.RenderScale)}"
            + (renderingMode != null ? $", renderingMode {Js.NumberToString(renderingMode.Value)}" : "")
            + (ssao != null
                ? $", SSAO {(ssao.Enabled ? $"i={NumOrNullU(ssao.Intensity)} r={NumOrNullU(ssao.Radius)}" : "off")}"
                : ""));

        return new PipelineInfo { Facts = facts, RpVolumeOverrides = rpVolumeOverrides, Ssao = ssao, RenderingMode = renderingMode };
    }

    private static bool Truthy(double? v) => v != null && v.Value != 0 && !double.IsNaN(v.Value);

    private static string NumOrNullU(double? v) => v == null ? "null" : Js.NumberToString(v.Value);
}
