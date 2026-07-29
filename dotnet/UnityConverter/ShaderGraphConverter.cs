using System.Globalization;
using System.Text;
using System.Text.Json;

namespace GameEngine.UnityConverter;

/// Unity `.shadergraph` -> engine SG v2 shader-graph source (a `.glsl` file whose
/// `// @sg-*` tag block is authoritative).
///
/// Two conversions carry real semantics and are done here rather than left to the
/// engine:
///
///   * Width lowering. Unity's dynamic slots are commonly vec4 while the engine's
///     SurfaceOutput has no vec4 pin (BaseColor is vec3, Opacity is float) and the
///     node library is float/vec3. A component-wise vec4 operation is therefore
///     lowered into an rgb node plus an alpha node, which is exact for per-channel
///     math and refused for anything else.
///   * Smoothness -> Roughness. Unity authors the complement of what the engine
///     stores, so a bare property is inverted at import and a computed value gets
///     an inserted OneMinus.
///
/// Anything without a faithful mapping is named in Report.Dropped rather than
/// approximated.
internal sealed class ShaderGraphConverter
{
    const string kNodeIdPrefix = "n_";
    const int kNodeIdHexLength = 8;
    const string kSurfaceSinkId = "surface_out";
    const int kSemanticSlotBaseColor = 0;
    const int kSemanticSlotPbrScalars = 1;
    const string kMetallicComponent = "x";
    const string kRoughnessComponent = "y";
    const string kEngineInputId = "engine_in";
    const double kSinkNodeX = 420;
    const double kSinkNodeSpacingY = 120;
    const double kAlphaLaneOffsetY = 140;

    readonly UnityShaderGraph m_Graph;
    readonly string m_GraphName;
    readonly ShaderGraphConversionReport m_Report = new();

    readonly List<string> m_PropertyTags = new();
    readonly List<string> m_TextureTags = new();
    readonly List<EmittedNode> m_Nodes = new();
    readonly List<string> m_Edges = new();

    /// Unity output slot -> already-lowered engine value.
    readonly Dictionary<string, LoweredValue> m_Lowered = new(StringComparer.Ordinal);
    readonly HashSet<string> m_InFlight = new(StringComparer.Ordinal);

    /// Unity property object id -> how that property reaches the shader.
    readonly Dictionary<string, PropertyPlan> m_PropertyPlans = new(StringComparer.Ordinal);

    double m_SinkFixupY;

    /// Emitted lazily: only a graph that reads an engine input grows the node.
    string? m_EngineInputNodeId;

    ShaderGraphConverter(UnityShaderGraph graph, string graphName)
    {
        m_Graph = graph;
        m_GraphName = graphName;
    }

    public static ShaderGraphConversionResult Convert(string unityJson, string graphName)
    {
        UnityShaderGraph graph = ShaderGraphDocument.Parse(unityJson);
        var converter = new ShaderGraphConverter(graph, graphName);
        return converter.Run();
    }

    ShaderGraphConversionResult Run()
    {
        if (m_Graph.Nodes.Count == 0)
        {
            m_Report.Dropped.Add((m_GraphName, "not a readable Unity shader graph (no GraphData nodes)"));
            return new ShaderGraphConversionResult { Success = false, Report = m_Report };
        }

        PlanProperties();

        bool wiredAnySurfacePin = false;
        foreach (UnityNode node in m_Graph.Nodes)
        {
            if (node.TypeName != "BlockNode" || node.BlockDescriptor == null)
                continue;

            if (ShaderGraphNodeMap.kSurfaceBlocks.TryGetValue(node.BlockDescriptor,
                    out ShaderGraphNodeMap.SgBlockMapping? block))
            {
                if (WireSurfaceBlock(node, block))
                    wiredAnySurfacePin = true;
                continue;
            }

            if (node.BlockDescriptor == ShaderGraphNodeMap.kAlphaClipThresholdBlock)
            {
                ApplyAlphaClipThreshold(node);
                continue;
            }

            if (node.BlockDescriptor == ShaderGraphNodeMap.kVertexPositionBlock)
            {
                WireVertexPosition(node);
                continue;
            }

            if (ShaderGraphNodeMap.kIgnorableVertexBlocks.Contains(node.BlockDescriptor))
                continue;

            if (FindDrivingEdge(node.ObjectId, ShaderGraphNodeMap.kBlockInputSlot) != null)
                m_Report.Dropped.Add((node.BlockDescriptor, "no engine surface pin for this Unity block"));
        }

        if (!wiredAnySurfacePin)
        {
            m_Report.Dropped.Add((m_GraphName, "no convertible SurfaceDescription block was connected"));
            return new ShaderGraphConversionResult { Success = false, Report = m_Report };
        }

        m_Nodes.Add(new EmittedNode(kSurfaceSinkId, "SurfaceOutput", 640, 0, new()));

        return new ShaderGraphConversionResult
        {
            Success = true,
            Source = Emit(),
            Report = m_Report,
            MaterialProperties = m_Report.MaterialProperties,
        };
    }

    // ------------------------------------------------------------ properties --

    void PlanProperties()
    {
        foreach (UnityProperty prop in m_Graph.Properties)
        {
            string reference = string.IsNullOrEmpty(prop.ReferenceName) ? prop.Name : prop.ReferenceName;
            string normalized = ShaderGraphNodeMap.NormalizeName(reference);

            if (prop.TypeName == ShaderGraphNodeMap.kTexturePropertyType)
            {
                PlanTextureProperty(prop, normalized);
                continue;
            }

            if (!ShaderGraphNodeMap.kPropertyTypes.TryGetValue(prop.TypeName, out (string SgType, int Width) info))
            {
                m_Report.Dropped.Add((prop.Name, $"unsupported Unity property type {prop.TypeName}"));
                continue;
            }

            ShaderGraphNodeMap.kSemanticProperties.TryGetValue(normalized, out string? semantic);
            m_PropertyPlans[prop.ObjectId] = BuildPropertyPlan(prop, info.SgType, info.Width, semantic);
        }
    }

