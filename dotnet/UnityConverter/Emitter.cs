using System.Text.RegularExpressions;

namespace GameEngine.UnityConverter;

/// Scene emission — port of convert.js emitScene() and its module-level
/// transform-convention primitives (conj-v2), the ambient floor emitter and
/// the faithful-skybox resolve.
internal sealed class EmittedCounts
{
    public int Entities;
    public int MeshEntities;
    public int GroupEntities;
    public int Lights;
    public int SuppressedAdditionalLightShadows;
    public readonly int[] LocalShadowTiers = new int[4];
    public int ResolvedMeshes;
    public int UnresolvedMeshes;
    public int SeededMeshes;
    public int MaterialParts;
    public int MaterialsBound;
    public int HiddenSkyFx;
    public readonly HashSet<string> UniqueFbx = [];
    public readonly SortedSet<string> UnresolvedFbxStemsSorted = new(StringComparer.Ordinal);
    public readonly HashSet<string> UnresolvedFbxStems = [];
    public readonly HashSet<string> SeededFbxStems = [];
    public string? SunEntityId;
    public bool Environment;
    public int DirectionalsBeyondEngineCap;
    public SkyboxResolve? Skybox;
}

internal sealed class SkyboxResolve
{
    public required string RelPath;
    public required string Guid;
    public double RotationDegrees;
    public bool Reused;
    public Skybox.BakeStats? Stats;
}

internal static class Emitter
{
    public const string TransformConventionVersion = "conj-v2 (R(conj(q)) engine)";

    // ------------------------------------------------------- formatting ----
    public static string FmtF(double v)
    {
        if (double.IsInteger(v)) return Js.NumberToString(v); // Number.isInteger
        return Js.NumberToString(Js.MathRound(v * 1e7) / 1e7);
    }

    public static string Fmt3(double[] a) => $"({FmtF(a[0])}, {FmtF(a[1])}, {FmtF(a[2])})";
    public static string Fmt4(double[] a) => $"({FmtF(a[0])}, {FmtF(a[1])}, {FmtF(a[2])}, {FmtF(a[3])})";

    // ------------------------------------------- transform convention ------
    public static double[] Conj(double[] q) => [-q[0], -q[1], -q[2], q[3]];

    public static double[] QMul(double[] a, double[] b) =>
    [
        a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
        a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
        a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
        a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ];

    public static double[] QRotate(double[] q, double[] v)
    {
        double x = q[0], y = q[1], z = q[2], w = q[3];
        double uvx = y * v[2] - z * v[1], uvy = z * v[0] - x * v[2], uvz = x * v[1] - y * v[0];
        double uuvx = y * uvz - z * uvy, uuvy = z * uvx - x * uvz, uuvz = x * uvy - y * uvx;
        return [v[0] + 2 * (w * uvx + uuvx), v[1] + 2 * (w * uvy + uuvy), v[2] + 2 * (w * uvz + uuvz)];
    }

    public static readonly double[] kYFlip = [0, 1, 0, 0];

    public static double[] EmitObjectQuat(double[] qUnity) => Conj(qUnity);
    public static double[] EmitDirectionalQuat(double[] worldRot) => Conj(QMul(worldRot, kYFlip));

    public sealed class WorldTrs
    {
        public double[] Pos = [0, 0, 0];
        public double[] Rot = [0, 0, 0, 1];
        public double[] Scl = [1, 1, 1];
    }

    public static WorldTrs ComposeWorldTrs(IEnumerable<SceneNode> chain)
    {
        var result = new WorldTrs();
        foreach (SceneNode c in chain)
        {
            double[] scaled = [c.Pos[0] * result.Scl[0], c.Pos[1] * result.Scl[1], c.Pos[2] * result.Scl[2]];
            double[] rotated = QRotate(result.Rot, scaled);
            result.Pos = [result.Pos[0] + rotated[0], result.Pos[1] + rotated[1], result.Pos[2] + rotated[2]];
            result.Rot = QMul(result.Rot, c.Rot);
            result.Scl = [result.Scl[0] * c.Scale[0], result.Scl[1] * c.Scale[1], result.Scl[2] * c.Scale[2]];
        }
        return result;
    }

    private static readonly Regex kSanitizeQuotesRe = new(@"[""\\]", RegexOptions.Compiled);
    private static readonly Regex kSanitizeNewlinesRe = new(@"[\r\n]", RegexOptions.Compiled);
    private static readonly Regex kTexGuidRe = new(@"guid:\s*([0-9a-fA-F]{32})", RegexOptions.Compiled);
    private static readonly Regex kMeshNameSuffixRe = new(@" \([0-9]+\)$", RegexOptions.Compiled);

    public static string SanitizeName(string s) =>
        kSanitizeNewlinesRe.Replace(kSanitizeQuotesRe.Replace(s, "'"), " ");

    public static string MeshMatchName(string? s) =>
        SanitizeName(kMeshNameSuffixRe.Replace(s ?? "", "", 1));

    // --------------------------------------------------------- ambient -----
    public static double[] LinearizeAmbientColor(double[] c)
    {
        if (c[0] > 1 || c[1] > 1 || c[2] > 1) return c;
        return [Skybox.SrgbToLinear(c[0]), Skybox.SrgbToLinear(c[1]), Skybox.SrgbToLinear(c[2])];
    }

