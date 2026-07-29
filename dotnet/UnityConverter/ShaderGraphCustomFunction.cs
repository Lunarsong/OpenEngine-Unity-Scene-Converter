using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace GameEngine.UnityConverter;

/// Unity Custom Function nodes -> standalone `@sgnode` .glsl node files.
///
/// A Custom Function is an HLSL body plus a slot list. The engine's node library is
/// annotated GLSL reflected by SgNodeReflector from function signatures, so the
/// faithful destination is a node file of exactly that form: the translated body,
/// an `@sgnode` tag, and `@param`/`@out` tags naming the pins. The reflector globs
/// every .glsl under the project's Assets directory, so a generated file is picked
/// up without any registration step.
///
/// The translator is deliberately narrow. It converts what it can prove and refuses
/// the rest: a body containing HLSL this does not understand is reported by name
/// rather than emitted as a node that would fail to compile later.
internal static class ShaderGraphCustomFunction
{
    /// Unity's source-type discriminator on CustomFunctionNode.
    const int kSourceTypeFile = 0;
    const int kSourceTypeString = 1;

    /// Unity slot class -> GLSL type. Dynamic slots are absent on purpose: a Custom
    /// Function declares concrete types, and guessing a width here would produce a
    /// node whose signature silently disagrees with the author's HLSL.
    static readonly Dictionary<string, string> kSlotGlslTypes = new(StringComparer.Ordinal)
    {
        ["Vector1MaterialSlot"] = "float",
        ["Vector2MaterialSlot"] = "vec2",
        ["Vector3MaterialSlot"] = "vec3",
        ["Vector4MaterialSlot"] = "vec4",
        ["ColorRGBMaterialSlot"] = "vec3",
        ["ColorRGBAMaterialSlot"] = "vec4",
        ["Texture2DInputMaterialSlot"] = "sampler2D",
        ["Texture2DMaterialSlot"] = "sampler2D",
        ["BooleanMaterialSlot"] = "bool",
    };

    /// Slots that carry nothing across: the adapter owns the sampler.
    static readonly HashSet<string> kIgnoredSlotTypes = new(StringComparer.Ordinal)
    {
        "SamplerStateMaterialSlot",
    };

    /// HLSL -> GLSL, longest-token-first so `float4x4` is rewritten before `float4`.
    static readonly (string Hlsl, string Glsl)[] kTypeRewrites =
    {
        ("float4x4", "mat4"), ("float3x3", "mat3"), ("float2x2", "mat2"),
        ("half4x4", "mat4"), ("half3x3", "mat3"), ("half2x2", "mat2"),
        ("float4", "vec4"), ("float3", "vec3"), ("float2", "vec2"),
        ("half4", "vec4"), ("half3", "vec3"), ("half2", "vec2"),
        ("int4", "ivec4"), ("int3", "ivec3"), ("int2", "ivec2"),
        ("bool4", "bvec4"), ("bool3", "bvec3"), ("bool2", "bvec2"),
        ("half", "float"), ("fixed", "float"),
    };

    static readonly (string Hlsl, string Glsl)[] kIntrinsicRewrites =
    {
        ("lerp", "mix"), ("frac", "fract"), ("atan2", "atan"),
        ("ddx", "dFdx"), ("ddy", "dFdy"), ("fmod", "mod"),
        ("rsqrt", "inversesqrt"), ("tex2D", "texture"), ("tex2Dlod", "textureLod"),
    };

    /// HLSL this translator cannot honestly convert. `mul` is included because
    /// GLSL's `*` has the opposite operand order for matrices, so a mechanical
    /// substitution would silently transpose the transform.
    static readonly string[] kUntranslatable =
    {
        "mul", "SAMPLE_TEXTURE2D", "UNITY_", "TEXTURE2D", "SamplerState",
        "unity_", "cbuffer", "StructuredBuffer", "clip",
        // Any preprocessor directive: the body is selecting on shader keywords or
        // pulling in includes that exist only inside Unity's shader library.
        "#",
    };

    /// Calls a translated body may make: GLSL builtins, type constructors, and
    /// `saturate`, which is HLSL-only and gets a helper emitted alongside it.
    static readonly HashSet<string> kGlslBuiltins = new(StringComparer.Ordinal)
    {
        "abs", "acos", "all", "any", "asin", "atan", "ceil", "clamp", "cos", "cosh",
        "cross", "degrees", "determinant", "dFdx", "dFdy", "distance", "dot", "exp",
        "exp2", "faceforward", "floor", "fract", "fwidth", "inverse", "inversesqrt",
        "isinf", "isnan", "length", "log", "log2", "matrixCompMult", "max", "min",
        "mix", "mod", "modf", "normalize", "pow", "radians", "reflect", "refract",
        "round", "sign", "sin", "sinh", "smoothstep", "sqrt", "step", "tan", "tanh",
        "texture", "textureLod", "textureGrad", "textureSize", "transpose", "trunc",
        // constructors
        "float", "int", "uint", "bool", "vec2", "vec3", "vec4", "ivec2", "ivec3",
        "ivec4", "bvec2", "bvec3", "bvec4", "mat2", "mat3", "mat4",
        // HLSL carry-over with a helper
        "saturate",
    };