    void PlanTextureProperty(UnityProperty prop, string normalized)
    {
        if (!ShaderGraphNodeMap.kSemanticTextures.TryGetValue(normalized, out string? slotName))
        {
            m_Report.Dropped.Add((prop.Name,
                "texture has no canonical engine slot name; bind it manually after import"));
            return;
        }

        // The engine resolves the texture by the material's binding, so the graph
        // only needs the slot name. The GUID stays empty: the .material carries it.
        string hint = slotName == "normalMap" ? "linear" : "srgb";
        m_TextureTags.Add($"// @sg-texture   {slotName} \"\" hint={hint}");
        m_PropertyPlans[prop.ObjectId] = new PropertyPlan
        {
            Kind = PropertyKind.Texture,
            Reference = slotName,
            Width = 0,
        };
        m_Report.TextureSlots[slotName] = prop.Name;
    }

    PropertyPlan BuildPropertyPlan(UnityProperty prop, string sgType, int width, string? semanticKey)
    {
        double[] values = ReadPropertyValues(prop, width);

        // Unity Smoothness is stored as the complement of the engine's Roughness.
        bool isSmoothness = ShaderGraphNodeMap.NormalizeName(
            string.IsNullOrEmpty(prop.ReferenceName) ? prop.Name : prop.ReferenceName) == "smoothness";
        if (isSmoothness)
        {
            semanticKey = "roughness";
            if (values.Length >= 1)
                values[0] = 1.0 - values[0];
        }

        if (semanticKey == "baseColor" || semanticKey == "emissive")
        {
            // Vector semantics live in a real MaterialData field, so the graph can
            // read the field by name and the material keeps an editable row.
            string field = semanticKey == "baseColor" ? "uBaseColor" : "uParams18";
            if (semanticKey == "baseColor")
            {
                m_PropertyTags.Add($"// @sg-property  {field} vec4 default={FormatList(values, 4)} public=true");
                m_Report.MaterialProperties[semanticKey] = values.Take(4).ToArray();
                return new PropertyPlan
                {
                    Kind = PropertyKind.MaterialField,
                    Reference = field,
                    Width = 4,
                    Values = values,
                };
            }

            m_Report.MaterialProperties[semanticKey] = values.Take(3).ToArray();
            return new PropertyPlan
            {
                Kind = PropertyKind.InlineConstant,
                Reference = prop.Name,
                Width = 3,
                Values = values,
            };
        }

        if (semanticKey == "metallic" || semanticKey == "roughness")
        {
            m_Report.MaterialProperties[semanticKey] = new[] { values.Length > 0 ? values[0] : 0.0 };
            return new PropertyPlan
            {
                Kind = PropertyKind.SemanticScalar,
                Reference = prop.Name,
                Width = 1,
                Values = values,
                MaterialKey = semanticKey,
            };
        }

        if (semanticKey == "alphaCutoff")
        {
            m_Report.MaterialProperties[semanticKey] = new[] { values.Length > 0 ? values[0] : 0.5 };
            return new PropertyPlan { Kind = PropertyKind.AlphaCutoff, Reference = prop.Name, Width = 1, Values = values };
        }

        // No engine field carries this one. Bake the authored default so the shader
        // is correct, and say so: the value stops being runtime-editable.
        m_Report.Dropped.Add((prop.Name,
            "no engine material slot for this property; baked at its authored default (not runtime-editable)"));
        return new PropertyPlan
        {
            Kind = PropertyKind.InlineConstant,
            Reference = prop.Name,
            Width = width,
            Values = values,
        };
    }

    double[] ReadPropertyValues(UnityProperty prop, int width)
    {
        JsonElement v = prop.Value;
        if (v.ValueKind == JsonValueKind.Number && v.TryGetDouble(out double scalar))
            return new[] { scalar };
        if (v.ValueKind == JsonValueKind.True)
            return new[] { 1.0 };
        if (v.ValueKind == JsonValueKind.False)
            return new[] { 0.0 };

        if (v.ValueKind == JsonValueKind.Object)
        {
            var values = new List<double>();
            foreach (string key in new[] { "r", "g", "b", "a" })
            {
                if (v.TryGetProperty(key, out JsonElement c) && c.TryGetDouble(out double cv))
                    values.Add(cv);
            }
            if (values.Count > 0)
                return values.ToArray();

            foreach (string key in new[] { "x", "y", "z", "w" })
            {
                if (v.TryGetProperty(key, out JsonElement c) && c.TryGetDouble(out double cv))
                    values.Add(cv);
            }
            if (values.Count > 0)
                return values.ToArray();
        }

        return Enumerable.Repeat(0.0, Math.Max(1, width)).ToArray();
    }

    // ----------------------------------------------------------------- sinks --

