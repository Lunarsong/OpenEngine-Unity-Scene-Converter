using System.Numerics;
using System.Text.Json;
using GameEngine.UnityConverter;
using Xunit;

namespace GameEngine.UnityConverter.Tests;

public class PrefabMeshReferenceTests
{
    private const string Base = "00000000000000000000000000000001", Wrapper = "00000000000000000000000000000002",
        Scene = "00000000000000000000000000000003", MeshA = "00000000000000000000000000000004",
        MeshB = "00000000000000000000000000000005", Foreign = "00000000000000000000000000000006",
        MatA = "00000000000000000000000000000007", MatB = "00000000000000000000000000000008";
    private const string Filter = "9007199254741001", Renderer = "9007199254741003";
    private static string Xor(string a, string b) => ((BigInteger.Parse(a) ^ BigInteger.Parse(b)) & ((BigInteger.One << 63) - 1)).ToString();
    private static string Replacement => $"{{fileID: 4300001, guid: {MeshB}, type: 2}}";
    private static string BaseText(string? reference = null) => $$"""
        --- !u!1 &11
        GameObject:
          m_Name: SourceNode
          m_IsActive: 1
        --- !u!4 &12
        Transform:
          m_GameObject: {fileID: 11}
          m_Father: {fileID: 0}
          m_LocalPosition: {x: 2, y: 3, z: 4}
          m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}
          m_LocalScale: {x: 1, y: 1, z: 1}
        --- !u!33 &{{Filter}}
        MeshFilter:
          m_GameObject: {fileID: 11}
          m_Mesh: {{reference ?? $"{{fileID: 4300000, guid: {MeshA}, type: 2}}"}}
        --- !u!23 &{{Renderer}}
        MeshRenderer:
          m_GameObject: {fileID: 11}
          m_Enabled: 1
          m_CastShadows: 1
          m_ReceiveShadows: 1
          m_Materials:
          - {fileID: 2100000, guid: {{MatA}}, type: 2}
          - {fileID: 2100000, guid: {{MatB}}, type: 2}
        """ + "\n";

    private static string Mod(string guid, string id, string property, string? reference, string value = "") =>
        $"    - target: {{fileID: {id}, guid: {guid}, type: 3}}\n      propertyPath: {property}\n      value: {value}\n" +
        (reference == null ? "" : $"      objectReference: {reference}\n");
    private static string Instance(string id, string source, string modifications = "") =>
        $"--- !u!1001 &{id}\nPrefabInstance:\n  m_Modification:\n    m_TransformParent: {{fileID: 0}}\n    m_Modifications:" +
        (modifications.Length == 0 ? " []\n" : "\n" + modifications) + $"  m_SourcePrefab: {{fileID: 100100000, guid: {source}, type: 3}}\n";
    private static string Alias(string type, string anchor, string original, string source = Base) =>
        $"--- !u!{type} &{anchor} stripped\n" + (type switch { "4" => "Transform", "33" => "MeshFilter", "23" => "MeshRenderer", _ => "MonoBehaviour" }) +
        $":\n  m_CorrespondingSourceObject: {{fileID: {original}, guid: {source}, type: 3}}\n  m_PrefabInstance: {{fileID: 1000}}\n";

    private sealed class Fixture : IDisposable
    {
        private readonly Dictionary<string, PkgEntry> Entries = [];
        public string Root { get; } = Path.Combine(Path.GetTempPath(), "converter-mesh-reference-" + Guid.NewGuid().ToString("N"));
        public Fixture()
        {
            G.Stats.Reset(); G.MeshRefCache.Clear(); G.FbxNodeCache.Clear(); G.Warnings.Clear(); G.DroppedSettings.Clear(); G.NodeCounter = 0;
            Put(MeshA, "Original.asset", UnityStaticMeshTests.Fixture());
            Put(MeshB, "Replacement.asset", UnityStaticMeshTests.Fixture().Replace("&4300000", "&4300001").Replace("SyntheticRoof", "Replacement"));
            Put(Base, "Base.prefab", BaseText());
        }
        public void Put(string guid, string name, string text)
        {
            string dir = Path.Combine(Root, "package", guid);
            Directory.CreateDirectory(dir); File.WriteAllText(Path.Combine(dir, "asset"), text);
            Entries[guid] = new PkgEntry { AssetPath = "Assets/" + name, Dir = dir };
        }
        public Ctx Context()
        {
            var ctx = new Ctx { Pkg = new(Entries), PkgOrder = [.. Entries.Keys], PkgDir = Path.Combine(Root, "package"),
                ProjectDir = Path.Combine(Root, "project"), ModelSeedDir = Path.Combine(Root, "project", "assets", "Models_Unity"),
                MatOutDir = Path.Combine(Root, "project", "assets", "Materials_Unity") };
            ctx.MaterialCache[MatA] = new AssetRef { Guid = "a", Path = "Materials/A.material" };
            ctx.MaterialCache[MatB] = new AssetRef { Guid = "b", Path = "Materials/B.material" };
            return ctx;
        }
        public void Dispose() { if (Directory.Exists(Root)) Directory.Delete(Root, true); }
    }

