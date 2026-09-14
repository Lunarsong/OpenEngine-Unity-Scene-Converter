using System.Globalization;
using System.Text.RegularExpressions;

namespace GameEngine.UnityConverter;

// Source records, not an engine renderer-group selection contract.
internal sealed record LodRenderer(UnityObjectReference Source, string NodeId);
internal sealed record LodLevel(double ScreenRelativeHeight, double FadeTransitionWidth, List<LodRenderer> Renderers);
internal sealed class LodSourceGroup
{
    public required UnityObjectReference Source;
    public required string OwnerNodeId;
    public List<UnityObjectReference> InstancePath = [];
    public bool Enabled, AnimateCrossFading, LastLodIsBillboard;
    public required double[] LocalReferencePoint;
    public double Size, FadeMode;
    public List<LodLevel> Levels = [];
    public List<JsonObj> UnsupportedOverrides = [];

    public LodSourceGroup Clone(Dictionary<string, string> map, UnityObjectReference instance) => new()
    {
        Source = Source, OwnerNodeId = map[OwnerNodeId], InstancePath = [instance, .. InstancePath],
        Enabled = Enabled, AnimateCrossFading = AnimateCrossFading, LastLodIsBillboard = LastLodIsBillboard,
        LocalReferencePoint = [.. LocalReferencePoint], Size = Size, FadeMode = FadeMode,
        Levels = [.. Levels.Select(l => l with { Renderers = [.. l.Renderers.Select(r => r with { NodeId = map[r.NodeId] })] })],
        UnsupportedOverrides = [.. UnsupportedOverrides],
    };
}

internal static class LodSource
{
    public static Dictionary<string, UnityYamlDoc> IndexDocuments(List<UnityYamlDoc> docs) => docs.ToDictionary(d => d.Anchor,
        d => d.ClassId is "43" or "28" ? new UnityYamlDoc
        {
            ClassId = d.ClassId, Anchor = d.Anchor, Stripped = d.Stripped, Type = d.Type,
            Data = new YamlMap { ["serializedVersion"] = d.Data?["serializedVersion"] },
        } : d);

    public static UnityObjectReference? Reference(YamlMap? raw, FileStructure scope, string expectedClass)
    {
        if (raw == null || raw.Str("fileID") == "0") return null;
        string id = raw.Str("fileID") ?? "undefined", guid = (raw.Str("guid") ?? scope.SourceGuid).ToLowerInvariant();
        if (!Regex.IsMatch(id, @"^-?[0-9]+$") || !Regex.IsMatch(guid, "^[0-9a-f]{32}$"))
            throw new InvalidDataException($"Invalid source reference {guid}/{id}");
        bool embedded = string.IsNullOrEmpty(raw.Str("guid"));
        string? version = null;
        if (embedded)
        {
            if (!scope.Documents.TryGetValue(id, out UnityYamlDoc? doc) || doc.ClassId != expectedClass)
                throw new InvalidDataException($"Expected local class {expectedClass}: {guid}/{id}");
            if (expectedClass == "43") version = doc.Data?.Str("serializedVersion") ?? "unknown";
        }
        return new UnityObjectReference(guid, id, embedded, version);
    }

