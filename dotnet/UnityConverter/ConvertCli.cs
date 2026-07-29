namespace GameEngine.UnityConverter;

/// CLI driver — port of convert.js parseArgs/main/convertOneScene/
/// printHumanReport/listScenesMain and the --json protocol.
internal static class ConvertCli
{
    private sealed class Args
    {
        public readonly List<string> Scenes = [];
        public readonly Dictionary<string, string?> Values = [];
        public bool Verbose;
        public bool NoCopyTextures;
        public bool Png;
        public bool GradeLut;
        public bool Json;

        public string? Get(string key) => Values.GetValueOrDefault(key);
    }

    private sealed class ExitException(int code) : Exception
    {
        public readonly int Code = code;
    }

    public static int Run(string[] argv)
    {
        try
        {
            MainCli(argv);
            return 0;
        }
        catch (ExitException e)
        {
            return e.Code;
        }
    }

    /// Editor-hosted entry (see EditorHost): Program.Main's stream discipline
    /// and top-level error contract, with host-supplied writers instead of
    /// process stdio. The editor always passes explicit --list-scenes/--pkg/
    /// --scene flags, so Program's positional/auto-pick sugar is deliberately
    /// not replicated here.
    public static int RunWithIO(string[] argv, TextWriter stdout, TextWriter stderr)
    {
        G.Out = stdout;
        G.Err = stderr;
        try
        {
            return Run(argv);
        }
        catch (Exception ex)
        {
            // Match Program.Main: uncaught error -> stderr, exit 1.
            stderr.Write(ex + "\n");
            return 1;
        }
        finally
        {
            stdout.Flush();
            stderr.Flush();
        }
    }

    private static void Fail(string msg)
    {
        G.LogErr("ERROR: " + msg);
        throw new ExitException(1);
    }

    private static Args ParseArgs(string[] argv)
    {
        var a = new Args();
        for (int i = 0; i < argv.Length; i++)
        {
            string k = argv[i];
            if (k == "--verbose") { a.Verbose = true; continue; }
            if (k == "--no-copy-textures") { a.NoCopyTextures = true; continue; }
            if (k == "--png") { a.Png = true; continue; }
            if (k == "--grade-lut") { a.GradeLut = true; continue; }
            if (k == "--json") { a.Json = true; continue; }
            if (!k.StartsWith("--", StringComparison.Ordinal)) Fail($"Unknown arg: {k}");
            if (k == "--scene")
            {
                a.Scenes.Add(i + 1 < argv.Length ? argv[++i] : null!);
                continue;
            }
            a.Values[k[2..]] = i + 1 < argv.Length ? argv[++i] : null;
        }
        return a;
    }

    public static void RecordOutput(Ctx ctx, string absPath, string kind)
    {
        string key = Js.PathResolve(absPath);
        if (ctx.OutputSet.Contains(key)) return;
        ctx.OutputSet.Add(key);
        ctx.Outputs.Add((key, kind));
    }

    // ------------------------------------------------- package index -------
    public static (Dictionary<string, PkgEntry> ByGuid, List<string> Order) BuildPackageIndex(string pkgDir)
    {
        var byGuid = new Dictionary<string, PkgEntry>();
        var order = new List<string>();
        foreach (string entryPath in Directory.EnumerateFileSystemEntries(pkgDir))
        {
            string entry = Js.PathBasename(entryPath);
            string dir = Js.PathJoin(pkgDir, entry);
            string pn = Js.PathJoin(dir, "pathname");
            if (!File.Exists(pn)) continue;
            string assetPath = Js.ReadFileUtf8(pn).Split('\n')[0].Trim();
            string guid = entry.ToLowerInvariant();
            if (!byGuid.ContainsKey(guid)) order.Add(guid);
            byGuid[guid] = new PkgEntry { AssetPath = assetPath, Dir = dir };
        }
        return (byGuid, order);
    }

