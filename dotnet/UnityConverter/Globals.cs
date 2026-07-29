namespace GameEngine.UnityConverter;

/// Per-run counters mirroring convert.js's module-level `stats` object.
internal sealed class ConversionStats
{
    public int PrefabInstancesExpanded;
    public int DirectMeshFilters;
    public int SkippedSkinned;
    public int SkippedNonStaticFbx;
    public int SkippedInactive;
    public int ConvertedLights;
    public int SkippedLights;
    public int SkippedCameras;
    public int SkippedParticles;
    public int SkippedBuiltinUnsupported;
    public int LodGroups;
    public int FbxSubPartNodes;
    public int ModTargetFallbacks;
    public int ModTargetConflicts;
    public int MaterialOverridesBound;
    public int DroppedMaterialOverrides;
    public int DroppedDeepTrsOverrides;
    public int DroppedDeepPropOverrides;
    public int DroppedDeepActiveDisables;
    public int UnresolvedPrefabSources;
    public int UnresolvedFatherLinks;

    public void Reset()
    {
        PrefabInstancesExpanded = 0;
        DirectMeshFilters = 0;
        SkippedSkinned = 0;
        SkippedNonStaticFbx = 0;
        SkippedInactive = 0;
        ConvertedLights = 0;
        SkippedLights = 0;
        SkippedCameras = 0;
        SkippedParticles = 0;
        SkippedBuiltinUnsupported = 0;
        LodGroups = 0;
        FbxSubPartNodes = 0;
        ModTargetFallbacks = 0;
        ModTargetConflicts = 0;
        MaterialOverridesBound = 0;
        DroppedMaterialOverrides = 0;
        DroppedDeepTrsOverrides = 0;
        DroppedDeepPropOverrides = 0;
        DroppedDeepActiveDisables = 0;
        UnresolvedPrefabSources = 0;
        UnresolvedFatherLinks = 0;
    }
}

/// Module-level mutable state of the JS reference (caches that deliberately
/// survive across scenes in one run, the --json protocol counters, and the
/// stdout/stderr writers configured for byte-exact '\n' output).
internal static class G
{
    public static readonly ConversionStats Stats = new();
    public static readonly List<string> Warnings = [];
    public static readonly List<(string Kind, string Detail)> DroppedSettings = [];
    public static int NodeCounter;

    public static bool JsonMode;
    public static int JsonStep;
    public static int JsonTotal;
    public static readonly Dictionary<string, int> ItemCounters = [];

    // unityGuid -> mesh-node list (or null when unscannable).
    public static readonly Dictionary<string, List<FbxScanner.MeshNode>?> FbxNodeCache = [];
    public static readonly Dictionary<string, AssetRef?> MeshRefCache = [];
    public static readonly Dictionary<string, AssetRef?> TexRefCache = [];
    public static readonly Dictionary<string, JsonObj> ShippedHashesCache = [];

    public static TextWriter Out = Console.Out;
    public static TextWriter Err = Console.Error;

    // console.log / console.error (always '\n', never '\r\n').
    public static void Log(string s) => Out.Write(s + "\n");
    public static void LogErr(string s) => Err.Write(s + "\n");

    public static void Warn(string msg, bool verbose)
    {
        Warnings.Add(msg);
        if (verbose) LogErr("WARN: " + msg);
    }

    public static void NoteDropped(string kind, string detail, bool verbose)
    {
        DroppedSettings.Add((kind, detail));
        if (verbose) LogErr($"DROP: {kind}: {detail}");
    }

    // Info lines that must not corrupt the --json stdout stream.
    public static void LogInfo(string msg)
    {
        if (JsonMode) LogErr(msg);
        else Log(msg);
    }

    public static void ProgressStep(string phase, string detail)
    {
        if (!JsonMode) return;
        var o = new JsonObj();
        o["phase"] = phase;
        o["step"] = (double)(++JsonStep);
        o["total"] = (double)JsonTotal;
        o["detail"] = detail;
        Log(Json.Stringify(o));
    }

    public static void ProgressItem(string phase, string detail)
    {
        if (!JsonMode) return;
        int step = ItemCounters.GetValueOrDefault(phase) + 1;
        ItemCounters[phase] = step;
        var o = new JsonObj();
        o["phase"] = phase;
        o["step"] = (double)step;
        o["total"] = null;
        o["detail"] = detail;
        Log(Json.Stringify(o));
    }
}

/// { guid, path } asset reference (mesh/texture/material resolution result).
internal sealed class AssetRef
{
    public required string Guid;
    public required string Path;
    public bool Seeded;
}