    bool WireSurfaceBlock(UnityNode block, ShaderGraphNodeMap.SgBlockMapping mapping)
    {
        UnityEdge? driver = FindDrivingEdge(block.ObjectId, ShaderGraphNodeMap.kBlockInputSlot);
        if (driver == null)
            return false;

        LoweredValue? value = Lower(driver.OutputNodeId, driver.OutputSlotId);
        if (value == null)
            return false;

        string? source = ProjectTo(value, mapping.Width);
        if (source == null)
        {
            m_Report.Dropped.Add((block.BlockDescriptor ?? mapping.EnginePin,
                $"cannot express a width-{value.Width} value as the engine's {mapping.EnginePin} pin"));
            return false;
        }

        if (mapping.InvertScalar && !value.IsEngineConvention)
            source = EmitSinkNode("OneMinus", new() { ["value"] = source }, kScalarPin, mapping.EnginePin);

        m_Edges.Add($"// @sg-edge      {source} -> {kSurfaceSinkId}.{mapping.EnginePin}");
        return true;
    }

    void ApplyAlphaClipThreshold(UnityNode block)
    {
        UnityEdge? driver = FindDrivingEdge(block.ObjectId, ShaderGraphNodeMap.kBlockInputSlot);
        if (driver == null)
            return;

        UnityNode? source = m_Graph.FindNode(driver.OutputNodeId);
        if (source?.TypeName == "PropertyNode" && source.PropertyObjectId != null &&
            m_PropertyPlans.TryGetValue(source.PropertyObjectId, out PropertyPlan? plan) &&
            plan.Values.Length > 0)
        {
            m_Report.MaterialProperties["alphaCutoff"] = new[] { plan.Values[0] };
            m_Report.AlphaMode = "Mask";
            return;
        }

        m_Report.Dropped.Add((ShaderGraphNodeMap.kAlphaClipThresholdBlock,
            "alpha clip threshold is computed in the graph; the engine takes a constant material cutoff"));
    }

    void WireVertexPosition(UnityNode block)
    {
        UnityEdge? driver = FindDrivingEdge(block.ObjectId, ShaderGraphNodeMap.kBlockInputSlot);
        if (driver == null)
            return;

        m_Report.Dropped.Add((ShaderGraphNodeMap.kVertexPositionBlock,
            "vertex position is driven in the Unity graph; vertex-stage conversion is not implemented"));
    }

    // -------------------------------------------------------------- lowering --

    LoweredValue? Lower(string nodeId, int outputSlot)
    {
        string key = nodeId + "#" + outputSlot.ToString(CultureInfo.InvariantCulture);
        if (m_Lowered.TryGetValue(key, out LoweredValue? cached))
            return cached;

        if (!m_InFlight.Add(nodeId))
        {
            m_Report.Dropped.Add((nodeId, "cyclic graph"));
            return null;
        }

        LoweredValue? result = LowerUncached(nodeId, outputSlot);
        m_InFlight.Remove(nodeId);

        if (result != null)
            m_Lowered[key] = result;
        return result;
    }

    LoweredValue? LowerUncached(string nodeId, int outputSlot)
    {
        UnityNode? node = m_Graph.FindNode(nodeId);
        if (node == null)
            return null;

        if (ShaderGraphNodeMap.kCosmeticNodes.Contains(node.TypeName) ||
            ShaderGraphNodeMap.kImplicitNodes.Contains(node.TypeName))
        {
            return null;
        }

        if (ShaderGraphNodeMap.kPassThroughNodes.Contains(node.TypeName))
        {
            UnityEdge? through = FindDrivingEdge(node.ObjectId, 0);
            return through == null ? null : Lower(through.OutputNodeId, through.OutputSlotId);
        }

        if (ShaderGraphNodeMap.kConstantNodes.TryGetValue(node.TypeName,
                out (string EngineNode, int Width) constant))
        {
            return LowerConstantNode(node, constant.EngineNode, constant.Width);
        }

        if (ShaderGraphNodeMap.kEngineInputNodes.TryGetValue(node.TypeName,
                out ShaderGraphNodeMap.SgEngineInputMapping? engineInput))
        {
            return LowerEngineInput(node, engineInput, outputSlot);
        }

        if (node.TypeName == "CustomFunctionNode")
            return LowerCustomFunction(node, outputSlot);

        switch (node.TypeName)
        {
            case "PropertyNode":
                return LowerProperty(node);
            case "SplitNode":
                return LowerSplit(node, outputSlot);
            case "BranchNode":
                return LowerBranch(node);
            case "RemapNode":
                return LowerRemap(node);
        }

        if (ShaderGraphNodeMap.kNodes.TryGetValue(node.TypeName, out SgNodeMapping? mapping))
            return LowerMapped(node, mapping, outputSlot);

        m_Report.Dropped.Add((node.TypeName, "no engine node maps this Unity node"));
        return null;
    }

