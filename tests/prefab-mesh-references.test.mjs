import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const { buildPackageIndex, buildFileStructure, emitScene, resolveMeshAsset } =
    createRequire(import.meta.url)('../src/convert.js');
const G = Object.fromEntries(['base','wrapper','scene','meshA','meshB','foreign','matA','matB','fbx']
    .map((key, i) => [key, (i + 1).toString(16).padStart(32, '0')]));
const FILTER = '9007199254741001', RENDERER = '9007199254741003';
const xor = (a,b) => ((BigInt(a)^BigInt(b)) & 0x7fffffffffffffffn).toString();

// Small static Mesh v10 with two deliberately ordered material domains.
// The geometry is synthetic; no licensed package is needed by this suite.
function mesh(fileID = '4300000', name = 'OrderedMesh') {
    const bytes = Buffer.alloc(3 * 48);
    [[1,0,0],[1,1,0],[1,0,1]].forEach((p,i) =>
        [...p,1,0,0,0,1,0,1,0,0].forEach((v,j) => bytes.writeFloatLE(v,i*48+j*4)));
    const channels = Array.from({length:14},()=>[0,0,0,0]);
    channels[0]=[0,0,0,3]; channels[1]=[0,12,0,3]; channels[2]=[0,24,0,4]; channels[4]=[0,40,0,2];
    return `--- !u!43 &${fileID}
Mesh:
  serializedVersion: 10
  m_Name: ${name}
  m_SubMeshes:
${[0,6].map(first => `  - serializedVersion: 2
    firstByte: ${first}
    indexCount: 3
    topology: 0
    baseVertex: 0
    firstVertex: 0
    vertexCount: 3
`).join('')}  m_Shapes:
    vertices: []
    shapes: []
    channels: []
    fullWeights: []
  m_BindPose: []
  m_BonesAABB: []
  m_MeshCompression: 0
  m_IndexFormat: 0
  m_IndexBuffer: 000001000200020001000000
  m_VertexData:
    m_VertexCount: 3
    m_Channels:
${channels.map(c=>`    - stream: ${c[0]}
      offset: ${c[1]}
      format: ${c[2]}
      dimension: ${c[3]}
`).join('')}    m_DataSize: ${bytes.length}
    _typelessdata: ${bytes.toString('hex')}
  m_CompressedMesh:
${Array.from({length:10},(_,i)=>`    channel${i}:
      m_NumItems: 0
`).join('')}  m_LocalAABB:
    m_Center: {x: 1, y: 0.5, z: 0.5}
  m_StreamData:
    size: 0
    path:
`;
}
function base(reference = `{fileID: 4300000, guid: ${G.meshA}, type: 2}`) {
    return `--- !u!1 &11
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
--- !u!33 &${FILTER}
MeshFilter:
  m_GameObject: {fileID: 11}
  m_Mesh: ${reference}
--- !u!23 &${RENDERER}
MeshRenderer:
  m_GameObject: {fileID: 11}
  m_Enabled: 1
  m_CastShadows: 1
  m_ReceiveShadows: 1
  m_Materials:
  - {fileID: 2100000, guid: ${G.matA}, type: 2}
  - {fileID: 2100000, guid: ${G.matB}, type: 2}
`;
}
function modification(targetGuid, targetID, property, reference, value = '') {
    return `    - target: {fileID: ${targetID}, guid: ${targetGuid}, type: 3}
      propertyPath: ${property}
      value: ${value}
${reference === undefined ? '' : `      objectReference: ${reference}\n`}`;
}
function instance(id, source, modifications = '') {
    return `--- !u!1001 &${id}
PrefabInstance:
  m_Modification:
    m_TransformParent: {fileID: 0}
    m_Modifications:${modifications ? '\n'+modifications : ' []\n'}  m_SourcePrefab: {fileID: 100100000, guid: ${source}, type: 3}
`;
}
function alias(type, anchor, original, instanceID='1000', source=G.base) {
    return `--- !u!${type} &${anchor} stripped
${{'4':'Transform','23':'MeshRenderer','33':'MeshFilter','114':'MonoBehaviour'}[type]}:
  m_CorrespondingSourceObject: {fileID: ${original}, guid: ${source}, type: 3}
  m_PrefabInstance: {fileID: ${instanceID}}
`;
}
function fixture(t) {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'prefab-mesh-reference-'));
    t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    const pkg=path.join(dir,'package'); fs.mkdirSync(pkg);
    const put=(guid,name,text)=>{const p=path.join(pkg,guid);fs.mkdirSync(p,{recursive:true});fs.writeFileSync(path.join(p,'pathname'),'Assets/'+name+'\n');fs.writeFileSync(path.join(p,'asset'),text);};
    put(G.meshA,'Original.asset',mesh()); put(G.meshB,'Replacement.asset',mesh('4300001','Replacement'));
    put(G.base,'Base.prefab',base());
    const ctx=()=>({pkg:buildPackageIndex(pkg),structureCache:new Map(),assetDb:null,
        modelSeedDir:path.join(dir,'project','assets','Models_Unity'),projectDir:path.join(dir,'project'),
        matOutDir:path.join(dir,'project','assets','Materials_Unity'),
        materialCache:new Map([[G.matA,{path:'Materials/A.material',guid:'a'}],[G.matB,{path:'Materials/B.material',guid:'b'}]]),
        matHide:new Set(),verbose:false,renderSettings:null,volumeOverrides:null,outputSet:new Set(),outputs:[]});
    return{dir,put,ctx};
}
const replacement = `{fileID: 4300001, guid: ${G.meshB}, type: 2}`;

