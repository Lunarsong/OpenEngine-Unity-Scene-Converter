using System.Text.RegularExpressions;

namespace GameEngine.UnityConverter;

/// Unity scene/prefab structure building — port of buildFileStructure,
/// expandPrefabInstance and applyModification, including the FBX sub-part
/// split and the stripped-doc alias resolution passes.
internal static class SceneStructure
{
    public static readonly HashSet<string> kWanted =
        ["1", "4", "23", "33", "137", "1001", "108", "20", "205", "198", "199", "64", "65", "114", "82", "104"];
    public static readonly Dictionary<string, string> kBuiltinMeshes = new()
    {
        ["10202"] = "Cube",
        ["10207"] = "Sphere",
        ["10208"] = "Capsule",
        ["10209"] = "Plane",
    };
    public static readonly HashSet<string> kBuiltinGuids =
        ["0000000000000000e000000000000000", "0000000000000000f000000000000000"];

    public static double AsNum(object? v, double dflt)
    {
        double f = Js.ParseFloat(v as string ?? (v is double d ? Js.NumberToString(d) : null));
        return double.IsFinite(f) ? f : dflt;
    }

    public static bool Truthy01(object? v) =>
        !(v is string s && (s == "0" || s == "") || v is double d && d == 0 || v == null);

    // JS `v || dflt` string coalescing (falsy: undefined/null/'').
    private static string OrDefaultString(object? v, string dflt) => v switch
    {
        null => dflt,
        string s => s.Length > 0 ? s : dflt,
        _ => Js.ToJsString(v),
    };

    // Plain JS truthiness for YAML values (falsy: null/undefined/'').
    private static bool Truthy01Loose(object? v) =>
        v != null && !(v is string s && s.Length == 0);

    public static void ReadTrs(SceneNode node, YamlMap t)
    {
        YamlMap p = t.Map("m_LocalPosition") ?? new YamlMap();
        YamlMap r = t.Map("m_LocalRotation") ?? new YamlMap();
        YamlMap s = t.Map("m_LocalScale") ?? new YamlMap();
        node.Pos = [AsNum(p["x"], 0), AsNum(p["y"], 0), AsNum(p["z"], 0)];
        node.Rot = [AsNum(r["x"], 0), AsNum(r["y"], 0), AsNum(r["z"], 0), AsNum(r["w"], 1)];
        node.Scale = [AsNum(s["x"], 1), AsNum(s["y"], 1), AsNum(s["z"], 1)];
    }

