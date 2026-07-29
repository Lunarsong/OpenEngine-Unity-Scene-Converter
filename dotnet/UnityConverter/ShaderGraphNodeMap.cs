namespace GameEngine.UnityConverter;

/// Unity ShaderGraph node type -> engine `@sgnode` type, with the Unity slot-id
/// tables needed to rewire edges.
///
/// Unity addresses pins by integer slot id declared per node class; the engine
/// addresses them by name. Every entry below was checked against real edges in
/// the Synty corpus rather than transcribed from memory.
///
/// Width: the engine node library is float/vec3, so each mapping names the node
/// for each width it supports. A width the mapping leaves null is reported as an
/// honest drop instead of being silently narrowed.
internal sealed class SgNodeMapping
{
    public required string UnityType;

    /// Engine node type for scalar (float) operands, null when unsupported.
    public string? ScalarNode;

    /// Engine node type for vec3 operands, null when unsupported.
    public string? VectorNode;

    /// Unity input slot id -> engine input pin name.
    public Dictionary<int, string> InputPins = new();

    /// Unity output slot id -> engine output pin name.
    public Dictionary<int, string> OutputPins = new();

    /// True when the operation acts per channel, so a vec4 operand can be lowered
    /// into an rgb node plus an alpha node without changing the result.
    public bool ComponentWise;

    /// Pins declared float on the engine's vector node (VectorLerp's weight,
    /// Fresnel's power). Operands land on them at width 1 regardless of how wide
    /// Unity serialized the slot.
    public HashSet<string> ScalarPins = new(StringComparer.Ordinal);
}

internal static class ShaderGraphNodeMap
{
    public const string kScalarPinResult = "result";

    /// Slot ids shared by the two-input/one-output math nodes (A=0, B=1, Out=2).
    static Dictionary<int, string> BinaryInputs(string a = "a", string b = "b") =>
        new() { [0] = a, [1] = b };

    static Dictionary<int, string> ResultAt(int slotId) => new() { [slotId] = kScalarPinResult };

    public static readonly Dictionary<string, SgNodeMapping> kNodes = BuildNodeTable();

