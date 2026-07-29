using GameEngine.UnityConverter;
using Xunit;

namespace GameEngine.UnityConverter.Tests;

/// Fixtures here are synthetic minimal graphs authored to Unity's serialization
/// shape. Real vendor `.shadergraph` assets are licensed content and must never
/// be committed, so every fixture is hand-built from the format rules the reader
/// depends on.
public class ShaderGraphConverterTests
{
    // ------------------------------------------------------------- fixtures --

    /// Unity writes each graph object as its own top-level block, concatenated.
    static string Blocks(params string[] objects) => string.Join("\n\n", objects);

    static string GraphData(string properties, string nodes, string edges, string targets = "") =>
        $@"{{
    ""m_SGVersion"": 3,
    ""m_Type"": ""UnityEditor.ShaderGraph.GraphData"",
    ""m_ObjectId"": ""graph0"",
    ""m_Properties"": [{properties}],
    ""m_Nodes"": [{nodes}],
    ""m_Edges"": [{edges}],
    ""m_ActiveTargets"": [{targets}]
}}";

    static string Ref(string id) => $@"{{ ""m_Id"": ""{id}"" }}";

    static string Property(string id, string type, string name, string reference, string value) =>
        $@"{{
    ""m_Type"": ""UnityEditor.ShaderGraph.Internal.{type}, Unity.ShaderGraph.Editor"",
    ""m_ObjectId"": ""{id}"",
    ""m_Name"": ""{name}"",
    ""m_OverrideReferenceName"": ""{reference}"",
    ""m_Value"": {value}
}}";

    static string Node(string id, string type, double x = 0, double y = 0, string extra = "") =>
        $@"{{
    ""m_Type"": ""UnityEditor.ShaderGraph.{type}, Unity.ShaderGraph.Editor"",
    ""m_ObjectId"": ""{id}"",
    ""m_DrawState"": {{ ""m_Position"": {{ ""x"": {x}, ""y"": {y}, ""width"": 100, ""height"": 40 }} }}{extra}
}}";

    static string PropertyNode(string id, string propertyId, double x = 0, double y = 0) =>
        Node(id, "PropertyNode", x, y, $@",
    ""m_Property"": {Ref(propertyId)}");

    static string BlockNode(string id, string descriptor) =>
        Node(id, "BlockNode", 0, 0, $@",
    ""m_SerializedDescriptor"": ""{descriptor}""");

    static string Edge(string outNode, int outSlot, string inNode, int inSlot) =>
        $@"{{
    ""m_OutputSlot"": {{ ""m_Node"": {Ref(outNode)}, ""m_SlotId"": {outSlot} }},
    ""m_InputSlot"": {{ ""m_Node"": {Ref(inNode)}, ""m_SlotId"": {inSlot} }}
}}";

    /// A target names its active sub-target by object id, the shape real
    /// `.shadergraph` files serialize (one sub-target per target).
    static string Target(string id, string type, string subTargetId) =>
        $@"{{
    ""m_Type"": ""UnityEditor.Rendering.Universal.ShaderGraph.{type}, Unity.RenderPipelines.Universal.Editor"",
    ""m_ObjectId"": ""{id}"",
    ""m_ActiveSubTarget"": {{ ""m_Id"": ""{subTargetId}"" }}
}}";

    static string SubTarget(string id, string type) =>
        $@"{{
    ""m_Type"": ""UnityEditor.Rendering.Universal.ShaderGraph.{type}, Unity.RenderPipelines.Universal.Editor"",
    ""m_ObjectId"": ""{id}""
}}";

    // --------------------------------------------------------------- reader --

    [Fact]
    public void SplitObjects_SeparatesConcatenatedUnityObjects()
    {
        string text = Blocks(@"{ ""a"": 1 }", @"{ ""b"": { ""c"": 2 } }");
        List<string> blocks = ShaderGraphDocument.SplitObjects(text);
        Assert.Equal(2, blocks.Count);
    }

    [Fact]
    public void SplitObjects_IgnoresBracesInsideStrings()
    {
        string text = @"{ ""a"": ""}{ not a brace"" }";
        Assert.Single(ShaderGraphDocument.SplitObjects(text));
    }

    [Fact]
    public void ShortTypeName_StripsNamespaceAndAssembly()
    {
        Assert.Equal("AddNode",
            ShaderGraphDocument.ShortTypeName("UnityEditor.ShaderGraph.AddNode, Unity.ShaderGraph.Editor"));
    }

    [Fact]
    public void Parse_ResolvesPropertiesNodesAndEdges()
    {
        string json = Blocks(
            GraphData(Ref("p0"), $"{Ref("pn0")}, {Ref("b0")}", Edge("pn0", 0, "b0", 0)),
            Property("p0", "ColorShaderProperty", "Base Color", "_BaseColor",
                @"{ ""r"": 1, ""g"": 0.5, ""b"": 0.25, ""a"": 1 }"),
            PropertyNode("pn0", "p0"),
            BlockNode("b0", "SurfaceDescription.BaseColor"));

        UnityShaderGraph graph = ShaderGraphDocument.Parse(json);

        Assert.Equal(3, graph.SgVersion);
        Assert.Single(graph.Properties);
        Assert.Equal("Base Color", graph.Properties[0].Name);
        Assert.Equal("_BaseColor", graph.Properties[0].ReferenceName);
        Assert.Equal(2, graph.Nodes.Count);
        Assert.Single(graph.Edges);
        Assert.Equal("pn0", graph.Edges[0].OutputNodeId);
        Assert.Equal(0, graph.Edges[0].InputSlotId);
    }

    // ------------------------------------------------------- mapping tables --

    [Fact]
    public void NodeMap_PinsTheUnitySlotIdsTheConverterRelieson()
    {
        // These ids come from Unity's node classes and were cross-checked against
        // real edges; a silent change here mis-wires every converted graph.
        SgNodeMapping multiply = ShaderGraphNodeMap.kNodes["MultiplyNode"];
        Assert.Equal("a", multiply.InputPins[0]);
        Assert.Equal("b", multiply.InputPins[1]);
        Assert.Equal("result", multiply.OutputPins[2]);

        SgNodeMapping sample = ShaderGraphNodeMap.kNodes["SampleTexture2DNode"];
        Assert.Equal("tex", sample.InputPins[1]);
        Assert.Equal("uv", sample.InputPins[2]);
        Assert.Equal("rgba", sample.OutputPins[0]);
        Assert.Equal("a", sample.OutputPins[7]);

        SgNodeMapping strength = ShaderGraphNodeMap.kNodes["NormalStrengthNode"];
        Assert.Equal("value", strength.InputPins[0]);
        Assert.Equal("strength", strength.InputPins[1]);
        Assert.Equal("result", strength.OutputPins[2]);

        Assert.Equal(0, ShaderGraphNodeMap.kBranchPredicateSlot);
        Assert.Equal(1, ShaderGraphNodeMap.kBranchTrueSlot);
        Assert.Equal(3, ShaderGraphNodeMap.kBranchOutputSlot);
        Assert.Equal(3, ShaderGraphNodeMap.kSplitChannelBySlot[4]);
    }

    [Fact]
    public void NodeMap_SmoothnessBlockCarriesTheRoughnessInversion()
    {
        ShaderGraphNodeMap.SgBlockMapping smoothness =
            ShaderGraphNodeMap.kSurfaceBlocks["SurfaceDescription.Smoothness"];
        Assert.Equal("Roughness", smoothness.EnginePin);
        Assert.True(smoothness.InvertScalar);

        Assert.False(ShaderGraphNodeMap.kSurfaceBlocks["SurfaceDescription.Metallic"].InvertScalar);
    }

    // ------------------------------------------------------- tag  emission --

    [Fact]
    public void Convert_EmitsAuthoritativeTagBlockWithSurfaceOutputSink()
    {
        string json = Blocks(
            GraphData(Ref("p0"), $"{Ref("pn0")}, {Ref("b0")}", Edge("pn0", 0, "b0", 0)),
            Property("p0", "ColorShaderProperty", "Base Color", "_BaseColor",
                @"{ ""r"": 1, ""g"": 0.5, ""b"": 0.25, ""a"": 1 }"),
            PropertyNode("pn0", "p0"),
            BlockNode("b0", "SurfaceDescription.BaseColor"));

        ShaderGraphConversionResult result = ShaderGraphConverter.Convert(json, "SynthBasic");

        Assert.True(result.Success, string.Join("; ", result.Report.Dropped.Select(d => d.Subject + ": " + d.Reason)));
        Assert.Contains("// @sg-graph     SynthBasic", result.Source);
        Assert.Contains("// @sg-stage     surface", result.Source);
        Assert.Contains("// @sg-lighting  StandardPBR", result.Source);
        Assert.Contains("type=SurfaceOutput", result.Source);
        Assert.Contains("-> surface_out.BaseColor", result.Source);
        // A colour semantic reaches the GPU through the real MaterialData field.
        Assert.Contains("// @sg-property  uBaseColor vec4 default=1, 0.5, 0.25, 1 public=true", result.Source);
        Assert.Equal(new[] { 1.0, 0.5, 0.25, 1.0 }, result.Report.MaterialProperties["baseColor"]);
    }

    [Fact]
    public void Convert_InvertsSmoothnessIntoRoughness()
    {
        string json = Blocks(
            GraphData($"{Ref("p0")}, {Ref("pc")}",
                $"{Ref("pn0")}, {Ref("b0")}, {Ref("pnc")}, {Ref("bc")}",
                $"{Edge("pn0", 0, "b0", 0)}, {Edge("pnc", 0, "bc", 0)}"),
            Property("p0", "Vector1ShaderProperty", "Smoothness", "_Smoothness", "0.25"),
            Property("pc", "ColorShaderProperty", "Base Color", "_BaseColor",
                @"{ ""r"": 1, ""g"": 1, ""b"": 1, ""a"": 1 }"),
            PropertyNode("pn0", "p0"),
            PropertyNode("pnc", "pc"),
            BlockNode("b0", "SurfaceDescription.Smoothness"),
            BlockNode("bc", "SurfaceDescription.BaseColor"));

        ShaderGraphConversionResult result = ShaderGraphConverter.Convert(json, "SynthSmooth");

        Assert.True(result.Success);
        // Unity smoothness 0.25 is engine roughness 0.75.
        Assert.Equal(new[] { 0.75 }, result.Report.MaterialProperties["roughness"]);
        // A bare property is inverted at import, and the pin reads the real PBR field.
        Assert.Contains("type=FloatParameter", result.Source);
        Assert.Contains("component=y", result.Source);
        Assert.Contains("-> surface_out.Roughness", result.Source);
    }

    [Fact]
    public void Convert_LowersComponentWiseVec4IntoRgbAndAlphaLanes()
    {
        // albedo sample (vec4) * base colour (vec4) -> BaseColor takes rgb,
        // Split.A takes the alpha lane. The engine has no vec4 pin, so the
        // multiply must become a vec3 node plus a scalar node.
        string json = Blocks(
            GraphData($"{Ref("pTex")}, {Ref("pCol")}",
                $"{Ref("nTexProp")}, {Ref("nColProp")}, {Ref("nSample")}, {Ref("nMul")}, {Ref("nSplit")}, {Ref("bBase")}, {Ref("bAlpha")}",
                string.Join(", ",
                    Edge("nTexProp", 0, "nSample", 1),
                    Edge("nSample", 0, "nMul", 0),
                    Edge("nColProp", 0, "nMul", 1),
                    Edge("nMul", 2, "bBase", 0),
                    Edge("nMul", 2, "nSplit", 0),
                    Edge("nSplit", 4, "bAlpha", 0))),
            Property("pTex", "Texture2DShaderProperty", "Albedo Map", "_MainTex",
                @"{ ""m_SerializedTexture"": """", ""m_Guid"": """" }"),
            Property("pCol", "ColorShaderProperty", "Base Color", "_BaseColor",
                @"{ ""r"": 1, ""g"": 1, ""b"": 1, ""a"": 0.5 }"),
            PropertyNode("nTexProp", "pTex"),
            PropertyNode("nColProp", "pCol"),
            Node("nSample", "SampleTexture2DNode", -400, 0),
            Node("nMul", "MultiplyNode", -200, 0),
            Node("nSplit", "SplitNode", -100, 0),
            BlockNode("bBase", "SurfaceDescription.BaseColor"),
            BlockNode("bAlpha", "SurfaceDescription.Alpha"));

        ShaderGraphConversionResult result = ShaderGraphConverter.Convert(json, "SynthLower");

        Assert.True(result.Success, string.Join("; ", result.Report.Dropped.Select(d => d.Subject + ": " + d.Reason)));
        Assert.Contains("type=VectorMultiply", result.Source);
        Assert.Contains("type=Multiply", result.Source);
        Assert.Contains("type=SampleTexture2D", result.Source);
        // The vec4 material field narrows to a vec3 pin through a Vec3Parameter
        // carrying the rgb swizzle; without it the whole field lands on the pin.
        Assert.Contains("swizzle=xyz", result.Source);
        // The sampler's texture must land on the `tex` pin: any other pin name makes
        // the engine fall back to its default texture for every sampler.
        Assert.Contains("tex=albedoMap", result.Source);
        Assert.Contains("-> surface_out.BaseColor", result.Source);
        Assert.Contains("-> surface_out.Opacity", result.Source);
        Assert.Equal("albedoMap", ShaderGraphNodeMap.kSemanticTextures["maintex"]);
        Assert.Equal("Albedo Map", result.Report.TextureSlots["albedoMap"]);
    }

    [Fact]
    public void Convert_EmitsDistinctNodeIdsForVec4InlineConstantProperty()
    {
        // A non-semantic vec4 property lowers to a ColorConstant plus a
        // FloatConstant alpha lane. Both stem from the same Unity object, so the
        // alpha node needs the alpha-lane id suffix or the two ids collide.
        string json = Blocks(
            GraphData(Ref("pTint"), $"{Ref("pnTint")}, {Ref("bBase")}", Edge("pnTint", 0, "bBase", 0)),
            Property("pTint", "Vector4ShaderProperty", "Tint", "_Tint",
                @"{ ""x"": 1, ""y"": 0.5, ""z"": 0.25, ""w"": 0.5 }"),
            PropertyNode("pnTint", "pTint"),
            BlockNode("bBase", "SurfaceDescription.BaseColor"));

        ShaderGraphConversionResult result = ShaderGraphConverter.Convert(json, "SynthDistinctIds");

        Assert.True(result.Success, string.Join("; ", result.Report.Dropped.Select(d => d.Subject + ": " + d.Reason)));
        Assert.Contains("type=ColorConstant", result.Source);
        Assert.Contains("type=FloatConstant", result.Source);

        List<string> nodeIds = result.Source
            .Split('\n')
            .Where(l => l.StartsWith("// @sg-node", StringComparison.Ordinal))
            .Select(l => l["// @sg-node".Length..].Trim().Split(' ')[0])
            .ToList();
        Assert.Equal(nodeIds.Count, nodeIds.Distinct(StringComparer.Ordinal).Count());
    }

    [Fact]
    public void Convert_MapsUnlitSubTargetToUnlitLighting()
    {
        string json = Blocks(
            GraphData(Ref("p0"), $"{Ref("pn0")}, {Ref("b0")}", Edge("pn0", 0, "b0", 0), Ref("t0")),
            Target("t0", "UniversalTarget", "st0"),
            SubTarget("st0", "UniversalUnlitSubTarget"),
            Property("p0", "ColorShaderProperty", "Base Color", "_BaseColor",
                @"{ ""r"": 1, ""g"": 1, ""b"": 1, ""a"": 1 }"),
            PropertyNode("pn0", "p0"),
            BlockNode("b0", "SurfaceDescription.BaseColor"));

        ShaderGraphConversionResult result = ShaderGraphConverter.Convert(json, "SynthUnlit");

        Assert.True(result.Success);
        Assert.Contains("// @sg-lighting  Unlit", result.Source);
    }

    [Fact]
    public void Convert_MixedTargetPairPrefersUniversalSubTarget()
    {
        // The SkyDome shape: an active Built-In target with a Lit sub-target next
        // to an active Universal target with an Unlit one. The URP sub-target
        // decides; scanning all sub-targets in the file misclassifies this as Lit.
        string json = Blocks(
            GraphData(Ref("p0"), $"{Ref("pn0")}, {Ref("b0")}", Edge("pn0", 0, "b0", 0),
                $"{Ref("tBi")}, {Ref("tUni")}"),
            Target("tBi", "BuiltInTarget", "stBi"),
            SubTarget("stBi", "BuiltInLitSubTarget"),
            Target("tUni", "UniversalTarget", "stUni"),
            SubTarget("stUni", "UniversalUnlitSubTarget"),
            Property("p0", "ColorShaderProperty", "Base Color", "_BaseColor",
                @"{ ""r"": 1, ""g"": 1, ""b"": 1, ""a"": 1 }"),
            PropertyNode("pn0", "p0"),
            BlockNode("b0", "SurfaceDescription.BaseColor"));

        ShaderGraphConversionResult result = ShaderGraphConverter.Convert(json, "SynthMixedTargets");

        Assert.True(result.Success);
        Assert.Contains("// @sg-lighting  Unlit", result.Source);
    }

    [Fact]
    public void Convert_NamesUnmappedNodeInReportInsteadOfGuessing()
    {
        string json = Blocks(
            GraphData(Ref("p0"),
                $"{Ref("nOdd")}, {Ref("pn0")}, {Ref("bBase")}, {Ref("bAo")}",
                $"{Edge("pn0", 0, "bBase", 0)}, {Edge("nOdd", 1, "bAo", 0)}"),
            Property("p0", "ColorShaderProperty", "Base Color", "_BaseColor",
                @"{ ""r"": 1, ""g"": 1, ""b"": 1, ""a"": 1 }"),
            Node("nOdd", "GradientNoiseNode", 0, 0),
            PropertyNode("pn0", "p0"),
            BlockNode("bBase", "SurfaceDescription.BaseColor"),
            BlockNode("bAo", "SurfaceDescription.Occlusion"));

        ShaderGraphConversionResult result = ShaderGraphConverter.Convert(json, "SynthDrop");

        // The convertible part still converts; the unmapped node is named, not faked.
        Assert.True(result.Success);
        Assert.Contains(result.Report.Dropped, d => d.Subject == "GradientNoiseNode");
        Assert.DoesNotContain("GradientNoise", result.Source);
    }

    [Fact]
    public void Convert_ReportsGraphWithNoConvertibleSurfaceBlock()
    {
        string json = Blocks(
            GraphData("", Ref("b0"), ""),
            BlockNode("b0", "SurfaceDescription.BaseColor"));

        ShaderGraphConversionResult result = ShaderGraphConverter.Convert(json, "SynthEmpty");

        Assert.False(result.Success);
        Assert.Contains(result.Report.Dropped, d => d.Reason.Contains("no convertible SurfaceDescription block"));
    }

    [Fact]
    public void Convert_DoesNotInvertSmoothnessTwice()
    {
        // A bare Smoothness property is complemented into the material's roughness at
        // import, so the graph must read that field straight. Inserting a OneMinus as
        // well would hand the shader the original smoothness back.
        string json = Blocks(
            GraphData($"{Ref("p0")}, {Ref("pc")}",
                $"{Ref("pn0")}, {Ref("b0")}, {Ref("pnc")}, {Ref("bc")}",
                $"{Edge("pn0", 0, "b0", 0)}, {Edge("pnc", 0, "bc", 0)}"),
            Property("p0", "Vector1ShaderProperty", "Smoothness", "_Smoothness", "0.25"),
            Property("pc", "ColorShaderProperty", "Base Color", "_BaseColor",
                @"{ ""r"": 1, ""g"": 1, ""b"": 1, ""a"": 1 }"),
            PropertyNode("pn0", "p0"),
            PropertyNode("pnc", "pc"),
            BlockNode("b0", "SurfaceDescription.Smoothness"),
            BlockNode("bc", "SurfaceDescription.BaseColor"));

        ShaderGraphConversionResult result = ShaderGraphConverter.Convert(json, "SynthNoDoubleInvert");

        Assert.True(result.Success);
        Assert.Equal(new[] { 0.75 }, result.Report.MaterialProperties["roughness"]);
        Assert.DoesNotContain("type=OneMinus", result.Source);
    }

    [Fact]
    public void Convert_InsertsOneMinusWhenSmoothnessIsComputedInGraph()
    {
        // A computed smoothness has no material field to complement at import, so the
        // conversion has to happen in the shader.
        string json = Blocks(
            GraphData($"{Ref("pa")}, {Ref("pb")}, {Ref("pc")}",
                $"{Ref("pna")}, {Ref("pnb")}, {Ref("nMul")}, {Ref("b0")}, {Ref("pnc")}, {Ref("bc")}",
                string.Join(", ",
                    Edge("pna", 0, "nMul", 0),
                    Edge("pnb", 0, "nMul", 1),
                    Edge("nMul", 2, "b0", 0),
                    Edge("pnc", 0, "bc", 0))),
            Property("pa", "Vector1ShaderProperty", "Gloss A", "_GlossA", "0.5"),
            Property("pb", "Vector1ShaderProperty", "Gloss B", "_GlossB", "0.5"),
            Property("pc", "ColorShaderProperty", "Base Color", "_BaseColor",
                @"{ ""r"": 1, ""g"": 1, ""b"": 1, ""a"": 1 }"),
            PropertyNode("pna", "pa"),
            PropertyNode("pnb", "pb"),
            Node("nMul", "MultiplyNode", -200, 0),
            PropertyNode("pnc", "pc"),
            BlockNode("b0", "SurfaceDescription.Smoothness"),
            BlockNode("bc", "SurfaceDescription.BaseColor"));

        ShaderGraphConversionResult result = ShaderGraphConverter.Convert(json, "SynthComputedSmooth");

        Assert.True(result.Success);
        Assert.Contains("type=OneMinus", result.Source);
        Assert.Contains("-> surface_out.Roughness", result.Source);
    }

    [Fact]
    public void Convert_WritesVectorLiteralsForUnconnectedVectorPins()
    {
        // A pin default is spliced into GLSL verbatim; a bare "0" on a vec3 pin is not
        // valid GLSL, so an unconnected vector input needs a constructor. Branch's
        // True side carries a colour here and its False side is left unconnected —
        // the shape real Unity "enable this effect" graphs use.
        string json = Blocks(
            GraphData($"{Ref("pBool")}, {Ref("pCol")}",
                $"{Ref("pnBool")}, {Ref("pnCol")}, {Ref("nBranch")}, {Ref("nMul")}, {Ref("bEmis")}, {Ref("bBase")}",
                string.Join(", ",
                    Edge("pnBool", 0, "nBranch", 0),
                    Edge("pnCol", 0, "nBranch", 1),
                    Edge("nBranch", 3, "bEmis", 0),
                    Edge("pnCol", 0, "nMul", 0),
                    Edge("nMul", 2, "bBase", 0))),
            Property("pBool", "BooleanShaderProperty", "Enable", "_Enable", "true"),
            Property("pCol", "ColorShaderProperty", "Base Color", "_BaseColor",
                @"{ ""r"": 1, ""g"": 1, ""b"": 1, ""a"": 1 }"),
            PropertyNode("pnBool", "pBool"),
            PropertyNode("pnCol", "pCol"),
            Node("nBranch", "BranchNode", -100, 0),
            Node("nMul", "MultiplyNode", -100, 100, $@",
    ""m_Slots"": [{Ref("sMulB")}]"),
            Slot("sMulB", "Vector4MaterialSlot", 1, "B", 0, @"{ ""x"": 2, ""y"": 2, ""z"": 2, ""w"": 2 }"),
            BlockNode("bEmis", "SurfaceDescription.Emission"),
            BlockNode("bBase", "SurfaceDescription.BaseColor"));

        ShaderGraphConversionResult result = ShaderGraphConverter.Convert(json, "SynthVectorLiteral");

        Assert.True(result.Success);
        Assert.Contains("vec3(0.0)", result.Source);
        // The literal belongs on the node tag as a pin default, never as an edge
        // endpoint: "vec3(0.0)" is not a node.pin reference.
        Assert.DoesNotContain("vec3(0.0) ->", result.Source);
        Assert.Contains("a=vec3(0.0)", result.Source);
        // The mapped-node path writes an unconnected pin's serialized slot literal
        // at the consuming pin's width.
        Assert.Contains("b=vec3(2, 2, 2)", result.Source);
    }

    [Fact]
    public void Convert_KeepsScalarPinsScalarOnVectorNodes()
    {
        // Unity serializes Lerp's T as a vector literal, but the engine's vec3
        // lerp takes a float weight: the projection width must come from the
        // engine pin, not from the serialized literal.
        string json = Blocks(
            GraphData(Ref("pCol"), $"{Ref("pnCol")}, {Ref("nLerp")}, {Ref("bBase")}",
                string.Join(", ",
                    Edge("pnCol", 0, "nLerp", 0),
                    Edge("pnCol", 0, "nLerp", 1),
                    Edge("nLerp", 3, "bBase", 0))),
            Property("pCol", "ColorShaderProperty", "Base Color", "_BaseColor",
                @"{ ""r"": 1, ""g"": 1, ""b"": 1, ""a"": 1 }"),
            PropertyNode("pnCol", "pCol"),
            Node("nLerp", "LerpNode", -100, 0, $@",
    ""m_Slots"": [{Ref("sLerpT")}]"),
            Slot("sLerpT", "DynamicVectorMaterialSlot", 2, "T", 0,
                @"{ ""x"": 0.5, ""y"": 0.5, ""z"": 0.5, ""w"": 0.5 }"),
            BlockNode("bBase", "SurfaceDescription.BaseColor"));

        ShaderGraphConversionResult result = ShaderGraphConverter.Convert(json, "SynthScalarWeight");

        Assert.True(result.Success, string.Join("; ", result.Report.Dropped.Select(d => d.Subject + ": " + d.Reason)));
        Assert.Contains("type=VectorLerp", result.Source);
        Assert.Contains("weight=0.5", result.Source);
        Assert.DoesNotContain("weight=vec3", result.Source);
    }

    [Fact]
    public void Convert_SplitsRemapRangesOntoScalarPins()
    {
        // Unity packs each Remap range into one Vector2 slot; the engine's Remap
        // takes four float pins. The authored constants must land on those pins —
        // a phantom inMinMax/outMinMax attribute leaves the real pins at zero and
        // the node evaluating to a constant.
        string json = Blocks(
            GraphData(Ref("pSpeed"), $"{Ref("pnSpeed")}, {Ref("nRemap")}, {Ref("bAlpha")}",
                string.Join(", ",
                    Edge("pnSpeed", 0, "nRemap", 0),
                    Edge("nRemap", 3, "bAlpha", 0))),
            Property("pSpeed", "Vector1ShaderProperty", "Speed", "_Speed", "0.5"),
            PropertyNode("pnSpeed", "pSpeed"),
            Node("nRemap", "RemapNode", -100, 0, $@",
    ""m_Slots"": [{Ref("sRemapIn")}, {Ref("sRemapOut")}]"),
            Slot("sRemapIn", "Vector2MaterialSlot", 1, "In Min Max", 0, @"{ ""x"": 0, ""y"": 1 }"),
            Slot("sRemapOut", "Vector2MaterialSlot", 2, "Out Min Max", 0, @"{ ""x"": 0.35, ""y"": 50 }"),
            BlockNode("bAlpha", "SurfaceDescription.Alpha"));

        ShaderGraphConversionResult result = ShaderGraphConverter.Convert(json, "SynthRemap");

        Assert.True(result.Success, string.Join("; ", result.Report.Dropped.Select(d => d.Subject + ": " + d.Reason)));
        Assert.Contains("type=Remap", result.Source);
        Assert.Contains("inMin=0", result.Source);
        Assert.Contains("inMax=1", result.Source);
        Assert.Contains("outMin=0.35", result.Source);
        Assert.Contains("outMax=50", result.Source);
        Assert.DoesNotContain("inMinMax", result.Source);
        Assert.DoesNotContain("outMinMax", result.Source);
    }

    [Fact]
    public void Convert_DropsRemapWithWiredRangeAndSaysSo()
    {
        // A wired range cannot be split onto the four scalar pins; that must be an
        // honest, named drop — never a silently wrong constant.
        string json = Blocks(
            GraphData($"{Ref("pSpeed")}, {Ref("pRange")}",
                $"{Ref("pnSpeed")}, {Ref("pnRange")}, {Ref("nRemap")}, {Ref("bAlpha")}",
                string.Join(", ",
                    Edge("pnSpeed", 0, "nRemap", 0),
                    Edge("pnRange", 0, "nRemap", 1),
                    Edge("nRemap", 3, "bAlpha", 0))),
            Property("pSpeed", "Vector1ShaderProperty", "Speed", "_Speed", "0.5"),
            Property("pRange", "Vector2ShaderProperty", "Range", "_Range",
                @"{ ""x"": 0, ""y"": 1 }"),
            PropertyNode("pnSpeed", "pSpeed"),
            PropertyNode("pnRange", "pRange"),
            Node("nRemap", "RemapNode", -100, 0),
            BlockNode("bAlpha", "SurfaceDescription.Alpha"));

        ShaderGraphConversionResult result = ShaderGraphConverter.Convert(json, "SynthRemapWired");

        Assert.DoesNotContain("type=Remap", result.Source);
        Assert.Contains(result.Report.Dropped, d => d.Subject == "RemapNode" && d.Reason.Contains("wired"));
    }

    // ------------------------------------------------------------- pin audit --

    /// Every engine pin name the mapping table writes must exist as a parameter on
    /// the engine node's GLSL signature, and float parameters on vector nodes must
    /// be listed in ScalarPins. A phantom pin becomes an ignored node attribute
    /// while the real pin silently takes the unwired fallback.
    [Fact]
    public void NodeMap_EveryMappedPinExistsOnTheEngineSignature()
    {
        string? nodesRoot = TryFindEngineGraphNodesRoot();
        if (nodesRoot == null)
            return; // Standalone converter checkout without an engine tree; see TryFindEngineGraphNodesRoot.
        Dictionary<string, List<List<(string Name, string Type)>>> signatures = ParseEngineSignatures(nodesRoot);
        Assert.True(signatures.Count > 0, $"no SG_ signatures parsed under {nodesRoot}");

        var failures = new List<string>();
        foreach ((string unityType, SgNodeMapping mapping) in ShaderGraphNodeMap.kNodes)
        {
            foreach ((string? engineNode, bool vectorLane) in
                     new[] { (mapping.ScalarNode, false), (mapping.VectorNode, true) })
            {
                if (engineNode == null)
                    continue;
                if (!signatures.TryGetValue(engineNode, out List<List<(string Name, string Type)>>? overloads))
                {
                    failures.Add($"{unityType}: engine node '{engineNode}' has no SG_{engineNode} GLSL signature");
                    continue;
                }

                var declared = overloads.SelectMany(o => o).Select(p => p.Name)
                    .ToHashSet(StringComparer.Ordinal);
                foreach (string pin in mapping.InputPins.Values)
                {
                    if (!declared.Contains(pin))
                        failures.Add($"{unityType} -> SG_{engineNode}: pin '{pin}' does not exist " +
                                     $"(real pins: {string.Join(", ", declared.OrderBy(n => n, StringComparer.Ordinal))})");
                }

                if (!vectorLane)
                    continue;
                var floatPins = overloads.SelectMany(o => o).Where(p => p.Type == "float")
                    .Select(p => p.Name).ToHashSet(StringComparer.Ordinal);
                foreach (string pin in mapping.InputPins.Values)
                {
                    if (floatPins.Contains(pin) && !mapping.ScalarPins.Contains(pin))
                        failures.Add($"{unityType} -> SG_{engineNode}: pin '{pin}' is float in GLSL " +
                                     "but missing from ScalarPins");
                }
                foreach (string pin in mapping.ScalarPins)
                {
                    if (!floatPins.Contains(pin))
                        failures.Add($"{unityType} -> SG_{engineNode}: ScalarPins lists '{pin}' " +
                                     "which is not a float parameter in GLSL");
                }
            }
        }

        Assert.True(failures.Count == 0, string.Join("\n", failures));
    }

    /// Locates the engine's Graph/Nodes GLSL directory. Resolution order:
    /// OPENENGINE_ENGINE_ROOT (explicit engine checkout — set-but-wrong is an
    /// error, never a skip), then walking up from the test binary (an engine
    /// checkout has Engine/Modules/... above Managed/UnityConverter.Tests/bin).
    /// Inside the engine embed — marked by UnityConverter/mirror-manifest.json,
    /// which the embed sync writes and the standalone repo never carries — a
    /// failed walk means broken discovery and throws, so the audit can never
    /// silently stop running in engine CI. Only a standalone converter checkout
    /// with no engine root returns null, and the audit is skipped.
    static string? TryFindEngineGraphNodesRoot()
    {
        const string kNodesSubdir = "Engine/Modules/Rendering/Shaders/Graph/Nodes";
        string? envRoot = Environment.GetEnvironmentVariable("OPENENGINE_ENGINE_ROOT");
        if (!string.IsNullOrEmpty(envRoot))
        {
            string fromEnv = Path.Combine(envRoot, kNodesSubdir);
            if (!Directory.Exists(fromEnv))
                throw new InvalidOperationException(
                    $"OPENENGINE_ENGINE_ROOT is set but {fromEnv} does not exist");
            return fromEnv;
        }

        bool engineEmbed = false;
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            string candidate = Path.Combine(dir.FullName, kNodesSubdir);
            if (Directory.Exists(candidate))
                return candidate;
            if (File.Exists(Path.Combine(dir.FullName, "UnityConverter", "mirror-manifest.json")))
                engineEmbed = true;
            dir = dir.Parent;
        }
        if (engineEmbed)
            throw new InvalidOperationException(
                "engine Graph/Nodes directory not found above the engine embed; the pin audit must run from an engine checkout");
        return null;
    }

    static Dictionary<string, List<List<(string Name, string Type)>>> ParseEngineSignatures(string nodesRoot)
    {
        var signatures = new Dictionary<string, List<List<(string, string)>>>(StringComparer.Ordinal);
        var definition = new System.Text.RegularExpressions.Regex(
            @"^\s*(?:float|vec2|vec3|vec4|void)\s+SG_([A-Za-z0-9_]+)\s*\(([^)]*)\)",
            System.Text.RegularExpressions.RegexOptions.Multiline);
        foreach (string file in Directory.EnumerateFiles(nodesRoot, "*.glsl", SearchOption.AllDirectories))
        {
            foreach (System.Text.RegularExpressions.Match m in definition.Matches(File.ReadAllText(file)))
            {
                var pins = new List<(string, string)>();
                foreach (string raw in m.Groups[2].Value.Split(','))
                {
                    string p = raw.Trim();
                    if (p.StartsWith("in ", StringComparison.Ordinal) ||
                        p.StartsWith("out ", StringComparison.Ordinal) ||
                        p.StartsWith("inout ", StringComparison.Ordinal))
                    {
                        p = p[(p.IndexOf(' ') + 1)..].Trim();
                    }
                    string[] bits = p.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                    if (bits.Length >= 2)
                        pins.Add((bits[^1], bits[^2]));
                }
                if (!signatures.TryGetValue(m.Groups[1].Value, out List<List<(string, string)>>? overloads))
                    signatures[m.Groups[1].Value] = overloads = new();
                overloads.Add(pins);
            }
        }
        return signatures;
    }

    // ------------------------------------------------------ custom functions --

    static string Slot(string id, string type, int slotId, string display, int slotType, string value = "0.0") =>
        $@"{{
    ""m_Type"": ""UnityEditor.ShaderGraph.{type}, Unity.ShaderGraph.Editor"",
    ""m_ObjectId"": ""{id}"",
    ""m_Id"": {slotId},
    ""m_DisplayName"": ""{display}"",
    ""m_SlotType"": {slotType},
    ""m_Value"": {value}
}}";

    static string CustomFunctionNode(string id, string name, string body, string slots) =>
        $@"{{
    ""m_Type"": ""UnityEditor.ShaderGraph.CustomFunctionNode, Unity.ShaderGraph.Editor"",
    ""m_ObjectId"": ""{id}"",
    ""m_Name"": ""Custom Function"",
    ""m_DrawState"": {{ ""m_Position"": {{ ""x"": -300, ""y"": 0, ""width"": 100, ""height"": 40 }} }},
    ""m_Slots"": [{slots}],
    ""m_SourceType"": 1,
    ""m_FunctionName"": ""{name}"",
    ""m_FunctionBody"": ""{body}""
}}";

    [Fact]
    public void Convert_TranslatesCustomFunctionIntoAnSgNodeFile()
    {
        string json = Blocks(
            GraphData(Ref("pc"),
                $"{Ref("nCf")}, {Ref("pnc")}, {Ref("bBase")}",
                $"{Edge("pnc", 0, "nCf", 0)}, {Edge("nCf", 1, "bBase", 0)}"),
            Property("pc", "ColorShaderProperty", "Base Color", "_BaseColor",
                @"{ ""r"": 1, ""g"": 1, ""b"": 1, ""a"": 1 }"),
            PropertyNode("pnc", "pc"),
            CustomFunctionNode("nCf", "TintBoost",
                "Out = saturate(lerp(In, frac(In * 2.0), 0.5));",
                string.Join(", ", Ref("s0"), Ref("s1"))),
            Slot("s0", "Vector3MaterialSlot", 0, "In", 0, @"{ ""x"": 0, ""y"": 0, ""z"": 0 }"),
            Slot("s1", "Vector3MaterialSlot", 1, "Out", 1, @"{ ""x"": 0, ""y"": 0, ""z"": 0 }"),
            BlockNode("bBase", "SurfaceDescription.BaseColor"));

        ShaderGraphConversionResult result = ShaderGraphConverter.Convert(json, "SynthCustomFn");

        Assert.True(result.Success,
            string.Join("; ", result.Report.Dropped.Select(d => d.Subject + ": " + d.Reason)));

        // The graph references the translated node by type.
        Assert.Contains("type=TintBoost", result.Source);
        Assert.Contains("-> surface_out.BaseColor", result.Source);

        // A standalone node-library file is produced in the form SgNodeReflector reads.
        Assert.True(result.Report.GeneratedNodeFiles.ContainsKey("TintBoost.glsl"));
        string node = result.Report.GeneratedNodeFiles["TintBoost.glsl"];
        Assert.Contains("// @sgnode TintBoost", node);
        // Pin identifiers keep the Unity display-name spelling, because the HLSL body
        // assigns those names: lowercasing would declare `in` and assign `In`.
        Assert.Contains("vec3 SG_TintBoost(vec3 In)", node);
        Assert.Contains("vec3 Out;", node);
        Assert.Contains("return Out;", node);
        // HLSL intrinsics are rewritten, not passed through.
        Assert.Contains("mix(", node);
        Assert.Contains("fract(", node);
        Assert.DoesNotContain("lerp(", node);
        Assert.DoesNotContain("frac(", node);
    }

    [Fact]
    public void Convert_RefusesCustomFunctionItCannotTranslate()
    {
        // `mul` is refused deliberately: GLSL's `*` takes matrix operands in the
        // opposite order, so substituting it would silently transpose the transform.
        string json = Blocks(
            GraphData(Ref("pc"),
                $"{Ref("nCf")}, {Ref("pnc")}, {Ref("bBase")}, {Ref("bAo")}",
                $"{Edge("pnc", 0, "bBase", 0)}, {Edge("nCf", 1, "bAo", 0)}"),
            Property("pc", "ColorShaderProperty", "Base Color", "_BaseColor",
                @"{ ""r"": 1, ""g"": 1, ""b"": 1, ""a"": 1 }"),
            PropertyNode("pnc", "pc"),
            CustomFunctionNode("nCf", "BadFn", "Out = mul(worldMatrix, In).x;",
                string.Join(", ", Ref("s0"), Ref("s1"))),
            Slot("s0", "Vector3MaterialSlot", 0, "In", 0, @"{ ""x"": 0, ""y"": 0, ""z"": 0 }"),
            Slot("s1", "Vector1MaterialSlot", 1, "Out", 1),
            BlockNode("bBase", "SurfaceDescription.BaseColor"),
            BlockNode("bAo", "SurfaceDescription.Occlusion"));

        ShaderGraphConversionResult result = ShaderGraphConverter.Convert(json, "SynthBadFn");

        Assert.True(result.Success);
        Assert.Empty(result.Report.GeneratedNodeFiles);
        Assert.Contains(result.Report.Dropped, d => d.Reason.Contains("does not convert"));
        Assert.DoesNotContain("type=BadFn", result.Source);
    }

    [Fact]
    public void Convert_ReportsCustomFunctionBackedByExternalHlslFile()
    {
        string json = Blocks(
            GraphData(Ref("pc"),
                $"{Ref("nCf")}, {Ref("pnc")}, {Ref("bBase")}, {Ref("bAo")}",
                $"{Edge("pnc", 0, "bBase", 0)}, {Edge("nCf", 1, "bAo", 0)}"),
            Property("pc", "ColorShaderProperty", "Base Color", "_BaseColor",
                @"{ ""r"": 1, ""g"": 1, ""b"": 1, ""a"": 1 }"),
            PropertyNode("pnc", "pc"),
            $@"{{
    ""m_Type"": ""UnityEditor.ShaderGraph.CustomFunctionNode, Unity.ShaderGraph.Editor"",
    ""m_ObjectId"": ""nCf"",
    ""m_Name"": ""Custom Function"",
    ""m_DrawState"": {{ ""m_Position"": {{ ""x"": 0, ""y"": 0, ""width"": 100, ""height"": 40 }} }},
    ""m_Slots"": [{Ref("s1")}],
    ""m_SourceType"": 0,
    ""m_FunctionName"": ""FromFile"",
    ""m_FunctionSource"": ""9f8e7d6c5b4a39281706""
}}",
            Slot("s1", "Vector1MaterialSlot", 1, "Out", 1),
            BlockNode("bBase", "SurfaceDescription.BaseColor"),
            BlockNode("bAo", "SurfaceDescription.Occlusion"));

        ShaderGraphConversionResult result = ShaderGraphConverter.Convert(json, "SynthFileFn");

        Assert.Contains(result.Report.Dropped, d => d.Reason.Contains("external .hlsl file"));
        Assert.Empty(result.Report.GeneratedNodeFiles);
    }

    [Fact]
    public void Convert_ReportsNonGraphInputRatherThanThrowing()
    {
        ShaderGraphConversionResult result = ShaderGraphConverter.Convert("not json at all", "SynthGarbage");
        Assert.False(result.Success);
        Assert.Contains(result.Report.Dropped, d => d.Reason.Contains("not a readable Unity shader graph"));
    }
}
