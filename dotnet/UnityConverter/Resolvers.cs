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

    private static AssetRef ResolveSerializedMesh(Ctx ctx, UnityObjectReference source, PkgEntry entry)
    {
        if (Js.PathExtname(entry.AssetPath).ToLowerInvariant() != ".asset")
            throw new InvalidDataException($"Unsupported MeshFilter asset: {entry.AssetPath} ({source.FileId})");
        if (string.IsNullOrEmpty(source.FileId)) throw new InvalidDataException($"Serialized Mesh reference has no fileID: {source.Guid}");
        if (ctx.SerializedMeshes.TryGetValue(source, out AssetRef? cached)) return cached;
        UnityStaticMesh.Mesh mesh = UnityStaticMesh.Read(Js.ReadFileUtf8(Js.PathJoin(entry.Dir, "asset")), source.FileId);
        if (ctx.ModelSeedDir == null) throw new InvalidDataException("Serialized Unity Mesh conversion requires --project");
        string relative = $"SerializedMeshes/{source.Guid}/{source.FileId}.glb";
        string destination = Js.PathJoin(ctx.ModelSeedDir, relative);
        mesh.Name = Emitter.SanitizeName(mesh.Name);
        if (mesh.Name.Length == 0) mesh.Name = "UnityMesh";
        byte[] data = UnityStaticMesh.EncodeGlb(mesh);
        Directory.CreateDirectory(Js.PathDirname(destination));
        if (!File.Exists(destination) || !File.ReadAllBytes(destination).AsSpan().SequenceEqual(data))
            File.WriteAllBytes(destination, data);
        if (mesh.RepairedTangentVertices.Count > 0)
            G.Warn($"{entry.AssetPath}: repaired undefined tangents at vertices {string.Join(", ", mesh.RepairedTangentVertices)}", ctx.Verbose);
        ConvertCli.RecordOutput(ctx, destination, "model");
        var result = new AssetRef { Guid = "", Path = $"{Materials.kModelSeedRel}/{relative}", Seeded = true,
            MeshName = mesh.Name, PartCount = mesh.Submeshes.Count };
        G.ProgressItem("models", result.Path);
        ctx.SerializedMeshes[source] = result;
        return result;
    }

    public static AssetRef? ResolveMeshAsset(Ctx ctx, UnityObjectReference source)
    {
        string unityFbxGuid = source.Guid;
        PkgEntry? entry = ctx.PkgGet(unityFbxGuid);
        if (entry != null && Js.PathExtname(entry.AssetPath).ToLowerInvariant() != ".fbx")
            return ResolveSerializedMesh(ctx, source, entry);
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