test('direct typed Mesh reference emits its exact fileID, GLB domains and material order', t=>{
    const f=fixture(t),ctx=f.ctx(),st=buildFileStructure(ctx,G.base,[]);
    assert.deepEqual(st.nodes.get(st.rootIds[0]).meshRef,{guid:G.meshA,fileID:'4300000'});
    const result=emitScene(ctx,st,'Direct');
    assert.equal(result.emitted.meshEntities,2);
    assert.match(result.text,/SerializedMeshes\/00000000000000000000000000000004\/4300000\.glb/);
    const blocks=result.text.split('[entity ').filter(s=>s.includes('MeshRenderer.meshName'));
    assert.equal(blocks.length,2);
    assert.match(blocks[0],/meshName = "OrderedMesh_0"[\s\S]*Materials\/A\.material/);
    assert.match(blocks[1],/meshName = "OrderedMesh_1"[\s\S]*Materials\/B\.material/);
    const output=ctx.outputs.find(o=>o.kind==='model');assert.ok(output);
    const data=fs.readFileSync(output.path),doc=JSON.parse(data.subarray(20,20+data.readUInt32LE(12)).toString());
    assert.deepEqual(doc.materials.map(m=>m.name),['UnityMaterial_0','UnityMaterial_1']);
    assert.deepEqual(doc.meshes.map(m=>m.primitives[0].material),[0,1]);
});

test('nested repeated instances keep replacement and material overrides isolated', t=>{
    const f=fixture(t);
    f.put(G.wrapper,'Wrapper.prefab',instance('1000',G.base)+alias('4',xor('12','1000'),'12'));
    f.put(G.scene,'Repeated.unity',instance('2000',G.wrapper,
        modification(G.wrapper,xor(FILTER,'1000'),'m_Mesh',replacement)+
        modification(G.wrapper,xor(RENDERER,'1000'),'m_Materials.Array.data[1]',`{fileID: 2100000, guid: ${G.matA}, type: 2}`))+
        instance('3000',G.wrapper));
    const ctx=f.ctx(),st=buildFileStructure(ctx,G.scene,[]),nodes=st.rootIds.map(id=>st.nodes.get(id));
    assert.equal(nodes.length,2);
    assert.deepEqual(nodes[0].meshRef,{guid:G.meshB,fileID:'4300001'});
    assert.deepEqual(nodes[0].matGuids,[G.matA,G.matA]);
    assert.deepEqual(nodes[1].meshRef,{guid:G.meshA,fileID:'4300000'});
    assert.deepEqual(nodes[1].matGuids,[G.matA,G.matB]);
    assert.deepEqual(nodes.map(n=>n.pos),[[2,3,4],[2,3,4]]);
    assert.deepEqual(buildFileStructure(ctx,G.base,[]).nodes.values().next().value.meshRef,{guid:G.meshA,fileID:'4300000'});
    assert.equal(emitScene(ctx,st,'Repeated').emitted.meshEntities,4);
});

