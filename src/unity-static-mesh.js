'use strict';

// Authoring-only support for uncompressed, static Unity Mesh v10 assets. This
// deliberately rejects layouts it cannot preserve; it is not a general mesh
// importer. No external tools, Python runtime, or licensed fixtures are needed.
const ATTRIBUTES = Object.freeze({
    POSITION: [0, 3], NORMAL: [1, 3], TANGENT: [2, 4], TEXCOORD_0: [4, 2],
});

function requireMesh(condition, message) {
    if (!condition) throw new Error(message);
}

function escapeRe(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function field(text, name, indent = 2) {
    const matches = [...text.matchAll(new RegExp(`^${' '.repeat(indent)}${escapeRe(name)}: *(.*)$`, 'gm'))];
    requireMesh(matches.length === 1, `Expected one Unity Mesh field: ${name}`);
    return matches[0][1].trim();
}

function integer(value, label) {
    requireMesh(/^-?\d+$/.test(value) && Number.isSafeInteger(Number(value)), `Invalid Unity integer: ${label}`);
    return Number(value);
}

function section(text, name, following, indent = 2) {
    // Check the markers independently so a duplicate cannot hide inside the
    // non-greedy section match.
    requireMesh(field(text, name, indent) === '', `Invalid Unity Mesh section: ${name}`);
    field(text, following, indent);
    const spaces = ' '.repeat(indent);
    const match = new RegExp(`^${spaces}${escapeRe(name)}:\n([\\s\\S]*?)^${spaces}${escapeRe(following)}:`, 'm').exec(text);
    requireMesh(match, `Expected one Unity Mesh section: ${name}`);
    return match[1];
}

function hexBytes(value, label) {
    // Buffer.from(hex) otherwise silently truncates invalid/odd input.
    requireMesh(value.length % 2 === 0 && /^[\da-fA-F]*$/.test(value), `Invalid Unity hex buffer: ${label}`);
    return Buffer.from(value, 'hex');
}

function meshName(value) {
    if (value.startsWith('"')) {
        try {
            const name = JSON.parse(value);
            requireMesh(typeof name === 'string', 'Invalid Unity mesh name');
            return name;
        } catch { throw new Error('Invalid Unity mesh name'); }
    }
    if (value.startsWith("'")) {
        requireMesh(value.endsWith("'") && value.length >= 2, 'Invalid Unity mesh name');
        return value.slice(1, -1).replace(/''/g, "'");
    }
    return value;
}

/**
 * Decode exactly one Unity Mesh document with the requested string fileID.
 * Returns { name, rootMeshName, submeshCount, attributes, submeshes,
 * repairedTangentVertices }. Attributes are flat Float32Arrays: POSITION and
 * NORMAL have 3 floats/vertex, TANGENT 4, TEXCOORD_0 2. Each submesh is a
 * Uint32Array of absolute source vertex indices in source triangle order.
 * Arrays are owned copies. Values remain in Unity coordinates and UV space.
 *
 * Only tangent xyz consisting of three NaNs may be repaired (the known roof
 * defects). The finite normal determines a stable perpendicular unit tangent;
 * w must already be +/-1 and is retained. Every repaired source vertex index
 * is reported. Partial NaNs, infinities, invalid w, and zero repair normals fail.
 */
function readUnityMesh(text, fileID = '4300000') {
    requireMesh(typeof text === 'string', 'Expected Unity Mesh text');
    requireMesh(typeof fileID === 'string' && /^-?\d+$/.test(fileID), 'Expected a string Unity Mesh fileID');
    text = text.replace(/\r\n/g, '\n');
    const headers = text.match(/^---.*$/gm) || [];
    requireMesh(headers.length === 1 && headers[0] === `--- !u!43 &${fileID}`,
        `Expected one Unity Mesh document (fileID ${fileID})`);
    requireMesh(text.includes(`${headers[0]}\nMesh:\n`), 'Expected a Unity Mesh document body');
    requireMesh(field(text, 'serializedVersion') === '10', 'Unsupported Unity Mesh version');
    requireMesh(field(text, 'm_MeshCompression') === '0', 'Compressed Unity Mesh is unsupported');
    requireMesh(field(text, 'm_BindPose') === '[]' && field(text, 'm_BonesAABB') === '[]', 'Skinned Unity Mesh is unsupported');
    const shapes = section(text, 'm_Shapes', 'm_BindPose');
    requireMesh(['vertices', 'shapes', 'channels', 'fullWeights'].every(key => field(shapes, key, 4) === '[]'),
        'Unity blend shapes are unsupported');
    requireMesh(field(text, 'm_StreamData') === '', 'Invalid Unity stream data');
    const stream = text.split('  m_StreamData:\n');
    requireMesh(stream.length === 2 && field(stream[1], 'size', 4) === '0' && field(stream[1], 'path', 4) === '',
        'External Unity vertex data is unsupported');
    const compressed = section(text, 'm_CompressedMesh', 'm_LocalAABB');
    const counts = [...compressed.matchAll(/^      m_NumItems: (.*)$/gm)];
    requireMesh(counts.length === 10 && counts.every(match => match[1].trim() === '0'),
        'Compressed Unity vertex channels are unsupported');

    const vertex = section(text, 'm_VertexData', 'm_CompressedMesh');
    const count = integer(field(vertex, 'm_VertexCount', 4), 'm_VertexCount');
    requireMesh(count > 0 && count <= 1000000, 'Invalid Unity vertex count');
    const channelText = section(vertex, 'm_Channels', 'm_DataSize', 4);
    const channelRe = /^    - stream: (\d+)\n      offset: (\d+)\n      format: (\d+)\n      dimension: (\d+)\n/gm;
    const channels = [...channelText.matchAll(channelRe)].map(match => match.slice(1).map(value => integer(value, 'channel')));
    requireMesh(channels.length === 14 && channelText.replace(channelRe, '').trim() === '',
        'Unsupported Unity vertex channel table');
    const active = channels.flatMap((channel, index) => channel[3] ? [index] : []);
    requireMesh(active.join(',') === '0,1,2,4', 'Unsupported or missing Unity vertex attributes');
    requireMesh(active.every(index => channels[index][0] === 0 && channels[index][2] === 0),
        'Expected a single float32 Unity vertex stream');
    const occupied = [];
    for (const [index, dimension] of Object.values(ATTRIBUTES)) {
        const offset = channels[index][1];
        requireMesh(channels[index][3] === dimension && offset % 4 === 0, 'Invalid Unity attribute layout');
        const end = offset + dimension * 4;
        requireMesh(Number.isSafeInteger(end), 'Invalid Unity attribute layout');
        requireMesh(occupied.every(([lo, hi]) => end <= lo || offset >= hi), 'Overlapping Unity attribute channels');
        occupied.push([offset, end]);
    }
    const stride = Math.max(...occupied.map(range => range[1]));
    const data = hexBytes(field(vertex, '_typelessdata', 4), '_typelessdata');
    requireMesh(data.length === integer(field(vertex, 'm_DataSize', 4), 'm_DataSize') && data.length === stride * count,
        'Unity vertex byte count does not match its layout');
    const name = meshName(field(text, 'm_Name'));
    const result = { name, rootMeshName: name, submeshCount: 0, attributes: {}, submeshes: [], repairedTangentVertices: [] };
    for (const [attribute, [index, dimension]] of Object.entries(ATTRIBUTES)) {
        const values = new Float32Array(count * dimension);
        for (let v = 0; v < count; v++) {
            for (let d = 0; d < dimension; d++) values[v * dimension + d] = data.readFloatLE(v * stride + channels[index][1] + d * 4);
        }
        if (attribute === 'TANGENT') {
            for (let v = 0; v < count; v++) {
                const t = v * 4;
                const repair = [values[t], values[t + 1], values[t + 2]].every(Number.isNaN);
                requireMesh(Number.isFinite(values[t + 3]) && (repair || values.subarray(t, t + 3).every(Number.isFinite)),
                    'Invalid Unity tangent data');
                requireMesh(values[t + 3] === -1 || values[t + 3] === 1, 'Unity tangent handedness must be -1 or 1');
                if (!repair) continue;
                const normal = Array.from(result.attributes.NORMAL.subarray(v * 3, v * 3 + 3));
                const length = Math.hypot(...normal);
                requireMesh(length > 1e-6, 'Cannot repair tangent with a zero normal');
                const n = normal.map(value => value / length);
                let axis = 0;
                for (let d = 1; d < 3; d++) if (Math.abs(n[d]) < Math.abs(n[axis])) axis = d;
                const tangent = n.map((value, d) => (d === axis ? 1 : 0) - value * n[axis]);
                const tangentLength = Math.hypot(...tangent);
                for (let d = 0; d < 3; d++) values[t + d] = tangent[d] / tangentLength;
                result.repairedTangentVertices.push(v);
            }
        } else {
            requireMesh(values.every(Number.isFinite), 'Non-finite Unity vertex attribute');
        }
        result.attributes[attribute] = values;
    }

    const indexFormat = integer(field(text, 'm_IndexFormat'), 'm_IndexFormat');
    requireMesh(indexFormat === 0 || indexFormat === 1, 'Unsupported Unity index format');
    const indexBytes = hexBytes(field(text, 'm_IndexBuffer'), 'm_IndexBuffer');
    const itemSize = indexFormat === 0 ? 2 : 4;
    requireMesh(indexBytes.length % itemSize === 0, 'Truncated Unity index buffer');
    const indexCount = indexBytes.length / itemSize;
    const submeshes = section(text, 'm_SubMeshes', 'm_Shapes').split('  - serializedVersion: 2\n');
    requireMesh(submeshes.length > 1 && !submeshes[0].trim(), 'Unsupported Unity submesh table');
    const ranges = [];
    for (const submesh of submeshes.slice(1)) {
        const [first, length, base, start, vertices] = ['firstByte', 'indexCount', 'baseVertex', 'firstVertex', 'vertexCount']
            .map(key => integer(field(submesh, key, 4), key));
        requireMesh(field(submesh, 'topology', 4) === '0', 'Only triangle Unity submeshes are supported');
        requireMesh(first >= 0 && first % itemSize === 0 && length > 0 && length % 3 === 0, 'Invalid Unity triangle range');
        const begin = first / itemSize, end = begin + length;
        requireMesh(Number.isSafeInteger(end) && end <= indexCount && start >= 0 && vertices > 0 && start + vertices <= count,
            'Unity submesh range outside buffer');
        requireMesh(ranges.every(([lo, hi]) => end <= lo || begin >= hi), 'Overlapping Unity submesh index ranges');
        ranges.push([begin, end]);
        const values = new Uint32Array(length);
        for (let i = 0; i < length; i++) {
            const offset = (begin + i) * itemSize;
            const value = (itemSize === 2 ? indexBytes.readUInt16LE(offset) : indexBytes.readUInt32LE(offset)) + base;
            requireMesh(Number.isSafeInteger(value) && value >= start && value < start + vertices, 'Unity index outside submesh vertices');
            values[i] = value;
        }
        result.submeshes.push(values);
    }
    requireMesh(ranges.reduce((sum, [lo, hi]) => sum + hi - lo, 0) === indexCount, 'Unclaimed Unity indices');
    result.submeshCount = result.submeshes.length;
    return result;
}

/**
 * Return a GLB Buffer with one named mesh/node `${name}_${slot}` per submesh and
 * material domains `UnityMaterial_${slot}` unless options.materialNames supplies
 * one nonempty string per source submesh. Names do not merge domain identities.
 * X reflection plus reversed winding makes the engine's default MirrorX import
 * restore Unity geometry. UV V is
 * flipped for glTF; the two handedness changes cancel, so tangent.w is retained.
 * Input is the flat typed-array representation returned by readUnityMesh.
 */
function encodeGlb(mesh, options = {}) {
    requireMesh(mesh && typeof mesh.name === 'string' && mesh.attributes && Array.isArray(mesh.submeshes) && mesh.submeshes.length > 0,
        'Invalid static mesh');
    requireMesh(options !== null && typeof options === 'object' && !Array.isArray(options), 'Invalid static mesh encoding options');
    const { materialNames = null } = options;
    if (materialNames !== null) {
        requireMesh(Array.isArray(materialNames) && materialNames.length === mesh.submeshes.length,
            'Invalid static mesh material names: expected one nonempty string per submesh');
        for (const name of materialNames) {
            requireMesh(typeof name === 'string' && name.length > 0,
                'Invalid static mesh material names: expected one nonempty string per submesh');
        }
    }
    const count = mesh.attributes.POSITION?.length / 3;
    requireMesh(Number.isInteger(count) && count > 0 && count <= 1000000, 'Invalid static mesh vertex count');
    requireMesh(Object.keys(mesh.attributes).sort().join(',') === Object.keys(ATTRIBUTES).sort().join(','), 'Invalid static mesh attributes');
    for (const [name, [, dimension]] of Object.entries(ATTRIBUTES)) {
        const values = mesh.attributes[name];
        requireMesh(values instanceof Float32Array && values.length === count * dimension && values.every(Number.isFinite),
            `Invalid static mesh attribute: ${name}`);
    }
    for (let i = 3; i < mesh.attributes.TANGENT.length; i += 4) {
        requireMesh(mesh.attributes.TANGENT[i] === -1 || mesh.attributes.TANGENT[i] === 1,
            'Static mesh tangent handedness must be -1 or 1');
    }
    const document = {
        asset: { version: '2.0', generator: 'OpenEngine Unity static mesh converter' },
        scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [],
        materials: mesh.submeshes.map((_, slot) => ({ name: materialNames === null ? `UnityMaterial_${slot}` : materialNames[slot] })),
        buffers: [], bufferViews: [], accessors: [],
    };
    const chunks = [];
    let byteLength = 0;
    function accessor(values, dimension, component, target) {
        const padding = (4 - byteLength % 4) % 4;
        if (padding) { chunks.push(Buffer.alloc(padding)); byteLength += padding; }
        const payload = Buffer.alloc(values.length * 4);
        for (let i = 0; i < values.length; i++) {
            if (component === 5126) payload.writeFloatLE(values[i], i * 4);
            else payload.writeUInt32LE(values[i], i * 4);
        }
        const view = document.bufferViews.length;
        document.bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: payload.length, target });
        chunks.push(payload); byteLength += payload.length;
        const result = { bufferView: view, componentType: component, count: values.length / dimension, type: dimension === 1 ? 'SCALAR' : `VEC${dimension}` };
        if (dimension === 3 && target === 34962) {
            result.min = [Infinity, Infinity, Infinity]; result.max = [-Infinity, -Infinity, -Infinity];
            for (let i = 0; i < values.length; i++) {
                result.min[i % 3] = Math.min(result.min[i % 3], values[i]);
                result.max[i % 3] = Math.max(result.max[i % 3], values[i]);
            }
        }
        document.accessors.push(result);
        return document.accessors.length - 1;
    }
    for (const [slot, sourceIndices] of mesh.submeshes.entries()) {
        requireMesh(sourceIndices instanceof Uint32Array && sourceIndices.length > 0 && sourceIndices.length % 3 === 0 && sourceIndices.every(index => index < count),
            'Invalid static mesh triangle indices');
        const selected = [...new Set(sourceIndices)].sort((a, b) => a - b);
        const remap = new Map(selected.map((index, i) => [index, i]));
        const attributes = {};
        for (const [name, [, dimension]] of Object.entries(ATTRIBUTES)) {
            const source = mesh.attributes[name];
            const values = new Float32Array(selected.length * dimension);
            for (let i = 0; i < selected.length; i++) {
                values.set(source.subarray(selected[i] * dimension, (selected[i] + 1) * dimension), i * dimension);
                if (name === 'TEXCOORD_0') values[i * dimension + 1] = 1 - values[i * dimension + 1];
                else values[i * dimension] *= -1;
            }
            attributes[name] = accessor(values, dimension, 5126, 34962);
        }
        const indices = new Uint32Array(sourceIndices.length);
        for (let i = 0; i < indices.length; i += 3) {
            indices[i] = remap.get(sourceIndices[i]);
            indices[i + 1] = remap.get(sourceIndices[i + 2]);
            indices[i + 2] = remap.get(sourceIndices[i + 1]);
        }
        const index = accessor(indices, 1, 5125, 34963);
        const name = `${mesh.name}_${slot}`;
        document.meshes.push({ name, primitives: [{ attributes, indices: index, material: slot, mode: 4 }] });
        document.nodes.push({ name, mesh: slot });
        document.scenes[0].nodes.push(slot);
    }
    document.buffers = [{ byteLength }];
    const json = Buffer.from(JSON.stringify(document), 'utf8');
    const jsonPadding = Buffer.alloc((4 - json.length % 4) % 4, 0x20);
    const binaryPadding = Buffer.alloc((4 - byteLength % 4) % 4);
    const total = 12 + 8 + json.length + jsonPadding.length + 8 + byteLength + binaryPadding.length;
    requireMesh(total <= 0xffffffff, 'Static mesh exceeds GLB size limit');
    const header = Buffer.alloc(20), binaryHeader = Buffer.alloc(8);
    header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(total, 8);
    header.writeUInt32LE(json.length + jsonPadding.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
    binaryHeader.writeUInt32LE(byteLength + binaryPadding.length, 0); binaryHeader.writeUInt32LE(0x004e4942, 4);
    return Buffer.concat([header, json, jsonPadding, binaryHeader, ...chunks, binaryPadding], total);
}

module.exports = { readUnityMesh, encodeGlb };
