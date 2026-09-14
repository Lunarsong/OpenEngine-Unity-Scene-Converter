import fs from 'node:fs';
export const G = Object.fromEntries(['base','wrapper','scene','embedded','foreign','material','matA','matB']
    .map((name, i) => [name, (i + 1).toString(16).padStart(32, '0')]));
export const GROUP = '9007199254741017', RENDERER = '9007199254741003';
export const baseText = fs.readFileSync(new URL('./lod-source/Base.prefab', import.meta.url), 'utf8');
export const embeddedText = fs.readFileSync(new URL('./lod-source/Embedded.prefab', import.meta.url), 'utf8');
export const xor = (a,b) => ((BigInt(a)^BigInt(b)) & 0x7fffffffffffffffn).toString();
export function modification(target, property, value = '', reference = '{fileID: 0}', guid = G.base) {
    return `    - target: {fileID: ${target}, guid: ${guid}, type: 3}\n      propertyPath: ${property}\n      value: ${value}\n      objectReference: ${reference}\n`;
}
export function instance(id, source = G.base, mods = '') {
    return `--- !u!1001 &${id}\nPrefabInstance:\n  m_Modification:\n    m_TransformParent: {fileID: 0}\n    m_Modifications:${mods ? '\n'+mods : ' []\n'}  m_SourcePrefab: {fileID: 100100000, guid: ${source}, type: 3}\n`;
}
export function alias(type, anchor, original, source = G.base, id = '1000') {
    return `--- !u!${type} &${anchor} stripped\n${{'4':'Transform','23':'MeshRenderer','205':'LODGroup'}[type]}:\n  m_CorrespondingSourceObject: {fileID: ${original}, guid: ${source}, type: 3}\n  m_PrefabInstance: {fileID: ${id}}\n`;
}
export function nestedScene() {
    return {
        [G.base]: { pathname: 'Assets/Base.prefab', asset: baseText },
        [G.embedded]: { pathname: 'Assets/Embedded.prefab', asset: embeddedText },
        [G.wrapper]: { pathname: 'Assets/Wrapper.prefab', asset: instance('1000') + alias('4', xor('4','1000'), '4') },
        [G.scene]: { pathname: 'Assets/LOD.unity', asset:
            instance('2000', G.wrapper, modification(xor(GROUP,'1000'), 'm_Enabled', '0', '{fileID: 0}', G.wrapper) +
                modification(xor(RENDERER,'1000'), 'm_Materials.Array.data[1]', '', `{fileID: 2100099, guid: ${G.matA}, type: 2}`, G.wrapper)) +
            instance('3000', G.wrapper) + instance('4000', G.embedded) },
    };
}