    // Parse Unity RenderSettings and classify the scene as day/night.
    public static RenderSettingsInfo ParseRenderSettings(YamlMap d)
    {
        double[]? Col(object? c) => c is YamlMap m
            ? [AsNum(m["r"], 0), AsNum(m["g"], 0), AsNum(m["b"], 0)] : null;
        double[]? sky = Col(d["m_AmbientSkyColor"]);
        double Lum(double[]? c) => c != null ? 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] : 1.0;
        bool fogEnabled = Truthy01(d["m_Fog"]);
        YamlMap? skyboxMat = d.Map("m_SkyboxMaterial");
        string? skyboxGuid = skyboxMat != null && Truthy01Loose(skyboxMat["guid"])
            ? Js.ToJsString(skyboxMat["guid"]).ToLowerInvariant() : null;
        return new RenderSettingsInfo
        {
            FogEnabled = fogEnabled,
            FogColor = Col(d["m_FogColor"]),
            FogMode = Js.ParseInt(OrDefaultString(d["m_FogMode"], "1"), 10),
            FogStart = AsNum(d["m_LinearFogStart"], 0),
            FogEnd = AsNum(d["m_LinearFogEnd"], 300),
            FogDensity = AsNum(d["m_FogDensity"], 0.01),
            AmbientMode = Js.ParseInt(OrDefaultString(d["m_AmbientMode"], "0"), 10),
            AmbientSky = sky,
            AmbientEquator = Col(d["m_AmbientEquatorColor"]),
            AmbientGround = Col(d["m_AmbientGroundColor"]),
            SkyboxGuid = skyboxGuid,
            IsNight = fogEnabled && Lum(sky) < 0.6,
        };
    }

    private static readonly Regex kSmStemRe = new("^sm_", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    // Build the node structure of a Unity YAML file (scene or prefab).
    public static FileStructure? BuildFileStructure(Ctx ctx, string unityGuid, List<string> stack)
    {
        unityGuid = unityGuid.ToLowerInvariant();
        if (ctx.StructureCache.TryGetValue(unityGuid, out FileStructure? cachedSt)) return cachedSt;
        if (stack.Contains(unityGuid))
        {
            G.Warn($"prefab cycle at {unityGuid}", ctx.Verbose);
            return null;
        }

        PkgEntry? pkgEntry = ctx.PkgGet(unityGuid);
        if (pkgEntry == null) return null;
        string assetPath = pkgEntry.AssetPath;
        string ext = Js.PathExtname(assetPath).ToLowerInvariant();

        if (ext == ".fbx")
        {
            string stem = Js.PathBasename(assetPath, Js.PathExtname(assetPath));
            SceneNode root = SceneNode.Make(stem);
            root.MeshFbxGuid = unityGuid;
            root.NonStaticFbx = !kSmStemRe.IsMatch(stem);
            var fbxSt = new FileStructure { IsFbx = true };
            fbxSt.Add(root);
            fbxSt.RootIds.Add(root.Id);
            if (!root.NonStaticFbx)
            {
                if (!G.FbxNodeCache.TryGetValue(unityGuid, out List<FbxScanner.MeshNode>? scan))
                {
                    scan = FbxScanner.ScanFbxMeshNodes(Js.PathJoin(pkgEntry.Dir, "asset"));
                    G.FbxNodeCache[unityGuid] = scan;
                }
                if (scan != null && scan.Count > 1)
                {
                    FbxScanner.MeshNode rootScan = scan.FirstOrDefault(n => n.Name == stem)
                        ?? scan.FirstOrDefault(n => n.Parent == null)
                        ?? scan[0];
                    foreach (FbxScanner.MeshNode sn in scan)
                    {
                        if (sn == rootScan || FbxScanner.kFbxAuxNodeRe.IsMatch(sn.Name)) continue;
                        SceneNode child = SceneNode.Make(sn.Name);
                        child.MeshFbxGuid = unityGuid;
                        child.NonStaticFbx = false;
                        child.Pos =
                        [
                            -(sn.Offset[0] - rootScan.Offset[0]),
                            sn.Offset[1] - rootScan.Offset[1],
                            sn.Offset[2] - rootScan.Offset[2],
                        ];
                        child.Father = root.Id;
                        child.Order = fbxSt.Count;
                        fbxSt.Add(child);
                        root.Children.Add(child.Id);
                        G.Stats.FbxSubPartNodes++;
                    }
                }
            }
            ctx.StructureCache[unityGuid] = fbxSt;
            return fbxSt;
        }
        if (ext != ".prefab" && ext != ".unity")
        {
            // JS caches nothing on this branch (early return before set).
            return null;
        }

        string text = Js.ReadFileUtf8(Js.PathJoin(pkgEntry.Dir, "asset"));
        List<UnityYamlDoc> docs = UnityYaml.Parse(text, kWanted);

        if (ext == ".unity" && ctx.RenderSettings == null)
        {
            UnityYamlDoc? rs = docs.FirstOrDefault(d => d.ClassId == "104" && d.Data != null);
            if (rs != null) ctx.RenderSettings = ParseRenderSettings(rs.Data!);
        }

        if (ext == ".unity" && ctx.VolumeOverrides == null)
        {
            (double Prio, string Prof)? best = null;
            foreach (UnityYamlDoc d in docs)
            {
                if (d.ClassId != "114" || d.Data == null) continue;
                YamlMap? scr = d.Data.Map("m_Script");
                if (scr == null || Js.ToJsString(scr["guid"]).ToLowerInvariant() != VolumeProfiles.kUrpVolumeScriptGuid) continue;
                if (!Truthy01(d.Data["m_Enabled"]) || !Truthy01(d.Data["m_IsGlobal"])) continue;
                double prio = AsNum(d.Data["priority"], 0);
                YamlMap? sharedProfile = d.Data.Map("sharedProfile");
                string? prof = sharedProfile?.Str("guid") is string pg && pg.Length > 0
                    ? Js.ToJsString(sharedProfile["guid"]).ToLowerInvariant() : null;
                if (prof == null) continue;
                if (best == null || prio >= best.Value.Prio) best = (prio, prof);
            }
            if (best != null)
            {
                PkgEntry? entry = ctx.PkgGet(best.Value.Prof);
                if (entry != null)
                {
                    ctx.VolumeOverrides = VolumeProfiles.ParseVolumeProfile(
                        Js.ReadFileUtf8(Js.PathJoin(entry.Dir, "asset")));
                    if (ctx.Verbose)
                    {
                        G.LogInfo($"volume profile: {Js.PathBasename(entry.AssetPath)} -> "
                            + string.Join(", ", ctx.VolumeOverrides.Keys));
                    }
                }
            }
        }

        var st = new FileStructure { IsFbx = false };
        var goToNode = new Dictionary<string, string>();
        int order = 0;

        // Pass 1: real transforms -> nodes.
        foreach (UnityYamlDoc d in docs)
        {
            if (d.ClassId != "4" || d.Stripped || d.Data == null) continue;
            SceneNode node = SceneNode.Make("");
            node.Order = order++;
            ReadTrs(node, d.Data);
            string? fatherAnchor = d.Data.Map("m_Father")?.Str("fileID");
            node.FatherAnchor = string.IsNullOrEmpty(fatherAnchor) ? "0" : fatherAnchor;
            st.Add(node);
            st.AnchorToNode[d.Anchor] = node.Id;
            string? go = d.Data.Map("m_GameObject")?.Str("fileID");
            if (!string.IsNullOrEmpty(go) && go != "0")
            {
                st.AnchorToNode[go] = node.Id;
                goToNode[go] = node.Id;
            }
        }

        // Pass 2: real GameObjects -> name/active.
        foreach (UnityYamlDoc d in docs)
        {
            if (d.ClassId != "1" || d.Stripped || d.Data == null) continue;
            string? nid = goToNode.GetValueOrDefault(d.Anchor);
            if (nid == null) continue;
            SceneNode node = st.Get(nid);
            node.Name = d.Data.Has("m_Name") && d.Data["m_Name"] != null ? Js.ToJsString(d.Data["m_Name"]) : "";
            node.Active = Truthy01(d.Data["m_IsActive"]);
        }

        // Pass 2.5: index stripped docs per instance.
        var strippedByInstance = new Dictionary<string, (List<string> T4, List<string> T1)>();
        foreach (UnityYamlDoc d in docs)
        {
            if (!d.Stripped || (d.ClassId != "4" && d.ClassId != "1") || d.Data == null) continue;
            string? inst = d.Data.Map("m_PrefabInstance")?.Str("fileID");
            string? corr = d.Data.Map("m_CorrespondingSourceObject")?.Str("fileID");
            if (string.IsNullOrEmpty(inst) || string.IsNullOrEmpty(corr)) continue;
            if (!strippedByInstance.TryGetValue(inst, out (List<string> T4, List<string> T1) refs))
            {
                refs = ([], []);
                strippedByInstance[inst] = refs;
            }
            (d.ClassId == "4" ? refs.T4 : refs.T1).Add(corr);
        }

        // Pass 3: nested prefab instances.
        foreach (UnityYamlDoc d in docs)
        {
            if (d.ClassId != "1001" || d.Data == null) continue;
            var newStack = new List<string>(stack) { unityGuid };
            (List<string> T4, List<string> T1)? refs =
                strippedByInstance.TryGetValue(d.Anchor, out (List<string> T4, List<string> T1) r) ? r : null;
            ExpandPrefabInstance(ctx, st, d, newStack, refs);
        }

        // Pass 4: stripped transform/GO docs alias into expanded instance clones.
        foreach (UnityYamlDoc d in docs)
        {
            if (!d.Stripped || (d.ClassId != "4" && d.ClassId != "1")) continue;
            if (d.Data == null) continue;
            string? instAnchor = d.Data.Map("m_PrefabInstance")?.Str("fileID");
            string? corr = d.Data.Map("m_CorrespondingSourceObject")?.Str("fileID");
            InstanceClone? inst = instAnchor != null ? st.InstanceClones?.GetValueOrDefault(instAnchor) : null;
            if (inst == null) continue;
            string? subNodeId = corr != null ? inst.Sub.AnchorToNode.GetValueOrDefault(corr) : null;
            string? cloneId = subNodeId != null ? inst.Map.GetValueOrDefault(subNodeId) : inst.RootCloneId;
            if (cloneId != null) st.AnchorToNode[d.Anchor] = cloneId;
        }

        // Pass 5: real mesh filters / renderers.
        foreach (UnityYamlDoc d in docs)
        {
            if (d.Data == null || d.Stripped) continue;
            string? go = d.Data.Map("m_GameObject")?.Str("fileID");
            string? nid = go != null && go.Length > 0 ? st.AnchorToNode.GetValueOrDefault(go) : null;
            if (d.ClassId == "33")
            {
                if (nid == null) continue;
                SceneNode? node = st.TryGet(nid);
                if (node == null) continue;
                YamlMap mesh = d.Data.Map("m_Mesh") ?? new YamlMap();
                string? meshGuid = mesh.Str("guid");
                string? meshFileId = mesh.Str("fileID");
                if (!string.IsNullOrEmpty(meshGuid) && !kBuiltinGuids.Contains(Js.ToJsString(meshGuid).ToLowerInvariant()))
                {
                    node.MeshFbxGuid = Js.ToJsString(meshGuid).ToLowerInvariant();
                }
                else if (meshFileId != null && kBuiltinMeshes.TryGetValue(meshFileId, out string? prim))
                {
                    node.MeshPrimitive = prim;
                }
                else if (!string.IsNullOrEmpty(meshFileId) && meshFileId != "0")
                {
                    G.Stats.SkippedBuiltinUnsupported++;
                }
                st.AnchorToNode[d.Anchor] = nid;
            }
            else if (d.ClassId == "23")
            {
                if (nid == null) continue;
                SceneNode? node = st.TryGet(nid);
                if (node == null) continue;
                node.RendererEnabled = Truthy01(d.Data["m_Enabled"]);
                node.CastShadows = Truthy01(d.Data["m_CastShadows"]);
                node.ReceiveShadows = Truthy01(d.Data["m_ReceiveShadows"]);
                if (d.Data["m_Materials"] is YamlList mats && mats.Count > 0)
                {
                    node.MatGuids = [.. mats.Select(m =>
                        (m as YamlMap)?.Str("guid") is string g && g.Length > 0
                            ? (string?)Js.ToJsString(g).ToLowerInvariant() : null)];
                    if (node.MatGuids.Count > 1)
                        node.MatCount = node.MatGuids.Count;
                }
                st.AnchorToNode[d.Anchor] = nid;
            }
            else if (d.ClassId == "137")
            {
                if (nid != null)
                {
                    SceneNode? node = st.TryGet(nid);
                    if (node != null) node.Skinned = true;
                }
                G.Stats.SkippedSkinned++;
            }
            else if (d.ClassId == "108")
            {
                string uType = d.Data.Has("m_Type") && d.Data["m_Type"] != null ? Js.ToJsString(d.Data["m_Type"]) : "1";
                SceneNode? node = nid != null ? st.TryGet(nid) : null;
                if (node != null && (uType == "1" || uType == "2"))
                {
                    YamlMap col = d.Data.Map("m_Color") ?? new YamlMap();
                    object? shadowType = d.Data.Map("m_Shadows")?["m_Type"];
                    node.Light = new LightInfo
                    {
                        Type = uType == "1" ? "directional" : "point",
                        Color = [AsNum(col["r"], 1), AsNum(col["g"], 1), AsNum(col["b"], 1)],
                        Intensity = AsNum(d.Data["m_Intensity"], 1),
                        Range = AsNum(d.Data["m_Range"], 10),
                        Shadows = Truthy01(shadowType),
                        Enabled = Truthy01(d.Data["m_Enabled"]),
                    };
                    G.Stats.ConvertedLights++;
                }
                else
                {
                    G.Stats.SkippedLights++;
                }
            }
            else if (d.ClassId == "114")
            {
                object? tier = d.Data["m_AdditionalLightsShadowResolutionTier"];
                if (d.Data.Has("m_AdditionalLightsShadowResolutionTier") && nid != null)
                {
                    SceneNode? node = st.TryGet(nid);
                    if (node != null)
                    {
                        double v = AsNum(tier, double.NaN);
                        node.UrpShadowTier = double.IsNaN(v) ? null : v;
                    }
                }
            }
            else if (d.ClassId == "20")
            {
                G.Stats.SkippedCameras++;
            }
            else if (d.ClassId == "198" || d.ClassId == "199")
            {
                G.Stats.SkippedParticles++;
            }
            else if (d.ClassId == "205")
            {
                G.Stats.LodGroups++;
            }
        }

        // Pass 6: resolve father links.
        foreach (SceneNode node in st.Nodes())
        {
            if (node.Father != null) continue;
            string fa = node.FatherAnchor;
            if (string.IsNullOrEmpty(fa) || fa == "0")
            {
                node.Father = "ROOT";
                continue;
            }
            string? pid = st.AnchorToNode.GetValueOrDefault(fa);
            if (pid != null && pid != node.Id)
            {
                node.Father = pid;
            }
            else
            {
                node.Father = "ROOT";
                G.Stats.UnresolvedFatherLinks++;
            }
        }
        foreach (SceneNode node in st.Nodes())
        {
            if (node.Father == "ROOT")
            {
                node.Father = null;
                st.RootIds.Add(node.Id);
            }
            else
            {
                st.Get(node.Father!).Children.Add(node.Id);
            }
        }
        var sortedRoots = st.RootIds.OrderBy(id => st.Get(id).Order).ToList();
        st.RootIds.Clear();
        st.RootIds.AddRange(sortedRoots);
        foreach (SceneNode node in st.Nodes())
        {
            var sorted = node.Children.OrderBy(id => st.Get(id).Order).ToList();
            node.Children.Clear();
            node.Children.AddRange(sorted);
        }

        ctx.StructureCache[unityGuid] = st;
        return st;
    }

    private static readonly HashSet<string> kTrsProps =
    [
        "m_LocalPosition.x", "m_LocalPosition.y", "m_LocalPosition.z",
        "m_LocalRotation.x", "m_LocalRotation.y", "m_LocalRotation.z", "m_LocalRotation.w",
        "m_LocalScale.x", "m_LocalScale.y", "m_LocalScale.z",
    ];

    private static readonly HashSet<string> kNameish =
    [
        "m_Name", "m_TagString", "m_Layer", "m_StaticEditorFlags", "m_RootOrder",
        "m_LocalEulerAnglesHint.x", "m_LocalEulerAnglesHint.y", "m_LocalEulerAnglesHint.z",
    ];

    private static readonly Regex kMatSizeRe = new(@"^m_Materials\.Array\.size$", RegexOptions.Compiled);
    private static readonly Regex kMatDataRe = new(@"^m_Materials\.Array\.data\[([0-9]+)\]$", RegexOptions.Compiled);
    private static readonly Regex kMatAnyRe = new(@"^m_Materials\.Array\.", RegexOptions.Compiled);

    private sealed class Modification
    {
        public bool TargetPresent;   // JS truthiness of m.target
        public string? Target;       // m.target.fileID
        public string? PropertyPath;
        public object? Value;
        public string? ObjectRefGuid;
    }

    // JS: `!m.target` — falsy when absent, null, or empty string.
    private static bool HasTarget(Modification m) => m.TargetPresent;

    private static bool TruthyPath(Modification m) =>
        m.PropertyPath is string p && p.Length > 0;

    // Expand one PrefabInstance doc into `st`.
    public static void ExpandPrefabInstance(Ctx ctx, FileStructure st, UnityYamlDoc doc, List<string> stack,
        (List<string> T4, List<string> T1)? strippedRefs)
    {
        YamlMap mod = doc.Data!.Map("m_Modification") ?? new YamlMap();
        string? srcGuidRaw = doc.Data.Map("m_SourcePrefab")?.Str("guid");
        string? srcGuid = srcGuidRaw != null ? Js.ToJsString(srcGuidRaw).ToLowerInvariant() : null;
        if (srcGuid == "") srcGuid = null;
        FileStructure? sub = srcGuid != null ? BuildFileStructure(ctx, srcGuid, stack) : null;
        if (sub == null)
        {
            G.Stats.UnresolvedPrefabSources++;
            return;
        }
        if (sub.RootIds.Count != 1)
            G.Warn($"prefab {srcGuid} has {sub.RootIds.Count} roots; using first", ctx.Verbose);

        G.Stats.PrefabInstancesExpanded++;

        var map = new Dictionary<string, string>();
        foreach (string sid in sub.NodeOrder)
        {
            SceneNode c = sub.Get(sid).Clone();
            c.Order = st.Count;
            map[sid] = c.Id;
            st.Add(c);
        }
        foreach (string sid in sub.NodeOrder)
        {
            SceneNode snode = sub.Get(sid);
            SceneNode c = st.Get(map[sid]);
            c.Father = snode.Father != null ? map.GetValueOrDefault(snode.Father) : null;
        }
        string rootCloneId = map[sub.RootIds[0]];
        SceneNode rootClone = st.Get(rootCloneId);
        rootClone.Father = null;
        string? tp = mod.Map("m_TransformParent")?.Str("fileID");
        rootClone.FatherAnchor = string.IsNullOrEmpty(tp) ? "0" : tp;
        foreach (string sid in sub.NodeOrder)
        {
            if (sid == sub.RootIds[0]) continue;
            SceneNode c = st.Get(map[sid]);
            c.Father ??= rootCloneId;
        }

        // Collect modifications (m_Modifications list).
        var mods = new List<Modification>();
        if (mod["m_Modifications"] is YamlList modList)
        {
            foreach (object? mRaw in modList)
            {
                if (mRaw is not YamlMap m) { mods.Add(new Modification()); continue; }
                object? target = m["target"];
                mods.Add(new Modification
                {
                    TargetPresent = target is YamlMap || target is YamlList
                        || (target is string ts && ts.Length > 0),
                    Target = (target as YamlMap)?.Str("fileID"),
                    PropertyPath = m.Str("propertyPath"),
                    Value = m["value"],
                    ObjectRefGuid = m.Map("objectReference")?.Str("guid"),
                });
            }
        }

        // Material overrides: recover m_Materials.Array mods per renderer target.
        var materialSeenTargets = new HashSet<string>();
        {
            var matByTarget = new Dictionary<string, (double Size, Dictionary<int, string?> Slots)>();
            var matTargetOrder = new List<string>();
            foreach (Modification m in mods)
            {
                if (!TruthyPath(m) || !HasTarget(m)) continue;
                string t = string.IsNullOrEmpty(m.Target) ? "0" : m.Target!;
                Match sz = kMatSizeRe.Match(m.PropertyPath!);
                Match dm = kMatDataRe.Match(m.PropertyPath!);
                if (!sz.Success && !dm.Success) continue;
                if (!matByTarget.TryGetValue(t, out (double Size, Dictionary<int, string?> Slots) rec))
                {
                    rec = (0, []);
                    matTargetOrder.Add(t);
                }
                if (sz.Success)
                {
                    rec.Size = Math.Max(rec.Size, AsNum(m.Value, 0));
                }
                else
                {
                    int idx = (int)Js.ParseInt(dm.Groups[1].Value, 10);
                    rec.Size = Math.Max(rec.Size, idx + 1);
                    string? g = m.ObjectRefGuid;
                    rec.Slots[idx] = !string.IsNullOrEmpty(g) ? Js.ToJsString(g).ToLowerInvariant() : null;
                }
                matByTarget[t] = rec;
            }
            if (matTargetOrder.Count > 0)
            {
                var meshClones = new List<SceneNode>();
                foreach (string cid in map.Values)
                {
                    SceneNode c = st.Get(cid);
                    if (c.MeshFbxGuid != null || c.MeshPrimitive != null) meshClones.Add(c);
                }
                SceneNode? soleMeshClone = meshClones.Count == 1 ? meshClones[0]
                    : (rootClone.MeshFbxGuid != null ? rootClone : null);
                bool singleTarget = matTargetOrder.Count == 1;
                foreach (string t in matTargetOrder)
                {
                    (double Size, Dictionary<int, string?> Slots) rec = matByTarget[t];
                    materialSeenTargets.Add(t);
                    string? sid = sub.AnchorToNode.GetValueOrDefault(t);
                    SceneNode? node = sid != null ? st.TryGet(map.GetValueOrDefault(sid)) : null;
                    if (node != null && node.MeshFbxGuid == null && node.MeshPrimitive == null) node = null;
                    if (node == null && singleTarget) node = soleMeshClone;
                    if (node == null)
                    {
                        G.Stats.DroppedMaterialOverrides += rec.Slots.Values.Count(v => v != null);
                        continue;
                    }
                    if (rec.Size > node.MatCount) node.MatCount = rec.Size;
                    foreach ((int idx, string? g) in rec.Slots)
                        if (g != null) node.SetMatGuid(idx, g);
                    G.Stats.MaterialOverridesBound += rec.Slots.Values.Count(v => v != null);
                }
            }
        }

        // Root discrimination via stripped-doc corr ids.
        string? rootTransformCorr = null, rootGoCorr = null;
        if (strippedRefs != null)
        {
            List<string> un4 = [.. strippedRefs.Value.T4.Where(c => !sub.AnchorToNode.ContainsKey(c))];
            List<string> un1 = [.. strippedRefs.Value.T1.Where(c => !sub.AnchorToNode.ContainsKey(c))];
            if (un4.Count == 1) rootTransformCorr = un4[0];
            if (un1.Count == 1) rootGoCorr = un1[0];
        }

        // Apply modifications grouped by target fileID.
        var groups = new Dictionary<string, List<Modification>>();
        var groupOrder = new List<string>();
        foreach (Modification m in mods)
        {
            if (!HasTarget(m)) continue;
            string t = string.IsNullOrEmpty(m.Target) ? "0" : m.Target!;
            if (!groups.TryGetValue(t, out List<Modification>? list))
            {
                list = [];
                groups[t] = list;
                groupOrder.Add(t);
            }
            list.Add(m);
        }
        bool rootTrsApplied = false, rootNameApplied = false;
        foreach (string target in groupOrder)
        {
            List<Modification> groupMods = groups[target];
            if (materialSeenTargets.Contains(target)
                && groupMods.All(m => m.PropertyPath != null && kMatAnyRe.IsMatch(m.PropertyPath)))
            {
                continue;
            }
            string? nid = sub.AnchorToNode.GetValueOrDefault(target);
            SceneNode? node = nid != null ? st.TryGet(map.GetValueOrDefault(nid)) : null;
            if (node == null)
            {
                bool hasTrs = groupMods.Any(m => m.PropertyPath != null && kTrsProps.Contains(m.PropertyPath));
                if (target == rootTransformCorr || target == rootGoCorr)
                {
                    node = rootClone;
                    if (hasTrs) rootTrsApplied = true;
                    if (groupMods.Any(m => m.PropertyPath == "m_Name")) rootNameApplied = true;
                }
                else if (hasTrs)
                {
                    if (rootTransformCorr != null)
                    {
                        G.Stats.DroppedDeepTrsOverrides++;
                        continue;
                    }
                    if (rootTrsApplied)
                    {
                        G.Stats.ModTargetConflicts++;
                        continue;
                    }
                    rootTrsApplied = true;
                    G.Stats.ModTargetFallbacks++;
                    node = rootClone;
                }
                else
                {
                    bool nameOnly = groupMods.All(m => m.PropertyPath != null && kNameish.Contains(m.PropertyPath));
                    bool hasName = groupMods.Any(m => m.PropertyPath == "m_Name");
                    if (hasName && nameOnly && !rootNameApplied)
                    {
                        rootNameApplied = true;
                        G.Stats.ModTargetFallbacks++;
                        node = rootClone;
                    }
                    else if (rootTransformCorr == null)
                    {
                        G.Stats.ModTargetFallbacks++;
                        node = rootClone;
                    }
                    else
                    {
                        G.Stats.DroppedDeepPropOverrides++;
                        if (groupMods.Any(m => m.PropertyPath == "m_IsActive" && !Truthy01(m.Value)))
                            G.Stats.DroppedDeepActiveDisables++;
                        continue;
                    }
                }
            }
            foreach (Modification m in groupMods)
                ApplyModification(node, m.PropertyPath, m.Value);
        }

        st.InstanceClones ??= [];
        st.InstanceClones[doc.Anchor] = new InstanceClone { Sub = sub, Map = map, RootCloneId = rootCloneId };
    }

    public static void ApplyModification(SceneNode node, string? prop, object? value)
    {
        switch (prop)
        {
            case "m_LocalPosition.x": node.Pos[0] = AsNum(value, node.Pos[0]); break;
            case "m_LocalPosition.y": node.Pos[1] = AsNum(value, node.Pos[1]); break;
            case "m_LocalPosition.z": node.Pos[2] = AsNum(value, node.Pos[2]); break;
            case "m_LocalRotation.x": node.Rot[0] = AsNum(value, node.Rot[0]); break;
            case "m_LocalRotation.y": node.Rot[1] = AsNum(value, node.Rot[1]); break;
            case "m_LocalRotation.z": node.Rot[2] = AsNum(value, node.Rot[2]); break;
            case "m_LocalRotation.w": node.Rot[3] = AsNum(value, node.Rot[3]); break;
            case "m_LocalScale.x": node.Scale[0] = AsNum(value, node.Scale[0]); break;
            case "m_LocalScale.y": node.Scale[1] = AsNum(value, node.Scale[1]); break;
            case "m_LocalScale.z": node.Scale[2] = AsNum(value, node.Scale[2]); break;
            case "m_Name":
                if (Truthy01Value(value)) node.Name = Js.ToJsString(value);
                break;
            case "m_IsActive": node.Active = Truthy01(value); break;
            case "m_Enabled": node.RendererEnabled = Truthy01(value); break;
            case "m_CastShadows": node.CastShadows = Truthy01(value); break;
            case "m_ReceiveShadows": node.ReceiveShadows = Truthy01(value); break;
            default: break;
        }
    }

    // JS `if (value)` truthiness for the rename case.
    private static bool Truthy01Value(object? value) =>
        value is string s ? s.Length > 0 : value != null;
}