    /// A Custom Function becomes a standalone `@sgnode` .glsl node file, which the
    /// reflector picks up from the project's Assets tree, plus a normal node
    /// reference in the graph.
    LoweredValue? LowerCustomFunction(UnityNode node, int outputSlot)
    {
        ShaderGraphCustomFunction.Translation? translation =
            ShaderGraphCustomFunction.TryTranslate(node, out string failure);
        if (translation == null)
        {
            m_Report.Dropped.Add((node.Name.Length > 0 ? node.Name : "CustomFunctionNode", failure));
            return null;
        }

        m_Report.GeneratedNodeFiles[translation.FileName] = translation.Source;

        // Inputs are the node's input slots in declared order; the translated
        // signature keeps that order, so pins line up with Unity's slot ids.
        var args = new Dictionary<string, string>();
        var inputSlots = node.Slots.Where(s => s.Value.IsInput).OrderBy(s => s.Key).ToList();
        int pinIndex = 0;
        foreach (KeyValuePair<int, UnitySlot> entry in inputSlots)
        {
            if (pinIndex >= translation.Inputs.Count)
                break;
            string pin = translation.Inputs[pinIndex].Pin;
            int targetWidth = GlslWidth(translation.Inputs[pinIndex].GlslType);
            pinIndex++;

            UnityEdge? edge = FindDrivingEdge(node.ObjectId, entry.Key);
            if (edge != null)
            {
                LoweredValue? driven = Lower(edge.OutputNodeId, edge.OutputSlotId);
                string? projected = driven == null ? null : ProjectTo(driven, targetWidth);
                if (projected != null)
                {
                    args[pin] = projected;
                    continue;
                }
            }
            double[] literal = entry.Value.ReadComponents();
            if (literal.Length > 0)
                args[pin] = ProjectTo(LiteralValue(literal), targetWidth) ?? FormatScalar(0);
        }

        var outputSlots = node.Slots.Where(s => !s.Value.IsInput).OrderBy(s => s.Key).ToList();
        int outputIndex = outputSlots.FindIndex(s => s.Key == outputSlot);
        if (outputIndex < 0 || outputIndex >= translation.Outputs.Count)
            return null;

        (string Pin, string GlslType) output = translation.Outputs[outputIndex];
        string id = EmitNode(translation.TypeId, args, output.Pin, node);
        return new LoweredValue { Main = id, Width = GlslWidth(output.GlslType) };
    }

    static int GlslWidth(string glslType) => glslType switch
    {
        "vec4" => 4,
        "vec3" => 3,
        "vec2" => 2,
        _ => 1,
    };

    /// A Unity constant node keeps its components in its input slots (X, Y, Z, W),
    /// each of which may itself be driven by an edge.
    LoweredValue? LowerConstantNode(UnityNode node, string engineNode, int width)
    {
        var components = new List<string>();
        for (int slotId = 1; slotId <= width; slotId++)
        {
            UnityEdge? edge = FindDrivingEdge(node.ObjectId, slotId);
            if (edge != null)
            {
                LoweredValue? driven = Lower(edge.OutputNodeId, edge.OutputSlotId);
                string? projected = driven == null ? null : ProjectTo(driven, 1);
                if (projected != null)
                {
                    components.Add(projected);
                    continue;
                }
            }
            double[] literal = node.SlotLiteral(slotId);
            components.Add(FormatScalar(literal.ElementAtOrDefault(0)));
        }

        if (width == 1)
        {
            string scalarId = EmitNode(engineNode, new(), "value", node,
                extra: new Dictionary<string, string> { ["value"] = components[0] });
            return new LoweredValue { Main = scalarId, Width = 1 };
        }

        var attrs = new Dictionary<string, string>();
        string[] names = { "x", "y", "z", "w" };
        for (int i = 0; i < width; i++)
            attrs[names[i]] = components[i];
        string id = EmitNode(engineNode, new(), "value", node, extra: attrs);
        return new LoweredValue { Main = id, Width = width };
    }

    /// Unity's geometry/time source nodes all become pins on one shared EngineInput
    /// node, so a graph reading position and normal does not grow two source nodes.
    LoweredValue? LowerEngineInput(UnityNode node, ShaderGraphNodeMap.SgEngineInputMapping mapping,
                                   int outputSlot)
    {
        if (!mapping.PinBySlot.TryGetValue(outputSlot, out string? pin))
        {
            m_Report.Dropped.Add((node.TypeName,
                $"output slot {outputSlot} has no engine equivalent on this input node"));
            return null;
        }

        if (m_EngineInputNodeId == null)
        {
            m_EngineInputNodeId = kEngineInputId;
            m_Nodes.Add(new EmittedNode(kEngineInputId, "EngineInput", node.PositionX, node.PositionY,
                                        new Dictionary<string, string>()));
        }
        return new LoweredValue { Main = m_EngineInputNodeId + "." + pin, Width = mapping.Width };
    }

    LoweredValue? LowerProperty(UnityNode node)
    {
        if (node.PropertyObjectId == null ||
            !m_PropertyPlans.TryGetValue(node.PropertyObjectId, out PropertyPlan? plan))
        {
            return null;
        }

        switch (plan.Kind)
        {
            case PropertyKind.Texture:
                // A texture name is a valid edge source on its own.
                return new LoweredValue { Main = plan.Reference, Width = 0 };

            case PropertyKind.MaterialField:
            {
                // An edge sourced from a property name resolves to the whole field
                // (`Mat.uBaseColor`, a vec4), which GLSL will not narrow to a vec3
                // pin. A parameter node carries the swizzle that makes it a vec3.
                string rgb = EmitNode("Vec3Parameter", new(), "value", node, extra: new()
                {
                    ["slot"] = kSemanticSlotBaseColor.ToString(CultureInfo.InvariantCulture),
                    ["swizzle"] = "xyz",
                    ["variableName"] = plan.Reference,
                });
                var value = new LoweredValue { Main = rgb, Width = Math.Min(plan.Width, 3) };
                if (plan.Width >= 4)
                {
                    value.Width = 4;
                    // An edge carries a whole field, so the field's w component needs a
                    // parameter node to become a float pin.
                    value.AlphaFactory = () => EmitNode("FloatParameter", new(), "value", node, extra: new()
                    {
                        ["slot"] = kSemanticSlotBaseColor.ToString(CultureInfo.InvariantCulture),
                        ["component"] = "w",
                        ["variableName"] = plan.Reference,
                    }, alphaLane: true);
                }
                return value;
            }

            case PropertyKind.SemanticScalar:
            {
                string component = plan.MaterialKey == "metallic" ? kMetallicComponent : kRoughnessComponent;
                string id = EmitNode("FloatParameter", new(), "value", node, extra: new()
                {
                    ["slot"] = kSemanticSlotPbrScalars.ToString(CultureInfo.InvariantCulture),
                    ["component"] = component,
                    ["variableName"] = plan.MaterialKey ?? plan.Reference,
                });
                // The stored material value is already in engine convention (a Unity
                // smoothness was complemented at import), so the sink must not invert
                // it a second time.
                return new LoweredValue { Main = id, Width = 1, IsEngineConvention = true };
            }

            case PropertyKind.AlphaCutoff:
                return LiteralValue(new[] { plan.Values.FirstOrDefault() });

            default:
                return LowerInlineConstant(plan, node);
        }
    }