    public static List<string> EmitAmbientLightLines(RenderSettingsInfo? rs, bool verbose)
    {
        var lines = new List<string>();
        const int kAmbientFloorNits = 60;
        bool ambientEmitted = rs != null && (rs.AmbientMode == 1 || rs.AmbientMode == 3);
        if (ambientEmitted && !rs!.IsNight)
        {
            G.Warn("day-scene ambient emission is uncalibrated: AmbientLight.Intensity is set to the "
                + $"night {kAmbientFloorNits}-nit anchor, which is imperceptible under a day sky — "
                + "tune AmbientLight.Intensity in the converted scene by hand", verbose);
        }
        if (rs != null && rs.AmbientMode == 1 && rs.AmbientSky != null && rs.AmbientEquator != null && rs.AmbientGround != null)
        {
            lines.Add("AmbientLight.Mode = 1");
            lines.Add($"AmbientLight.SkyColor = {Fmt3(LinearizeAmbientColor(rs.AmbientSky))}");
            lines.Add($"AmbientLight.EquatorColor = {Fmt3(LinearizeAmbientColor(rs.AmbientEquator))}");
            lines.Add($"AmbientLight.GroundColor = {Fmt3(LinearizeAmbientColor(rs.AmbientGround))}");
            lines.Add($"AmbientLight.Intensity = {kAmbientFloorNits}");
        }
        else if (rs != null && rs.AmbientMode == 3 && rs.AmbientSky != null)
        {
            lines.Add("AmbientLight.Mode = 0");
            lines.Add($"AmbientLight.Color = {Fmt3(LinearizeAmbientColor(rs.AmbientSky))}");
            lines.Add($"AmbientLight.Intensity = {kAmbientFloorNits}");
        }
        return lines;
    }

    // ------------------------------------------------- faithful skybox -----
    public const int kSkyboxEquirectMaxWidth = 8192;

