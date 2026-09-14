import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { G, GROUP, RENDERER, baseText, embeddedText, modification, instance, alias, nestedScene, xor } from './fixtures/lod-source.mjs';
const { buildPackageIndex, buildFileStructure, summarizeLodGroups, emitScene } = createRequire(import.meta.url)('../src/convert.js');
function fixture(t, entries = nestedScene()) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lod-source-'));
    t.after(() => fs.rmSync(root, {recursive:true, force:true}));
    const put = (guid, name, asset) => {
        const dir = path.join(root,'pkg',guid); fs.mkdirSync(dir,{recursive:true});
        fs.writeFileSync(path.join(dir,'pathname'),'Assets/'+name); fs.writeFileSync(path.join(dir,'asset'),asset);
    };
    for (const [guid,e] of Object.entries(entries)) put(guid,path.basename(e.pathname),e.asset);
    const context = () => ({pkg:buildPackageIndex(path.join(root,'pkg')),structureCache:new Map(),verbose:false,
        materialCache:new Map([[G.matA,{guid:'a',path:'Materials/A.material'}],[G.matB,{guid:'b',path:'Materials/B.material'}]]),
        matHide:new Set(),outputs:[],outputSet:new Set(),projectDir:path.join(root,'project'),modelSeedDir:path.join(root,'project','Models')});
    const build = (guid = G.base, ctx = context()) => buildFileStructure(ctx,guid,[]);
    return {root,put,context,build};
}
test('ordered source levels bind exact renderer IDs and scoped material permutations, independent of document order', t => {
    const f=fixture(t),st=f.build(),[g]=summarizeLodGroups(st);
    assert.deepEqual(g.source,{guid:G.base,fileID:GROUP});
    assert.deepEqual(g.localReferencePoint,[1.25,-2.5,3.75]); assert.equal(g.size,19.125);
    assert.deepEqual([g.fadeMode,g.animateCrossFading,g.lastLodIsBillboard],[2,true,false]);
    assert.deepEqual(g.levels.map(l=>[l.screenRelativeHeight,l.fadeTransitionWidth]),[[.35,.125],[.1,.25]]);
    assert.deepEqual(g.levels[0].renderers.map(r=>r.source.fileID),['24',RENDERER]);
    assert.deepEqual(g.levels[0].renderers.map(r=>r.materialRefs.map(m=>m.fileID)),[['2100002','2100001'],['2100001','2100002']]);
    assert.equal(g.levels[0].renderers[0].rendererEnabled,false); assert.equal(g.runtimeSelectionSupported,false);
    assert.equal(g.effectiveSourceKnown,true);
    const node=st.nodes.get(g.levels[0].renderers[1].nodeId); const legacy=node.matGuids;
    legacy[0]='corrupt'; assert.equal(node.materialRefs[0].guid,G.matA);
});
test('nested clones remap members, retain instance scopes, project effective material overrides and flag group overrides', t => {
    const f=fixture(t),ctx=f.context(),st=f.build(G.scene,ctx),groups=summarizeLodGroups(st);
    assert.equal(groups.length,2);
    const [a,b]=groups;
    assert.notEqual(a.ownerNodeId,b.ownerNodeId);
    assert.notEqual(a.levels[1].renderers[0].nodeId,b.levels[1].renderers[0].nodeId);
    assert.deepEqual(a.instancePath,[{guid:G.scene,fileID:'2000'},{guid:G.wrapper,fileID:'1000'}]);
    assert.equal(a.effectiveSourceKnown,false); assert.equal(b.effectiveSourceKnown,true);
    assert.equal(a.unsupportedOverrides[0].propertyPath,'m_Enabled');
    assert.equal(a.enabled,true); // original source, explicitly marked ineffective
    assert.equal(st.nodes.get(a.ownerNodeId).rendererEnabled,true); // no wrong renderer write
    assert.equal(a.levels[1].renderers[0].materialRefs[1].fileID,'2100099');
    assert.equal(b.levels[1].renderers[0].materialRefs[1].fileID,'2100002');
    assert.equal(summarizeLodGroups(f.build(G.base,ctx))[0].unsupportedOverrides.length,0);
});
test('explicit non-XOR stripped group aliases bind overrides without inventing another instance', t => {
    const f=fixture(t);
    f.put(G.wrapper,'Wrapper.prefab',instance('1000')+alias('205','800',GROUP));
    f.put(G.scene,'LOD.unity',instance('2000',G.wrapper,modification('800','m_LODs.Array.data[0].screenRelativeHeight','.7','{fileID: 0}',G.wrapper)));
    const [g]=summarizeLodGroups(f.build(G.scene));
    assert.equal(g.effectiveSourceKnown,false); assert.equal(g.levels[0].screenRelativeHeight,.35);
});
test('embedded v11 mesh/material are retained as unsupported identities and never published as a substitute', t => {
    const f=fixture(t),ctx=f.context(),st=f.build(G.embedded,ctx),n=st.nodes.get(st.rootIds[0]);
    assert.deepEqual(n.meshRef,{guid:G.embedded,fileID:'-9007199254741023',embedded:true,serializedVersion:'11'});
    assert.deepEqual(n.materialRefs,[{guid:G.embedded,fileID:'2100077',embedded:true}]);
    assert.deepEqual(n.matGuids,[null]);
    assert.equal(emitScene(ctx,st,'Embedded').emitted.meshEntities,0);
    assert.deepEqual(ctx.outputs,[]); assert.equal(fs.existsSync(ctx.modelSeedDir),false);
});
test('outer LOD member resolves the exact stripped renderer of an unsupported embedded instance', t => {
    const f=fixture(t);
    f.put(G.base,'Base.prefab',baseText.replace('- renderer: {fileID: 24}','- renderer: {fileID: 888}')+
        instance('1000',G.embedded)+alias('23','888','23',G.embedded));
    const [g]=summarizeLodGroups(f.build());
    assert.equal(g.levels[0].renderers[0].source.fileID,'888');
    assert.equal(g.levels[0].renderers[0].meshRef.guid,G.embedded);
    assert.equal(g.levels[0].renderers[0].unsupported.length,2);
    assert.equal(g.levels[0].renderers[1].unsupported.length,0);
});
for (const [name,from,to] of [
    ['nonfinite size','m_Size: 19.125','m_Size: NaN'], ['partial numeric','m_Size: 19.125','m_Size: 19x'],
    ['missing reference point','z: 3.75','q: 3.75'], ['bad threshold','screenRelativeHeight: 0.35','screenRelativeHeight: 1.01'],
    ['missing renderer','renderer: {fileID: 24}','renderer: {fileID: 999}'],
    ['wrong renderer class','renderer: {fileID: 24}','renderer: {fileID: 22}'],
    ['foreign renderer','renderer: {fileID: 24}',`renderer: {fileID: 24, guid: ${G.foreign}}`],
    ['fractional flag','m_Enabled: 1','m_Enabled: 0.5'],
]) test(`invalid source ${name} is rejected before structure caching`, t => {
    const f=fixture(t);f.put(G.base,'Base.prefab',baseText.replace(from,to));const ctx=f.context();
    assert.throws(()=>f.build(G.base,ctx),/LODGroup/);assert.equal(ctx.structureCache.has(G.base),false);
});
test('unknown group override target and mistyped embedded object fail explicitly', t=>{
    const f=fixture(t);f.put(G.scene,'LOD.unity',instance('1000',G.base,modification('999','m_LODs.Array.size','0')));
    assert.throws(()=>f.build(G.scene),/Unresolved LODGroup override/);
    f.put(G.embedded,'Embedded.prefab',embeddedText.replace('fileID: -9007199254741023','fileID: 2100077'));
    assert.throws(()=>f.build(G.embedded),/Expected local class 43/);
});
test('material array shrink removes stale slots and rejects out-of-range effective bindings', t=>{
    const f=fixture(t);f.put(G.scene,'LOD.unity',instance('1000',G.base,modification(RENDERER,'m_Materials.Array.size','1')));
    assert.equal(summarizeLodGroups(f.build(G.scene))[0].levels[1].renderers[0].materialRefs.length,1);
    f.put(G.scene,'LOD.unity',instance('1000',G.base,modification(RENDERER,'m_Materials.Array.size','1')+
        modification(RENDERER,'m_Materials.Array.data[1]','','{fileID: 0}')));
    assert.throws(()=>f.build(G.scene),/exceeds overridden array size/);
});
test('a resolved renderer retains material overrides after its mesh is explicitly cleared', t=>{
    const f=fixture(t);f.put(G.scene,'LOD.unity',instance('1000',G.base,
        modification('9007199254741001','m_Mesh')+
        modification(RENDERER,'m_Materials.Array.data[0]','',`{fileID: 2100099, guid: ${G.matB}, type: 2}`)));
    const [group]=summarizeLodGroups(f.build(G.scene)),node=group.levels[1].renderers[0];
    assert.equal(node.meshRef,null); assert.equal(group.effectiveSourceKnown,true);
    assert.deepEqual(node.materialRefs[0],{guid:G.matB,fileID:'2100099'});
});
for (const [kind,source] of [['group',GROUP],['renderer',RENDERER]])
test(`inferred nested ${kind} aliases reject real local object identity collisions`,t=>{
    const f=fixture(t),collision=xor(source,'1000');
    f.put(G.wrapper,'Wrapper.prefab',instance('1000')+alias('4',xor('4','1000'),'4')+
        `--- !u!1 &${collision}\nGameObject:\n  m_Name: RealLocalObject\n  m_IsActive: 1\n`+
        `--- !u!4 &20001\nTransform:\n  m_GameObject: {fileID: ${collision}}\n  m_Father: {fileID: 1004}\n`);
    f.put(G.scene,'LOD.unity',instance('2000',G.wrapper,modification(collision,'m_IsActive','0','{fileID: 0}',G.wrapper)));
    assert.throws(()=>f.build(G.scene),/Ambiguous nested component identity/);
});
for (const field of ['m_RemovedComponents','m_RemovedGameObjects','m_AddedComponents','m_AddedGameObjects'])
test(`${field} cannot leave apparently effective LOD source records`,t=>{
    const f=fixture(t);f.put(G.scene,'LOD.unity',instance('1000').replace('    m_Modifications:',
        `    ${field}: [{fileID: ${GROUP}, guid: ${G.base}, type: 3}]\n    m_Modifications:`));
    assert.throws(()=>f.build(G.scene),/Unsupported prefab structural operation with LODGroup/);
});
test('unsupported structural edits survive nesting in a member that has no group itself',t=>{
    const f=fixture(t);f.put(G.wrapper,'Wrapper.prefab',instance('1000',G.embedded).replace('    m_Modifications:',
        `    m_RemovedComponents: [{fileID: 23, guid: ${G.embedded}, type: 3}]\n    m_Modifications:`)+alias('23','888','23',G.embedded));
    f.put(G.base,'Base.prefab',baseText.replace('- renderer: {fileID: 24}','- renderer: {fileID: 999}')+
        instance('2000',G.wrapper)+alias('23','999','888',G.wrapper,'2000'));
    assert.throws(()=>f.build(),/Unsupported prefab structural operation with LODGroup/);
});
test('cached embedded identities retain versions without vertex or image payload blobs',t=>{
    const f=fixture(t),blob='ab'.repeat(32768);
    f.put(G.embedded,'Embedded.prefab',embeddedText.replace('  m_Name: EmbeddedMesh',`  m_Name: EmbeddedMesh\n  _typelessdata: ${blob}`)
        .replace('  m_Name: EmbeddedTexture',`  m_Name: EmbeddedTexture\n  m_ImageData: ${blob}`));
    const ctx=f.context(),st=f.build(G.embedded,ctx);assert.equal(st,ctx.structureCache.get(G.embedded));
    assert.deepEqual(st.documents.get('-9007199254741023').data,{serializedVersion:'11'});
    assert.deepEqual(st.documents.get('2800077').data,{serializedVersion:'2'});
    assert.equal(st.nodes.get(st.rootIds[0]).meshRef.serializedVersion,'11');
});
for (const [property,value] of [['m_Materials.Array.size','2147483648'],['m_Materials.Array.data[2147483647]','']])
test(`material array admission rejects values outside Unity Int32 range: ${property}`,t=>{
    const f=fixture(t);f.put(G.scene,'LOD.unity',instance('1000',G.base,modification(RENDERER,property,value)));
    assert.throws(()=>f.build(G.scene),/Invalid material array/);
});
test('emission consumes authoritative slots without allocating the compatibility view per material',t=>{
    const f=fixture(t),ctx=f.context(),st=f.build(G.base,ctx);
    for(const [id,node]of st.nodes)st.nodes.set(id,{...node,get matGuids(){throw new Error('compatibility view should not be read during emission');}});
    assert.ok(emitScene(ctx,st,'DirectSlots').emitted.meshEntities>0);
});