test('explicit non-XOR component aliases work without inventing unlisted aliases', t=>{
    const f=fixture(t);
    f.put(G.wrapper,'Wrapper.prefab',instance('1000',G.base)+alias('4','777','12')+alias('33','888',FILTER)+alias('23','889',RENDERER));
    f.put(G.scene,'Explicit.unity',instance('2000',G.wrapper,modification(G.wrapper,'888','m_Mesh',replacement)));
    const ctx=f.ctx(),st=buildFileStructure(ctx,G.scene,[]);
    assert.equal(st.nodes.get(st.rootIds[0]).meshRef.guid,G.meshB);
    assert.equal(buildFileStructure(ctx,G.wrapper,[]).anchorToNode.has(xor(FILTER,'1000')),false);
    f.put(G.scene,'Unlisted.unity',instance('2000',G.wrapper,modification(G.wrapper,xor(FILTER,'1000'),'m_Mesh',replacement)));
    assert.throws(()=>buildFileStructure(f.ctx(),G.scene,[]),/Unresolved MeshFilter/);
});

test('null replacement clears inherited geometry without changing a sibling instance',t=>{
    const f=fixture(t);
    f.put(G.scene,'Null.unity',instance('2000',G.base,modification(G.base,FILTER,'m_Mesh','{fileID: 0}'))+instance('3000',G.base));
    const ctx=f.ctx(),st=buildFileStructure(ctx,G.scene,[]),nodes=st.rootIds.map(id=>st.nodes.get(id));
    assert.equal(nodes[0].meshRef,null);assert.equal(nodes[0].meshPrimitive,null);
    assert.equal(nodes[1].meshRef.guid,G.meshA);
    assert.equal(emitScene(ctx,st,'Null').emitted.meshEntities,2);
});

test('mesh overrides reject wrong target GUID, wrong component type and absent objectReference',t=>{
    const f=fixture(t);
    for(const [guid,id,ref,pattern] of [[G.foreign,FILTER,replacement,/outside prefab/],[G.base,RENDERER,replacement,/Unresolved MeshFilter/],[G.base,FILTER,undefined,/Missing MeshFilter objectReference/]]){
        f.put(G.scene,'Invalid.unity',instance('2000',G.base,modification(guid,id,'m_Mesh',ref)));
        assert.throws(()=>buildFileStructure(f.ctx(),G.scene,[]),pattern);
    }
});

test('stripped aliases with a foreign source GUID cannot authenticate or redirect a mesh target',t=>{
    const f=fixture(t);
    for(const type of ['4','33','114']){
        const id=type==='4'?'12':FILTER;
        f.put(G.wrapper,'Forged.prefab',instance('1000',G.base)+alias(type,xor(id,'1000'),id,'1000',G.foreign));
        f.put(G.scene,'Invalid.unity',instance('2000',G.wrapper,modification(G.wrapper,xor(FILTER,'1000'),'m_Mesh',replacement)));
        assert.throws(()=>buildFileStructure(f.ctx(),G.scene,[]),/source|GUID|Unresolved|alias/i);
    }
});

test('serialized mesh rejects absent/wrong fileID and unsupported replacement type before model publication',t=>{
    const f=fixture(t);
    f.put(G.foreign,'Other.png','not a mesh');
    for(const source of [{guid:G.meshB,fileID:null},{guid:G.meshB,fileID:'4300999'},{guid:G.foreign,fileID:'4300000'}]){
        const ctx=f.ctx();assert.throws(()=>resolveMeshAsset(ctx,source),/fileID|Unsupported/);assert.equal(ctx.outputs.length,0);
    }
});

test('missing replacement asset is an explicit failure, never a successful empty scene',t=>{
    const f=fixture(t);
    f.put(G.scene,'Missing.unity',instance('2000',G.base,modification(G.base,FILTER,'m_Mesh',`{fileID: 4300000, guid: ${G.foreign}, type: 2}`)));
    const ctx=f.ctx();assert.throws(()=>emitScene(ctx,buildFileStructure(ctx,G.scene,[]),'Missing'),/missing|unresolved|asset/i);
    assert.equal(ctx.outputs.length,0);
});

