'use strict';

// Source metadata only. These records do not select or emit engine LODs.
// All references retain the owning Unity file namespace and integer-string ID.
function indexDocuments(docs) {
    const index = new Map();
    for (const doc of docs) {
        if (index.has(doc.anchor)) throw new Error(`Duplicate Unity document identity ${doc.anchor}`);
        // Keep the parser single-owner, but do not retain embedded vertex/image
        // blobs through the cached FileStructure after this parse finishes.
        index.set(doc.anchor, ['43', '28'].includes(doc.classId)
            ? { ...doc, data: { serializedVersion: doc.data?.serializedVersion } } : doc);
    }
    return index;
}

function sourceReference(raw, scope, documents, expectedClass) {
    if (!raw || String(raw.fileID) === '0') return null;
    const fileID = String(raw.fileID), guid = String(raw.guid || scope).toLowerCase();
    if (!/^-?\d+$/.test(fileID) || !/^[0-9a-f]{32}$/.test(guid))
        throw new Error(`Invalid source reference ${guid}/${fileID}`);
    const ref = { guid, fileID };
    if (!raw.guid) {
        const doc = documents.get(fileID);
        if (!doc || doc.classId !== expectedClass)
            throw new Error(`Expected local class ${expectedClass}: ${guid}/${fileID}`);
        ref.embedded = true;
        if (expectedClass === '43') ref.serializedVersion = String(doc.data?.serializedVersion ?? 'unknown');
    }
    return ref;
}

function numeric(raw, label, min = -Infinity, max = Infinity) {
    if (!['number', 'string'].includes(typeof raw) || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(String(raw)))
        throw new Error(`Invalid LODGroup ${label}`);
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min || value > max)
        throw new Error(`Invalid LODGroup ${label}`);
    return value;
}
function flag(raw, label) {
    const value = numeric(raw, label, 0, 1);
    if (value !== 0 && value !== 1) throw new Error(`Invalid LODGroup ${label}`);
    return value === 1;
}

function readGroups(st, docs) {
    for (const doc of docs) {
        if (doc.classId !== '205' || doc.stripped) continue;
        const d = doc.data;
        const go = d?.m_GameObject;
        const ownerNodeId = go && !go.guid && st.anchorToNode.get(go.fileID);
        if (!ownerNodeId || st.anchorTypes.get(go.fileID) !== '1')
            throw new Error(`Unresolved LODGroup owner ${st.sourceGuid}/${doc.anchor}`);
        if (!Array.isArray(d.m_LODs)) throw new Error(`Invalid LODGroup m_LODs ${doc.anchor}`);
        const p = d.m_LocalReferencePoint;
        const fadeMode = numeric(d.m_FadeMode, 'm_FadeMode', 0, 2);
        if (!Number.isInteger(fadeMode)) throw new Error('Invalid LODGroup m_FadeMode');
        const group = {
            source: { guid: st.sourceGuid, fileID: doc.anchor }, ownerNodeId, instancePath: [],
            enabled: flag(d.m_Enabled, 'm_Enabled'),
            localReferencePoint: ['x', 'y', 'z'].map(k => numeric(p?.[k], `m_LocalReferencePoint.${k}`)),
            size: numeric(d.m_Size, 'm_Size', 0), fadeMode,
            animateCrossFading: flag(d.m_AnimateCrossFading, 'm_AnimateCrossFading'),
            lastLodIsBillboard: flag(d.m_LastLODIsBillboard, 'm_LastLODIsBillboard'),
            levels: d.m_LODs.map((level, index) => {
                if (!Array.isArray(level.renderers)) throw new Error(`Invalid LODGroup renderers ${index}`);
                return {
                    screenRelativeHeight: numeric(level.screenRelativeHeight, 'screenRelativeHeight', 0, 1),
                    fadeTransitionWidth: numeric(level.fadeTransitionWidth, 'fadeTransitionWidth', 0, 1),
                    renderers: level.renderers.map(member => {
                        const ref = member?.renderer;
                        const nodeId = ref && !ref.guid && st.anchorToNode.get(ref.fileID);
                        if (!nodeId || !['23', '137'].includes(st.anchorTypes.get(ref.fileID)))
                            throw new Error(`Unresolved LODGroup renderer ${st.sourceGuid}/${ref?.fileID}`);
                        return { source: { guid: st.sourceGuid, fileID: ref.fileID }, nodeId };
                    }),
                };
            }),
            // A source record remains inspectable when an effective override is unsupported.
            // Callers MUST check this list before using its original scalar/level values.
            unsupportedOverrides: [],
        };
        st.lodGroups.push(group);
        st.anchorToLodGroup.set(doc.anchor, group);
    }
    if (st.lodGroups.length && st.unsupportedStructuralOperations.length)
        throw new Error(`Unsupported prefab structural operation with LODGroup records: ${st.unsupportedStructuralOperations.join(', ')}`);
}