    /// GLSL keywords a Unity pin display name can collide with ("Out" sanitizes to
    /// `out`). A colliding pin is renamed in the signature and in the body together.
    static readonly HashSet<string> kGlslReserved = new(StringComparer.Ordinal)
    {
        "in", "out", "inout", "uniform", "varying", "attribute", "const", "buffer",
        "shared", "layout", "sampler", "image", "float", "int", "uint", "bool",
        "vec2", "vec3", "vec4", "mat2", "mat3", "mat4", "void", "return", "discard",
    };

    public sealed class Translation
    {
        public required string TypeId;
        public required string FileName;
        public required string Source;
        public required List<(string Pin, string GlslType)> Inputs;
        public required List<(string Pin, string GlslType)> Outputs;
    }

    /// Translates a CustomFunctionNode, or returns null with the reason recorded.
    public static Translation? TryTranslate(UnityNode node, out string failure)
    {
        failure = string.Empty;

        int sourceType = node.Raw.TryGetProperty("m_SourceType", out JsonElement st) &&
                         st.TryGetInt32(out int parsedType)
            ? parsedType
            : kSourceTypeString;

        if (sourceType == kSourceTypeFile)
        {
            failure = "custom function reads an external .hlsl file; only an inline body can be translated";
            return null;
        }

        string functionName = node.Raw.TryGetProperty("m_FunctionName", out JsonElement fn)
            ? fn.GetString() ?? string.Empty
            : string.Empty;
        string body = node.Raw.TryGetProperty("m_FunctionBody", out JsonElement fb)
            ? fb.GetString() ?? string.Empty
            : string.Empty;

        if (string.IsNullOrWhiteSpace(functionName) || string.IsNullOrWhiteSpace(body))
        {
            failure = "custom function has no inline body to translate";
            return null;
        }

        string typeId = SanitizeTypeId(functionName);
        if (typeId.Length == 0)
        {
            failure = $"custom function name '{functionName}' has no usable identifier";
            return null;
        }

        var inputs = new List<(string Pin, string GlslType)>();
        var outputs = new List<(string Pin, string GlslType)>();
        if (!ReadSignature(node, inputs, outputs, out failure))
            return null;
        if (outputs.Count == 0)
        {
            failure = "custom function declares no output slot";
            return null;
        }

        string translated = TranslateBody(body, inputs.Concat(outputs).Select(p => p.Item1),
                                          out bool needsSaturate, out failure);
        if (failure.Length > 0)
            return null;

        for (int i = 0; i < inputs.Count; i++)
            inputs[i] = (ResolveReservedPin(inputs[i].Pin, ref translated), inputs[i].GlslType);
        for (int i = 0; i < outputs.Count; i++)
            outputs[i] = (ResolveReservedPin(outputs[i].Pin, ref translated), outputs[i].GlslType);

        return new Translation
        {
            TypeId = typeId,
            FileName = typeId + ".glsl",
            Source = Emit(typeId, functionName, inputs, outputs, translated, needsSaturate),
            Inputs = inputs,
            Outputs = outputs,
        };
    }

    static bool ReadSignature(UnityNode node, List<(string, string)> inputs,
                              List<(string, string)> outputs, out string failure)
    {
        failure = string.Empty;
        foreach (KeyValuePair<int, UnitySlot> entry in node.Slots.OrderBy(s => s.Key))
        {
            UnitySlot slot = entry.Value;
            string slotType = slot.TypeName;

            if (kIgnoredSlotTypes.Contains(slotType))
                continue;
            if (!kSlotGlslTypes.TryGetValue(slotType, out string? glslType))
            {
                failure = $"custom function pin '{slot.DisplayName}' has slot type {slotType}, " +
                          "which has no unambiguous GLSL type";
                return false;
            }

            string pin = SanitizePin(slot.DisplayName);
            if (pin.Length == 0)
                pin = (slot.IsInput ? "in" : "out") + entry.Key.ToString();

            if (slot.IsInput)
                inputs.Add((pin, glslType));
            else
                outputs.Add((pin, glslType));
        }
        return true;
    }