    static Dictionary<string, SgNodeMapping> BuildNodeTable()
    {
        var table = new List<SgNodeMapping>
        {
            new() { UnityType = "MultiplyNode", ScalarNode = "Multiply", VectorNode = "VectorMultiply",
                    ComponentWise = true, InputPins = BinaryInputs(), OutputPins = ResultAt(2) },
            new() { UnityType = "AddNode", ScalarNode = "Add", VectorNode = "VectorAdd",
                    ComponentWise = true, InputPins = BinaryInputs(), OutputPins = ResultAt(2) },
            new() { UnityType = "SubtractNode", ScalarNode = "Subtract", VectorNode = "VectorSubtract",
                    ComponentWise = true, InputPins = BinaryInputs(), OutputPins = ResultAt(2) },
            new() { UnityType = "DivideNode", ScalarNode = "Divide", VectorNode = "VectorDivide",
                    ComponentWise = true, InputPins = BinaryInputs(), OutputPins = ResultAt(2) },
            new() { UnityType = "PowerNode", ScalarNode = "Power", VectorNode = null,
                    ComponentWise = true, InputPins = BinaryInputs("base", "exp"), OutputPins = ResultAt(2) },
            new() { UnityType = "MinimumNode", ScalarNode = "Min", VectorNode = null,
                    ComponentWise = true, InputPins = BinaryInputs(), OutputPins = ResultAt(2) },
            new() { UnityType = "MaximumNode", ScalarNode = "Max", VectorNode = null,
                    ComponentWise = true, InputPins = BinaryInputs(), OutputPins = ResultAt(2) },

            // Single-input, single-output: In=0, Out=1.
            new() { UnityType = "OneMinusNode", ScalarNode = "OneMinus", VectorNode = null,
                    ComponentWise = true, InputPins = new() { [0] = "value" }, OutputPins = ResultAt(1) },
            new() { UnityType = "SaturateNode", ScalarNode = "Saturate", VectorNode = null,
                    ComponentWise = true, InputPins = new() { [0] = "value" }, OutputPins = ResultAt(1) },
            new() { UnityType = "AbsoluteNode", ScalarNode = "Abs", VectorNode = null,
                    ComponentWise = true, InputPins = new() { [0] = "value" }, OutputPins = ResultAt(1) },
            new() { UnityType = "NormalizeNode", ScalarNode = null, VectorNode = "Normalize",
                    InputPins = new() { [0] = "value" }, OutputPins = ResultAt(1) },

            new() { UnityType = "LerpNode", ScalarNode = "Lerp", VectorNode = "VectorLerp",
                    ComponentWise = true,
                    InputPins = new() { [0] = "a", [1] = "b", [2] = "weight" }, OutputPins = ResultAt(3),
                    ScalarPins = new(StringComparer.Ordinal) { "weight" } },
            new() { UnityType = "ClampNode", ScalarNode = "Clamp", VectorNode = "VectorClamp",
                    ComponentWise = true,
                    InputPins = new() { [0] = "value", [1] = "minVal", [2] = "maxVal" }, OutputPins = ResultAt(3) },

            new() { UnityType = "DotProductNode", ScalarNode = null, VectorNode = "DotProduct",
                    InputPins = BinaryInputs(), OutputPins = ResultAt(2) },
            new() { UnityType = "DistanceNode", ScalarNode = null, VectorNode = "VectorDistance",
                    InputPins = BinaryInputs(), OutputPins = ResultAt(2) },

            new() { UnityType = "NormalStrengthNode", ScalarNode = null, VectorNode = "NormalStrength",
                    InputPins = new() { [0] = "value", [1] = "strength" }, OutputPins = ResultAt(2),
                    ScalarPins = new(StringComparer.Ordinal) { "strength" } },
            new() { UnityType = "NormalBlendNode", ScalarNode = null, VectorNode = "NormalBlend",
                    InputPins = BinaryInputs(), OutputPins = ResultAt(2) },

            // Sample Texture 2D: Texture=1, UV=2, Sampler=3; RGBA=0, R=4, G=5, B=6, A=7.
            new() { UnityType = "SampleTexture2DNode", ScalarNode = "SampleTexture2D",
                    VectorNode = "SampleTexture2D",
                    InputPins = new() { [1] = "tex", [2] = "uv" },
                    OutputPins = new() { [0] = "rgba", [4] = "r", [5] = "g", [6] = "b", [7] = "a" } },

            // Tiling And Offset: UV=0, Tiling=1, Offset=2, Out=3. The engine's
            // TransformUV is uv * scale + offset — the same expression.
            new() { UnityType = "TilingAndOffsetNode", ScalarNode = null, VectorNode = "TransformUV",
                    InputPins = new() { [0] = "uv", [1] = "scale", [2] = "offset" },
                    OutputPins = new() { [3] = "out" } },

            // Fresnel: Normal=0, ViewDir=1, Power=2, Out=3.
            new() { UnityType = "FresnelNode", ScalarNode = null, VectorNode = "Fresnel",
                    InputPins = new() { [0] = "normal", [1] = "view", [2] = "power" },
                    OutputPins = ResultAt(3),
                    ScalarPins = new(StringComparer.Ordinal) { "power" } },
        };

        var map = new Dictionary<string, SgNodeMapping>(StringComparer.Ordinal);
        foreach (SgNodeMapping entry in table)
            map[entry.UnityType] = entry;
        return map;
    }

    /// Unity Split: In=0; R=1, G=2, B=3, A=4. Handled as channel projection rather
    /// than a node, because the engine reads channels off the source expression.
    public static readonly Dictionary<int, int> kSplitChannelBySlot = new()
    {
        [1] = 0, [2] = 1, [3] = 2, [4] = 3,
    };

