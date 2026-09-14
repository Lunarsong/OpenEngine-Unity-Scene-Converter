using System.Numerics;
using System.Text.Json;
using GameEngine.UnityConverter;
using Xunit;

namespace GameEngine.UnityConverter.Tests;

public class LodSourceTests
{
    const string Base = "00000000000000000000000000000001", Wrapper = "00000000000000000000000000000002",
        Scene = "00000000000000000000000000000003", Embedded = "00000000000000000000000000000004",
        MatA = "00000000000000000000000000000007", Group = "9007199254741017", Renderer = "9007199254741003";
    static string Text(string name) => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "LodSource", name + ".prefab"));
    static string Xor(string a, string b) => ((BigInteger.Parse(a) ^ BigInteger.Parse(b)) & ((BigInteger.One << 63) - 1)).ToString();
    static string Mod(string target, string property, string value = "", string reference = "{fileID: 0}", string guid = Base) =>
        $"    - target: {{fileID: {target}, guid: {guid}, type: 3}}\n      propertyPath: {property}\n      value: {value}\n      objectReference: {reference}\n";
    static string Instance(string id, string source = Base, string mods = "") =>
        $"--- !u!1001 &{id}\nPrefabInstance:\n  m_Modification:\n    m_TransformParent: {{fileID: 0}}\n    m_Modifications:{(mods.Length > 0 ? "\n" + mods : " []\n")}  m_SourcePrefab: {{fileID: 100100000, guid: {source}, type: 3}}\n";
    static string Alias(string type, string anchor, string original, string source = Base) =>
        $"--- !u!{type} &{anchor} stripped\n{(type == "4" ? "Transform" : type == "23" ? "MeshRenderer" : "LODGroup")}:\n  m_CorrespondingSourceObject: {{fileID: {original}, guid: {source}, type: 3}}\n  m_PrefabInstance: {{fileID: 1000}}\n";
    sealed class Fixture : IDisposable
    {
        public readonly string Root = Path.Combine(Path.GetTempPath(), "lod-source-" + Guid.NewGuid().ToString("N"));
        readonly Dictionary<string, PkgEntry> entries = [];
        public Fixture() { Put(Base, Text("Base")); Put(Embedded, Text("Embedded")); }
        public void Put(string guid, string text)
        {
            string dir = Path.Combine(Root, guid); Directory.CreateDirectory(dir); File.WriteAllText(Path.Combine(dir,"asset"),text);
            entries[guid] = new PkgEntry { AssetPath = "Assets/" + guid + ".prefab", Dir = dir };
        }
        public Ctx Context() => new() { Pkg = new(entries), PkgOrder = [.. entries.Keys], PkgDir = Root,
            ProjectDir = Path.Combine(Root,"project"), ModelSeedDir = Path.Combine(Root,"project","Models") };
        public FileStructure Build(string guid = Base, Ctx? ctx = null) => SceneStructure.BuildFileStructure(ctx ?? Context(),guid,[])!;
        public void Dispose() => Directory.Delete(Root,true);
    }
    [Fact]
    public void OrderedSourceAndScopedMaterialPermutationsUseExactRendererIds()
    {
        using var f = new Fixture(); FileStructure st = f.Build(); LodSourceGroup g = Assert.Single(st.LodGroups);
        Assert.Equal(new UnityObjectReference(Base,Group),g.Source);
        Assert.Equal(new[]{1.25,-2.5,3.75},g.LocalReferencePoint); Assert.Equal(19.125,g.Size);
        Assert.Equal(new[]{.35,.1},g.Levels.Select(l=>l.ScreenRelativeHeight));
        Assert.Equal(new[]{.125,.25},g.Levels.Select(l=>l.FadeTransitionWidth));
        Assert.Equal(new[]{"24",Renderer},g.Levels[0].Renderers.Select(r=>r.Source.FileId));
        Assert.Equal(new[]{"2100002","2100001"},st.Get(g.Levels[0].Renderers[0].NodeId).MaterialRefs.Select(r=>r!.FileId));
        Assert.Equal(new[]{"2100001","2100002"},st.Get(g.Levels[0].Renderers[1].NodeId).MaterialRefs.Select(r=>r!.FileId));
        Assert.False(st.Get(g.Levels[0].Renderers[0].NodeId).RendererEnabled);
        using var doc = JsonDocument.Parse(Json.Stringify(LodSource.Summarize(st)));
        Assert.False(doc.RootElement[0].GetProperty("runtimeSelectionSupported").GetBoolean());
        Assert.True(doc.RootElement[0].GetProperty("effectiveSourceKnown").GetBoolean());
    }
    [Fact]
    public void NestedClonesKeepEffectiveBindingsAndUnsupportedGroupOverridesIsolated()
    {
        using var f = new Fixture();
        f.Put(Wrapper,Instance("1000")+Alias("4",Xor("4","1000"),"4"));
        f.Put(Scene,Instance("2000",Wrapper,Mod(Xor(Group,"1000"),"m_Enabled","0","{fileID: 0}",Wrapper)+
            Mod(Xor(Renderer,"1000"),"m_Materials.Array.data[1]","",$"{{fileID: 2100099, guid: {MatA}, type: 2}}",Wrapper))+Instance("3000",Wrapper));
        Ctx ctx = f.Context(); FileStructure st=f.Build(Scene,ctx);
        Assert.Equal(2,st.LodGroups.Count); var a=st.LodGroups[0];var b=st.LodGroups[1];
        Assert.NotEqual(a.OwnerNodeId,b.OwnerNodeId);
        Assert.Equal(new[]{new UnityObjectReference(Scene,"2000"),new(Wrapper,"1000")},a.InstancePath);
        Assert.Single(a.UnsupportedOverrides);Assert.Empty(b.UnsupportedOverrides);Assert.True(a.Enabled);
        Assert.True(st.Get(a.OwnerNodeId).RendererEnabled);
        Assert.Equal("2100099",st.Get(a.Levels[1].Renderers[0].NodeId).MaterialRefs[1]!.FileId);
        Assert.Equal("2100002",st.Get(b.Levels[1].Renderers[0].NodeId).MaterialRefs[1]!.FileId);
        Assert.Empty(f.Build(Base,ctx).LodGroups[0].UnsupportedOverrides);
    }
    [Fact]
    public void ExplicitGroupAliasPreservesOriginalMetadataButMarksEffectiveOverrideUnsupported()
    {
        using var f=new Fixture();f.Put(Wrapper,Instance("1000")+Alias("205","800",Group));
        f.Put(Scene,Instance("2000",Wrapper,Mod("800","m_LODs.Array.data[0].screenRelativeHeight",".7","{fileID: 0}",Wrapper)));
        LodSourceGroup g=Assert.Single(f.Build(Scene).LodGroups);
        Assert.Single(g.UnsupportedOverrides);Assert.Equal(.35,g.Levels[0].ScreenRelativeHeight);
    }
    [Fact]
    public void EmbeddedSourceIdentitiesNeverPublishSubstituteArtifacts()
    {
        using var f=new Fixture();Ctx ctx=f.Context();FileStructure st=f.Build(Embedded,ctx);SceneNode n=st.Get(st.RootIds[0]);
        Assert.Equal(new UnityObjectReference(Embedded,"-9007199254741023",true,"11"),n.MeshRef);
        Assert.Equal(new UnityObjectReference(Embedded,"2100077",true),Assert.Single(n.MaterialRefs));
        Assert.Null(Assert.Single(n.MatGuids));
        Assert.Equal(0,Emitter.EmitScene(ctx,st,"Embedded").Emitted.MeshEntities);
        Assert.Empty(ctx.Outputs);Assert.False(Directory.Exists(ctx.ModelSeedDir));
    }
    [Fact]
    public void OuterGroupBindsExactStrippedEmbeddedRendererAlongsideOrdinaryMembers()
    {
        using var f=new Fixture();f.Put(Base,Text("Base").Replace("- renderer: {fileID: 24}","- renderer: {fileID: 888}")+
            Instance("1000",Embedded)+Alias("23","888","23",Embedded));
        FileStructure st=f.Build();var members=st.LodGroups[0].Levels[0].Renderers;
        Assert.Equal("888",members[0].Source.FileId);
        Assert.Equal(2,LodSource.UnsupportedBindings(st.Get(members[0].NodeId)).Count);
        Assert.Empty(LodSource.UnsupportedBindings(st.Get(members[1].NodeId)));
    }
    [Theory]
    [InlineData("m_Size: 19.125","m_Size: NaN")]
    [InlineData("m_Size: 19.125","m_Size: 19x")]
    [InlineData("z: 3.75","q: 3.75")]
    [InlineData("screenRelativeHeight: 0.35","screenRelativeHeight: 1.01")]
    [InlineData("renderer: {fileID: 24}","renderer: {fileID: 999}")]
    [InlineData("renderer: {fileID: 24}","renderer: {fileID: 22}")]
    [InlineData("renderer: {fileID: 24}","renderer: {fileID: 24, guid: 00000000000000000000000000000005}")]
    [InlineData("m_Enabled: 1","m_Enabled: 0.5")]
    public void InvalidSourceRejectsBeforeCaching(string from,string to)
    {
        using var f=new Fixture();f.Put(Base,Text("Base").Replace(from,to));Ctx ctx=f.Context();
        Assert.Contains("LODGroup",Assert.Throws<InvalidDataException>(()=>f.Build(Base,ctx)).Message);
        Assert.False(ctx.StructureCache.ContainsKey(Base));
    }
    [Fact]
    public void UnknownGroupOverrideAndMistypedLocalMeshReject()
    {
        using var f=new Fixture();f.Put(Scene,Instance("1000",Base,Mod("999","m_LODs.Array.size","0")));
        Assert.Contains("Unresolved LODGroup",Assert.Throws<InvalidDataException>(()=>f.Build(Scene)).Message);
        f.Put(Embedded,Text("Embedded").Replace("fileID: -9007199254741023","fileID: 2100077"));
        Assert.Contains("Expected local class 43",Assert.Throws<InvalidDataException>(()=>f.Build(Embedded)).Message);
    }
    [Fact]
    public void EffectiveMaterialArrayShrinkRemovesStaleBindingsAndRejectsOutOfRangeSlots()
    {
        using var f=new Fixture();f.Put(Scene,Instance("1000",Base,Mod(Renderer,"m_Materials.Array.size","1")));
        FileStructure st=f.Build(Scene);Assert.Single(st.Get(st.LodGroups[0].Levels[1].Renderers[0].NodeId).MaterialRefs);
        f.Put(Scene,Instance("1000",Base,Mod(Renderer,"m_Materials.Array.size","1")+Mod(Renderer,"m_Materials.Array.data[1]")));
        Assert.Contains("exceeds overridden array size",Assert.Throws<InvalidDataException>(()=>f.Build(Scene)).Message);
    }
    [Fact]
    public void ResolvedRendererKeepsMaterialOverridesAfterNullMeshReplacement()
    {
        using var f=new Fixture();f.Put(Scene,Instance("1000",Base,Mod("9007199254741001","m_Mesh")+
            Mod(Renderer,"m_Materials.Array.data[0]","",$"{{fileID: 2100099, guid: {MatA}, type: 2}}")));
        FileStructure st=f.Build(Scene);LodSourceGroup group=st.LodGroups[0];SceneNode node=st.Get(group.Levels[1].Renderers[0].NodeId);
        Assert.Null(node.MeshRef);Assert.Empty(group.UnsupportedOverrides);
        Assert.Equal(new UnityObjectReference(MatA,"2100099"),node.MaterialRefs[0]);
    }
    [Theory]
    [InlineData(Group)]
    [InlineData(Renderer)]
    public void InferredNestedAliasCannotOverwriteRealLocalObjectIdentity(string source)
    {
        using var f=new Fixture();string collision=Xor(source,"1000");
        f.Put(Wrapper,Instance("1000")+Alias("4",Xor("4","1000"),"4")+
            $"--- !u!1 &{collision}\nGameObject:\n  m_Name: RealLocalObject\n  m_IsActive: 1\n"+
            $"--- !u!4 &20001\nTransform:\n  m_GameObject: {{fileID: {collision}}}\n  m_Father: {{fileID: 1004}}\n");
        f.Put(Scene,Instance("2000",Wrapper,Mod(collision,"m_IsActive","0","{fileID: 0}",Wrapper)));
        Assert.Contains("Ambiguous nested component identity",Assert.Throws<InvalidDataException>(()=>f.Build(Scene)).Message);
    }
    [Theory]
    [InlineData("m_RemovedComponents")]
    [InlineData("m_RemovedGameObjects")]
    [InlineData("m_AddedComponents")]
    [InlineData("m_AddedGameObjects")]
    public void UnsupportedStructuralEditsCannotLeaveEffectiveLodRecords(string field)
    {
        using var f=new Fixture();f.Put(Scene,Instance("1000").Replace("    m_Modifications:",
            $"    {field}: [{{fileID: {Group}, guid: {Base}, type: 3}}]\n    m_Modifications:"));
        Assert.Contains("Unsupported prefab structural operation with LODGroup",Assert.Throws<InvalidDataException>(()=>f.Build(Scene)).Message);
    }
    [Fact]
    public void UnsupportedMemberStructuralEditsPropagateToEnclosingGroup()
    {
        using var f=new Fixture();f.Put(Wrapper,Instance("1000",Embedded).Replace("    m_Modifications:",
            $"    m_RemovedComponents: [{{fileID: 23, guid: {Embedded}, type: 3}}]\n    m_Modifications:")+Alias("23","888","23",Embedded));
        f.Put(Base,Text("Base").Replace("- renderer: {fileID: 24}","- renderer: {fileID: 999}")+
            Instance("2000",Wrapper)+Alias("23","999","888",Wrapper).Replace("fileID: 1000}","fileID: 2000}"));
        Assert.Contains("Unsupported prefab structural operation with LODGroup",Assert.Throws<InvalidDataException>(()=>f.Build()).Message);
    }
    [Fact]
    public void CachedEmbeddedIdentitiesDropVertexAndImagePayloads()
    {
        using var f=new Fixture();string blob=new('a',65536);
        f.Put(Embedded,Text("Embedded").Replace("  m_Name: EmbeddedMesh",$"  m_Name: EmbeddedMesh\n  _typelessdata: {blob}")
            .Replace("  m_Name: EmbeddedTexture",$"  m_Name: EmbeddedTexture\n  m_ImageData: {blob}"));
        Ctx ctx=f.Context();FileStructure st=f.Build(Embedded,ctx);Assert.Same(st,ctx.StructureCache[Embedded]);
        Assert.Equal(new[]{"serializedVersion"},st.Documents["-9007199254741023"].Data!.Keys);
        Assert.Equal(new[]{"serializedVersion"},st.Documents["2800077"].Data!.Keys);
        Assert.Equal("11",st.Get(st.RootIds[0]).MeshRef!.SerializedVersion);
    }
    [Theory]
    [InlineData("m_Materials.Array.size","2147483648")]
    [InlineData("m_Materials.Array.data[2147483647]","")]
    public void MaterialArrayAdmissionRejectsValuesBeyondUnityInt32Range(string property,string value)
    {
        using var f=new Fixture();f.Put(Scene,Instance("1000",Base,Mod(Renderer,property,value)));
        Assert.Contains("Invalid material array",Assert.Throws<InvalidDataException>(()=>f.Build(Scene)).Message);
    }
}