    private static double Numeric(object? raw, string label, double min = double.NegativeInfinity, double max = double.PositiveInfinity)
    {
        if (raw is not string text || !Regex.IsMatch(text, @"^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$") ||
            !double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out double value) ||
            !double.IsFinite(value) || value < min || value > max)
            throw new InvalidDataException($"Invalid LODGroup {label}");
        return value;
    }
    private static bool Flag(object? raw, string label)
    {
        double value = Numeric(raw, label, 0, 1);
        if (value != 0 && value != 1) throw new InvalidDataException($"Invalid LODGroup {label}");
        return value == 1;
    }

    public static void ReadGroups(FileStructure st, List<UnityYamlDoc> docs)
    {
        foreach (UnityYamlDoc doc in docs)
        {
            if (doc.ClassId != "205" || doc.Stripped) continue;
            YamlMap d = doc.Data ?? new();
            YamlMap? go = d.Map("m_GameObject");
            string? id = go?.Str("fileID");
            string? owner = id != null && string.IsNullOrEmpty(go?.Str("guid")) ? st.AnchorToNode.GetValueOrDefault(id) : null;
            if (owner == null || st.AnchorTypes.GetValueOrDefault(id!) != "1")
                throw new InvalidDataException($"Unresolved LODGroup owner {st.SourceGuid}/{doc.Anchor}");
            if (d.List("m_LODs") is not YamlList levels) throw new InvalidDataException($"Invalid LODGroup m_LODs {doc.Anchor}");
            YamlMap? p = d.Map("m_LocalReferencePoint");
            double fadeMode = Numeric(d["m_FadeMode"], "m_FadeMode", 0, 2);
            if (fadeMode != Math.Truncate(fadeMode)) throw new InvalidDataException("Invalid LODGroup m_FadeMode");
            var group = new LodSourceGroup
            {
                Source = new(st.SourceGuid, doc.Anchor), OwnerNodeId = owner,
                Enabled = Flag(d["m_Enabled"], "m_Enabled"),
                LocalReferencePoint = [.. new[] { "x", "y", "z" }.Select(k => Numeric(p?[k], $"m_LocalReferencePoint.{k}"))],
                Size = Numeric(d["m_Size"], "m_Size", 0), FadeMode = fadeMode,
                AnimateCrossFading = Flag(d["m_AnimateCrossFading"], "m_AnimateCrossFading"),
                LastLodIsBillboard = Flag(d["m_LastLODIsBillboard"], "m_LastLODIsBillboard"),
            };
            foreach (object? item in levels)
            {
                if (item is not YamlMap level || level.List("renderers") is not YamlList members)
                    throw new InvalidDataException($"Invalid LODGroup renderers {group.Levels.Count}");
                var renderers = new List<LodRenderer>();
                foreach (object? member in members)
                {
                    YamlMap? reference = (member as YamlMap)?.Map("renderer");
                    string? rendererId = reference?.Str("fileID");
                    string? node = rendererId != null && string.IsNullOrEmpty(reference?.Str("guid")) ? st.AnchorToNode.GetValueOrDefault(rendererId) : null;
                    if (node == null || st.AnchorTypes.GetValueOrDefault(rendererId!) is not ("23" or "137"))
                        throw new InvalidDataException($"Unresolved LODGroup renderer {st.SourceGuid}/{rendererId ?? "undefined"}");
                    renderers.Add(new(new(st.SourceGuid, rendererId!), node));
                }
                group.Levels.Add(new(Numeric(level["screenRelativeHeight"], "screenRelativeHeight", 0, 1),
                    Numeric(level["fadeTransitionWidth"], "fadeTransitionWidth", 0, 1), renderers));
            }
            st.LodGroups.Add(group);
            st.AnchorToLodGroup[doc.Anchor] = group;
        }
        if (st.LodGroups.Count > 0 && st.UnsupportedStructuralOperations.Count > 0)
            throw new InvalidDataException($"Unsupported prefab structural operation with LODGroup records: {string.Join(", ", st.UnsupportedStructuralOperations)}");
    }

    // A nested member may carry unsupported editing even when its file has no LODGroup.
    public static void RecordStructuralOperations(FileStructure st, FileStructure sub, UnityYamlDoc doc)
    {
        st.UnsupportedStructuralOperations.AddRange(sub.UnsupportedStructuralOperations);
        foreach (YamlMap? container in new[] { doc.Data, doc.Data?.Map("m_Modification") })
            foreach (string key in new[] { "m_RemovedComponents", "m_RemovedGameObjects", "m_AddedComponents", "m_AddedGameObjects" })
                if (container?[key] is { } value && (value is not YamlList list || list.Count > 0))
                    st.UnsupportedStructuralOperations.Add($"{st.SourceGuid}/{doc.Anchor}:{key}");
    }

    public static (Dictionary<LodSourceGroup, LodSourceGroup> Clones, HashSet<YamlMap> Handled) CloneGroups(
        FileStructure st, FileStructure sub, Dictionary<string, string> map, string instanceId, YamlList? modifications)
    {
        var clones = new Dictionary<LodSourceGroup, LodSourceGroup>();
        foreach (LodSourceGroup group in sub.LodGroups)
        {
            LodSourceGroup clone = group.Clone(map, new(st.SourceGuid, instanceId));
            clones[group] = clone;
            st.LodGroups.Add(clone);
        }
        var handled = new HashSet<YamlMap>();
        foreach (object? raw in modifications ?? [])
        {
            if (raw is not YamlMap mod) continue;
            YamlMap? target = mod.Map("target");
            string? id = target?.Str("fileID");
            LodSourceGroup? group = id != null ? sub.AnchorToLodGroup.GetValueOrDefault(id) : null;
            if (group == null)
            {
                if (mod.Str("propertyPath")?.StartsWith("m_LODs", StringComparison.Ordinal) == true ||
                    mod.Str("propertyPath")?.StartsWith("m_LocalReferencePoint", StringComparison.Ordinal) == true ||
                    mod.Str("propertyPath") is "m_Size" or "m_FadeMode" or "m_AnimateCrossFading" or "m_LastLODIsBillboard")
                    throw new InvalidDataException($"Unresolved LODGroup override {target?.Str("guid") ?? "undefined"}/{id ?? "undefined"}");
                continue;
            }
            if (target?.Str("guid")?.ToLowerInvariant() != sub.SourceGuid)
                throw new InvalidDataException($"LODGroup override target is outside prefab {sub.SourceGuid}");
            clones[group].UnsupportedOverrides.Add(new JsonObj
            {
                ["instance"] = RefJson(new(st.SourceGuid, instanceId)), ["target"] = RefJson(new(sub.SourceGuid, id!)),
                ["propertyPath"] = mod.Str("propertyPath") ?? "", ["value"] = ToJson(mod["value"]),
                ["objectReference"] = ToJson(mod["objectReference"]),
            });
            handled.Add(mod);
        }
        return (clones, handled);
    }

    public static List<string> UnsupportedBindings(SceneNode node)
    {
        var result = new List<string>();
        if (node.MeshRef is { Embedded: true } mesh)
            result.Add($"embedded Mesh {mesh.Guid}/{mesh.FileId} v{mesh.SerializedVersion}");
        for (int i = 0; i < node.MaterialRefs.Count; ++i)
            if (node.MaterialRefs[i] is { Embedded: true } mat) result.Add($"embedded Material {mat.Guid}/{mat.FileId} slot {i}");
        return result;
    }
    private static object? ToJson(object? raw)
    {
        if (raw is YamlMap map) { var obj = new JsonObj(); foreach (string k in map.Keys) obj[k] = ToJson(map[k]); return obj; }
        if (raw is YamlList list) return new JsonArr(list.Select(ToJson));
        return raw;
    }
    private static JsonObj? RefJson(UnityObjectReference? r)
    {
        if (r == null) return null;
        var obj = new JsonObj { ["guid"] = r.Guid, ["fileID"] = r.FileId };
        if (r.Embedded) obj["embedded"] = true;
        if (r.SerializedVersion != null) obj["serializedVersion"] = r.SerializedVersion;
        return obj;
    }
    public static JsonArr Summarize(FileStructure st) => new(st.LodGroups.Select(g => new JsonObj
    {
        ["source"] = RefJson(g.Source), ["ownerNodeId"] = g.OwnerNodeId,
        ["instancePath"] = new JsonArr(g.InstancePath.Select(RefJson)), ["enabled"] = g.Enabled,
        ["localReferencePoint"] = g.LocalReferencePoint, ["size"] = g.Size, ["fadeMode"] = g.FadeMode,
        ["animateCrossFading"] = g.AnimateCrossFading, ["lastLodIsBillboard"] = g.LastLodIsBillboard,
        ["levels"] = new JsonArr(g.Levels.Select(l => new JsonObj
        {
            ["screenRelativeHeight"] = l.ScreenRelativeHeight, ["fadeTransitionWidth"] = l.FadeTransitionWidth,
            ["renderers"] = new JsonArr(l.Renderers.Select(r =>
            {
                SceneNode node = st.Get(r.NodeId);
                return new JsonObj
                {
                    ["source"] = RefJson(r.Source), ["nodeId"] = r.NodeId, ["name"] = node.Name,
                    ["active"] = node.Active, ["rendererEnabled"] = node.RendererEnabled,
                    ["meshRef"] = RefJson(node.MeshRef), ["materialRefs"] = new JsonArr(node.MaterialRefs.Select(RefJson)),
                    ["unsupported"] = new JsonArr(UnsupportedBindings(node).Concat(node.Skinned ? ["skinned renderer"] : [])),
                };
            })),
        })),
        ["unsupportedOverrides"] = new JsonArr(g.UnsupportedOverrides),
        ["effectiveSourceKnown"] = g.UnsupportedOverrides.Count == 0, ["runtimeSelectionSupported"] = false,
    }));
}
