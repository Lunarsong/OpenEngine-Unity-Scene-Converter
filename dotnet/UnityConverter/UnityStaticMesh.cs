using System.Buffers.Binary;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace GameEngine.UnityConverter;

/// Authoring-only decoder for one uncompressed, static Unity Mesh v10 document.
/// Arrays own their data and retain source coordinates until GLB encoding.
internal static class UnityStaticMesh
{
    internal sealed class Mesh
    {
        public required string Name;
        public readonly Dictionary<string, float[]> Attributes = [];
        public readonly List<uint[]> Submeshes = [];
        public readonly List<int> RepairedTangentVertices = [];
    }

    private static readonly (string Name, int Channel, int Dimension)[] Attributes =
        [("POSITION", 0, 3), ("NORMAL", 1, 3), ("TANGENT", 2, 4), ("TEXCOORD_0", 4, 2)];
    private const RegexOptions Options = RegexOptions.Multiline | RegexOptions.CultureInvariant;
    private static void Require(bool condition, string message)
    {
        if (!condition) throw new InvalidDataException(message);
    }

    private static string Field(string text, string name, int indent = 2)
    {
        var matches = Regex.Matches(text, "^" + new string(' ', indent) + Regex.Escape(name) + ": *(.*)$", Options);
        Require(matches.Count == 1, $"Expected one Unity Mesh field: {name}");
        return matches[0].Groups[1].Value.Trim();
    }

    private static long Integer(string value, string label)
    {
        Require(Regex.IsMatch(value, @"^-?\d+$", RegexOptions.CultureInvariant) &&
            long.TryParse(value, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out _) &&
            Math.Abs(decimal.Parse(value, CultureInfo.InvariantCulture)) <= 9007199254740991m,
            $"Invalid Unity integer: {label}");
        return long.Parse(value, CultureInfo.InvariantCulture);
    }

    private static string Section(string text, string name, string following, int indent = 2)
    {
        Require(Field(text, name, indent) == "", $"Invalid Unity Mesh section: {name}");
        Field(text, following, indent);
        string spaces = new(' ', indent);
        var match = Regex.Match(text, "^" + spaces + Regex.Escape(name) + ":\n([\\s\\S]*?)^" + spaces + Regex.Escape(following) + ":", Options);
        Require(match.Success, $"Expected one Unity Mesh section: {name}");
        return match.Groups[1].Value;
    }

    private static byte[] HexBytes(string value, string label)
    {
        Require(value.Length % 2 == 0 && Regex.IsMatch(value, "^[0-9a-fA-F]*$", RegexOptions.CultureInvariant), $"Invalid Unity hex buffer: {label}");
        return Convert.FromHexString(value);
    }

    private static string MeshName(string value)
    {
        if (value.StartsWith('"'))
        {
            try { return JsonSerializer.Deserialize<string>(value) ?? throw new InvalidDataException("Invalid Unity mesh name"); }
            catch (JsonException) { throw new InvalidDataException("Invalid Unity mesh name"); }
        }
        if (value.StartsWith('\''))
        {
            Require(value.Length >= 2 && value.EndsWith('\''), "Invalid Unity mesh name");
            return value[1..^1].Replace("''", "'");
        }
        return value;
    }

    private static double Hypot(double[] values)
    {
        double max = values.Max(Math.Abs);
        if (max == 0) return 0;
        double sum = 0, correction = 0;
        foreach (double value in values)
        {
            double scaled = value / max, term = scaled * scaled - correction, next = sum + term;
            correction = (next - sum) - term;
            sum = next;
        }
        return Math.Sqrt(sum) * max;
    }