    LoweredValue? LowerInlineConstant(PropertyPlan plan, UnityNode node)
    {
        if (plan.Width <= 1)
        {
            string id = EmitNode("FloatConstant", new(), "value", node, extra: new()
            {
                ["value"] = FormatScalar(plan.Values.FirstOrDefault()),
            });
            return new LoweredValue { Main = id, Width = 1 };
        }

        double[] v = plan.Values;
        var extra = new Dictionary<string, string>
        {
            ["r"] = FormatScalar(v.ElementAtOrDefault(0)),
            ["g"] = FormatScalar(v.ElementAtOrDefault(1)),
            ["b"] = FormatScalar(v.ElementAtOrDefault(2)),
        };
        string vecId = EmitNode("ColorConstant", new(), "value", node, extra: extra);
        var lowered = new LoweredValue { Main = vecId, Width = 3 };
        if (plan.Width >= 4)
        {
            lowered.Width = 4;
            lowered.Alpha = EmitNode("FloatConstant", new(), "value", node, extra: new()
            {
                ["value"] = FormatScalar(v.ElementAtOrDefault(3)),
            }, alphaLane: true);
        }
        return lowered;
    }

    LoweredValue? LowerSplit(UnityNode node, int outputSlot)
    {
        UnityEdge? driver = FindDrivingEdge(node.ObjectId, 0);
        if (driver == null)
            return null;

        LoweredValue? source = Lower(driver.OutputNodeId, driver.OutputSlotId);
        if (source == null)
            return null;

        if (!ShaderGraphNodeMap.kSplitChannelBySlot.TryGetValue(outputSlot, out int channel))
            return null;

        if (channel == 3)
        {
            string? alpha = AlphaLaneOf(source);
            if (alpha != null)
                return new LoweredValue { Main = alpha, Width = 1 };
            m_Report.Dropped.Add(("Split.A", "split alpha of a value that carries no alpha channel"));
            return null;
        }

        if (source.Width < 3)
            return channel == 0 ? new LoweredValue { Main = source.Main, Width = 1 } : null;

        string decomposed = EmitNode("VectorDecompose", new() { ["value"] = source.Main },
            channel == 0 ? "x" : channel == 1 ? "y" : "z", node);
        return new LoweredValue { Main = decomposed, Width = 1 };
    }

    LoweredValue? LowerBranch(UnityNode node)
    {
        UnityEdge? predicateEdge = FindDrivingEdge(node.ObjectId, ShaderGraphNodeMap.kBranchPredicateSlot);
        UnityEdge? trueEdge = FindDrivingEdge(node.ObjectId, ShaderGraphNodeMap.kBranchTrueSlot);
        UnityEdge? falseEdge = FindDrivingEdge(node.ObjectId, ShaderGraphNodeMap.kBranchFalseSlot);

        LoweredValue? predicate = predicateEdge == null
            ? null
            : Lower(predicateEdge.OutputNodeId, predicateEdge.OutputSlotId);
        LoweredValue? whenTrue = trueEdge == null ? null : Lower(trueEdge.OutputNodeId, trueEdge.OutputSlotId);
        LoweredValue? whenFalse = falseEdge == null ? null : Lower(falseEdge.OutputNodeId, falseEdge.OutputSlotId);

        if (predicate == null)
            return null;

        int width = Math.Max(whenTrue?.Width ?? 1, whenFalse?.Width ?? 1);
        int pinWidth = Math.Min(width, 3);
        string trueRef = ProjectOrZero(whenTrue, pinWidth);
        string falseRef = ProjectOrZero(whenFalse, pinWidth);
        string predicateRef = ProjectOrZero(predicate, 1);

        if (width >= 3)
        {
            // mix(a, b, weight) with a 0/1 weight is Unity's Branch for vectors.
            string id = EmitNode("ColorMix",
                new() { ["a"] = falseRef, ["b"] = trueRef, ["weight"] = predicateRef }, kVectorPin, node);
            return new LoweredValue { Main = id, Width = 3 };
        }

        string scalarId = EmitNode("If",
            new() { ["condition"] = predicateRef, ["trueVal"] = trueRef, ["falseVal"] = falseRef }, "out", node);
        return new LoweredValue { Main = scalarId, Width = 1 };
    }

