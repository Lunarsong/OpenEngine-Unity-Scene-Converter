using System.Text.Json;

namespace GameEngine.UnityConverter;

/// Reader for Unity `.shadergraph` / `.shadersubgraph` assets.
///
/// The file is not a single JSON document: Unity serializes each graph object as
/// its own top-level `{...}` block, concatenated, cross-referencing by
/// `m_ObjectId`. The first block is the `GraphData` and holds the id lists for
/// properties, nodes and edges. Reading therefore means splitting on brace depth
/// (string-aware) and then resolving ids against an index.
internal static class ShaderGraphDocument
{
    /// Unity type names arrive assembly-qualified ("UnityEditor.ShaderGraph.AddNode, Unity.ShaderGraph.Editor").
    /// Everything downstream keys off the bare class name.
    public static string ShortTypeName(string? qualified)
    {
        if (string.IsNullOrEmpty(qualified))
            return string.Empty;
        int comma = qualified.IndexOf(',');
        string typePart = comma >= 0 ? qualified[..comma] : qualified;
        int dot = typePart.LastIndexOf('.');
        return dot >= 0 ? typePart[(dot + 1)..] : typePart;
    }

    public static List<string> SplitObjects(string text)
    {
        var blocks = new List<string>();
        int depth = 0;
        int start = -1;
        bool inString = false;
        bool escaped = false;

        for (int i = 0; i < text.Length; i++)
        {
            char c = text[i];
            if (inString)
            {
                if (escaped)
                    escaped = false;
                else if (c == '\\')
                    escaped = true;
                else if (c == '"')
                    inString = false;
                continue;
            }

            if (c == '"')
            {
                inString = true;
                continue;
            }

            if (c == '{')
            {
                if (depth == 0)
                    start = i;
                depth++;
            }
            else if (c == '}')
            {
                depth--;
                if (depth == 0 && start >= 0)
                {
                    blocks.Add(text[start..(i + 1)]);
                    start = -1;
                }
            }
        }
        return blocks;
    }

    public static UnityShaderGraph Parse(string text)
    {
        var graph = new UnityShaderGraph();
        var objects = new Dictionary<string, JsonElement>();
        var ordered = new List<JsonElement>();

        foreach (string block in SplitObjects(text))
        {
            JsonElement element;
            try
            {
                // Keep the document alive by cloning: JsonDocument owns its buffer.
                using JsonDocument parsed = JsonDocument.Parse(block);
                element = parsed.RootElement.Clone();
            }
            catch (JsonException)
            {
                continue;
            }
            ordered.Add(element);
            if (element.TryGetProperty("m_ObjectId", out JsonElement id) && id.ValueKind == JsonValueKind.String)
                objects[id.GetString()!] = element;
        }

        graph.Objects = objects;

        JsonElement root = default;
        bool foundRoot = false;
        foreach (JsonElement candidate in ordered)
        {
            if (candidate.TryGetProperty("m_Type", out JsonElement t) &&
                ShortTypeName(t.GetString()) == "GraphData")
            {
                root = candidate;
                foundRoot = true;
                break;
            }
        }
        if (!foundRoot)
            return graph;

        graph.SgVersion = root.TryGetProperty("m_SGVersion", out JsonElement v) && v.TryGetInt32(out int sgv) ? sgv : 0;

        foreach (string targetId in ReadIdList(root, "m_ActiveTargets"))
        {
            if (!objects.TryGetValue(targetId, out JsonElement target) ||
                !target.TryGetProperty("m_Type", out JsonElement tt))
            {
                continue;
            }

            // Each target names its active sub-target by object id; the other
            // sub-targets serialized in the file are inactive and say nothing
            // about how the graph is meant to render.
            string subTarget = string.Empty;
            if (target.TryGetProperty("m_ActiveSubTarget", out JsonElement active) &&
                active.TryGetProperty("m_Id", out JsonElement subId) &&
                subId.GetString() is { Length: > 0 } sid &&
                objects.TryGetValue(sid, out JsonElement sub) &&
                sub.TryGetProperty("m_Type", out JsonElement st))
            {
                subTarget = ShortTypeName(st.GetString());
            }
            graph.ActiveTargets.Add((ShortTypeName(tt.GetString()), subTarget));
        }

        foreach (string propertyId in ReadIdList(root, "m_Properties"))
        {
            if (!objects.TryGetValue(propertyId, out JsonElement obj))
                continue;
            graph.Properties.Add(ReadProperty(propertyId, obj));
        }

        foreach (string nodeId in ReadIdList(root, "m_Nodes"))
        {
            if (!objects.TryGetValue(nodeId, out JsonElement obj))
                continue;
            UnityNode node = ReadNode(nodeId, obj);
            AttachSlots(node, obj, objects);
            graph.Nodes.Add(node);
        }

        if (root.TryGetProperty("m_Edges", out JsonElement edges) && edges.ValueKind == JsonValueKind.Array)
        {
            foreach (JsonElement edge in edges.EnumerateArray())
            {
                UnityEdge? read = ReadEdge(edge);
                if (read != null)
                    graph.Edges.Add(read);
            }
        }

        return graph;
    }