    public static Mesh Read(string text, string fileId = "4300000")
    {
        Require(text != null, "Expected Unity Mesh text");
        Require(fileId != null && Regex.IsMatch(fileId, @"^-?[0-9]+$", RegexOptions.CultureInvariant), "Expected a string Unity Mesh fileID");
        text = text!.Replace("\r\n", "\n");
        var headers = Regex.Matches(text, "^---.*$", Options);
        Require(headers.Count == 1 && headers[0].Value == $"--- !u!43 &{fileId}", $"Expected one Unity Mesh document (fileID {fileId})");
        Require(text.Contains(headers[0].Value + "\nMesh:\n", StringComparison.Ordinal), "Expected a Unity Mesh document body");
        Require(Field(text, "serializedVersion") == "10", "Unsupported Unity Mesh version");
        Require(Field(text, "m_MeshCompression") == "0", "Compressed Unity Mesh is unsupported");
        Require(Field(text, "m_BindPose") == "[]" && Field(text, "m_BonesAABB") == "[]", "Skinned Unity Mesh is unsupported");
        string shapes = Section(text, "m_Shapes", "m_BindPose");
        Require(new[] { "vertices", "shapes", "channels", "fullWeights" }.All(key => Field(shapes, key, 4) == "[]"), "Unity blend shapes are unsupported");
        Require(Field(text, "m_StreamData") == "", "Invalid Unity stream data");
        string[] stream = text.Split("  m_StreamData:\n");
        Require(stream.Length == 2 && Field(stream[1], "size", 4) == "0" && Field(stream[1], "path", 4) == "", "External Unity vertex data is unsupported");
        string compressed = Section(text, "m_CompressedMesh", "m_LocalAABB");
        var counts = Regex.Matches(compressed, "^      m_NumItems: (.*)$", Options);
        Require(counts.Count == 10 && counts.All(match => match.Groups[1].Value.Trim() == "0"), "Compressed Unity vertex channels are unsupported");
        string vertex = Section(text, "m_VertexData", "m_CompressedMesh");
        long vertexCount = Integer(Field(vertex, "m_VertexCount", 4), "m_VertexCount");
        Require(vertexCount > 0 && vertexCount <= 1000000, "Invalid Unity vertex count");
        int count = (int)vertexCount;
        string channelText = Section(vertex, "m_Channels", "m_DataSize", 4);
        const string channelPattern = "^    - stream: (\\d+)\n      offset: (\\d+)\n      format: (\\d+)\n      dimension: (\\d+)\n";
        var channels = Regex.Matches(channelText, channelPattern, Options)
            .Select(match => Enumerable.Range(1, 4).Select(i => Integer(match.Groups[i].Value, "channel")).ToArray()).ToArray();
        Require(channels.Length == 14 && Regex.Replace(channelText, channelPattern, "", Options).Trim() == "", "Unsupported Unity vertex channel table");
        int[] active = Enumerable.Range(0, channels.Length).Where(i => channels[i][3] != 0).ToArray();
        Require(active.SequenceEqual(new[] { 0, 1, 2, 4 }), "Unsupported or missing Unity vertex attributes");
        Require(active.All(i => channels[i][0] == 0 && channels[i][2] == 0), "Expected a single float32 Unity vertex stream");
        var occupied = new List<(long Start, long End)>();
        foreach (var attribute in Attributes)
        {
            long offset = channels[attribute.Channel][1], end = offset + attribute.Dimension * 4;
            Require(channels[attribute.Channel][3] == attribute.Dimension && offset % 4 == 0 && end <= 9007199254740991L, "Invalid Unity attribute layout");
            Require(occupied.All(range => end <= range.Start || offset >= range.End), "Overlapping Unity attribute channels");
            occupied.Add((offset, end));
        }
        long stride = occupied.Max(range => range.End);
        byte[] data = HexBytes(Field(vertex, "_typelessdata", 4), "_typelessdata");
        Require(data.Length == Integer(Field(vertex, "m_DataSize", 4), "m_DataSize") &&
            stride <= data.Length / count && data.Length == stride * count, "Unity vertex byte count does not match its layout");
        var mesh = new Mesh { Name = MeshName(Field(text, "m_Name")) };
        foreach (var attribute in Attributes)
        {
            int dimension = attribute.Dimension;
            float[] values = new float[count * dimension];
            for (int v = 0; v < count; v++)
                for (int d = 0; d < dimension; d++)
                    values[v * dimension + d] = BinaryPrimitives.ReadSingleLittleEndian(data.AsSpan((int)(v * stride + channels[attribute.Channel][1] + d * 4), 4));
            if (attribute.Name == "TANGENT")
            {
                for (int v = 0; v < count; v++)
                {
                    int t = v * 4;
                    bool repair = float.IsNaN(values[t]) && float.IsNaN(values[t + 1]) && float.IsNaN(values[t + 2]);
                    Require(float.IsFinite(values[t + 3]) && (repair || (float.IsFinite(values[t]) && float.IsFinite(values[t + 1]) && float.IsFinite(values[t + 2]))), "Invalid Unity tangent data");
                    Require(values[t + 3] is -1 or 1, "Unity tangent handedness must be -1 or 1");
                    if (!repair) continue;
                    double[] n = mesh.Attributes["NORMAL"].AsSpan(v * 3, 3).ToArray().Select(value => (double)value).ToArray();
                    double length = Hypot(n);
                    Require(length > 1e-6, "Cannot repair tangent with a zero normal");
                    for (int d = 0; d < 3; d++) n[d] /= length;
                    int axis = 0;
                    for (int d = 1; d < 3; d++) if (Math.Abs(n[d]) < Math.Abs(n[axis])) axis = d;
                    double[] tangent = n.Select((value, d) => (d == axis ? 1d : 0d) - value * n[axis]).ToArray();
                    double tangentLength = Hypot(tangent);
                    for (int d = 0; d < 3; d++) values[t + d] = (float)(tangent[d] / tangentLength);
                    mesh.RepairedTangentVertices.Add(v);
                }
            }
            else Require(values.All(float.IsFinite), "Non-finite Unity vertex attribute");
            mesh.Attributes[attribute.Name] = values;
        }
        long indexFormat = Integer(Field(text, "m_IndexFormat"), "m_IndexFormat");
        Require(indexFormat is 0 or 1, "Unsupported Unity index format");
        byte[] indexBytes = HexBytes(Field(text, "m_IndexBuffer"), "m_IndexBuffer");
        int itemSize = indexFormat == 0 ? 2 : 4;
        Require(indexBytes.Length % itemSize == 0, "Truncated Unity index buffer");
        int indexCount = indexBytes.Length / itemSize;
        string[] submeshes = Section(text, "m_SubMeshes", "m_Shapes").Split("  - serializedVersion: 2\n");
        Require(submeshes.Length > 1 && submeshes[0].Trim() == "", "Unsupported Unity submesh table");
        var ranges = new List<(long Start, long End)>();
        foreach (string submesh in submeshes.Skip(1))
        {
            long first = Integer(Field(submesh, "firstByte", 4), "firstByte"), length = Integer(Field(submesh, "indexCount", 4), "indexCount");
            long baseVertex = Integer(Field(submesh, "baseVertex", 4), "baseVertex"), start = Integer(Field(submesh, "firstVertex", 4), "firstVertex"), vertices = Integer(Field(submesh, "vertexCount", 4), "vertexCount");
            Require(Field(submesh, "topology", 4) == "0", "Only triangle Unity submeshes are supported");
            Require(first >= 0 && first % itemSize == 0 && length > 0 && length % 3 == 0, "Invalid Unity triangle range");
            long begin = first / itemSize, end = begin + length;
            Require(end <= indexCount && start >= 0 && vertices > 0 && start + vertices <= count, "Unity submesh range outside buffer");
            Require(ranges.All(range => end <= range.Start || begin >= range.End), "Overlapping Unity submesh index ranges");
            ranges.Add((begin, end));
            uint[] values = new uint[(int)length];
            for (int i = 0; i < values.Length; i++)
            {
                int offset = (int)((begin + i) * itemSize);
                long value = (itemSize == 2 ? BinaryPrimitives.ReadUInt16LittleEndian(indexBytes.AsSpan(offset, 2)) : BinaryPrimitives.ReadUInt32LittleEndian(indexBytes.AsSpan(offset, 4))) + baseVertex;
                Require(value >= start && value < start + vertices, "Unity index outside submesh vertices");
                values[i] = (uint)value;
            }
            mesh.Submeshes.Add(values);
        }
        Require(ranges.Sum(range => range.End - range.Start) == indexCount, "Unclaimed Unity indices");
        return mesh;
    }