    /// Unity's Remap packs each range into one Vector2 slot (In=0, InMinMax=1,
    /// OutMinMax=2, Out=3); the engine's Remap takes four float pins. The ranges
    /// are authored constants in practice, so they split onto the pins; a wired
    /// range cannot be split and is an honest, named drop.
    LoweredValue? LowerRemap(UnityNode node)
    {
        UnityEdge? valueEdge = FindDrivingEdge(node.ObjectId, 0);
        LoweredValue? driven = valueEdge == null
            ? null
            : Lower(valueEdge.OutputNodeId, valueEdge.OutputSlotId);
        if (driven == null)
            return null;
        if (driven.Width >= 3)
        {
            m_Report.Dropped.Add((node.TypeName,
                $"engine has no vec3 form of this node; the graph applies it to a width-{driven.Width} value"));
            return null;
        }

        if (FindDrivingEdge(node.ObjectId, 1) != null || FindDrivingEdge(node.ObjectId, 2) != null)
        {
            m_Report.Dropped.Add((node.TypeName,
                "a min/max range is wired from a node; the engine's Remap takes four scalar pins, " +
                "so only authored constant ranges convert"));
            return null;
        }

        double[] inRange = node.SlotLiteral(1);
        double[] outRange = node.SlotLiteral(2);
        if (inRange.Length < 2 || outRange.Length < 2)
        {
            m_Report.Dropped.Add((node.TypeName,
                "a min/max range slot carries no serialized (min, max) literal"));
            return null;
        }

        string? valueRef = ProjectTo(driven, 1);
        if (valueRef == null)
            return null;

        string id = EmitNode("Remap", new()
        {
            ["value"] = valueRef,
            ["inMin"] = FormatScalar(inRange[0]),
            ["inMax"] = FormatScalar(inRange[1]),
            ["outMin"] = FormatScalar(outRange[0]),
            ["outMax"] = FormatScalar(outRange[1]),
        }, kScalarPin, node);
        return new LoweredValue { Main = id, Width = 1 };
    }

    LoweredValue? LowerMapped(UnityNode node, SgNodeMapping mapping, int outputSlot)
    {
        if (node.TypeName == "SampleTexture2DNode")
            return LowerSampleTexture(node, mapping, outputSlot);

        var operands = new List<(string Pin, LoweredValue Value)>();
        int width = 1;
        bool anyDriven = false;
        foreach ((int slotId, string pin) in mapping.InputPins)
        {
            UnityEdge? edge = FindDrivingEdge(node.ObjectId, slotId);
            if (edge != null)
            {
                LoweredValue? value = Lower(edge.OutputNodeId, edge.OutputSlotId);
                if (value != null)
                {
                    operands.Add((pin, value));
                    width = Math.Max(width, value.Width);
                    anyDriven = true;
                    continue;
                }
            }

            // Nothing wired: Unity uses the slot's serialized literal, so dropping it
            // would silently change the operation (a Multiply by 2 becoming a Multiply
            // by whatever the engine's pin default happens to be).
            double[] literal = node.SlotLiteral(slotId);
            if (literal.Length == 0)
                continue;
            operands.Add((pin, LiteralValue(literal)));
        }

        if (!anyDriven)
            return null;

        if (width >= 3)
        {
            if (mapping.VectorNode == null)
            {
                m_Report.Dropped.Add((node.TypeName,
                    $"engine has no vec3 form of this node; the graph applies it to a width-{width} value"));
                return null;
            }

            var vectorArgs = new Dictionary<string, string>();
            foreach ((string pin, LoweredValue value) in operands)
            {
                // The engine pin decides the width: a float pin on the vector node
                // (Lerp's weight) takes the operand at width 1 no matter how wide
                // Unity serialized the slot.
                int target = mapping.ScalarPins.Contains(pin) ? 1 : (value.Width >= 3 ? 3 : 1);
                string? projected = ProjectTo(value, target);
                if (projected != null)
                    vectorArgs[pin] = projected;
            }
            string vectorId = EmitNode(mapping.VectorNode, vectorArgs, kVectorPin, node);
            var lowered = new LoweredValue { Main = vectorId, Width = Math.Min(width, 3) };

            if (width >= 4 && mapping.ComponentWise && mapping.ScalarNode != null)
            {
                // Only materialize (and only complain about) the alpha lane if a
                // consumer reads it: most colour math discards alpha downstream.
                lowered.Width = 4;
                string scalarNode = mapping.ScalarNode;
                lowered.AlphaFactory = () =>
                {
                    var alphaArgs = new Dictionary<string, string>();
                    foreach ((string pin, LoweredValue value) in operands)
                    {
                        string? alpha = AlphaLaneOf(value);
                        if (alpha == null)
                        {
                            m_Report.Dropped.Add((node.TypeName,
                                "alpha channel of this operation was not carried (an operand has no alpha lane)"));
                            return string.Empty;
                        }
                        alphaArgs[pin] = alpha;
                    }
                    return EmitNode(scalarNode, alphaArgs, kScalarPin, node, alphaLane: true);
                };
            }
            return lowered;
        }

        if (mapping.ScalarNode == null)
        {
            m_Report.Dropped.Add((node.TypeName, "engine has no scalar form of this node"));
            return null;
        }

        var scalarArgs = new Dictionary<string, string>();
        foreach ((string pin, LoweredValue value) in operands)
        {
            string? projected = ProjectTo(value, 1);
            if (projected != null)
                scalarArgs[pin] = projected;
        }
        string id = EmitNode(mapping.ScalarNode, scalarArgs, kScalarPin, node);
        return new LoweredValue { Main = id, Width = 1 };
    }