    // ---------------------------------------------------- inventory mode ---
    private static readonly (string Cls, HashSet<string> Exts)[] kAssetClasses =
    [
        ("scene", [".unity"]),
        ("prefab", [".prefab"]),
        ("model", [".fbx", ".obj", ".gltf", ".glb", ".dae"]),
        ("texture", [".png", ".jpg", ".jpeg", ".tga", ".tif", ".tiff", ".psd", ".exr", ".hdr", ".dds", ".bmp"]),
        ("material", [".mat"]),
        ("shader", [".shader", ".shadergraph", ".hlsl", ".cginc", ".compute"]),
        ("audio", [".wav", ".mp3", ".ogg", ".aif", ".aiff"]),
        ("animation", [".anim", ".controller", ".playable"]),
    ];

    private static string ClassifyAssetPath(string assetPath)
    {
        string ext = Js.PathExtname(assetPath).ToLowerInvariant();
        if (ext.Length == 0) return "folder";
        foreach ((string cls, HashSet<string> exts) in kAssetClasses)
            if (exts.Contains(ext)) return cls;
        return "other";
    }

    private static void ListScenesMain(string bundle)
    {
        List<(string Guid, string AssetPath)> entries;
        string bundleKind;
        if (UnityPackage.IsUnityPackageFile(bundle))
        {
            bundleKind = "unitypackage";
            (List<string> order, Dictionary<string, UnityPackage.IndexEntry> byGuid) = UnityPackage.IndexUnityPackage(bundle);
            entries = [.. order.Select(g => (g, byGuid[g].AssetPath!))];
        }
        else if (Directory.Exists(bundle))
        {
            bundleKind = "extracted-dir";
            (Dictionary<string, PkgEntry> byGuid, List<string> order) = BuildPackageIndex(bundle);
            entries = [.. order.Select(g => (g, byGuid[g].AssetPath))];
        }
        else
        {
            Fail($"--list-scenes: '{bundle}' is neither an extracted package dir nor a .unitypackage file");
            return;
        }
        var scenes = new List<JsonObj>();
        var assetCounts = new JsonObj();
        foreach ((string guid, string assetPath) in entries)
        {
            string cls = ClassifyAssetPath(assetPath);
            assetCounts[cls] = (assetCounts[cls] is double d ? d : 0) + 1;
            if (cls == "scene")
            {
                var s = new JsonObj();
                s["name"] = Js.PathBasename(assetPath, Js.PathExtname(assetPath));
                s["path"] = assetPath;
                s["guid"] = guid;
                scenes.Add(s);
            }
        }
        // Node localeCompare — ICU collation, matched via CompareInfo.
        var collator = System.Globalization.CultureInfo.CurrentCulture.CompareInfo;
        scenes.Sort((a, b) => collator.Compare((string)a["path"]!, (string)b["path"]!));
        var inv = new JsonObj();
        inv["bundle"] = Js.PathResolve(bundle);
        inv["bundleKind"] = bundleKind;
        inv["scenes"] = new JsonArr(scenes);
        inv["assetCounts"] = assetCounts;
        inv["totalAssets"] = (double)entries.Count;
        G.Log(Json.Stringify(inv));
    }

    // ---------------------------------------------------------------- main -
    private static string ResolveSceneRef(Ctx ctx, string sceneRef)
    {
        string wanted = sceneRef.ToLowerInvariant().Replace('\\', '/');
        if (ctx.Pkg.ContainsKey(wanted)) return wanted;
        foreach (string g in ctx.PkgOrder)
        {
            string p = ctx.Pkg[g].AssetPath.ToLowerInvariant();
            if (p.EndsWith(".unity", StringComparison.Ordinal) && p.EndsWith(wanted, StringComparison.Ordinal)) return g;
        }
        Fail($"scene '{sceneRef}' not found in package");
        return ""; // unreachable
    }

    private static void ResetPerSceneState(Ctx ctx)
    {
        G.Stats.Reset();
        G.Warnings.Clear();
        G.DroppedSettings.Clear();
        G.NodeCounter = 0;
        ctx.StructureCache.Clear();
        ctx.RenderSettings = null;
        ctx.VolumeOverrides = null;
    }