    private static JsonObj Obj(params (string Key, object? Value)[] pairs)
    {
        var result = new JsonObj();
        foreach (var (key, value) in pairs) result[key] = value;
        return result;
    }

    public static byte[] EncodeGlb(Mesh mesh, IReadOnlyList<string>? materialNames = null)
    {
        Require(mesh != null && mesh.Name != null && mesh.Submeshes.Count > 0, "Invalid static mesh");
        if (materialNames != null)
        {
            Require(materialNames.Count == mesh!.Submeshes.Count, "Invalid static mesh material names: expected one nonempty string per submesh");
            foreach (string name in materialNames)
                Require(!string.IsNullOrEmpty(name), "Invalid static mesh material names: expected one nonempty string per submesh");
        }
        Require(mesh!.Attributes.TryGetValue("POSITION", out var positions) && positions.Length % 3 == 0 && positions.Length is > 0 and <= 3000000, "Invalid static mesh vertex count");
        int count = positions!.Length / 3;
        Require(mesh.Attributes.Keys.Order().SequenceEqual(Attributes.Select(a => a.Name).Order()), "Invalid static mesh attributes");
        foreach (var attribute in Attributes)
            Require(mesh.Attributes[attribute.Name].Length == count * attribute.Dimension && mesh.Attributes[attribute.Name].All(float.IsFinite), $"Invalid static mesh attribute: {attribute.Name}");
        for (int i = 3; i < mesh.Attributes["TANGENT"].Length; i += 4)
            Require(mesh.Attributes["TANGENT"][i] is -1 or 1, "Static mesh tangent handedness must be -1 or 1");
        var sceneNodes = new JsonArr(); var nodes = new JsonArr(); var meshes = new JsonArr(); var views = new JsonArr(); var accessors = new JsonArr();
        var document = Obj(("asset", Obj(("version", "2.0"), ("generator", "OpenEngine Unity static mesh converter"))),
            ("scene", 0), ("scenes", new JsonArr { Obj(("nodes", sceneNodes)) }), ("nodes", nodes), ("meshes", meshes),
            ("materials", new JsonArr(mesh.Submeshes.Select((_, slot) => (object?)Obj(("name", materialNames == null ? $"UnityMaterial_{slot}" : materialNames[slot]))))),
            ("buffers", new JsonArr()), ("bufferViews", views), ("accessors", accessors));
        using var binary = new MemoryStream();
        int Accessor(float[]? floats, uint[]? indices, int dimension, int target)
        {
            int length = floats?.Length ?? indices!.Length, component = floats != null ? 5126 : 5125;
            while (binary.Position % 4 != 0) binary.WriteByte(0);
            int offset = checked((int)binary.Position);
            byte[] payload = new byte[checked(length * 4)];
            for (int i = 0; i < length; i++)
                if (floats != null) BinaryPrimitives.WriteSingleLittleEndian(payload.AsSpan(i * 4, 4), floats[i]);
                else BinaryPrimitives.WriteUInt32LittleEndian(payload.AsSpan(i * 4, 4), indices![i]);
            int view = views.Count;
            views.Add(Obj(("buffer", 0), ("byteOffset", offset), ("byteLength", payload.Length), ("target", target)));
            binary.Write(payload);
            var accessor = Obj(("bufferView", view), ("componentType", component), ("count", length / dimension), ("type", dimension == 1 ? "SCALAR" : $"VEC{dimension}"));
            if (dimension == 3 && target == 34962)
            {
                double[] min = [double.PositiveInfinity, double.PositiveInfinity, double.PositiveInfinity], max = [double.NegativeInfinity, double.NegativeInfinity, double.NegativeInfinity];
                for (int i = 0; i < length; i++) { min[i % 3] = Math.Min(min[i % 3], floats![i]); max[i % 3] = Math.Max(max[i % 3], floats[i]); }
                accessor["min"] = min; accessor["max"] = max;
            }
            accessors.Add(accessor);
            return accessors.Count - 1;
        }
        for (int slot = 0; slot < mesh.Submeshes.Count; slot++)
        {
            uint[] source = mesh.Submeshes[slot];
            Require(source.Length > 0 && source.Length % 3 == 0 && source.All(index => index < count), "Invalid static mesh triangle indices");
            uint[] selected = source.Distinct().Order().ToArray();
            var remap = selected.Select((index, i) => (index, i)).ToDictionary(pair => pair.index, pair => (uint)pair.i);
            var attributes = new JsonObj();
            foreach (var attribute in Attributes)
            {
                int dimension = attribute.Dimension;
                float[] values = new float[selected.Length * dimension], original = mesh.Attributes[attribute.Name];
                for (int i = 0; i < selected.Length; i++)
                {
                    Array.Copy(original, (int)selected[i] * dimension, values, i * dimension, dimension);
                    if (attribute.Name == "TEXCOORD_0") values[i * dimension + 1] = 1 - values[i * dimension + 1];
                    else values[i * dimension] *= -1;
                }
                attributes[attribute.Name] = Accessor(values, null, dimension, 34962);
            }
            uint[] indices = new uint[source.Length];
            for (int i = 0; i < source.Length; i += 3) { indices[i] = remap[source[i]]; indices[i + 1] = remap[source[i + 2]]; indices[i + 2] = remap[source[i + 1]]; }
            int indexAccessor = Accessor(null, indices, 1, 34963);
            string name = $"{mesh.Name}_{slot}";
            meshes.Add(Obj(("name", name), ("primitives", new JsonArr { Obj(("attributes", attributes), ("indices", indexAccessor), ("material", slot), ("mode", 4)) })));
            nodes.Add(Obj(("name", name), ("mesh", slot))); sceneNodes.Add(slot);
        }
        document["buffers"] = new JsonArr { Obj(("byteLength", (int)binary.Length)) };
        byte[] json = Encoding.UTF8.GetBytes(Json.Stringify(document)), bytes = binary.ToArray();
        int jsonLength = checked((json.Length + 3) / 4 * 4), binaryLength = checked((bytes.Length + 3) / 4 * 4);
        byte[] output = new byte[checked(28 + jsonLength + binaryLength)];
        void Word(int offset, uint value) => BinaryPrimitives.WriteUInt32LittleEndian(output.AsSpan(offset, 4), value);
        Word(0, 0x46546c67); Word(4, 2); Word(8, (uint)output.Length); Word(12, (uint)jsonLength); Word(16, 0x4e4f534a);
        json.CopyTo(output, 20); output.AsSpan(20 + json.Length, jsonLength - json.Length).Fill(0x20);
        Word(20 + jsonLength, (uint)binaryLength); Word(24 + jsonLength, 0x004e4942); bytes.CopyTo(output, 28 + jsonLength);
        return output;
    }
}