    /// Unity Branch: Predicate=0, True=1, False=2, Out=3.
    public const int kBranchPredicateSlot = 0;
    public const int kBranchTrueSlot = 1;
    public const int kBranchFalseSlot = 2;
    public const int kBranchOutputSlot = 3;

    /// PropertyNode and BlockNode both use slot 0 for their single pin.
    public const int kPropertyOutputSlot = 0;
    public const int kBlockInputSlot = 0;

    /// Unity node types that carry no shading meaning for us. Skipped silently —
    /// dropping a sticky note is not a fidelity loss worth reporting.
    public static readonly HashSet<string> kCosmeticNodes = new(StringComparer.Ordinal)
    {
        "StickyNoteData", "GroupData", "CategoryData",
    };

    /// Unity nodes that pass their single input straight through.
    public static readonly HashSet<string> kPassThroughNodes = new(StringComparer.Ordinal)
    {
        "RedirectNodeData",
    };

    /// Sampler state is implicit in the engine: the adapter owns the sampler a
    /// bindless texture is read through, so there is nothing to carry across.
    public static readonly HashSet<string> kImplicitNodes = new(StringComparer.Ordinal)
    {
        "SamplerStateNode",
    };

    /// Unity constant nodes -> the engine constant node of the same width. Their
    /// components live in the node's input slots, not in a value field.
    public static readonly Dictionary<string, (string EngineNode, int Width)> kConstantNodes =
        new(StringComparer.Ordinal)
        {
            ["Vector1Node"] = ("FloatConstant", 1),
            ["Vector2Node"] = ("Vec2Constant", 2),
            ["Vector3Node"] = ("Vec3Constant", 3),
            ["Vector4Node"] = ("Vec4Constant", 4),
        };

    /// Unity geometry/time source nodes -> a pin on the engine's EngineInput
    /// pseudo-node, keyed by the Unity output slot the graph reads.
    /// Only slots with an exact engine equivalent are listed; anything else on these
    /// nodes (Unity's SineTime, camera near/far, …) is reported rather than guessed.
    public sealed class SgEngineInputMapping
    {
        public required Dictionary<int, string> PinBySlot;
        public required int Width;
    }

    public static readonly Dictionary<string, SgEngineInputMapping> kEngineInputNodes =
        new(StringComparer.Ordinal)
        {
            ["NormalVectorNode"] = new() { PinBySlot = new() { [0] = "WorldNormal" }, Width = 3 },
            ["PositionNode"] = new() { PinBySlot = new() { [0] = "WorldPosition" }, Width = 3 },
            ["ViewDirectionNode"] = new() { PinBySlot = new() { [0] = "ViewDirection" }, Width = 3 },
            ["VertexColorNode"] = new() { PinBySlot = new() { [0] = "VertexColor" }, Width = 4 },
            ["UVNode"] = new() { PinBySlot = new() { [0] = "UV0" }, Width = 2 },
            ["TimeNode"] = new() { PinBySlot = new() { [0] = "Time" }, Width = 1 },
            ["SceneDepthNode"] = new() { PinBySlot = new() { [0] = "LinearDepth" }, Width = 1 },
            ["CameraNode"] = new() { PinBySlot = new() { [0] = "CameraPosition" }, Width = 3 },
        };

    /// A Unity SurfaceDescription/VertexDescription block -> the engine sink pin it
    /// drives, plus the semantic conversion the engine's convention requires.
    public sealed class SgBlockMapping
    {
        public required string EnginePin;

        /// Unity Smoothness is the complement of our Roughness, so the converter
        /// inserts a OneMinus rather than binding the value straight through.
        public bool InvertScalar;

        /// Width the engine sink pin expects.
        public required int Width;
    }