    static string TranslateBody(string body, IEnumerable<string> pins, out bool needsSaturate,
                                out string failure)
    {
        failure = string.Empty;
        needsSaturate = false;
        foreach (string token in kUntranslatable)
        {
            if (body.Contains(token, StringComparison.Ordinal))
            {
                failure = $"custom function body uses '{token}', which this translator does not convert";
                return string.Empty;
            }
        }

        string text = body.Replace("\r\n", "\n");
        foreach ((string hlsl, string glsl) in kTypeRewrites)
            text = Regex.Replace(text, $@"\b{Regex.Escape(hlsl)}\b", glsl);
        foreach ((string hlsl, string glsl) in kIntrinsicRewrites)
            text = Regex.Replace(text, $@"\b{Regex.Escape(hlsl)}\b(?=\s*\()", glsl);

        // HLSL accepts a float suffix; GLSL does not, so `1.0f` would fail to compile.
        text = Regex.Replace(text, @"(\d)[fF]\b", "$1");

        // Every call has to resolve to something that exists on our side. A body
        // calling into Unity's shader library (GetMainLight, TransformWorldToShadowCoord)
        // must be refused, not emitted as a node that fails to compile later.
        var known = new HashSet<string>(kGlslBuiltins, StringComparer.Ordinal);
        foreach (string pin in pins)
            known.Add(pin);
        foreach (Match call in Regex.Matches(text, @"\b([A-Za-z_]\w*)\s*\("))
        {
            string name = call.Groups[1].Value;
            if (known.Contains(name))
            {
                if (name == "saturate")
                    needsSaturate = true;
                continue;
            }
            failure = $"custom function body calls '{name}', which has no equivalent here";
            return string.Empty;
        }

        return text.Trim();
    }

    static string Emit(string typeId, string originalName, List<(string Pin, string GlslType)> inputs,
                       List<(string Pin, string GlslType)> outputs, string body, bool needsSaturate)
    {
        var sb = new StringBuilder();
        sb.Append("// @category Unity\n");
        sb.Append("// @version 1\n");
        sb.Append("//\n");
        sb.Append($"// Translated from the Unity Custom Function '{originalName}'.\n");
        sb.Append("// Reflected by SgNodeReflector from the signature below.\n");
        sb.Append("\n");
        if (needsSaturate)
        {
            // HLSL's saturate has no GLSL equivalent; the overloads keep the translated
            // body readable instead of rewriting each call site.
            sb.Append("float saturate(float v) { return clamp(v, 0.0, 1.0); }\n");
            sb.Append("vec2 saturate(vec2 v) { return clamp(v, vec2(0.0), vec2(1.0)); }\n");
            sb.Append("vec3 saturate(vec3 v) { return clamp(v, vec3(0.0), vec3(1.0)); }\n");
            sb.Append("vec4 saturate(vec4 v) { return clamp(v, vec4(0.0), vec4(1.0)); }\n");
            sb.Append("\n");
        }
        sb.Append($"// @sgnode {typeId}\n");
        sb.Append($"// @display \"{originalName}\"\n");
        foreach ((string pin, string _) in inputs)
            sb.Append($"// @param {pin} \"{pin}\"\n");
        foreach ((string pin, string _) in outputs)
            sb.Append($"// @out {pin} {pin}\n");

        // A single output is returned; several become out parameters, which is the
        // shape SgGraphCompiler emits multi-output calls in.
        bool single = outputs.Count == 1;
        var parameters = new List<string>();
        foreach ((string pin, string type) in inputs)
            parameters.Add($"{type} {pin}");
        if (!single)
        {
            foreach ((string pin, string type) in outputs)
                parameters.Add($"out {type} {pin}");
        }

        string returnType = single ? outputs[0].GlslType : "void";
        sb.Append($"{returnType} SG_{typeId}({string.Join(", ", parameters)})\n");
        sb.Append("{\n");
        if (single)
            sb.Append($"    {outputs[0].GlslType} {outputs[0].Pin};\n");
        foreach (string line in body.Split('\n'))
            sb.Append("    ").Append(line.TrimEnd()).Append('\n');
        if (single)
            sb.Append($"    return {outputs[0].Pin};\n");
        sb.Append("}\n");
        return sb.ToString();
    }

    static string SanitizeTypeId(string name)
    {
        var chars = new List<char>(name.Length);
        foreach (char c in name)
        {
            if (char.IsLetterOrDigit(c) || c == '_')
                chars.Add(c);
        }
        while (chars.Count > 0 && char.IsDigit(chars[0]))
            chars.RemoveAt(0);
        return new string(chars.ToArray());
    }

    /// The HLSL body refers to pins by their Unity display name, so the identifier
    /// keeps that spelling exactly — lowercasing it would leave the body assigning a
    /// name the signature does not declare.
    static string SanitizePin(string displayName)
    {
        var chars = new List<char>(displayName.Length);
        foreach (char c in displayName)
        {
            if (char.IsLetterOrDigit(c) || c == '_')
                chars.Add(c);
        }
        if (chars.Count > 0 && char.IsDigit(chars[0]))
            chars.Insert(0, '_');
        return new string(chars.ToArray());
    }

    /// Renames a pin that collides with a GLSL keyword, in the signature and in the
    /// body at once, so the two keep agreeing.
    static string ResolveReservedPin(string pin, ref string body)
    {
        if (!kGlslReserved.Contains(pin))
            return pin;
        string renamed = "sg" + char.ToUpperInvariant(pin[0]) + pin[1..];
        body = Regex.Replace(body, $@"\b{Regex.Escape(pin)}\b", renamed);
        return renamed;
    }
}