    LoweredValue? LowerSampleTexture(UnityNode node, SgNodeMapping mapping, int outputSlot)
    {
        UnityEdge? textureEdge = FindDrivingEdge(node.ObjectId, 1);
        string? textureName = null;
        if (textureEdge != null)
        {
            LoweredValue? texture = Lower(textureEdge.OutputNodeId, textureEdge.OutputSlotId);
            textureName = texture?.Main;
        }
        if (textureName == null)
        {
            m_Report.Dropped.Add(("Sample Texture 2D", "sampler has no resolvable texture property"));
            return null;
        }

        // The sampler's texture is a slot name, not a graph value: it belongs in the
        // node's `tex` pin default. Naming any other pin makes the compiler fall back
        // to DefaultTextureNameForNode, which would sample albedoMap for every
        // texture in the graph.
        var args = new Dictionary<string, string>();
        UnityEdge? uvEdge = FindDrivingEdge(node.ObjectId, 2);
        if (uvEdge != null)
        {
            LoweredValue? uv = Lower(uvEdge.OutputNodeId, uvEdge.OutputSlotId);
            string? projected = uv == null ? null : ProjectTo(uv, 2);
            if (projected != null)
                args["uv"] = projected;
        }

        string id = EmitNodeShared("SampleTexture2D", args, node,
            extra: new Dictionary<string, string> { ["tex"] = textureName });
        if (!mapping.OutputPins.TryGetValue(outputSlot, out string? pin))
            return null;

        if (pin == "rgba")
            return new LoweredValue { Main = id + ".rgb", Width = 4, Alpha = id + ".a" };
        return new LoweredValue { Main = id + "." + pin, Width = 1 };
    }

    // ----------------------------------------------------------- projections --

    const string kScalarPin = "result";
    const string kVectorPin = "result";

    /// Adapt a lowered value to the width a consumer pin needs. Returns an edge
    /// source reference ("node.pin") or a literal, or null when the adaptation
    /// would change the result.
    static LoweredValue LiteralValue(double[] components) =>
        new() { LiteralComponents = components, Width = components.Length, IsLiteral = true };

    string? ProjectTo(LoweredValue value, int width)
    {
        if (value.IsLiteral)
        {
            // A literal is spliced into GLSL verbatim, and GLSL neither widens a scalar
            // into a vector nor narrows a vector, so it is formatted at the width the
            // consuming pin asks for.
            double[] c = value.LiteralComponents;
            if (width <= 1)
                return FormatScalar(c.ElementAtOrDefault(0));
            if (c.Length == 1)
                return $"vec{width}({FormatScalar(c[0])})";
            if (c.Length < width)
                return null;
            return $"vec{width}({FormatList(c, width)})";
        }

        if (width <= 1)
        {
            if (value.Width <= 1)
                return value.Main;
            // Narrowing a vector to a scalar needs an explicit channel choice.
            return null;
        }

        // The engine broadcasts a scalar into a vector pin, and vec4 values keep
        // their rgb lane in Main, so both cases are already the right reference.
        return value.Main;
    }

    /// An unconnected Unity pin reads as zero. Widths above 1 need a constructor so
    /// the literal is valid GLSL at the pin.
    string ProjectOrZero(LoweredValue? value, int width)
    {
        string? projected = value == null ? null : ProjectTo(value, width);
        if (projected != null)
            return projected;
        return width <= 1 ? FormatScalar(0) : $"vec{width}(0.0)";
    }

    string? AlphaLaneOf(LoweredValue value)
    {
        if (value.Alpha != null)
            return value.Alpha;
        if (value.AlphaFactory != null)
        {
            Func<string> factory = value.AlphaFactory;
            value.AlphaFactory = null;
            string produced = factory();
            value.Alpha = produced.Length == 0 ? null : produced;
            return value.Alpha;
        }
        if (value.Width == 1)
            return value.Main;
        return null;
    }

    // -------------------------------------------------------------- emission --

    string EmitNode(string type, Dictionary<string, string> inputs, string outputPin, UnityNode origin,
                    Dictionary<string, string>? extra = null, bool alphaLane = false)
    {
        string id = MakeNodeId(origin, alphaLane ? "a" : null);
        if (m_Nodes.Any(n => n.Id == id))
        {
            throw new InvalidOperationException(
                $"node id collision: '{id}' emitted twice for Unity object '{origin.ObjectId}' ({origin.TypeName}); " +
                "a second emission from the same origin needs its own lane suffix (see EmitNodeShared for shared reads)");
        }
        var attrs = new Dictionary<string, string>(extra ?? new());
        m_Nodes.Add(new EmittedNode(id, type, origin.PositionX, origin.PositionY + (alphaLane ? kAlphaLaneOffsetY : 0), attrs));
        foreach ((string pin, string source) in inputs)
            AddInputEdge(id, pin, source, attrs);
        return id + "." + outputPin;
    }

    /// A node the converter synthesizes to satisfy an engine convention rather than
    /// to mirror a Unity node. Unity block nodes all sit at the origin, so these are
    /// placed near the sink instead of inheriting a meaningless position.
    string EmitSinkNode(string type, Dictionary<string, string> inputs, string outputPin, string sinkPin)
    {
        string id = kNodeIdPrefix + "fix_" + sinkPin.ToLowerInvariant();
        var attrs = new Dictionary<string, string>();
        m_Nodes.Add(new EmittedNode(id, type, kSinkNodeX, m_SinkFixupY, attrs));
        m_SinkFixupY += kSinkNodeSpacingY;
        foreach ((string pin, string source) in inputs)
            AddInputEdge(id, pin, source, attrs);
        return id + "." + outputPin;
    }

    /// A node whose outputs are read through several pins is emitted once and
    /// referenced by pin, so the graph keeps one sample instead of N.
    string EmitNodeShared(string type, Dictionary<string, string> inputs, UnityNode origin,
                          Dictionary<string, string>? extra = null)
    {
        string id = MakeNodeId(origin, null);
        if (m_Nodes.Any(n => n.Id == id))
            return id;
        var attrs = new Dictionary<string, string>(extra ?? new());
        m_Nodes.Add(new EmittedNode(id, type, origin.PositionX, origin.PositionY, attrs));
        foreach ((string pin, string source) in inputs)
            AddInputEdge(id, pin, source, attrs);
        return id;
    }