    public static readonly Dictionary<string, SgBlockMapping> kSurfaceBlocks = new(StringComparer.Ordinal)
    {
        ["SurfaceDescription.BaseColor"] = new() { EnginePin = "BaseColor", Width = 3 },
        ["SurfaceDescription.Emission"] = new() { EnginePin = "Emissive", Width = 3 },
        ["SurfaceDescription.NormalTS"] = new() { EnginePin = "Normal", Width = 3 },
        ["SurfaceDescription.Metallic"] = new() { EnginePin = "Metallic", Width = 1 },
        ["SurfaceDescription.Smoothness"] = new() { EnginePin = "Roughness", Width = 1, InvertScalar = true },
        ["SurfaceDescription.Occlusion"] = new() { EnginePin = "AmbientOcclusion", Width = 1 },
        ["SurfaceDescription.Alpha"] = new() { EnginePin = "Opacity", Width = 1 },
    };

    /// Blocks that configure the material document rather than feeding a graph pin.
    public const string kAlphaClipThresholdBlock = "SurfaceDescription.AlphaClipThreshold";

    /// Vertex blocks Unity always serializes. Position drives the vertex sink; the
    /// engine's vertex graph has no normal/tangent pin, so an unconnected
    /// normal/tangent block is a no-op rather than a loss.
    public const string kVertexPositionBlock = "VertexDescription.Position";

    public static readonly HashSet<string> kIgnorableVertexBlocks = new(StringComparer.Ordinal)
    {
        "VertexDescription.Normal", "VertexDescription.Tangent",
    };

    /// Unity property class -> engine graph property type and channel width.
    public static readonly Dictionary<string, (string SgType, int Width)> kPropertyTypes =
        new(StringComparer.Ordinal)
        {
            ["Vector1ShaderProperty"] = ("float", 1),
            ["Vector2ShaderProperty"] = ("vec2", 2),
            ["Vector3ShaderProperty"] = ("vec3", 3),
            ["Vector4ShaderProperty"] = ("vec4", 4),
            ["ColorShaderProperty"] = ("vec4", 4),
            ["BooleanShaderProperty"] = ("float", 1),
        };

    public const string kTexturePropertyType = "Texture2DShaderProperty";

    /// Unity reference name (lowercased, non-alphanumerics stripped) -> the engine
    /// material property whose semantics match. These reach the GPU through the
    /// engine's own named field, so they stay inspector-editable after import.
    public static readonly Dictionary<string, string> kSemanticProperties = new(StringComparer.Ordinal)
    {
        ["basecolor"] = "baseColor",
        ["color"] = "baseColor",
        ["maincolor"] = "baseColor",
        ["metallic"] = "metallic",
        ["emissioncolor"] = "emissive",
        ["emissivecolor"] = "emissive",
        ["occlusion"] = "ao",
        ["alphaclipthreshold"] = "alphaCutoff",
    };

    /// Well-known engine texture slot names, in the canonical bindless order the
    /// surface contract assigns. A converted texture property claims the slot its
    /// Unity name implies so the adapter's ordinals stay canonical.
    public static readonly Dictionary<string, string> kSemanticTextures = new(StringComparer.Ordinal)
    {
        ["albedomap"] = "albedoMap",
        ["basemap"] = "albedoMap",
        ["maintex"] = "albedoMap",
        ["normalmap"] = "normalMap",
        ["bumpmap"] = "normalMap",
        ["emissionmap"] = "emissiveMap",
        ["emissivemap"] = "emissiveMap",
        ["occlusionmap"] = "aoMap",
        ["aomap"] = "aoMap",
        ["metallicmap"] = "metallicMap",
        ["roughnessmap"] = "roughnessMap",
    };

    public static string NormalizeName(string name)
    {
        var chars = new List<char>(name.Length);
        foreach (char c in name)
        {
            if (char.IsLetterOrDigit(c))
                chars.Add(char.ToLowerInvariant(c));
        }
        return new string(chars.ToArray());
    }
}