test('unsupported local Mesh fileID fails instead of rendering the inherited mesh',t=>{
    const f=fixture(t);
    f.put(G.scene,'Local.unity',instance('2000',G.base,modification(G.base,FILTER,'m_Mesh','{fileID: 987654321}')));
    assert.throws(()=>buildFileStructure(f.ctx(),G.scene,[]),/Unsupported builtin MeshFilter/);
});

test('an explicit null material clears its inherited slot while preserving the other domain',t=>{
    const f=fixture(t);
    f.put(G.scene,'NullMaterial.unity',instance('2000',G.base,modification(G.base,RENDERER,'m_Materials.Array.data[1]','{fileID: 0}')));
    const ctx=f.ctx(),st=buildFileStructure(ctx,G.scene,[]);
    assert.deepEqual(st.nodes.get(st.rootIds[0]).matGuids,[G.matA,null]);
    const result=emitScene(ctx,st,'NullMaterial');assert.equal(result.emitted.meshEntities,2);assert.equal(result.emitted.materialsBound,1);
});

test('a material override cannot bind through a same-number target from another source prefab',t=>{
    const f=fixture(t);
    f.put(G.scene,'ForeignMaterial.unity',instance('2000',G.base,
        modification(G.foreign,RENDERER,'m_Materials.Array.data[1]',`{fileID: 2100000, guid: ${G.matA}, type: 2}`)));
    const st=buildFileStructure(f.ctx(),G.scene,[]);
    assert.deepEqual(st.nodes.get(st.rootIds[0]).matGuids,[G.matA,G.matB]);
});

test('serialized material domains come from the mesh even when the source material array is short',t=>{
    const f=fixture(t);
    f.put(G.base,'Base.prefab',base().replace(`  - {fileID: 2100000, guid: ${G.matB}, type: 2}\n`,''));
    const ctx=f.ctx(),result=emitScene(ctx,buildFileStructure(ctx,G.base,[]),'ShortArray');
    assert.equal(result.emitted.meshEntities,2);
    assert.equal(result.emitted.materialsBound,1);
    assert.match(result.text,/meshName = "OrderedMesh_1"/);
});

test('quoted and multiline Unity mesh names produce matching safe GLB names and scene selectors',t=>{
    const f=fixture(t),sourceName='Odd "Roof"\nTop\\Other';
    f.put(G.meshA,'Original.asset',mesh('4300000',JSON.stringify(sourceName)));
    const ctx=f.ctx(),result=emitScene(ctx,buildFileStructure(ctx,G.base,[]),'Named');
    const selectors=[...result.text.matchAll(/^MeshRenderer\.meshName = "([^"\r\n]*)"$/gm)].map(m=>m[1]);
    assert.deepEqual(selectors,["Odd 'Roof' Top'Other_0","Odd 'Roof' Top'Other_1"]);
    const output=ctx.outputs.find(o=>o.kind==='model');assert.ok(output);
    const data=fs.readFileSync(output.path),doc=JSON.parse(data.subarray(20,20+data.readUInt32LE(12)).toString());
    assert.deepEqual(doc.meshes.map(m=>m.name),selectors);
    assert.deepEqual(doc.nodes.map(n=>n.name),selectors);
});

test('empty source mesh name uses one stable generated stem for GLB and scene selectors',t=>{
    const f=fixture(t);
    f.put(G.meshA,'Original.asset',mesh('4300000','""'));
    const ctx=f.ctx(),result=emitScene(ctx,buildFileStructure(ctx,G.base,[]),'Unnamed');
    const selectors=[...result.text.matchAll(/^MeshRenderer\.meshName = "([^"\r\n]*)"$/gm)].map(m=>m[1]);
    assert.deepEqual(selectors,['UnityMesh_0','UnityMesh_1']);
    const data=fs.readFileSync(ctx.outputs.find(o=>o.kind==='model').path);
    const doc=JSON.parse(data.subarray(20,20+data.readUInt32LE(12)).toString());
    assert.deepEqual(doc.meshes.map(m=>m.name),selectors);
    assert.deepEqual(doc.nodes.map(n=>n.name),selectors);
});