    private static FileStructure Build(Ctx ctx, string source) => SceneStructure.BuildFileStructure(ctx, source, [])!;

    [Fact]
    public void TypedDirectReferenceEmitsExactFileIdAndOrderedMaterialDomains()
    {
        using var fixture = new Fixture(); var ctx = fixture.Context(); var structure = Build(ctx, Base);
        Assert.Equal(new UnityObjectReference(MeshA, "4300000"), structure.Get(structure.RootIds[0]).MeshRef);
        var emitted = Emitter.EmitScene(ctx, structure, "Direct");
        Assert.Equal(2, emitted.Emitted.MeshEntities);
        Assert.Contains($"SerializedMeshes/{MeshA}/4300000.glb", emitted.Text);
        Assert.Contains("MeshRenderer.meshName = \"SyntheticRoof_0\"", emitted.Text);
        Assert.Contains("MeshRenderer.meshName = \"SyntheticRoof_1\"", emitted.Text);
        Assert.True(emitted.Text.IndexOf("Materials/A.material", StringComparison.Ordinal) < emitted.Text.IndexOf("Materials/B.material", StringComparison.Ordinal));
        Assert.Single(ctx.Outputs, output => output.Kind == "model");
        Assert.Same(Resolvers.ResolveMeshAsset(ctx, new(MeshA, "4300000")), Resolvers.ResolveMeshAsset(ctx, new(MeshA, "4300000")));
    }

    [Fact]
    public void RepeatedNestedInstancesIsolateMeshMaterialAndSourceTransforms()
    {
        using var fixture = new Fixture();
        fixture.Put(Wrapper, "Wrapper.prefab", Instance("1000", Base) + Alias("4", Xor("12", "1000"), "12"));
        fixture.Put(Scene, "Repeated.unity", Instance("2000", Wrapper,
            Mod(Wrapper, Xor(Filter, "1000"), "m_Mesh", Replacement) +
            Mod(Wrapper, Xor(Renderer, "1000"), "m_Materials.Array.data[1]", $"{{fileID: 2100000, guid: {MatA}, type: 2}}")) + Instance("3000", Wrapper));
        var ctx = fixture.Context(); var structure = Build(ctx, Scene);
        var a = structure.Get(structure.RootIds[0]); var b = structure.Get(structure.RootIds[1]);
        Assert.Equal(new UnityObjectReference(MeshB, "4300001"), a.MeshRef); Assert.Equal(new UnityObjectReference(MeshA, "4300000"), b.MeshRef);
        Assert.Equal(new[] { MatA, MatA }, a.MatGuids); Assert.Equal(new[] { MatA, MatB }, b.MatGuids);
        Assert.Equal(new double[] { 2, 3, 4 }, a.Pos); Assert.Equal(a.Pos, b.Pos);
        var original = Build(ctx, Base); Assert.Equal(b.MeshRef, original.Get(original.RootIds[0]).MeshRef);
        Assert.Equal(4, Emitter.EmitScene(ctx, structure, "Repeated").Emitted.MeshEntities);
    }

    [Fact]
    public void ExplicitNonXorAliasesResolveWithoutGuessingMissingComponents()
    {
        using var fixture = new Fixture();
        fixture.Put(Wrapper, "Wrapper.prefab", Instance("1000", Base) + Alias("4", "777", "12") + Alias("33", "888", Filter) + Alias("23", "889", Renderer));
        fixture.Put(Scene, "Explicit.unity", Instance("2000", Wrapper, Mod(Wrapper, "888", "m_Mesh", Replacement)));
        var ctx = fixture.Context(); var structure = Build(ctx, Scene);
        Assert.Equal(MeshB, structure.Get(structure.RootIds[0]).MeshRef!.Guid);
        Assert.False(Build(ctx, Wrapper).AnchorToNode.ContainsKey(Xor(Filter, "1000")));
        fixture.Put(Scene, "Invalid.unity", Instance("2000", Wrapper, Mod(Wrapper, Xor(Filter, "1000"), "m_Mesh", Replacement)));
        Assert.Throws<InvalidDataException>(() => Build(fixture.Context(), Scene));
    }

    [Theory]
    [InlineData(Foreign, Filter, "replacement")]
    [InlineData(Base, Renderer, "replacement")]
    [InlineData(Base, Filter, null)]
    [InlineData(Base, Filter, "{fileID: 987654321}")]
    [InlineData(Base, Filter, "{fileID: {nested: 1}}")]
    [InlineData(Base, Filter, "{fileID: 10202, guid: {nested: 1}}")]
    [InlineData(Base, Filter, "{fileID: 4300000, guid: 00000000000000000000000000000006, type: 2}")]
    public void InvalidMeshOverrideFailsExplicitly(string targetGuid, string target, string? replacement)
    {
        using var fixture = new Fixture();
        fixture.Put(Scene, "Invalid.unity", Instance("2000", Base, Mod(targetGuid, target, "m_Mesh", replacement == "replacement" ? Replacement : replacement)));
        var ctx = fixture.Context(); Assert.Throws<InvalidDataException>(() => Build(ctx, Scene)); Assert.Empty(ctx.Outputs);
    }

