using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using GameEngine.UnityConverter;
using Xunit;

namespace GameEngine.UnityConverter.Tests;

public class UnityStaticMeshTests
{
    internal static string Fixture() => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "StaticMesh.asset")).Replace("\r\n", "\n");

    internal static string SetFloats(string text, params (int Vertex, int Offset, float Value)[] edits)
    {
        var match = Regex.Match(text, @"(?m)^    _typelessdata: ([0-9a-f]+)$");
        byte[] bytes = Convert.FromHexString(match.Groups[1].Value);
        foreach (var edit in edits)
            BinaryPrimitives.WriteSingleLittleEndian(bytes.AsSpan(edit.Vertex * 48 + edit.Offset, 4), edit.Value);
        return text.Replace(match.Groups[1].Value, Convert.ToHexString(bytes).ToLowerInvariant());
    }

    private sealed class Glb : IDisposable
    {
        public JsonDocument Json { get; }
        public JsonElement Root => Json.RootElement;
        private readonly byte[] Binary;
        public Glb(byte[] bytes)
        {
            uint Word(int at) => BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(at, 4));
            Assert.Equal(0x46546c67u, Word(0)); Assert.Equal(2u, Word(4)); Assert.Equal((uint)bytes.Length, Word(8));
            int jsonLength = (int)Word(12); Assert.Equal(0, jsonLength % 4); Assert.Equal(0x4e4f534au, Word(16));
            Json = JsonDocument.Parse(bytes.AsMemory(20, jsonLength));
            int header = 20 + jsonLength, binaryLength = (int)Word(header);
            Assert.Equal(0, binaryLength % 4); Assert.Equal(0x004e4942u, Word(header + 4));
            Assert.Equal(bytes.Length, header + 8 + binaryLength);
            Binary = bytes[(header + 8)..];
            Assert.Equal(binaryLength, Root.GetProperty("buffers")[0].GetProperty("byteLength").GetInt32());
            for (int i = 0; i < Root.GetProperty("accessors").GetArrayLength(); i++) Values(i);
        }

        public double[] Values(int index)
        {
            var accessor = Root.GetProperty("accessors")[index];
            var view = Root.GetProperty("bufferViews")[accessor.GetProperty("bufferView").GetInt32()];
            int dimension = accessor.GetProperty("type").GetString() switch { "SCALAR" => 1, "VEC2" => 2, "VEC3" => 3, "VEC4" => 4, _ => throw new Exception("Bad accessor") };
            int count = accessor.GetProperty("count").GetInt32(), component = accessor.GetProperty("componentType").GetInt32();
            int offset = view.GetProperty("byteOffset").GetInt32(), length = view.GetProperty("byteLength").GetInt32();
            Assert.Equal(0, offset % 4); Assert.Equal(0, view.GetProperty("buffer").GetInt32());
            Assert.Equal(count * dimension * 4, length); Assert.True(offset + length <= Binary.Length);
            Assert.Contains(component, new[] { 5125, 5126 });
            var values = new double[count * dimension];
            for (int i = 0; i < values.Length; i++)
            {
                var span = Binary.AsSpan(offset + i * 4, 4);
                values[i] = component == 5126 ? BinaryPrimitives.ReadSingleLittleEndian(span) : BinaryPrimitives.ReadUInt32LittleEndian(span);
                Assert.True(double.IsFinite(values[i]));
            }
            return values;
        }

        public void Dispose() => Json.Dispose();
    }

    [Fact]
    public void ExactFileIdentityAndBothIndexWidthsPreserveDomains()
    {
        string text = Fixture();
        var mesh = UnityStaticMesh.Read(text);
        Assert.Equal("SyntheticRoof", mesh.Name);
        Assert.Equal(new uint[] { 2, 0, 1 }, mesh.Submeshes[0]);
        Assert.Equal(new uint[] { 0, 2, 3 }, mesh.Submeshes[1]);
        Assert.Empty(mesh.RepairedTangentVertices);
        string largeId = "568364820087899322";
        Assert.Equal(mesh.Name, UnityStaticMesh.Read(text.Replace("&4300000", "&" + largeId).Replace("\n", "\r\n"), largeId).Name);
        Assert.Throws<InvalidDataException>(() => UnityStaticMesh.Read(text, largeId));
        Assert.Throws<InvalidDataException>(() => UnityStaticMesh.Read(text, "٤٣٠٠٠٠٠"));
        uint[] indices = [2, 0, 1, 0, 2, 3];
        byte[] buffer = new byte[indices.Length * 4];
        for (int i = 0; i < indices.Length; i++) BinaryPrimitives.WriteUInt32LittleEndian(buffer.AsSpan(i * 4, 4), indices[i]);
        text = Regex.Replace(text, @"(?m)^  m_IndexBuffer: .*$", "  m_IndexBuffer: " + Convert.ToHexString(buffer));
        text = text.Replace("m_IndexFormat: 0", "m_IndexFormat: 1").Replace("firstByte: 6", "firstByte: 12");
        Assert.Equal(mesh.Submeshes[1], UnityStaticMesh.Read(text).Submeshes[1]);
    }

    [Fact]
    public void GlbMatchesJavaScriptGoldenAndRestoresGeometryUnderEngineMirrorX()
    {
        byte[] bytes = UnityStaticMesh.EncodeGlb(UnityStaticMesh.Read(Fixture()));
        // Generated independently by the JS reference from this synthetic asset.
        Assert.Equal("05ff941d116ac6f2eb33d140f7219ef8cf62307d7538f7c714c17167ad2f1af6", Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant());
        using var glb = new Glb(bytes);
        Assert.Equal(2, glb.Root.GetProperty("meshes").GetArrayLength());
        var primitive = glb.Root.GetProperty("meshes")[0].GetProperty("primitives")[0];
        var attributes = primitive.GetProperty("attributes");
        Assert.Equal(new double[] { -1, 1, 2, -3, 1, 2, -3, 3, 2 }, glb.Values(attributes.GetProperty("POSITION").GetInt32()));
        Assert.Equal(new double[] { 0, 1, 1, 1, 1, 0 }, glb.Values(attributes.GetProperty("TEXCOORD_0").GetInt32()));
        Assert.Equal(new double[] { -1, 0, 0, 1, -1, 0, 0, 1, -1, 0, 0, 1 }, glb.Values(attributes.GetProperty("TANGENT").GetInt32()));
        Assert.Equal(new double[] { 2, 1, 0 }, glb.Values(primitive.GetProperty("indices").GetInt32()));
        for (int slot = 0; slot < 2; slot++)
        {
            Assert.Equal($"SyntheticRoof_{slot}", glb.Root.GetProperty("meshes")[slot].GetProperty("name").GetString());
            Assert.Equal(slot, glb.Root.GetProperty("meshes")[slot].GetProperty("primitives")[0].GetProperty("material").GetInt32());
            Assert.Equal($"UnityMaterial_{slot}", glb.Root.GetProperty("materials")[slot].GetProperty("name").GetString());
        }
    }

    [Fact]
    public void RepairsOnlyAllNanTangentXyzAndReportsSourceVertexWithoutChangingHandedness()
    {
        string text = SetFloats(Fixture(), (0, 12, 1), (0, 16, 2), (0, 20, 3),
            (0, 24, float.NaN), (0, 28, float.NaN), (0, 32, float.NaN), (0, 36, -1));
        var mesh = UnityStaticMesh.Read(text);
        Assert.Equal(new[] { 0 }, mesh.RepairedTangentVertices);
        float[] tangent = mesh.Attributes["TANGENT"];
        Assert.Equal(-1, tangent[3]);
        Assert.True(Math.Abs(tangent[0] + 2 * tangent[1] + 3 * tangent[2]) < 1e-6);
        Assert.True(Math.Abs(tangent.Take(3).Sum(v => v * v) - 1) < 1e-6);
        Assert.Equal("604358f71747e80be08877714ff0fe7a078e958e8138d9b160fde7dbd4fe43cc", Convert.ToHexString(SHA256.HashData(UnityStaticMesh.EncodeGlb(mesh))).ToLowerInvariant());
        Assert.Throws<InvalidDataException>(() => UnityStaticMesh.Read(SetFloats(text, (0, 24, 0))));
        Assert.Throws<InvalidDataException>(() => UnityStaticMesh.Read(SetFloats(text, (0, 36, 0))));
        Assert.Throws<InvalidDataException>(() => UnityStaticMesh.Read(SetFloats(text, (0, 12, 0), (0, 16, 0), (0, 20, 0))));
        foreach (int offset in new[] { 0, 12, 24, 36, 40 })
            Assert.Throws<InvalidDataException>(() => UnityStaticMesh.Read(SetFloats(Fixture(), (0, offset, float.PositiveInfinity))));
    }

    [Theory]
    [InlineData("serializedVersion: 10", "serializedVersion: 9")]
    [InlineData("m_MeshCompression: 0", "m_MeshCompression: 1")]
    [InlineData("m_BindPose: []", "m_BindPose: [1]")]
    [InlineData("m_BonesAABB: []", "m_BonesAABB: [1]")]
    [InlineData("    vertices: []", "    vertices: [1]")]
    [InlineData("      m_NumItems: 0", "      m_NumItems: 1")]
    [InlineData("    size: 0", "    size: 16")]
    [InlineData("    path:", "    path: external.resS")]
    [InlineData("m_VertexCount: 4", "m_VertexCount: 1000001")]
    [InlineData("m_VertexCount: 4", "m_VertexCount: 9007199254740993")]
    [InlineData("m_VertexCount: 4", "m_VertexCount: 0")]
    [InlineData("m_DataSize: 192", "m_DataSize: 188")]
    [InlineData("_typelessdata: ", "_typelessdata: gg")]
    [InlineData("_typelessdata: ", "_typelessdata: f")]
    [InlineData("offset: 12", "offset: 13")]
    [InlineData("offset: 12", "offset: 8")]
    [InlineData("offset: 40", "offset: 9007199254740991")]
    [InlineData("m_IndexFormat: 0", "m_IndexFormat: 2")]
    [InlineData("m_IndexBuffer: ", "m_IndexBuffer: ff")]
    [InlineData("firstByte: 6", "firstByte: 4")]
    [InlineData("firstByte: 6", "firstByte: 7")]
    [InlineData("indexCount: 3", "indexCount: 2")]
    [InlineData("topology: 0", "topology: 1")]
    [InlineData("vertexCount: 4", "vertexCount: 2")]
    [InlineData("baseVertex: 0", "baseVertex: -1")]
    [InlineData("firstVertex: 0", "firstVertex: 1")]
    [InlineData("  m_Name:", "  m_Name: Duplicate\n  m_Name:")]
    public void MalformedOrUnsupportedInputFailsBeforeGlb(string before, string after)
    {
        string text = Fixture();
        Assert.Contains(before, text, StringComparison.Ordinal);
        Assert.Throws<InvalidDataException>(() => UnityStaticMesh.Read(text.Replace(before, after)));
    }

    [Fact]
    public void SignedBaseVertexIsAppliedBeforeValidatingUint32Indices()
    {
        string text = Fixture();
        int begin = text.IndexOf("  - serializedVersion: 2\n", StringComparison.Ordinal);
        int second = text.IndexOf("  - serializedVersion: 2\n", begin + 1, StringComparison.Ordinal);
        int shapes = text.IndexOf("  m_Shapes:\n", StringComparison.Ordinal);
        text = text.Remove(second, shapes - second);
        uint high = 0xfffffffc;
        byte[] indices = new byte[12];
        for (int i = 0; i < 3; i++) BinaryPrimitives.WriteUInt32LittleEndian(indices.AsSpan(i * 4, 4), high + (uint)i);
        text = Regex.Replace(text, @"(?m)^  m_IndexBuffer: .*$", "  m_IndexBuffer: " + Convert.ToHexString(indices));
        text = text.Replace("m_IndexFormat: 0", "m_IndexFormat: 1").Replace("baseVertex: 0", "baseVertex: -4294967292");
        Assert.Equal(new uint[] { 0, 1, 2 }, UnityStaticMesh.Read(text).Submeshes[0]);
        Assert.Throws<InvalidDataException>(() => UnityStaticMesh.Read(text.Replace("baseVertex: -4294967292", "baseVertex: 0")));
    }

    [Fact]
    public void FullChannelTableAndIndexCoverageAreRequired()
    {
        string text = Fixture();
        string channels = "    - stream: 0\n      offset: 0\n      format: 0\n      dimension: 3\n";
        Assert.Throws<InvalidDataException>(() => UnityStaticMesh.Read(text.Replace(channels, channels.Replace("stream: 0", "stream: 1"))));
        Assert.Throws<InvalidDataException>(() => UnityStaticMesh.Read(text.Replace(channels, channels.Replace("format: 0", "format: 1"))));
        Assert.Throws<InvalidDataException>(() => UnityStaticMesh.Read(text.Replace(channels, channels.Replace("dimension: 3", "dimension: 0"))));
        Assert.Throws<InvalidDataException>(() => UnityStaticMesh.Read(text.Replace("    m_DataSize:", "    unknownChannel: 7\n    m_DataSize:")));
        int second = text.IndexOf("  - serializedVersion: 2\n", text.IndexOf("  - serializedVersion: 2\n", StringComparison.Ordinal) + 1, StringComparison.Ordinal);
        int shapes = text.IndexOf("  m_Shapes:\n", StringComparison.Ordinal);
        Assert.Throws<InvalidDataException>(() => UnityStaticMesh.Read(text.Remove(second, shapes - second)));
    }

    [Fact]
    public void DocumentAndEncoderBoundariesRejectAmbiguityOrIncompleteArrays()
    {
        Assert.Throws<InvalidDataException>(() => UnityStaticMesh.Read(Fixture() + "--- !u!43 &4300001\nMesh:\n"));
        Assert.Throws<InvalidDataException>(() => UnityStaticMesh.Read(Fixture().Replace("Mesh:\n", "Material:\n")));
        var mesh = UnityStaticMesh.Read(Fixture());
        mesh.Attributes["TEXCOORD_0"] = [0, 1];
        Assert.Throws<InvalidDataException>(() => UnityStaticMesh.EncodeGlb(mesh));
        mesh = UnityStaticMesh.Read(Fixture()); mesh.Submeshes[0][0] = 999;
        Assert.Throws<InvalidDataException>(() => UnityStaticMesh.EncodeGlb(mesh));
        mesh = UnityStaticMesh.Read(Fixture()); mesh.Attributes["TANGENT"][3] = 0;
        Assert.Throws<InvalidDataException>(() => UnityStaticMesh.EncodeGlb(mesh));
    }
}