    public static void MainCli(string[] argv)
    {
        G.LogErr($"transform-convention: {Emitter.TransformConventionVersion}");
        Args args = ParseArgs(argv);
        G.JsonMode = args.Json;
        G.JsonStep = 0;
        G.JsonTotal = 0;
        G.ItemCounters.Clear();
        if (args.Get("list-scenes") != null)
        {
            ListScenesMain(args.Get("list-scenes")!);
            return;
        }
        if (args.Get("pkg") == null || args.Scenes.Count == 0)
        {
            G.LogErr("Usage: node convert.js --pkg <extracted-pkg-dir|.unitypackage> --scene <scene path suffix|guid> [--scene <...>] --project <target-project-dir> [--assetdb <file>] [--unity-project <unity-project-dir>] [--out <output.scene>] [--local-shadows off|faithful] [--json] [--verbose]\n"
                + "       node convert.js --list-scenes <extracted-pkg-dir|.unitypackage>");
            throw new ExitException(2);
        }
        var sceneRefs = new List<string>();
        foreach (string s in args.Scenes)
            if (!sceneRefs.Contains(s)) sceneRefs.Add(s);
        if (args.Get("out") != null && sceneRefs.Count > 1)
            Fail("--out is single-scene only; multi-scene runs name outputs <project>/assets/<Scene>_unity.scene");
        string localShadows = args.Get("local-shadows") ?? "faithful";
        if (localShadows != "off" && localShadows != "faithful")
            Fail($"--local-shadows must be off|faithful (got '{localShadows}')");

        string pkgDir = args.Get("pkg")!;
        bool isRawPkg = UnityPackage.IsUnityPackageFile(pkgDir);
        G.JsonTotal = (isRawPkg ? 1 : 0) + 1 + (args.Get("unity-project") != null ? 1 : 0) + sceneRefs.Count * 3;
        if (isRawPkg)
        {
            string dest = Directory.CreateTempSubdirectory("unitypkg-").FullName;
            G.LogErr($"Package: extracting {pkgDir} -> {dest}");
            UnityPackage.ExtractUnityPackage(pkgDir, dest);
            G.ProgressStep("extract", pkgDir);
            pkgDir = dest;
        }

        (Dictionary<string, PkgEntry> byGuid, List<string> order) = BuildPackageIndex(pkgDir);
        var ctx = new Ctx
        {
            Pkg = byGuid,
            PkgOrder = order,
            PkgDir = pkgDir,
            ProjectDir = args.Get("project"),
            LocalShadows = localShadows,
            GradeLutFallback = args.GradeLut,
            Verbose = args.Verbose,
        };
        G.LogErr($"Package: {ctx.Pkg.Count} assets indexed");
        G.ProgressStep("index", $"{ctx.Pkg.Count} assets indexed");

        if (args.Get("unity-project") != null)
        {
            ctx.ProjectPipeline = VolumeProfiles.LoadUnityProjectPipeline(args.Get("unity-project")!, ctx.Verbose);
            G.ProgressStep("pipeline", args.Get("unity-project")!);
        }

        if (ctx.ProjectDir != null)
        {
            ctx.MatOutDir = Js.PathJoin(ctx.ProjectDir, "assets", Materials.kMatOutRel);
            Directory.CreateDirectory(ctx.MatOutDir);
            if (!args.NoCopyTextures)
            {
                ctx.TexCopyDir = Js.PathJoin(ctx.ProjectDir, "assets", Materials.kTexCopyRel);
                Directory.CreateDirectory(ctx.TexCopyDir);
            }
            ctx.ModelSeedDir = Js.PathJoin(ctx.ProjectDir, "assets", Materials.kModelSeedRel);
            if (!args.Png && ctx.TexCopyDir != null)
            {
                ctx.Texc = Materials.FindTexc(args.Get("texc"));
                if (ctx.Texc != null) G.LogErr($"KTX2 encoder: {ctx.Texc}");
                else G.LogErr("WARNING: TextureCompiler.exe not found (build with -DBUILD_TOOLS=ON, or pass --texc/--png); falling back to raw texture copies");
            }
        }

        string? dbFile = args.Get("assetdb");
        if (dbFile == null && args.Get("project") != null
            && File.Exists(Js.PathJoin(args.Get("project")!, "AssetDatabase.assetdb")))
            dbFile = Js.PathJoin(args.Get("project")!, "AssetDatabase.assetdb");
        if (dbFile != null)
        {
            ctx.AssetDbIndex = AssetDb.Load(dbFile);
            int models = ctx.AssetDbIndex.ByStem.Values.Sum(v => v.Count);
            G.LogErr($"AssetDb: {dbFile} ({ctx.AssetDbIndex.ByGuid.Count} assets, {models} model files)");
        }
        else
        {
            G.LogErr("AssetDb: NONE — mesh refs seed from the pack (Models_Unity/) where possible");
        }

        var sceneGuids = new List<string>();
        foreach (string s in sceneRefs)
        {
            string g = ResolveSceneRef(ctx, s);
            if (!sceneGuids.Contains(g)) sceneGuids.Add(g);
        }

        var sceneRecords = new List<JsonObj>();
        foreach (string guid in sceneGuids)
            sceneRecords.Add(ConvertOneScene(ctx, args, guid, sceneGuids.Count > 1));

        if (G.JsonMode)
        {
            MatStats m = ctx.MatStats;
            var summary = new JsonObj();
            summary["phase"] = "summary";
            summary["ok"] = true;
            summary["scenes"] = new JsonArr(sceneRecords);
            var materials = new JsonObj();
            materials["generated"] = (double)m.Generated;
            materials["skippedPlain"] = (double)m.SkippedPlain;
            materials["unresolvedMat"] = (double)m.UnresolvedMat;
            materials["texResolved"] = (double)m.TexResolved;
            materials["texEncoded"] = (double)m.TexEncoded;
            materials["texCopied"] = (double)m.TexCopied;
            materials["texUnresolved"] = (double)m.TexUnresolved;
            materials["unmappable"] = (double)m.FallbackUnmappable;
            summary["materials"] = materials;
            var models = new JsonObj();
            models["seeded"] = (double)ctx.Outputs.Count(o => o.Kind == "model");
            summary["models"] = models;
            var outputs = new JsonArr();
            foreach ((string path, string kind) in ctx.Outputs)
            {
                var o = new JsonObj();
                o["path"] = path;
                o["kind"] = kind;
                outputs.Add(o);
            }
            summary["outputs"] = outputs;
            G.Log(Json.Stringify(summary));
        }
    }

