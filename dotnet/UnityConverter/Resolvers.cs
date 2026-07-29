namespace GameEngine.UnityConverter;

/// Mesh-asset resolution: assetdb-first, then pack seeding — port of
/// fbxStem / resolveMeshAsset / seedPackModel / relativizeToProject.
internal static class Resolvers
{
    public static string FbxStem(Ctx ctx, string unityGuid)
    {
        PkgEntry? e = ctx.PkgGet(unityGuid);
        return e != null ? Js.PathBasename(e.AssetPath, Js.PathExtname(e.AssetPath)) : unityGuid;
    }

    public static AssetRef? ResolveMeshAsset(Ctx ctx, string unityFbxGuid)
    {
        if (G.MeshRefCache.TryGetValue(unityFbxGuid, out AssetRef? cached)) return cached;
        AssetRef? result = null;
        if (ctx.AssetDbIndex != null)
        {
            string stem = FbxStem(ctx, unityFbxGuid).ToLowerInvariant();
            List<AssetRef> candidates = ctx.AssetDbIndex.ByStem.GetValueOrDefault(stem) ?? [];
            if (candidates.Count > 0)
            {
                AssetRef best = candidates.OrderBy(c => c.Path.Length).First();
                if (candidates.Count > 1)
                    G.Warn($"ambiguous stem '{stem}': {candidates.Count} assetdb entries; using {best.Path}", ctx.Verbose);
                result = new AssetRef { Guid = best.Guid, Path = RelativizeToProject(ctx, best.Path) };
            }
        }
        result ??= SeedPackModel(ctx, unityFbxGuid);
        G.MeshRefCache[unityFbxGuid] = result;
        return result;
    }

    // Assetdb miss -> extract the pack's FBX bytes into Models_Unity/ and
    // reference by PATH with an empty guid (SceneIO path-fallback binds it
    // after the editor's move pass registers the file).
    public static AssetRef? SeedPackModel(Ctx ctx, string unityFbxGuid)
    {
        if (ctx.ModelSeedDir == null) return null;
        PkgEntry? e = ctx.PkgGet(unityFbxGuid);
        if (e == null || Js.PathExtname(e.AssetPath).ToLowerInvariant() != ".fbx") return null;
        string packRel = e.AssetPath.Replace('\\', '/');
        if (packRel.StartsWith("assets/", StringComparison.OrdinalIgnoreCase)) packRel = packRel[7..];
        if (packRel.Split('/').Any(seg => seg == "" || seg == "..")) return null;
        string rel = $"{Materials.kModelSeedRel}/{packRel}";
        string dest = Js.PathJoin(ctx.ModelSeedDir, packRel);
        try
        {
            if (!File.Exists(dest))
            {
                Directory.CreateDirectory(Js.PathDirname(dest));
                File.Copy(Js.PathJoin(e.Dir, "asset"), dest);
            }
        }
        catch (Exception err)
        {
            G.Warn($"failed to seed pack model {e.AssetPath}: {err.Message}", ctx.Verbose);
            return null;
        }
        ConvertCli.RecordOutput(ctx, dest, "model");
        G.ProgressItem("models", rel);
        return new AssetRef { Guid = "", Path = rel, Seeded = true };
    }

    public static string RelativizeToProject(Ctx ctx, string p)
    {
        string norm = p.Replace('\\', '/');
        if (ctx.ProjectDir == null) return norm;
        string proj = ctx.ProjectDir.Replace('\\', '/').TrimEnd('/') + "/";
        if (norm.StartsWith(proj, StringComparison.OrdinalIgnoreCase))
            return norm[proj.Length..];
        return norm;
    }
}