    [Theory]
    [InlineData("4")]
    [InlineData("33")]
    [InlineData("23")]
    [InlineData("114")]
    public void ForeignOrUnrelatedStrippedAliasesCannotAuthenticateNestedMesh(string type)
    {
        using var fixture = new Fixture(); string id = type == "4" ? "12" : Filter;
        fixture.Put(Wrapper, "Forged.prefab", Instance("1000", Base) + Alias(type, Xor(id, "1000"), id, Foreign));
        fixture.Put(Scene, "Invalid.unity", Instance("2000", Wrapper, Mod(Wrapper, Xor(Filter, "1000"), "m_Mesh", Replacement)));
        Assert.Throws<InvalidDataException>(() => Build(fixture.Context(), Scene));
    }

    [Fact]
    public void NullMeshAndMaterialOverridesClearOnlyTheirOwnInheritedSlots()
    {
        using var fixture = new Fixture();
        fixture.Put(Scene, "Null.unity", Instance("2000", Base, Mod(Base, Filter, "m_Mesh", "{fileID: 0}")) +
            Instance("3000", Base, Mod(Base, Renderer, "m_Materials.Array.data[1]", "{fileID: 0}")));
        var ctx = fixture.Context(); var structure = Build(ctx, Scene);
        Assert.Null(structure.Get(structure.RootIds[0]).MeshRef);
        Assert.Equal(new string?[] { MatA, null }, structure.Get(structure.RootIds[1]).MatGuids);
        var result = Emitter.EmitScene(ctx, structure, "Null");
        Assert.Equal(2, result.Emitted.MeshEntities); Assert.Equal(1, result.Emitted.MaterialsBound);
        Assert.Contains(G.DroppedSettings, drop => drop.Kind == "mesh.defaultMaterials");
    }

    [Fact]
    public void ForeignMaterialTargetCannotReplaceSameNumberRenderer()
    {
        using var fixture = new Fixture();
        fixture.Put(Scene, "Foreign.unity", Instance("2000", Base, Mod(Foreign, Renderer, "m_Materials.Array.data[1]", $"{{fileID: 2100000, guid: {MatA}, type: 2}}")));
        var structure = Build(fixture.Context(), Scene);
        Assert.Equal(new[] { MatA, MatB }, structure.Get(structure.RootIds[0]).MatGuids);
    }

    [Theory]
    [InlineData("\"Odd \\\"Roof\\\"\\nTop\\\\Other\"", "Odd 'Roof' Top'Other")]
    [InlineData("\"\"", "UnityMesh")]
    public void SafeMeshNamesMatchGlbSelectorsAndShortMaterialArraysKeepGeometry(string serializedName, string expected)
    {
        using var fixture = new Fixture();
        fixture.Put(MeshA, "Original.asset", UnityStaticMeshTests.Fixture().Replace("m_Name: SyntheticRoof", "m_Name: " + serializedName));
        fixture.Put(Base, "Base.prefab", BaseText().Replace($"  - {{fileID: 2100000, guid: {MatB}, type: 2}}\n", ""));
        var ctx = fixture.Context(); var emitted = Emitter.EmitScene(ctx, Build(ctx, Base), "Names");
        Assert.Equal(2, emitted.Emitted.MeshEntities); Assert.Equal(1, emitted.Emitted.MaterialsBound);
        byte[] bytes = File.ReadAllBytes(ctx.Outputs.Single(output => output.Kind == "model").Path);
        using var json = JsonDocument.Parse(bytes.AsMemory(20, BitConverter.ToInt32(bytes, 12)));
        for (int slot = 0; slot < 2; slot++)
        {
            Assert.Equal($"{expected}_{slot}", json.RootElement.GetProperty("meshes")[slot].GetProperty("name").GetString());
            Assert.Contains($"MeshRenderer.meshName = \"{expected}_{slot}\"", emitted.Text);
        }
    }

    [Fact]
    public void ResolverReportsRepairsAndRejectsWrongDocumentOrAssetTypeBeforePublication()
    {
        using var fixture = new Fixture();
        fixture.Put(MeshA, "Original.asset", UnityStaticMeshTests.SetFloats(UnityStaticMeshTests.Fixture(), (0, 24, float.NaN), (0, 28, float.NaN), (0, 32, float.NaN)));
        var ctx = fixture.Context(); Resolvers.ResolveMeshAsset(ctx, new(MeshA, "4300000"));
        Assert.Contains(G.Warnings, warning => warning.Contains("repaired undefined tangents at vertices 0", StringComparison.Ordinal));
        fixture.Put(Foreign, "Other.png", "not a mesh");
        foreach (var reference in new[] { new UnityObjectReference(MeshB, null), new(MeshB, "4300999"), new(Foreign, "4300000") })
        {
            ctx = fixture.Context(); Assert.Throws<InvalidDataException>(() => Resolvers.ResolveMeshAsset(ctx, reference)); Assert.Empty(ctx.Outputs);
        }
    }
}
