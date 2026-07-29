namespace GameEngine.UnityConverter;

/// Package index entry: <guid>/pathname content + the guid dir.
internal sealed class PkgEntry
{
    public required string AssetPath;
    public required string Dir;
}

/// Per-family material tally for the honest material report.
internal sealed class FamilyStat
{
    public int Generated;
    public int Plain;
    public int Fallback;
    public string Note = "";
}

internal sealed class MatStats
{
    public int Generated;
    public int SkippedPlain;
    public int UnresolvedMat;
    public int TexResolved;
    public int TexCopied;
    public int TexEncoded;
    public int TexUnresolved;
    public int FallbackUnmappable;
    public readonly List<(string Name, string Shader, string? Reason)> FallbackList = [];
    public readonly List<string> FamilyOrder = [];
    public readonly Dictionary<string, FamilyStat> ByFamily = [];
}

/// Parsed Unity RenderSettings — port of parseRenderSettings().
internal sealed class RenderSettingsInfo
{
    public bool FogEnabled;
    public double[]? FogColor;
    public double FogMode;
    public double FogStart;
    public double FogEnd;
    public double FogDensity;
    public double AmbientMode;
    public double[]? AmbientSky;
    public double[]? AmbientEquator;
    public double[]? AmbientGround;
    public string? SkyboxGuid;
    public bool IsNight;
}

/// The conversion context — port of the `ctx` object assembled in main().
internal sealed class Ctx
{
    public required Dictionary<string, PkgEntry> Pkg;
    public required List<string> PkgOrder;
    public required string PkgDir;
    public string? ProjectDir;
    public AssetDb? AssetDbIndex;
    public readonly Dictionary<string, FileStructure?> StructureCache = [];
    public readonly Dictionary<string, AssetRef?> MaterialCache = [];
    public readonly HashSet<string> MatHide = [];
    public RenderSettingsInfo? RenderSettings;
    public JsonObj? VolumeOverrides;
    public string? MatOutDir;
    public string? TexCopyDir;
    public string? ModelSeedDir;
    public string? Texc;
    public readonly MatStats MatStats = new();
    public VolumeProfiles.PipelineInfo? ProjectPipeline;
    public string LocalShadows = "faithful";
    public bool GradeLutFallback;
    public bool Verbose;
    public readonly List<(string Path, string Kind)> Outputs = [];
    public readonly HashSet<string> OutputSet = [];
    public HashSet<string>? CopiedSurfaceShaders;

    public PkgEntry? PkgGet(string guid) => Pkg.GetValueOrDefault(guid);
}