    /// An input is either an edge from another node/property, or a literal pin
    /// default written into the node tag.
    void AddInputEdge(string nodeId, string pin, string source, Dictionary<string, string> attrs)
    {
        if (source.Length == 0)
            return;

        if (!IsEdgeReference(source))
        {
            attrs[pin] = source;
            return;
        }

        string endpoint = source.Contains('.') ? source : source + ".value";
        m_Edges.Add($"// @sg-edge      {endpoint} -> {nodeId}.{pin}");
    }

    /// An edge source is a `node.pin` / property / texture name. A GLSL literal is
    /// not — and `vec3(0.0)` also contains a dot, so the test has to exclude
    /// constructor syntax and numbers rather than just look for one.
    bool IsEdgeReference(string source)
    {
        if (source.Contains('(') || source.Contains(')'))
            return false;
        if (source.Length > 0 && (char.IsDigit(source[0]) || source[0] == '-' || source[0] == '+'))
            return false;
        if (source.Contains('.'))
            return true;
        return m_Nodes.Any(n => n.Id == source) ||
               m_TextureTags.Any(t => t.Contains($"@sg-texture   {source} ")) ||
               m_PropertyTags.Any(t => t.Contains($"@sg-property  {source} "));
    }

    string MakeNodeId(UnityNode origin, string? suffix)
    {
        string stem = origin.ObjectId.Length >= kNodeIdHexLength
            ? origin.ObjectId[..kNodeIdHexLength]
            : origin.ObjectId;
        return kNodeIdPrefix + stem + (suffix == null ? string.Empty : "_" + suffix);
    }

    string Emit()
    {
        var sb = new StringBuilder();
        sb.Append("// Converted from a Unity .shadergraph by the engine's Unity importer.\n");
        sb.Append("// The @sg-* tag block is authoritative; the body is regenerated on save.\n//\n");
        sb.Append($"// @sg-graph     {m_GraphName}\n");
        sb.Append("// @sg-version   1\n");
        sb.Append("// @sg-stage     surface\n");
        sb.Append($"// @sg-lighting  {(m_Graph.IsUnlit ? "Unlit" : "StandardPBR")}\n");

        foreach (string tag in m_PropertyTags)
            sb.Append(tag).Append('\n');
        foreach (string tag in m_TextureTags)
            sb.Append(tag).Append('\n');
        sb.Append("//\n");

        foreach (EmittedNode node in m_Nodes)
        {
            sb.Append($"// @sg-node      {node.Id} type={node.Type} pos=({FormatScalar(node.X)},{FormatScalar(node.Y)})");
            foreach ((string key, string value) in node.Attributes)
                sb.Append(' ').Append(key).Append('=').Append(value);
            sb.Append('\n');
        }
        foreach (string edge in m_Edges)
            sb.Append(edge).Append('\n');

        return sb.ToString();
    }

    UnityEdge? FindDrivingEdge(string nodeId, int slotId) =>
        m_Graph.Edges.FirstOrDefault(e => e.InputNodeId == nodeId && e.InputSlotId == slotId);

    static string FormatScalar(double value) =>
        value.ToString("0.######", CultureInfo.InvariantCulture);

    static string FormatList(double[] values, int count)
    {
        var parts = new List<string>();
        for (int i = 0; i < count; i++)
            parts.Add(FormatScalar(values.ElementAtOrDefault(i)));
        return string.Join(", ", parts);
    }

    enum PropertyKind
    {
        InlineConstant,
        MaterialField,
        SemanticScalar,
        AlphaCutoff,
        Texture,
    }

    sealed class PropertyPlan
    {
        public PropertyKind Kind;
        public string Reference = string.Empty;
        public int Width;
        public double[] Values = Array.Empty<double>();
        public string? MaterialKey;
    }

    sealed class LoweredValue
    {
        public string Main = string.Empty;
        public string? Alpha;

        /// Materializes the alpha lane on first use, so a node is only emitted for
        /// values whose alpha a consumer actually reads.
        public Func<string>? AlphaFactory;
        public int Width;
        public bool IsLiteral;

        /// Components of a literal, kept unformatted so the value can be written at
        /// whatever width the consuming pin needs.
        public double[] LiteralComponents = Array.Empty<double>();

        /// The value is already expressed the way the engine stores it, so a sink
        /// conversion (Unity smoothness -> engine roughness) must not run again.
        public bool IsEngineConvention;
    }

    sealed record EmittedNode(string Id, string Type, double X, double Y, Dictionary<string, string> Attributes);
}

internal sealed class ShaderGraphConversionReport
{
    /// (subject, reason) pairs, surfaced through the converter's honest-drop path.
    public List<(string Subject, string Reason)> Dropped = new();

    /// Engine material property key -> value the converted graph expects.
    public Dictionary<string, double[]> MaterialProperties = new(StringComparer.Ordinal);

    /// Engine texture slot -> the Unity property it came from.
    public Dictionary<string, string> TextureSlots = new(StringComparer.Ordinal);

    /// Node-library files the conversion produced (file name -> GLSL source), one per
    /// translated Unity Custom Function.
    public Dictionary<string, string> GeneratedNodeFiles = new(StringComparer.Ordinal);

    public string AlphaMode = "Opaque";
}

internal sealed class ShaderGraphConversionResult
{
    public bool Success;
    public string Source = string.Empty;
    public ShaderGraphConversionReport Report = new();
    public Dictionary<string, double[]> MaterialProperties = new(StringComparer.Ordinal);
}