// The existing resolver does not implement Unity structural prefab editing.
// Retain the refusal through nested members even if their own file has no group.
function recordStructuralOperations(st, sub, doc) {
    st.unsupportedStructuralOperations.push(...sub.unsupportedStructuralOperations);
    for (const container of [doc.data, doc.data?.m_Modification])
        for (const key of ['m_RemovedComponents', 'm_RemovedGameObjects', 'm_AddedComponents', 'm_AddedGameObjects']) {
            const value = container?.[key];
            if (value != null && (!Array.isArray(value) || value.length))
                st.unsupportedStructuralOperations.push(`${st.sourceGuid}/${doc.anchor}:${key}`);
        }
}

function cloneGroups(st, sub, map, instanceId, modifications) {
    const clones = new Map();
    for (const group of sub.lodGroups) {
        const clone = structuredClone(group);
        clone.ownerNodeId = map.get(group.ownerNodeId);
        clone.instancePath.unshift({ guid: st.sourceGuid, fileID: instanceId });
        for (const level of clone.levels) for (const member of level.renderers) member.nodeId = map.get(member.nodeId);
        clones.set(group, clone);
        st.lodGroups.push(clone);
    }
    const handled = new Set();
    for (const mod of modifications || []) {
        const target = mod?.target;
        const group = target && sub.anchorToLodGroup.get(target.fileID);
        if (!group) {
            if (mod?.propertyPath?.startsWith('m_LODs') || ['m_Size', 'm_FadeMode', 'm_AnimateCrossFading', 'm_LastLODIsBillboard'].includes(mod?.propertyPath) || mod?.propertyPath?.startsWith('m_LocalReferencePoint'))
                throw new Error(`Unresolved LODGroup override ${target?.guid}/${target?.fileID}`);
            continue;
        }
        if (String(target.guid || '').toLowerCase() !== sub.sourceGuid)
            throw new Error(`LODGroup override target is outside prefab ${sub.sourceGuid}`);
        clones.get(group).unsupportedOverrides.push({
            instance: { guid: st.sourceGuid, fileID: instanceId },
            target: { guid: sub.sourceGuid, fileID: target.fileID },
            propertyPath: String(mod.propertyPath || ''), value: mod.value ?? null,
            objectReference: mod.objectReference ? structuredClone(mod.objectReference) : null,
        });
        handled.add(mod);
    }
    return { clones, handled };
}

function unsupportedBindings(node) {
    const result = [];
    if (node.meshRef?.embedded) result.push(`embedded Mesh ${node.meshRef.guid}/${node.meshRef.fileID} v${node.meshRef.serializedVersion}`);
    (node.materialRefs || []).forEach((ref, slot) => {
        if (ref?.embedded) result.push(`embedded Material ${ref.guid}/${ref.fileID} slot ${slot}`);
    });
    return result;
}

// Project final bindings from the nodes, never from a stale copy in a group.
function summarize(st) {
    return st.lodGroups.map(group => ({ ...group,
        effectiveSourceKnown: group.unsupportedOverrides.length === 0,
        runtimeSelectionSupported: false,
        levels: group.levels.map(level => ({ ...level, renderers: level.renderers.map(member => {
            const node = st.nodes.get(member.nodeId);
            return { ...member, name: node.name, active: node.active, rendererEnabled: node.rendererEnabled,
                meshRef: node.meshRef, materialRefs: node.materialRefs,
                unsupported: [...unsupportedBindings(node), ...(node.skinned ? ['skinned renderer'] : [])] };
        }) })),
    }));
}

module.exports = { indexDocuments, sourceReference, readGroups, cloneGroups, recordStructuralOperations, unsupportedBindings, summarize };