    static List<string> ReadIdList(JsonElement owner, string field)
    {
        var ids = new List<string>();
        if (!owner.TryGetProperty(field, out JsonElement array) || array.ValueKind != JsonValueKind.Array)
            return ids;
        foreach (JsonElement entry in array.EnumerateArray())
        {
            if (entry.TryGetProperty("m_Id", out JsonElement id) && id.ValueKind == JsonValueKind.String)
                ids.Add(id.GetString()!);
        }
        return ids;
    }

    static UnityProperty ReadProperty(string objectId, JsonElement obj)
    {
        var prop = new UnityProperty
        {
            ObjectId = objectId,
            TypeName = obj.TryGetProperty("m_Type", out JsonElement t) ? ShortTypeName(t.GetString()) : string.Empty,
            Name = obj.TryGetProperty("m_Name", out JsonElement n) ? n.GetString() ?? string.Empty : string.Empty,
            Raw = obj,
        };

        if (obj.TryGetProperty("m_OverrideReferenceName", out JsonElement over) &&
            over.ValueKind == JsonValueKind.String && !string.IsNullOrEmpty(over.GetString()))
        {
            prop.ReferenceName = over.GetString()!;
        }
        else if (obj.TryGetProperty("m_DefaultReferenceName", out JsonElement def) &&
                 def.ValueKind == JsonValueKind.String)
        {
            prop.ReferenceName = def.GetString() ?? string.Empty;
        }

        if (obj.TryGetProperty("m_Value", out JsonElement value))
            prop.Value = value;

        return prop;
    }

    static UnityNode ReadNode(string objectId, JsonElement obj)
    {
        var node = new UnityNode
        {
            ObjectId = objectId,
            TypeName = obj.TryGetProperty("m_Type", out JsonElement t) ? ShortTypeName(t.GetString()) : string.Empty,
            Name = obj.TryGetProperty("m_Name", out JsonElement n) ? n.GetString() ?? string.Empty : string.Empty,
            Raw = obj,
        };

        if (obj.TryGetProperty("m_DrawState", out JsonElement draw) &&
            draw.TryGetProperty("m_Position", out JsonElement pos))
        {
            if (pos.TryGetProperty("x", out JsonElement px) && px.TryGetDouble(out double x))
                node.PositionX = x;
            if (pos.TryGetProperty("y", out JsonElement py) && py.TryGetDouble(out double y))
                node.PositionY = y;
        }

        if (obj.TryGetProperty("m_Property", out JsonElement propRef) &&
            propRef.TryGetProperty("m_Id", out JsonElement propId))
        {
            node.PropertyObjectId = propId.GetString();
        }

        if (obj.TryGetProperty("m_SerializedDescriptor", out JsonElement desc) &&
            desc.ValueKind == JsonValueKind.String)
        {
            node.BlockDescriptor = desc.GetString();
        }

        return node;
    }

    /// A Unity slot carries the literal a pin uses when nothing is wired to it, so an
    /// unconnected input is a value rather than an absence. Slots are separate objects
    /// referenced from the node's m_Slots list.
    static void AttachSlots(UnityNode node, JsonElement obj, Dictionary<string, JsonElement> objects)
    {
        foreach (string slotId in ReadIdList(obj, "m_Slots"))
        {
            if (!objects.TryGetValue(slotId, out JsonElement slot))
                continue;
            if (!slot.TryGetProperty("m_Id", out JsonElement id) || !id.TryGetInt32(out int numericId))
                continue;

            var read = new UnitySlot
            {
                Id = numericId,
                IsInput = !slot.TryGetProperty("m_SlotType", out JsonElement type) ||
                          !type.TryGetInt32(out int typeValue) || typeValue == 0,
                DisplayName = slot.TryGetProperty("m_DisplayName", out JsonElement dn)
                    ? dn.GetString() ?? string.Empty
                    : string.Empty,
                TypeName = slot.TryGetProperty("m_Type", out JsonElement slotType)
                    ? ShortTypeName(slotType.GetString())
                    : string.Empty,
            };
            if (slot.TryGetProperty("m_Value", out JsonElement value))
                read.Value = value;
            node.Slots[numericId] = read;
        }
    }

