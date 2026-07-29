namespace GameEngine.UnityConverter;

internal sealed class LightInfo
{
    public required string Type; // "directional" | "point"
    public double[] Color = [1, 1, 1];
    public double Intensity = 1;
    public double Range = 10;
    public bool Shadows;
    public bool Enabled;
}

/// One scene-graph node — port of convert.js makeNode()/cloneNode(). The
/// `Father` field carries the same three states the JS uses: null =
/// unresolved (pre-pass-6) or root (post-pass-6), "ROOT" = transient
/// sentinel, otherwise a node id.
internal sealed class SceneNode
{
    public string Id = "";
    public string Name = "";
    public bool Active = true;
    public double[] Pos = [0, 0, 0];
    public double[] Rot = [0, 0, 0, 1];
    public double[] Scale = [1, 1, 1];
    public string FatherAnchor = "0";
    public string? Father;
    public List<string> Children = [];
    public string? MeshFbxGuid;
    public string? MeshPrimitive;
    public double MatCount = 1;
    public List<string?> MatGuids = [];
    public bool CastShadows = true;
    public bool ReceiveShadows = true;
    public bool RendererEnabled = true;
    public bool Skinned;
    public bool NonStaticFbx;
    public LightInfo? Light;
    public double? UrpShadowTier;
    public double Order;

    public static SceneNode Make(string? name)
    {
        return new SceneNode { Id = "n" + (++G.NodeCounter), Name = name ?? "" };
    }

    public SceneNode Clone()
    {
        var c = new SceneNode
        {
            Id = "n" + (++G.NodeCounter),
            Name = Name,
            Active = Active,
            Pos = [.. Pos],
            Rot = [.. Rot],
            Scale = [.. Scale],
            FatherAnchor = FatherAnchor,
            Father = Father,
            Children = [],
            MeshFbxGuid = MeshFbxGuid,
            MeshPrimitive = MeshPrimitive,
            MatCount = MatCount,
            MatGuids = [.. MatGuids],
            CastShadows = CastShadows,
            ReceiveShadows = ReceiveShadows,
            RendererEnabled = RendererEnabled,
            Skinned = Skinned,
            NonStaticFbx = NonStaticFbx,
            Light = Light,
            UrpShadowTier = UrpShadowTier,
            Order = Order,
        };
        return c;
    }

    // JS sparse-array semantics for matGuids[idx] = value.
    public void SetMatGuid(int idx, string? guid)
    {
        while (MatGuids.Count <= idx) MatGuids.Add(null);
        MatGuids[idx] = guid;
    }

    public string? GetMatGuid(int idx) => idx >= 0 && idx < MatGuids.Count ? MatGuids[idx] : null;
}

/// Parsed file structure — nodes in insertion order plus anchor aliases.
internal sealed class FileStructure
{
    public bool IsFbx;
    public readonly List<string> NodeOrder = [];
    public readonly Dictionary<string, SceneNode> NodesById = [];
    public readonly Dictionary<string, string> AnchorToNode = [];
    public readonly List<string> RootIds = [];
    public Dictionary<string, InstanceClone>? InstanceClones;

    public SceneNode Get(string id) => NodesById[id];
    public SceneNode? TryGet(string? id) => id != null && NodesById.TryGetValue(id, out SceneNode? n) ? n : null;
    public int Count => NodeOrder.Count;

    public void Add(SceneNode node)
    {
        NodeOrder.Add(node.Id);
        NodesById[node.Id] = node;
    }

    public IEnumerable<SceneNode> Nodes()
    {
        foreach (string id in NodeOrder) yield return NodesById[id];
    }
}

internal sealed class InstanceClone
{
    public required FileStructure Sub;
    public required Dictionary<string, string> Map; // sub node id -> clone id
    public required string RootCloneId;
}