    private static readonly Regex kDdsExtRe = new(@"\.dds$", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    public static SkyboxResolve? ResolveSceneSkybox(Ctx ctx)
    {
        RenderSettingsInfo? rs = ctx.RenderSettings;
        if (rs?.SkyboxGuid == null) return null;
        PkgEntry? entry = ctx.PkgGet(rs.SkyboxGuid);
        if (entry == null)
        {
            G.Warn($"RenderSettings skybox material {rs.SkyboxGuid} not in package — procedural sky stays", ctx.Verbose);
            return null;
        }
        Skybox.SkyboxMat? mat = null;
        try
        {
            mat = Skybox.ParseUnitySkyboxMat(Js.ReadFileUtf8(Js.PathJoin(entry.Dir, "asset")));
        }
        catch (Exception e)
        {
            G.Warn($"skybox material {entry.AssetPath} unreadable: {e.Message}", ctx.Verbose);
            return null;
        }
        if (mat == null || !mat.IsBuiltinCubemap || mat.TexGuid == null)
        {
            G.Warn($"skybox material {entry.AssetPath} is not builtin Skybox/Cubemap with a bound _Tex "
                + $"(shader fileID {(mat != null ? Js.NumberToString(mat.ShaderFileId) : "?")}) — procedural sky stays", ctx.Verbose);
            return null;
        }
        PkgEntry? texEntry = ctx.PkgGet(mat.TexGuid);
        if (texEntry == null)
        {
            G.Warn($"skybox cubemap {mat.TexGuid} not in package — procedural sky stays", ctx.Verbose);
            return null;
        }
        if (!kDdsExtRe.IsMatch(texEntry.AssetPath))
        {
            G.Warn($"skybox cubemap {texEntry.AssetPath}: only DDS cubemaps are supported — procedural sky stays", ctx.Verbose);
            return null;
        }
        if (ctx.TexCopyDir == null)
        {
            G.Warn("skybox conversion needs the project texture dir (run with --project, without --no-copy-textures)", ctx.Verbose);
            return null;
        }
        if (mat.RotationDegrees != 0)
        {
            G.Warn($"skybox _Rotation={Js.NumberToString(mat.RotationDegrees)}: the Y-rotation sign parity between Unity's dome "
                + "rotation and Skybox.RotationDegrees is UNVERIFIED (no reference scene uses it) — verify visually", ctx.Verbose);
        }
        string stem = Js.PathBasename(texEntry.AssetPath, Js.PathExtname(texEntry.AssetPath));
        string outName = $"{stem}_equirect.hdr";
        string outAbs = Js.PathJoin(ctx.TexCopyDir, outName);
        string relPath = $"{Materials.kTexCopyRel}/{outName}";
        double[] mult = Skybox.ComputeSkyboxMultiplier(mat.Tint, mat.Exposure);
        string srcAbs = Js.PathJoin(texEntry.Dir, "asset");
        string metaAbs = outAbs + ".bake.json";
        var bakeParams = new JsonObj();
        bakeParams["maxWidth"] = (double)kSkyboxEquirectMaxWidth;
        bakeParams["multiplier"] = new JsonArr(mult.Select(x => (object?)x));
        bakeParams["srcMtimeMs"] = 0.0;
        try
        {
            bakeParams["srcMtimeMs"] = Js.StatMtimeMs(srcAbs);
        }
        catch
        {
            // stat at read below
        }
        bool reused = false;
        try
        {
            // JSON.stringify(JSON.parse(sidecar)) round-trips the exact bytes
            // the sidecar was written with, so the reuse check reduces to a
            // string compare against the current parameters' serialization.
            string prior = Js.ReadFileUtf8(metaAbs);
            reused = new FileInfo(outAbs).Length > 0 && prior == Json.Stringify(bakeParams);
        }
        catch
        {
            // no sidecar/output -> bake
        }
        Skybox.BakeStats? stats = null;
        if (!reused)
        {
            G.LogErr($"Skybox: baking {texEntry.AssetPath} -> {relPath} "
                + $"(mult {string.Join("/", mult.Select(FmtF))})...");
            long t0 = Environment.TickCount64;
            try
            {
                stats = Skybox.ConvertDdsCubemapToEquirectHdr(
                    File.ReadAllBytes(srcAbs), outAbs, kSkyboxEquirectMaxWidth, mult);
            }
            catch (Exception e)
            {
                G.Warn($"skybox cubemap conversion failed: {e.Message} — procedural sky stays", ctx.Verbose);
                return null;
            }
            Js.WriteFileUtf8(metaAbs, Json.Stringify(bakeParams));
            G.LogErr($"Skybox: baked {stats.FaceSize}px/face -> {stats.Width}x{stats.Height} "
                + $"in {((Environment.TickCount64 - t0) / 1000.0).ToString("F1", System.Globalization.CultureInfo.InvariantCulture)}s (mean L {ToExponential3(stats.MeanLuminance)}, "
                + $"peak L {stats.MaxLuminance.ToString("F4", System.Globalization.CultureInfo.InvariantCulture)} scene-linear)");
        }
        ConvertCli.RecordOutput(ctx, outAbs, "skybox");
        ConvertCli.RecordOutput(ctx, metaAbs, "skybox");
        return new SkyboxResolve
        {
            RelPath = relPath,
            Guid = Materials.DeterministicGuid(relPath),
            RotationDegrees = mat.RotationDegrees,
            Reused = reused,
            Stats = stats,
        };
    }

    // Number.prototype.toExponential(3): "d.ddde±x" (no zero-padded exponent).
    public static string ToExponential3(double v)
    {
        string s = v.ToString("0.000e+0", System.Globalization.CultureInfo.InvariantCulture);
        return s;
    }

    // ------------------------------------------------------- emitScene -----
    public sealed class EmitResult
    {
        public required string Text;
        public required EmittedCounts Emitted;
    }

    public static EmitResult EmitScene(Ctx ctx, FileStructure st, string sceneName)
    {
        var output = new List<string>
        {
            $"[scene name=\"{SanitizeName(sceneName)}\" version=1]",
            "; Converted from Unity scene by openengine-unity-scene-converter",
            "",
        };

        var emitted = new EmittedCounts();

        var keepCache = new Dictionary<string, bool>();
        bool IsMeshNode(SceneNode n) => (n.MeshFbxGuid != null && !n.Skinned && !n.NonStaticFbx) || n.MeshPrimitive != null;

        void CountSubtreeSkips(string nid)
        {
            SceneNode n = st.Get(nid);
            if (IsMeshNode(n)) G.Stats.SkippedInactive++;
            foreach (string c in n.Children) CountSubtreeSkips(c);
        }

        bool Keep(string nid)
        {
            if (keepCache.TryGetValue(nid, out bool cached)) return cached;
            SceneNode n = st.Get(nid);
            bool k;
            if (!n.Active)
            {
                CountSubtreeSkips(nid);
                k = false;
            }
            else
            {
                k = IsMeshNode(n) || n.Light != null || n.Children.Any(Keep);
                if (n.MeshFbxGuid != null && n.Skinned)
                {
                    // counted at parse
                }
                if (n.MeshFbxGuid != null && n.NonStaticFbx && !n.Skinned) G.Stats.SkippedNonStaticFbx++;
            }
            keepCache[nid] = k;
            return k;
        }

        WorldTrs WorldOf(string nid)
        {
            var chain = new List<SceneNode>();
            for (string? cur = nid; cur != null; cur = st.Get(cur).Father)
                chain.Insert(0, st.Get(cur));
            return ComposeWorldTrs(chain);
        }

        const int kEngineDirectionalCap = 4;
        string? strongestDirectionalNid = null;
        {
            double DirLuma(double[] c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
            var enabledDirs = new List<(string Nid, string Name, double Strength)>();
            void ScanDirs(string nid)
            {
                SceneNode? n = st.TryGet(nid);
                if (n == null || !n.Active) return;
                if (n.Light is { Type: "directional", Enabled: true })
                    enabledDirs.Add((nid, n.Name.Length > 0 ? n.Name : "Unnamed", DirLuma(n.Light.Color) * n.Light.Intensity));
                foreach (string c in n.Children) ScanDirs(c);
            }
            foreach (string r in st.RootIds) ScanDirs(r);
            if (enabledDirs.Count > 0)
            {
                (string Nid, string Name, double Strength) best = enabledDirs[0];
                foreach ((string Nid, string Name, double Strength) d in enabledDirs)
                    if (d.Strength > best.Strength) best = d;
                strongestDirectionalNid = best.Nid;
            }
            if (enabledDirs.Count > kEngineDirectionalCap)
            {
                emitted.DirectionalsBeyondEngineCap = enabledDirs.Count - kEngineDirectionalCap;
                G.LogErr($"NOTE: {enabledDirs.Count} enabled directionals; the engine lights the "
                    + $"strongest {kEngineDirectionalCap} (shadows from the primary only) — the rest will not contribute");
            }
        }

        int idCounter = 0;

        // Bind the .material generated from the Unity material at `slot`.
        bool EmitMaterialRef(SceneNode n, int slot)
        {
            string? ug = Materials.RemapPropWaterSubmesh(n, n.GetMatGuid(slot));
            if (ug == null) return false;
            AssetRef? m = Materials.ResolveMaterial(ctx, ug);
            if (m != null)
            {
                output.Add($"MeshRenderer.material = [path=\"{m.Path}\" guid=\"{m.Guid}\"]");
                emitted.MaterialsBound++;
            }
            bool hidden = ctx.MatHide.Contains(ug);
            if (hidden) emitted.HiddenSkyFx++;
            return hidden;
        }

        void EmitMeshCommon(SceneNode n, bool hidden)
        {
            output.Add("MeshRenderer.renderLayerMask = 1");
            output.Add($"MeshRenderer.castShadows = {(n.CastShadows ? "true" : "false")}");
            output.Add($"MeshRenderer.receiveShadows = {(n.ReceiveShadows ? "true" : "false")}");
            if (!n.RendererEnabled || hidden) output.Add("MeshRenderer.enabled = false");
        }

        void EmitNode(string nid, string? parentEntityId)
        {
            if (!Keep(nid)) return;
            SceneNode n = st.Get(nid);
            string eid = "e_" + (++idCounter);
            bool isDirLight = n.Light is { Type: "directional" };
            double[] pos = n.Pos, rot = EmitObjectQuat(n.Rot), scale = n.Scale;
            string parentAttr = parentEntityId != null ? $" parent=\"{parentEntityId}\"" : "";
            if (isDirLight)
            {
                WorldTrs w = WorldOf(nid);
                pos = w.Pos;
                scale = w.Scl;
                rot = EmitDirectionalQuat(w.Rot);
                parentAttr = "";
            }
            output.Add($"[entity id=\"{eid}\"{parentAttr}]");
            output.Add($"Name.value = \"{SanitizeName(n.Name.Length > 0 ? n.Name : "Unnamed")}\"");
            output.Add($"Transform.position = {Fmt3(pos)}");
            output.Add($"Transform.rotation = {Fmt4(rot)}");
            output.Add($"Transform.scale = {Fmt3(scale)}");

            emitted.Entities++;
            bool wasMesh = false;
            AssetRef? meshRef = null;
            string? meshBase = null;
            if (n.MeshPrimitive != null)
            {
                output.Add($"MeshRenderer.meshPrimitive = {n.MeshPrimitive}");
                // JS discards emitMaterialRef's hidden flag on the primitive
                // branch (emitMeshCommon(n) with hidden undefined).
                EmitMaterialRef(n, 0);
                EmitMeshCommon(n, false);
                wasMesh = true;
            }
            else if (IsMeshNode(n))
            {
                emitted.UniqueFbx.Add(n.MeshFbxGuid!);
                AssetRef? refAsset = Resolvers.ResolveMeshAsset(ctx, n.MeshFbxGuid!);
                if (refAsset != null)
                {
                    output.Add($"MeshRenderer.meshAsset = [path=\"{refAsset.Path}\" guid=\"{refAsset.Guid}\"]");
                    string mn = MeshMatchName(n.Name);
                    if (n.MatCount > 1 && mn.Length > 0)
                    {
                        output.Add($"MeshRenderer.meshName = \"{mn}_0\"");
                        meshRef = refAsset;
                        meshBase = mn;
                    }
                    else if (mn.Length > 0)
                    {
                        output.Add($"MeshRenderer.meshName = \"{mn}\"");
                    }
                    EmitMeshCommon(n, EmitMaterialRef(n, 0));
                    if (refAsset.Seeded)
                    {
                        emitted.SeededMeshes++;
                        emitted.SeededFbxStems.Add(Resolvers.FbxStem(ctx, n.MeshFbxGuid!));
                    }
                    else
                    {
                        emitted.ResolvedMeshes++;
                    }
                    wasMesh = true;
                }
                else
                {
                    string stem = Resolvers.FbxStem(ctx, n.MeshFbxGuid!);
                    output.Add($"; UNRESOLVED mesh asset: {stem}.fbx (unity guid {n.MeshFbxGuid})");
                    emitted.UnresolvedMeshes++;
                    emitted.UnresolvedFbxStems.Add(stem);
                }
            }
            if (n.Light != null)
            {
                bool isDir = n.Light.Type == "directional";
                output.Add($"Light.type = {(isDir ? 0 : 1)}");
                output.Add($"Light.color = {Fmt3(n.Light.Color)}");
                const double kDaylightReferenceLux = 100000;
                const double kMoonlightReferenceLux = 2000;
                bool night = ctx.RenderSettings?.IsNight == true;
                double referenceScale = night ? kMoonlightReferenceLux : kDaylightReferenceLux;
                output.Add($"Light.intensity = {FmtF(n.Light.Intensity * referenceScale)}");
                output.Add($"Light.intensityUnit = {(isDir ? "Lux" : "Candela")}");
                if (!isDir) output.Add($"Light.range = {FmtF(n.Light.Range)}");
                bool faithful = ctx.LocalShadows != "off";
                bool castsShadows = isDir ? n.Light.Shadows : (faithful && n.Light.Shadows);
                output.Add($"Light.castsShadows = {(castsShadows ? "true" : "false")}");
                if (!isDir && n.Light.Shadows)
                {
                    if (faithful)
                    {
                        int tier = n.UrpShadowTier == 0 ? 1 : n.UrpShadowTier == 2 ? 3 : 2;
                        output.Add($"Light.shadowResolutionTier = {tier}");
                        emitted.LocalShadowTiers[tier]++;
                    }
                    else
                    {
                        emitted.SuppressedAdditionalLightShadows++;
                    }
                }
                if (!n.Light.Enabled) output.Add("Light.enabled = false");
                emitted.Lights++;
                if (isDir && n.Light.Enabled && nid == strongestDirectionalNid)
                    emitted.SunEntityId = eid;
            }
            if (wasMesh) emitted.MeshEntities++;
            else emitted.GroupEntities++;
            output.Add("");
            if (meshRef != null && meshBase != null)
            {
                for (int k = 1; k < n.MatCount; ++k)
                {
                    string peid = "e_" + (++idCounter);
                    output.Add($"[entity id=\"{peid}\" parent=\"{eid}\"]");
                    output.Add($"Name.value = \"{SanitizeName(n.Name.Length > 0 ? n.Name : "Unnamed")} [mat {k}]\"");
                    output.Add("Transform.position = (0, 0, 0)");
                    output.Add("Transform.rotation = (0, 0, 0, 1)");
                    output.Add("Transform.scale = (1, 1, 1)");
                    output.Add($"MeshRenderer.meshAsset = [path=\"{meshRef.Path}\" guid=\"{meshRef.Guid}\"]");
                    output.Add($"MeshRenderer.meshName = \"{meshBase}_{k}\"");
                    EmitMeshCommon(n, EmitMaterialRef(n, k));
                    output.Add("");
                    emitted.Entities++;
                    emitted.MeshEntities++;
                    emitted.ResolvedMeshes++;
                    emitted.MaterialParts++;
                }
            }
            foreach (string c in n.Children) EmitNode(c, eid);
        }

        foreach (string r in st.RootIds) EmitNode(r, null);

        if (emitted.SunEntityId != null)
        {
            output.Add($"[entity id=\"e_{++idCounter}\"]");
            output.Add("Name.value = \"Sky Environment\"");
            output.Add("Transform.position = (0, 0, 0)");
            output.Add("Transform.rotation = (0, 0, 0, 1)");
            output.Add("Transform.scale = (1, 1, 1)");
            output.Add($"SkyEnvironment.SunLight = \"{emitted.SunEntityId}\"");
            output.Add("SkyEnvironment.TimeOfDayDrivesSunLight = false");
            output.AddRange(EmitAmbientLightLines(ctx.RenderSettings, ctx.Verbose));
            output.Add("");
            output.Add($"[entity id=\"e_{++idCounter}\"]");
            output.Add("Name.value = \"Post Process Volume\"");
            output.Add("Transform.position = (0, 0, 0)");
            output.Add("Transform.rotation = (0, 0, 0, 1)");
            output.Add("Transform.scale = (1, 1, 1)");
            output.Add("PostProcessVolume.enabled = true");
            output.Add("PostProcessVolume.isGlobal = true");
            output.Add("PostProcessVolume.tonemap = 0");

            JsonObj vol = ctx.VolumeOverrides ?? new JsonObj();
            var colAdj = vol["ColorAdjustments"] is JsonObj ca && ca["active"] is true ? ca : null;
            double colAdjPostExposureEv = colAdj?["postExposure"] is double pe ? pe : 0;
            if (ctx.RenderSettings?.IsNight == true)
            {
                const double kNightPinnedEv100 = 7.5;
                double pinnedEv = kNightPinnedEv100 - colAdjPostExposureEv;
                output.Add("ExposureAdjustmentEffect.enabled = true");
                output.Add("ExposureAdjustmentEffect.clampMin = true");
                output.Add($"ExposureAdjustmentEffect.minEv = {FmtF(pinnedEv)}");
                output.Add("ExposureAdjustmentEffect.clampMax = true");
                output.Add($"ExposureAdjustmentEffect.maxEv = {FmtF(pinnedEv)}");
            }
            else if (colAdjPostExposureEv != 0)
            {
                output.Add("ExposureAdjustmentEffect.enabled = true");
                output.Add($"ExposureAdjustmentEffect.compensation = {FmtF(colAdjPostExposureEv)}");
            }

            var bloom = vol["Bloom"] is JsonObj bl && bl["active"] is true ? bl : null;
            double bloomIntensity = bloom?["intensity"] is double bi ? bi : 0;
            if (bloom != null && bloomIntensity > 0)
            {
                const double kUrpBloomDefaultThreshold = 0.9;
                const double kUrpBloomDefaultScatter = 0.7;
                double thrGamma = bloom["threshold"] is double thg ? thg : kUrpBloomDefaultThreshold;
                double thr = Skybox.SrgbToLinear(thrGamma);
                double scatter = bloom["scatter"] is double sc ? sc : kUrpBloomDefaultScatter;
                output.Add("BloomEffect.enabled = true");
                output.Add($"BloomEffect.threshold = {FmtF(thr)}");
                output.Add($"BloomEffect.knee = {FmtF(0.5 * thr)}");
                output.Add($"BloomEffect.intensity = {FmtF(bloomIntensity)}");
                output.Add("BloomEffect.strength = 1");
                output.Add($"BloomEffect.scatter = {FmtF(0.05 + 0.9 * scatter)}");
                if (bloom["dirtIntensity"] is double di && di != 0)
                    G.Warn($"volume Bloom lens-dirt (intensity {Js.NumberToString(di)}) not translated (non-physical overlay; URP adds dirtTex * intensity * bloom on top of the bloom term)", ctx.Verbose);
            }

            var cgLines = new List<string>();
            var smh = vol["ShadowsMidtonesHighlights"] is JsonObj sm && sm["active"] is true ? sm : null;
            bool smhLive = smh != null && ((string[])["shadows", "midtones", "highlights"])
                .Any(w => smh[w] is double[] arr && !ColorGrade.IsIdentityWheel(arr));
            var lgg = vol["LiftGammaGain"] is JsonObj lg && lg["active"] is true ? lg : null;
            bool lggLive = lgg != null && ((string[])["lift", "gamma", "gain"])
                .Any(w => lgg[w] is double[] arr && !ColorGrade.IsIdentityWheel(arr));

            // URP ColorLookup (user 2D strip LUT) -> CubeLutEffect — port of the
            // convert.js block (see it for the full rationale: URP's sRGB-wrapped
            // user LUT sample == CubeLutEffect Rec709SRGB input encoding,
            // intensity = contribution; inert configs skip silently, real
            // translation failures become drop notes).
            bool lookupEmitted = false;
            {
                var lookup = vol["ColorLookup"] is JsonObj lo && lo["active"] is true ? lo : null;
                double rawContrib = lookup?["contribution"] is double lc ? lc : 0;
                double contrib = rawContrib > 1 ? 1 : rawContrib; // ClampedFloatParameter [0,1]
                string texGuid = "";
                if (lookup?["texture"] is string texRaw)
                {
                    Match gm = kTexGuidRe.Match(texRaw);
                    if (gm.Success) texGuid = gm.Groups[1].Value.ToLowerInvariant();
                }
                if (lookup != null && contrib > 0 && texGuid.Length > 0)
                {
                    PkgEntry? entry = ctx.PkgGet(texGuid);
                    string ext = entry != null ? Js.PathExtname(entry.AssetPath).ToLowerInvariant() : "";
                    if (ctx.ProjectDir == null)
                    {
                        G.NoteDropped("volume grade", "ColorLookup (needs --project to write the transcoded .cube LUT)", ctx.Verbose);
                    }
                    else if (entry == null)
                    {
                        G.NoteDropped("volume grade", $"ColorLookup (LUT texture {texGuid} not found in the package)", ctx.Verbose);
                    }
                    else if (ext != ".png")
                    {
                        G.NoteDropped("volume grade", $"ColorLookup (LUT texture format '{ext}' not supported yet; PNG strips only)", ctx.Verbose);
                    }
                    else
                    {
                        try
                        {
                            PngImage img = Png.DecodePng(File.ReadAllBytes(Js.PathJoin(entry.Dir, "asset")));
                            // Long math: DecodePng bounds Height <= 256, but keep
                            // the square un-wrappable on its own terms.
                            if (img.Width != (long)img.Height * img.Height)
                                throw new InvalidDataException($"{img.Width}x{img.Height} is not a LUT strip (width must equal height^2)");
                            // ASSET-ROOT-relative name, same rule as the SMH bake below.
                            string lutName = $"{sceneName}_lookup_lut.cube";
                            string lutAbs = Js.PathJoin(ctx.ProjectDir, "assets", lutName);
                            ColorGrade.BakeLookupCubeLut(img, lutAbs);
                            ConvertCli.RecordOutput(ctx, lutAbs, "lut");
                            output.Add("CubeLutEffect.enabled = true");
                            output.Add("CubeLutEffect.stackOrder = 0");
                            output.Add($"CubeLutEffect.intensity = {FmtF(contrib)}");
                            output.Add("CubeLutEffect.inputEncoding = 1"); // Rec709SRGB
                            output.Add($"CubeLutEffect.lutAsset = [path=\"{lutName}\" guid=\"\"]");
                            G.Warn($"volume ColorLookup {Js.PathBasename(entry.AssetPath)} ({img.Height}^3 strip) -> assets/{lutName}, contribution {FmtF(contrib)}", ctx.Verbose);
                            lookupEmitted = true;
                        }
                        catch (Exception err)
                        {
                            G.NoteDropped("volume grade", $"ColorLookup ({Js.PathBasename(entry.AssetPath)}: {err.Message})", ctx.Verbose);
                        }
                    }
                }
            }

            if (ctx.GradeLutFallback && smhLive && ctx.ProjectDir != null && !lookupEmitted)
            {
                string lutName = $"{sceneName}_smh_lut.cube";
                string lutAbs = Js.PathJoin(ctx.ProjectDir, "assets", lutName);
                ColorGrade.BakeSmhCubeLut(smh!, lutAbs);
                ConvertCli.RecordOutput(ctx, lutAbs, "lut");
                output.Add("CubeLutEffect.enabled = true");
                output.Add("CubeLutEffect.stackOrder = 0");
                output.Add("CubeLutEffect.intensity = 1");
                output.Add("CubeLutEffect.inputEncoding = 0");
                output.Add($"CubeLutEffect.lutAsset = [path=\"{lutName}\" guid=\"\"]");
                G.Warn($"volume ShadowsMidtonesHighlights baked to assets/{lutName} (--grade-lut legacy path)", ctx.Verbose);
                if (lggLive)
                    G.NoteDropped("volume grade", "LiftGammaGain (native-band mapping disabled by --grade-lut; the LUT fallback bakes SMH only)", ctx.Verbose);
            }
            else
            {
                if (ctx.GradeLutFallback && smhLive && lookupEmitted)
                    G.Warn("volume ShadowsMidtonesHighlights: --grade-lut bake superseded by ColorLookup (single CubeLutEffect slot); SMH carries as native ColorGradeEffect bands", ctx.Verbose);
                GradeBands? bands = null;
                if (smhLive) bands = ColorGrade.SmhToBands(smh!);
                if (lggLive) bands = bands != null ? ColorGrade.AddBands(bands, ColorGrade.LggToBands(lgg!)) : ColorGrade.LggToBands(lgg!);
                if (bands != null && !ColorGrade.BandsAreNeutral(bands))
                {
                    cgLines.AddRange(ColorGrade.EmitColorGradeBandLines(bands));
                    if (smhLive)
                    {
                        ColorGrade.BandLimits lim = ColorGrade.SmhLimitsToNative(smh!);
                        cgLines.Add($"ColorGradeEffect.shadowsStart = {FmtF(lim.ShadowsStart)}");
                        cgLines.Add($"ColorGradeEffect.shadowsEnd = {FmtF(lim.ShadowsEnd)}");
                        cgLines.Add($"ColorGradeEffect.highlightsStart = {FmtF(lim.HighlightsStart)}");
                        cgLines.Add($"ColorGradeEffect.highlightsEnd = {FmtF(lim.HighlightsEnd)}");
                    }
                    string[] live = [.. new[] { smhLive ? "ShadowsMidtonesHighlights" : null, lggLive ? "LiftGammaGain" : null }.Where(x => x != null)!];
                    G.Warn($"volume grade: {string.Join(" + ", live)} -> native ColorGradeEffect three-way bands", ctx.Verbose);
                }
            }

            if (colAdj != null)
            {
                if (colAdj["contrast"] is double contrast && contrast != 0)
                    cgLines.Add($"ColorGradeEffect.contrast = {FmtF(1 + contrast / 100)}");
                if (colAdj["saturation"] is double saturation && saturation != 0)
                    cgLines.Add($"ColorGradeEffect.saturation = {FmtF(1 + saturation / 100)}");
                // Hue Shift carries 1:1 in degrees: both ends are an HSV rotation at
                // the tail of the grade chain (engine: after the corrector; URP: after
                // its trackball/LGG block).
                if (colAdj["hueShift"] is double hs && hs != 0)
                    cgLines.Add($"ColorGradeEffect.hueShift = {FmtF(hs)}");
            }

            // URP WhiteBalance -> the grade block's temperature/tint, same -100..100
            // ranges: the engine mirrors ColorBalanceToLMSCoeffs and applies the LMS
            // gains at the head of the grade chain, so the adaptation matches URP.
            var wb = vol["WhiteBalance"] is JsonObj wbo && wbo["active"] is true ? wbo : null;
            if (wb != null)
            {
                if (wb["temperature"] is double wbTemperature && wbTemperature != 0)
                    cgLines.Add($"ColorGradeEffect.temperature = {FmtF(wbTemperature)}");
                if (wb["tint"] is double wbTint && wbTint != 0)
                    cgLines.Add($"ColorGradeEffect.tint = {FmtF(wbTint)}");
            }

            if (cgLines.Count > 0)
            {
                output.Add("ColorGradeEffect.enabled = true");
                output.Add("ColorGradeEffect.gradeInLog = true");
                output.AddRange(cgLines);
            }

            // ColorAdjustments.colorFilter -> ColorFilterEffect. Both are an unclipped
            // multiplier on pre-tonemap HDR color in the grade chain (the engine
            // filter runs inside hdr_color_fx's post-exposure block, URP's filter
            // slot). Unity stores the picker color; URP applies .value.linear, so the
            // channels carry through SrgbToLinear. Multiply/intensity-1 defaults of
            // ColorFilterEffect match URP's plain multiply — only enabled + color emit.
            // (rgb-only identity check: colorFilter is a COLOR, so its alpha is not a
            // wheel w-offset — IsIdentityWheel would treat opaque white as authored.)
            if (colAdj?["colorFilter"] is double[] cfArr
                && Enumerable.Range(0, 3).Any(i => Math.Abs(cfArr[i] - 1) >= 1e-4))
            {
                output.Add("ColorFilterEffect.enabled = true");
                output.Add($"ColorFilterEffect.colorR = {FmtF(Skybox.SrgbToLinear(cfArr[0]))}");
                output.Add($"ColorFilterEffect.colorG = {FmtF(Skybox.SrgbToLinear(cfArr[1]))}");
                output.Add($"ColorFilterEffect.colorB = {FmtF(Skybox.SrgbToLinear(cfArr[2]))}");
            }

            VolumeProfiles.SsaoInfo? ssao = ctx.ProjectPipeline?.Ssao;
            if (ssao != null && ssao.Enabled && (ssao.Intensity ?? 0) > 0)
            {
                output.Add("AmbientOcclusionEffect.enabled = true");
                output.Add($"AmbientOcclusionEffect.intensity = {FmtF(ssao.Intensity!.Value)}");
                if (ssao.Radius is double radius)
                    output.Add($"AmbientOcclusionEffect.radius = {FmtF(radius)}");
            }

            var vig = vol["Vignette"] is JsonObj vg && vg["active"] is true ? vg : null;
            double vigIntensity = vig?["intensity"] is double vi ? vi : 0;
            if (vig != null && vigIntensity > 0)
            {
                output.Add("VignetteEffect.enabled = true");
                output.Add($"VignetteEffect.intensity = {FmtF(vigIntensity)}");
                output.Add($"VignetteEffect.smoothness = {FmtF(vig["smoothness"] is double vs ? vs : 0.2)}");
                if (Truthy(vig["rounded"]))
                    output.Add("VignetteEffect.rounded = true");
                if (vig["color"] is double[] vc && (vc[0] > 0 || vc[1] > 0 || vc[2] > 0))
                {
                    output.Add($"VignetteEffect.colorR = {FmtF(vc[0])}");
                    output.Add($"VignetteEffect.colorG = {FmtF(vc[1])}");
                    output.Add($"VignetteEffect.colorB = {FmtF(vc[2])}");
                }
            }

            const double kEngineCaIntensityMax = 12;
            var caComp = vol["ChromaticAberration"] is JsonObj cb && cb["active"] is true ? cb : null;
            if (caComp?["intensity"] is double caIntensity && caIntensity > 0)
            {
                double px = Math.Min(kEngineCaIntensityMax, Math.Max(0, caIntensity * kEngineCaIntensityMax));
                output.Add("ChromaticAberrationEffect.enabled = true");
                output.Add($"ChromaticAberrationEffect.intensity = {FmtF(px)}");
            }

            var kTranslatedVolumeComponents = new HashSet<string>
            {
                "ColorAdjustments", "WhiteBalance", "Bloom", "Vignette", "ChromaticAberration",
                "ShadowsMidtonesHighlights", "LiftGammaGain", "Tonemapping",
                "ColorLookup", // -> CubeLutEffect (strip -> .cube transcode; failures noteDropped above)
            };
            bool ComponentHasEffect(JsonObj comp) => comp.Keys.Any(k => k != "active"
                && (comp[k] is double[] arr ? !ColorGrade.IsIdentityWheel(arr)
                    : comp[k] is double num ? num != 0
                    : comp[k] is string str && str.Length > 0));
            foreach (string name in vol.Keys)
            {
                if (vol[name] is not JsonObj comp || comp["active"] is not true || kTranslatedVolumeComponents.Contains(name)) continue;
                if (ComponentHasEffect(comp))
                    G.NoteDropped("volume grade", $"{name} (authored override, no engine mapping yet)", ctx.Verbose);
            }
            if (bloom?["tint"] is double[] bt && !ColorGrade.IsIdentityWheel(bt))
                G.NoteDropped("volume grade", "Bloom.tint (colored bloom; BloomEffect has no tint channel yet)", ctx.Verbose);

            RenderSettingsInfo? rsFog = ctx.RenderSettings;
            if (rsFog != null && rsFog.FogEnabled && rsFog.FogColor != null)
            {
                double near = Math.Max(0, rsFog.FogStart);
                double far = rsFog.FogMode == 1
                    ? Math.Max(near + 1, rsFog.FogEnd)
                    : Math.Max(near + 1, 3.0 / Math.Max(rsFog.FogDensity, 1e-4));
                double onset = Math.Max(10, (far - near) / 8);
                output.Add("HeightFogEffect.enabled = true");
                output.Add("HeightFogEffect.distanceFogEnabled = true");
                output.Add("HeightFogEffect.heightFogEnabled = false");
                output.Add($"HeightFogEffect.minDistance = {FmtF(near)}");
                output.Add($"HeightFogEffect.smoothLength = {FmtF(onset)}");
                output.Add($"HeightFogEffect.maxDistance = {FmtF(far)}");
                output.Add("HeightFogEffect.intensity = 0.8");
                output.Add("HeightFogEffect.density = 0.5");
                output.Add("HeightFogEffect.maxOpacity = 0.5");
                output.Add($"HeightFogEffect.emissive = {Fmt3(rsFog.FogColor)}");
                output.Add("HeightFogEffect.gradientMode = 0");
                output.Add("HeightFogEffect.trackDirectionalLight = false");
                output.Add("HeightFogEffect.noiseEnabled = false");
                output.Add("HeightFogEffect.skyEnabled = false");
                output.Add("HeightFogEffect.useTimeOfDay = false");
            }

            {
                const double kErShadowDistanceM = 50;
                const double kShadowSplitLambda = 0.45;
                const double kShadowDepthBias = 0.0001;
                const double kShadowNormalBias = 0.5;
                double? rpShadowDist = ctx.ProjectPipeline?.Facts.ShadowDistance;
                double maxShadowDistance = rpShadowDist != null && rpShadowDist.Value > 0
                    ? rpShadowDist.Value : kErShadowDistanceM;
                output.Add("ShadowSettingsEffect.enabled = true");
                output.Add($"ShadowSettingsEffect.maxShadowDistance = {FmtF(maxShadowDistance)}");
                output.Add($"ShadowSettingsEffect.splitLambda = {FmtF(kShadowSplitLambda)}");
                output.Add($"ShadowSettingsEffect.depthBias = {FmtF(kShadowDepthBias)}");
                output.Add($"ShadowSettingsEffect.normalBias = {FmtF(kShadowNormalBias)}");
            }
            output.Add("");
            emitted.Entities += 2;
            emitted.Environment = true;
        }

        SkyboxResolve? skyboxRef = ResolveSceneSkybox(ctx);
        if (skyboxRef != null)
        {
            output.Add($"[entity id=\"e_{++idCounter}\"]");
            output.Add("Name.value = \"Skybox (Unity)\"");
            output.Add("Transform.position = (0, 0, 0)");
            output.Add("Transform.rotation = (0, 0, 0, 1)");
            output.Add("Transform.scale = (1, 1, 1)");
            output.Add("Skybox.Enabled = true");
            output.Add("Skybox.HDRIIntensity = 1");
            output.Add("Skybox.IblIntensity = 1");
            output.Add("Skybox.IblLowerHemisphereDarkness = 0");
            output.Add($"Skybox.RotationDegrees = {FmtF(skyboxRef.RotationDegrees)}");
            output.Add($"Skybox.HDRI = [path=\"{skyboxRef.RelPath}\" guid=\"{skyboxRef.Guid}\"]");
            output.Add("");
            emitted.Entities += 1;
            emitted.Skybox = skyboxRef;
        }
        return new EmitResult { Text = string.Join("\n", output) + "\n", Emitted = emitted };
    }

    private static bool Truthy(object? v) => v switch
    {
        null => false,
        bool b => b,
        double d => d != 0 && !double.IsNaN(d),
        string s => s.Length > 0,
        double[] => true,
        _ => true,
    };
}