    static UnityEdge? ReadEdge(JsonElement edge)
    {
        if (!edge.TryGetProperty("m_OutputSlot", out JsonElement outSlot) ||
            !edge.TryGetProperty("m_InputSlot", out JsonElement inSlot))
        {
            return null;
        }

        string? outNode = ReadSlotNode(outSlot);
        string? inNode = ReadSlotNode(inSlot);
        if (outNode == null || inNode == null)
            return null;

        return new UnityEdge
        {
            OutputNodeId = outNode,
            OutputSlotId = ReadSlotId(outSlot),
            InputNodeId = inNode,
            InputSlotId = ReadSlotId(inSlot),
        };
    }

    static string? ReadSlotNode(JsonElement slot)
    {
        if (slot.TryGetProperty("m_Node", out JsonElement node) &&
            node.TryGetProperty("m_Id", out JsonElement id) && id.ValueKind == JsonValueKind.String)
        {
            return id.GetString();
        }
        return null;
    }

    static int ReadSlotId(JsonElement slot)
    {
        return slot.TryGetProperty("m_SlotId", out JsonElement id) && id.TryGetInt32(out int value) ? value : 0;
    }
}

internal sealed class UnityShaderGraph
{
    public int SgVersion;

    /// Active targets with the sub-target each one names as active.
    public List<(string Target, string SubTarget)> ActiveTargets = new();
    public List<UnityProperty> Properties = new();
    public List<UnityNode> Nodes = new();
    public List<UnityEdge> Edges = new();
    public Dictionary<string, JsonElement> Objects = new();

    public UnityNode? FindNode(string objectId) => Nodes.FirstOrDefault(n => n.ObjectId == objectId);

    public UnityProperty? FindProperty(string objectId) =>
        Properties.FirstOrDefault(p => p.ObjectId == objectId);

    /// The lighting model comes from one target's active sub-target. When a graph
    /// carries both a URP and a Built-In target the URP one decides: this engine's
    /// pipeline is URP-shaped, and mixed pairs (Built-In Lit + Universal Unlit)
    /// are how Unity serializes a graph authored for URP with a fallback.
    public bool IsUnlit
    {
        get
        {
            (string Target, string SubTarget) decisive =
                ActiveTargets.FirstOrDefault(t => t.Target == "UniversalTarget");
            if (decisive.Target is null)
                decisive = ActiveTargets.FirstOrDefault();
            return decisive.SubTarget?.Contains("Unlit", StringComparison.Ordinal) == true;
        }
    }
}

internal sealed class UnityProperty
{
    public string ObjectId = string.Empty;
    public string TypeName = string.Empty;
    public string Name = string.Empty;
    public string ReferenceName = string.Empty;
    public JsonElement Value;
    public JsonElement Raw;
}

internal sealed class UnityNode
{
    public string ObjectId = string.Empty;
    public string TypeName = string.Empty;
    public string Name = string.Empty;
    public double PositionX;
    public double PositionY;
    public string? PropertyObjectId;
    public string? BlockDescriptor;
    public JsonElement Raw;

    /// Slot id -> slot, covering inputs and outputs.
    public Dictionary<int, UnitySlot> Slots = new();

    /// The literal an unconnected input pin uses, as component values.
    public double[] SlotLiteral(int slotId)
    {
        if (!Slots.TryGetValue(slotId, out UnitySlot? slot))
            return Array.Empty<double>();
        return slot.ReadComponents();
    }
}

internal sealed class UnitySlot
{
    public int Id;
    public bool IsInput;
    public string DisplayName = string.Empty;

    /// Unity slot class name, which carries the pin's declared type.
    public string TypeName = string.Empty;
    public JsonElement Value;

    public double[] ReadComponents()
    {
        if (Value.ValueKind == JsonValueKind.Number && Value.TryGetDouble(out double scalar))
            return new[] { scalar };
        if (Value.ValueKind == JsonValueKind.True)
            return new[] { 1.0 };
        if (Value.ValueKind == JsonValueKind.False)
            return new[] { 0.0 };
        if (Value.ValueKind != JsonValueKind.Object)
            return Array.Empty<double>();

        var values = new List<double>();
        foreach (string key in new[] { "x", "y", "z", "w" })
        {
            if (Value.TryGetProperty(key, out JsonElement c) && c.TryGetDouble(out double cv))
                values.Add(cv);
        }
        return values.ToArray();
    }
}

internal sealed class UnityEdge
{
    public string OutputNodeId = string.Empty;
    public int OutputSlotId;
    public string InputNodeId = string.Empty;
    public int InputSlotId;
}