    private static JsonObj ConvertOneScene(Ctx ctx, Args args, string sceneGuid, bool multiScene)
    {
        ResetPerSceneState(ctx);
        string scenePath = ctx.Pkg[sceneGuid].AssetPath;
        G.LogErr($"Scene: {scenePath} ({sceneGuid})");

        long t0 = Environment.TickCount64;
        G.ProgressStep("expand", scenePath);
        FileStructure? st = SceneStructure.BuildFileStructure(ctx, sceneGuid, []);
        if (st == null) Fail($"failed to parse scene {scenePath}");
        G.LogErr($"Expanded {st!.Count} nodes in {Environment.TickCount64 - t0} ms");

        if (ctx.ProjectPipeline?.RpVolumeOverrides != null)
            ctx.VolumeOverrides = VolumeProfiles.LayerVolumeOverrides(
                ctx.ProjectPipeline.RpVolumeOverrides, ctx.VolumeOverrides ?? new JsonObj());

        string sceneName = Js.PathBasename(scenePath, ".unity");
        G.ProgressStep("emit", sceneName);
        Emitter.EmitResult result = Emitter.EmitScene(ctx, st, sceneName);

        string outFile = args.Get("out")
            ?? (args.Get("project") != null
                ? Js.PathJoin(args.Get("project")!, "assets", sceneName + "_unity.scene")
                : sceneName + "_unity.scene");
        Directory.CreateDirectory(Js.PathDirname(outFile));
        Js.WriteFileUtf8(outFile, result.Text);
        RecordOutput(ctx, outFile, "scene");
        G.ProgressStep("write", outFile);

        {
            string ext = Js.PathExtname(outFile);
            string backupFile = outFile[..^ext.Length] + ".backup" + ext;
            try
            {
                File.Delete(backupFile);
            }
            catch
            {
                // best-effort
            }
        }

        if (!G.JsonMode) PrintHumanReport(ctx, st, result.Emitted, outFile, multiScene ? sceneName : null);
        if (!ctx.Verbose && G.Warnings.Count > 0)
            G.LogErr($"({G.Warnings.Count} warnings; rerun with --verbose)");

        var droppedByKind = new Dictionary<string, SortedSet<string>>();
        var droppedKindOrder = new List<string>();
        foreach ((string kind, string detail) in G.DroppedSettings)
        {
            if (!droppedByKind.TryGetValue(kind, out SortedSet<string>? set))
            {
                set = new SortedSet<string>(StringComparer.Ordinal);
                droppedByKind[kind] = set;
                droppedKindOrder.Add(kind);
            }
            set.Add(detail);
        }
        var dropped = new JsonArr();
        foreach (string kind in droppedKindOrder)
        {
            foreach (string detail in droppedByKind[kind])
            {
                var d = new JsonObj();
                d["kind"] = kind;
                d["detail"] = detail;
                dropped.Add(d);
            }
        }
        EmittedCounts e = result.Emitted;
        var rec = new JsonObj();
        rec["scene"] = sceneName;
        rec["path"] = scenePath;
        rec["guid"] = sceneGuid;
        rec["output"] = Js.PathResolve(outFile);
        rec["entities"] = (double)e.Entities;
        rec["meshEntities"] = (double)e.MeshEntities;
        rec["groupEntities"] = (double)e.GroupEntities;
        rec["materialsBound"] = (double)e.MaterialsBound;
        rec["resolvedMeshes"] = (double)e.ResolvedMeshes;
        rec["unresolvedMeshes"] = (double)e.UnresolvedMeshes;
        rec["seededMeshes"] = (double)e.SeededMeshes;
        rec["lights"] = (double)e.Lights;
        rec["warnings"] = (double)G.Warnings.Count;
        rec["dropped"] = dropped;
        return rec;
    }

    private static void PrintHumanReport(Ctx ctx, FileStructure st, EmittedCounts emitted, string outFile, string? sceneNameTag)
    {
        ConversionStats s = G.Stats;
        G.Log(sceneNameTag != null ? $"--- conversion stats: {sceneNameTag} ---" : "--- conversion stats ---");
        G.Log($"output:                    {outFile}");
        G.Log($"nodes expanded:            {st.Count}");
        G.Log($"prefab instances expanded: {s.PrefabInstancesExpanded}");
        G.Log($"entities emitted:          {emitted.Entities} ({emitted.MeshEntities} mesh, {emitted.GroupEntities} group)");
        G.Log($"extra material-part ents:  {emitted.MaterialParts} (siblings for multi-material meshes)");
        G.Log($"material refs bound:       {emitted.MaterialsBound}");
        G.Log($"sky/FX meshes hidden:      {emitted.HiddenSkyFx} (hideMesh families: engine owns sky / unmappable FX)");
        G.Log($".material assets generated:{ctx.MatStats.Generated} (skipped plain: {ctx.MatStats.SkippedPlain}, unresolved .mat: {ctx.MatStats.UnresolvedMat})");
        G.Log($"material textures resolved:{ctx.MatStats.TexResolved} (ktx2-encoded: {ctx.MatStats.TexEncoded}, copied-in: {ctx.MatStats.TexCopied}, unresolved: {ctx.MatStats.TexUnresolved})");

        G.Log("--- material dispatch by Synty shader family (unique .mat) ---");
        var fams = ctx.MatStats.FamilyOrder
            .Select(f => (Family: f, Stat: ctx.MatStats.ByFamily[f]))
            .OrderByDescending(x => x.Stat.Generated + x.Stat.Plain + x.Stat.Fallback)
            .ToList();
        foreach ((string fam, FamilyStat c) in fams)
        {
            string note = c.Note.Length > 0 ? $"  ({c.Note})" : "";
            G.Log($"  {fam.PadRight(22)} generated {c.Generated.ToString(System.Globalization.CultureInfo.InvariantCulture).PadLeft(3)}  plain {c.Plain.ToString(System.Globalization.CultureInfo.InvariantCulture).PadLeft(3)}  fallback {c.Fallback.ToString(System.Globalization.CultureInfo.InvariantCulture).PadLeft(2)}{note}");
        }
        if (ctx.MatStats.FallbackList.Count > 0)
        {
            G.Log($"un-mappable shaders: {ctx.MatStats.FallbackUnmappable} (override skipped -> FBX default, NOT smeared)");
            foreach ((string name, string shader, string? reason) in ctx.MatStats.FallbackList)
                G.Log($"  {name}  [shader {shader}]  {reason}");
        }
        if (emitted.Skybox != null)
        {
            G.Log($"skybox: faithful Unity cubemap -> {emitted.Skybox.RelPath}"
                + (emitted.Skybox.Reused ? " (bake reused)" : ""));
        }
        G.Log($"mesh refs resolved:        {emitted.ResolvedMeshes}");
        G.Log($"mesh refs seeded from pack:{emitted.SeededMeshes} ({emitted.SeededFbxStems.Count} unique fbx extracted to {Materials.kModelSeedRel}/)");
        G.Log($"mesh refs UNRESOLVED:      {emitted.UnresolvedMeshes} ({emitted.UnresolvedFbxStems.Count} unique fbx)");
        G.Log($"unique static fbx used:    {emitted.UniqueFbx.Count}");
        G.Log($"skipped skinned meshes:    {s.SkippedSkinned}");
        G.Log($"skipped non-SM fbx nodes:  {s.SkippedNonStaticFbx}");
        G.Log($"skipped inactive meshes:   {s.SkippedInactive}");
        G.Log($"lights converted:          {emitted.Lights} (dir+point; spot/area skipped: {s.SkippedLights})");
        if (emitted.DirectionalsBeyondEngineCap > 0)
        {
            G.Log($"directionals beyond cap:   {emitted.DirectionalsBeyondEngineCap} (engine lights the strongest 4 — shadows from the primary only; the rest will not contribute)");
        }
        if (ctx.LocalShadows == "off")
        {
            G.Log($"addl-light shadows:        off — {emitted.SuppressedAdditionalLightShadows} source-flagged local shadows suppressed (--local-shadows=off)");
        }
        else
        {
            int[] lt = emitted.LocalShadowTiers;
            G.Log($"addl-light shadows:        faithful — {lt[1] + lt[2] + lt[3]} shadowed locals emitted (tier low/med/high: {lt[1]}/{lt[2]}/{lt[3]})");
        }
        G.Log($"skipped cameras:           {s.SkippedCameras}");
        G.Log($"skipped particle systems:  {s.SkippedParticles}");
        G.Log($"lod groups seen:           {s.LodGroups}");
        G.Log($"fbx sub-part nodes emitted:{s.FbxSubPartNodes} (multi-node prop children: glass/lids/drawers/arms)");
        G.Log($"mod-target root fallbacks: {s.ModTargetFallbacks}");
        G.Log($"mod-target conflicts:      {s.ModTargetConflicts}");
        G.Log($"material overrides bound:  {s.MaterialOverridesBound} (per-renderer variant recolours resolved to their sub-part)");
        G.Log($"dropped material overrides: {s.DroppedMaterialOverrides} (multi-renderer targets that could not resolve to a node — left at FBX default, not smeared)");
        G.Log($"dropped deep TRS overrides:  {s.DroppedDeepTrsOverrides}");
        G.Log($"dropped deep prop overrides: {s.DroppedDeepPropOverrides} ({s.DroppedDeepActiveDisables} were m_IsActive=0 -> possible ghost meshes)");
        G.Log($"unresolved prefab sources: {s.UnresolvedPrefabSources}");
        G.Log($"unresolved father links:   {s.UnresolvedFatherLinks}");
        if (emitted.UnresolvedFbxStems.Count > 0)
        {
            G.Log("unresolved fbx stems:");
            foreach (string stem in emitted.UnresolvedFbxStems.OrderBy(x => x, StringComparer.Ordinal))
                G.Log("  " + stem);
        }

        if (G.DroppedSettings.Count > 0)
        {
            G.Log("--- recognized settings dropped (no engine mapping) ---");
            var byKind = new Dictionary<string, SortedSet<string>>();
            var kindOrder = new List<string>();
            foreach ((string kind, string detail) in G.DroppedSettings)
            {
                if (!byKind.TryGetValue(kind, out SortedSet<string>? set))
                {
                    set = new SortedSet<string>(StringComparer.Ordinal);
                    byKind[kind] = set;
                    kindOrder.Add(kind);
                }
                set.Add(detail);
            }
            foreach (string kind in kindOrder)
                foreach (string detail in byKind[kind])
                    G.Log($"  [{kind}] {detail}");
        }
        else
        {
            G.Log("recognized settings dropped: none");
        }
    }
}
