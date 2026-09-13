import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { readUnityMesh, encodeGlb } = createRequire(import.meta.url)('../src/unity-static-mesh.js');

// Entirely synthetic Mesh v10 data; no Unity package or licensed fixtures.
function fixture(options = {}) {
    const positions = options.positions || [[1, 1, 2], [3, 1, 2], [3, 3, 2], [1, 3, 2]];
    const normals = options.normals || positions.map(() => [0, 0, 1]);
    const tangents = options.tangents || positions.map(() => [1, 0, 0, options.reverseV ? -1 : 1]);
    const uv = options.uv || positions.map(([x, y]) => [(x - 1) / 2, (options.reverseV ? -1 : 1) * (y - 1) / 2]);
    const channels = Array.from({ length: 14 }, () => [0, 0, 0, 0]);
    channels[0] = [0, 0, 0, 3]; channels[1] = [0, 12, 0, 3];
    channels[2] = [0, 24, 0, 4]; channels[4] = [0, 40, 0, 2];
    options.editChannels?.(channels);
    const vertices = Buffer.alloc(positions.length * 48);
    positions.forEach((position, i) => {
        [...position, ...normals[i], ...tangents[i], ...uv[i]].forEach((value, j) => vertices.writeFloatLE(value, i * 48 + j * 4));
    });
    const indexFormat = options.indexFormat || 0, itemSize = indexFormat ? 4 : 2;
    const rawIndices = options.indices || [2, 0, 1, 0, 2, 3];
    const indices = Buffer.alloc(rawIndices.length * itemSize);
    rawIndices.forEach((value, i) => indexFormat ? indices.writeUInt32LE(value, i * itemSize) : indices.writeUInt16LE(value, i * itemSize));
    const submeshes = options.submeshes || [
        { firstByte: 0, indexCount: 3, baseVertex: 0, firstVertex: 0, vertexCount: positions.length },
        { firstByte: itemSize * 3, indexCount: 3, baseVertex: 0, firstVertex: 0, vertexCount: positions.length },
    ];
    return `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!43 &${options.fileID || '4300000'}
Mesh:
  m_Name: ${options.name || 'SyntheticRoof'}
  serializedVersion: 10
  m_SubMeshes:
${submeshes.map(submesh => `  - serializedVersion: 2
    firstByte: ${submesh.firstByte}
    indexCount: ${submesh.indexCount}
    topology: ${submesh.topology || 0}
    baseVertex: ${submesh.baseVertex}
    firstVertex: ${submesh.firstVertex}
    vertexCount: ${submesh.vertexCount}
    localAABB:
      m_Center: {x: 2, y: 2, z: 2}
      m_Extent: {x: 1, y: 1, z: 0}
`).join('')}  m_Shapes:
    vertices: []
    shapes: []
    channels: []
    fullWeights: []
  m_BindPose: []
  m_BonesAABB: []
  m_MeshCompression: 0
  m_IndexFormat: ${indexFormat}
  m_IndexBuffer: ${indices.toString('hex')}
  m_VertexData:
    serializedVersion: 3
    m_VertexCount: ${positions.length}
    m_Channels:
${channels.map(([stream, offset, format, dimension]) => `    - stream: ${stream}
      offset: ${offset}
      format: ${format}
      dimension: ${dimension}
`).join('')}    m_DataSize: ${vertices.length}
    _typelessdata: ${vertices.toString('hex')}
  m_CompressedMesh:
${Array.from({ length: 10 }, (_, i) => `    channel${i}:
      m_NumItems: 0
      m_Data:
`).join('')}  m_LocalAABB:
    m_Center: {x: 2, y: 2, z: 2}
    m_Extent: {x: 1, y: 1, z: 0}
  m_StreamData:
    offset: 0
    size: 0
    path:
`;
}

// Read GLB bytes independently of the implementation. All accessors are checked
// against both chunk and bufferView boundaries; tests use these decoded values.
function glb(buffer) {
    assert.ok(Buffer.isBuffer(buffer));
    assert.equal(buffer.readUInt32LE(0), 0x46546c67);
    assert.equal(buffer.readUInt32LE(4), 2);
    assert.equal(buffer.readUInt32LE(8), buffer.length);
    const jsonLength = buffer.readUInt32LE(12);
    assert.equal(jsonLength % 4, 0);
    assert.equal(buffer.readUInt32LE(16), 0x4e4f534a);
    const document = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8'));
    const binaryHeader = 20 + jsonLength;
    const binaryLength = buffer.readUInt32LE(binaryHeader);
    assert.equal(binaryLength % 4, 0);
    assert.equal(buffer.readUInt32LE(binaryHeader + 4), 0x004e4942);
    assert.equal(binaryHeader + 8 + binaryLength, buffer.length);
    const binary = buffer.subarray(binaryHeader + 8);
    assert.equal(document.buffers.length, 1);
    assert.ok(document.buffers[0].byteLength <= binaryLength);
    assert.ok(binaryLength - document.buffers[0].byteLength < 4);
    function accessor(index) {
        const a = document.accessors[index], view = document.bufferViews[a.bufferView];
        const dimension = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
        assert.ok(dimension);
        assert.ok(a.componentType === 5126 || a.componentType === 5125);
        assert.equal(view.buffer, 0);
        assert.equal(view.byteOffset % 4, 0);
        assert.equal(view.byteLength, a.count * dimension * 4);
        assert.ok(view.byteOffset + view.byteLength <= document.buffers[0].byteLength);
        const rows = [];
        for (let i = 0; i < a.count; i++) {
            rows.push(Array.from({ length: dimension }, (_, d) => {
                const offset = view.byteOffset + (i * dimension + d) * 4;
                const value = a.componentType === 5126 ? binary.readFloatLE(offset) : binary.readUInt32LE(offset);
                assert.ok(Number.isFinite(value));
                return value;
            }));
        }
        return dimension === 1 ? rows.flat() : rows;
    }
    document.accessors.forEach((_, index) => accessor(index));
    return { document, accessor, binary };
}

const approx = (actual, expected, tolerance = 1e-6) => {
    assert.equal(actual.length, expected.length);
    actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) <= tolerance, `${actual} != ${expected}`));
};
const sub = (a, b) => a.map((value, i) => value - b[i]);
const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = a => a.map(value => value / Math.hypot(...a));

test('decodes copied float32 attributes, two domains, both index widths and exact large fileID', () => {
    for (const indexFormat of [0, 1]) {
        const mesh = readUnityMesh(fixture({ indexFormat }));
        assert.equal(mesh.name, 'SyntheticRoof');
        assert.equal(mesh.rootMeshName, mesh.name);
        assert.equal(mesh.submeshCount, 2);
        assert.deepEqual(mesh.repairedTangentVertices, []);
        assert.deepEqual(mesh.submeshes.map(indices => Array.from(indices)), [[2, 0, 1], [0, 2, 3]]);
        for (const values of Object.values(mesh.attributes)) assert.ok(values instanceof Float32Array);
        for (const indices of mesh.submeshes) assert.ok(indices instanceof Uint32Array);
        approx(Array.from(mesh.attributes.POSITION), [1, 1, 2, 3, 1, 2, 3, 3, 2, 1, 3, 2]);
    }
    const fileID = '568364820087899322';
    assert.equal(readUnityMesh(fixture({ fileID, name: '"Roof \\u03bb"' }).replace(/\n/g, '\r\n'), fileID).name, 'Roof λ');
    assert.throws(() => readUnityMesh(fixture({ fileID })), /fileID/);
    assert.throws(() => readUnityMesh(fixture(), 4300000), /string.*fileID/);
});

test('baseVertex and firstVertex apply before bounds admission, including uint32 raw indices', () => {
    const submesh = { firstByte: 0, indexCount: 3, baseVertex: 1, firstVertex: 1, vertexCount: 3 };
    assert.deepEqual(Array.from(readUnityMesh(fixture({ indices: [0, 1, 2], submeshes: [submesh] })).submeshes[0]), [1, 2, 3]);
    const high = 0xfffffffc;
    const mesh = readUnityMesh(fixture({ indexFormat: 1, indices: [high, high + 1, high + 2], submeshes: [{ ...submesh, baseVertex: -high, firstVertex: 0 }] }));
    assert.deepEqual(Array.from(mesh.submeshes[0]), [0, 1, 2]);
});

test('rejects unsupported documents, versions, skinning, shapes, compression and external streams', () => {
    const text = fixture();
    for (const [from, to, message] of [
        ['--- !u!43', '--- !u!21', /document/],
        ['Mesh:\n', 'Material:\n', /body/],
        ['serializedVersion: 10', 'serializedVersion: 9', /version/],
        ['m_MeshCompression: 0', 'm_MeshCompression: 1', /Compressed/],
        ['m_BindPose: []', 'm_BindPose: [1]', /Skinned/],
        ['m_BonesAABB: []', 'm_BonesAABB: [1]', /Skinned/],
        ['    vertices: []', '    vertices: [1]', /blend shapes/],
        ['      m_NumItems: 0', '      m_NumItems: 1', /Compressed/],
        ['    size: 0', '    size: 16', /External/],
        ['    path:', '    path: vertices.resS', /External/],
    ]) {
        assert.ok(text.includes(from), `Missing mutation target: ${from}`);
        assert.throws(() => readUnityMesh(text.replace(from, to)), message, `${from} -> ${to}`);
    }
    assert.throws(() => readUnityMesh(text + '\n--- !u!43 &4300001\nMesh:\n'), /one Unity Mesh/);
    assert.throws(() => readUnityMesh(text + '\n---\nMesh:\n'), /one Unity Mesh/);
    assert.throws(() => readUnityMesh(text.replace('  m_Name:', '  m_Name: Duplicate\n  m_Name:')), /one Unity Mesh field/);
});

test('admits only the full expected float32 channel layout and exact vertex bytes', () => {
    const edits = [
        [c => { c[0][0] = 1; }, /single float32/],
        [c => { c[1][2] = 1; }, /single float32/],
        [c => { c[4][3] = 0; }, /missing Unity vertex/],
        [c => { c[3][3] = 4; }, /Unsupported or missing/],
        [c => { c[0][3] = 4; }, /attribute layout/],
        [c => { c[1][1] = 13; }, /attribute layout/],
        [c => { c[1][1] = 8; }, /Overlapping/],
    ];
    for (const [editChannels, message] of edits) assert.throws(() => readUnityMesh(fixture({ editChannels })), message);
    const text = fixture();
    for (const [from, to, message] of [
        ['    m_VertexCount: 4', '    m_VertexCount: 0', /vertex count/],
        ['    m_VertexCount: 4', '    m_VertexCount: 1000001', /vertex count/],
        ['    m_VertexCount: 4', '    m_VertexCount: 4.5', /integer/],
        ['    m_VertexCount: 4', '    m_VertexCount: 9007199254740993', /integer/],
        ['    m_DataSize: 192', '    m_DataSize: 188', /vertex byte count/],
        ['    _typelessdata: ', '    _typelessdata: gg', /hex buffer/],
        ['    _typelessdata: ', '    _typelessdata: f', /hex buffer/],
        ['    _typelessdata: ', '    _typelessdata: 00000000', /vertex byte count/],
        ['    m_DataSize:', '    unexpectedChannel: 3\n    m_DataSize:', /channel table/],
        ['    m_DataSize:', '    - stream: 0\n      offset: 0\n      format: 0\n      dimension: 0\n    m_DataSize:', /channel table/],
    ]) {
        assert.ok(text.includes(from), `Missing mutation target: ${from}`);
        assert.throws(() => readUnityMesh(text.replace(from, to)), message, from);
    }
});

test('rejects out-of-range, overlapping, incomplete and nontriangle index buffers', () => {
    const text = fixture();
    for (const [from, to, message] of [
        ['  m_IndexFormat: 0', '  m_IndexFormat: 2', /index format/],
        ['  m_IndexBuffer: ', '  m_IndexBuffer: gg', /hex buffer/],
        ['  m_IndexBuffer: ', '  m_IndexBuffer: ff', /Truncated/],
        ['    firstByte: 6', '    firstByte: 4', /Overlapping/],
        ['    firstByte: 6', '    firstByte: 7', /triangle range/],
        ['    firstByte: 6', '    firstByte: 8', /outside buffer/],
        ['    indexCount: 3', '    indexCount: 2', /triangle range/],
        ['    topology: 0', '    topology: 1', /Only triangle/],
        ['    vertexCount: 4', '    vertexCount: 2', /outside submesh vertices/],
        ['    baseVertex: 0', '    baseVertex: -1', /outside submesh vertices/],
        ['    firstVertex: 0', '    firstVertex: 1', /outside buffer/],
        ['    indexCount: 3', '    indexCount: 9007199254740993', /integer/],
    ]) {
        assert.ok(text.includes(from), `Missing mutation target: ${from}`);
        assert.throws(() => readUnityMesh(text.replace(from, to)), message, `${from} -> ${to}`);
    }
    assert.throws(() => readUnityMesh(fixture({ indices: [2, 0, 9, 0, 2, 3] })), /outside submesh vertices/);
    assert.throws(() => readUnityMesh(fixture({ indices: [2, 0, 1, 0, 2, 3, 0, 1, 2] })), /Unclaimed/);
});

test('reports only six undefined tangent repairs, preserves valid data and stable perpendicular basis', () => {
    const positions = Array.from({ length: 8 }, (_, i) => [i, i % 3, 2]);
    const normals = positions.map(() => [1, 2, 3]);
    const tangents = positions.map((_, i) => i < 6 ? [NaN, NaN, NaN, i % 2 ? -1 : 1] : [0.25, 0.5, 0.75, -1]);
    const mesh = readUnityMesh(fixture({ positions, normals, tangents }));
    assert.deepEqual(mesh.repairedTangentVertices, [0, 1, 2, 3, 4, 5]);
    for (const i of mesh.repairedTangentVertices) {
        const tangent = Array.from(mesh.attributes.TANGENT.subarray(i * 4, i * 4 + 4));
        assert.ok(Math.abs(dot(tangent.slice(0, 3), normals[i])) < 1e-6);
        assert.ok(Math.abs(Math.hypot(...tangent.slice(0, 3)) - 1) < 1e-6);
        approx(tangent.slice(0, 3), [13 / Math.sqrt(182), -2 / Math.sqrt(182), -3 / Math.sqrt(182)]);
        assert.equal(tangent[3], tangents[i][3]);
    }
    assert.deepEqual(Array.from(mesh.attributes.TANGENT.subarray(24)), [0.25, 0.5, 0.75, -1, 0.25, 0.5, 0.75, -1]);
    glb(encodeGlb(mesh)); // no remaining NaNs can leak into the emitted GLB
    const tie = readUnityMesh(fixture({ tangents: [[NaN, NaN, NaN, 1], ...Array.from({ length: 3 }, () => [1, 0, 0, 1])] }));
    approx(Array.from(tie.attributes.TANGENT.subarray(0, 3)), [1, 0, 0]);
});

test('does not repair partial NaNs, infinities, bad handedness or bad source normals', () => {
    for (const tangent of [[NaN, 0, NaN, 1], [Infinity, 0, 0, 1], [NaN, NaN, NaN, NaN], [NaN, NaN, NaN, 0]]) {
        assert.throws(() => readUnityMesh(fixture({ tangents: [tangent, ...Array.from({ length: 3 }, () => [1, 0, 0, 1])] })), /tangent/);
    }
    const tangents = Array.from({ length: 4 }, () => [NaN, NaN, NaN, 1]);
    assert.throws(() => readUnityMesh(fixture({ tangents, normals: Array.from({ length: 4 }, () => [0, 0, 0]) })), /zero normal/);
    assert.throws(() => readUnityMesh(fixture({ normals: Array.from({ length: 4 }, () => [NaN, 0, 1]) })), /Non-finite/);
    assert.throws(() => readUnityMesh(fixture({ positions: [[Infinity, 0, 0], [1, 1, 1], [2, 2, 2], [3, 3, 3]] })), /Non-finite/);
    assert.throws(() => readUnityMesh(fixture({ uv: [[0, Infinity], [0, 0], [1, 1], [1, 0]] })), /Non-finite/);
});

test('GLB retains unique named material domains, source vertex order, winding and bounds without mutation', () => {
    const mesh = readUnityMesh(fixture({ name: '"Roof λ"' }));
    const before = structuredClone(mesh);
    const bytes = encodeGlb(mesh), { document, accessor } = glb(bytes);
    assert.deepEqual(mesh, before);
    assert.deepEqual(encodeGlb(mesh), bytes);
    assert.deepEqual(document.meshes.map(m => m.name), ['Roof λ_0', 'Roof λ_1']);
    assert.deepEqual(document.nodes, [{ name: 'Roof λ_0', mesh: 0 }, { name: 'Roof λ_1', mesh: 1 }]);
    assert.deepEqual(document.materials, [{ name: 'UnityMaterial_0' }, { name: 'UnityMaterial_1' }]);
    assert.deepEqual(document.scenes[0].nodes, [0, 1]);
    const first = document.meshes[0].primitives[0], second = document.meshes[1].primitives[0];
    assert.equal(first.mode, 4); assert.equal(first.material, 0); assert.equal(second.material, 1);
    assert.deepEqual(accessor(first.indices), [2, 1, 0]);
    assert.deepEqual(accessor(second.indices), [0, 2, 1]);
    assert.deepEqual(accessor(first.attributes.POSITION), [[-1, 1, 2], [-3, 1, 2], [-3, 3, 2]]);
    assert.deepEqual(document.accessors[first.attributes.POSITION].min, [-3, 1, 2]);
    assert.deepEqual(document.accessors[first.attributes.POSITION].max, [-1, 3, 2]);
    assert.equal(accessor(second.attributes.POSITION).length, 3); // omits vertex 1 owned only by slot 0
});

test('independent triangle/UV derivatives agree with encoded normals and tangent handedness', () => {
    for (const reverseV of [false, true]) {
        const mesh = readUnityMesh(fixture({ reverseV }));
        const { document, accessor } = glb(encodeGlb(mesh));
        for (const domain of document.meshes) {
            const primitive = domain.primitives[0], ids = accessor(primitive.indices);
            const positions = accessor(primitive.attributes.POSITION), uv = accessor(primitive.attributes.TEXCOORD_0);
            const normals = accessor(primitive.attributes.NORMAL), tangents = accessor(primitive.attributes.TANGENT);
            const [a, b, c] = ids, e1 = sub(positions[b], positions[a]), e2 = sub(positions[c], positions[a]);
            const q1 = sub(uv[b], uv[a]), q2 = sub(uv[c], uv[a]);
            const determinant = q1[0] * q2[1] - q1[1] * q2[0];
            assert.notEqual(determinant, 0);
            const dPdu = e1.map((value, i) => (value * q2[1] - e2[i] * q1[1]) / determinant);
            const dPdv = e1.map((value, i) => (e2[i] * q1[0] - value * q2[0]) / determinant);
            approx(unit(cross(e1, e2)), normals[a]);
            approx(unit(dPdu), tangents[a].slice(0, 3));
            approx(unit(dPdv), cross(normals[a], tangents[a].slice(0, 3)).map(value => value * tangents[a][3]));
            assert.equal(tangents[a][3], reverseV ? -1 : 1);
            // Independently emulate the engine's default MirrorX + UV flip:
            // restored winding and vertex values equal the original Unity data.
            const selected = [...new Set(mesh.submeshes[primitive.material])].sort((x, y) => x - y);
            positions.forEach((p, i) => approx([-p[0], p[1], p[2]], Array.from(mesh.attributes.POSITION.subarray(selected[i] * 3, selected[i] * 3 + 3))));
            uv.forEach((value, i) => approx([value[0], 1 - value[1]], Array.from(mesh.attributes.TEXCOORD_0.subarray(selected[i] * 2, selected[i] * 2 + 2))));
            assert.deepEqual([ids[0], ids[2], ids[1]].map(index => selected[index]), Array.from(mesh.submeshes[primitive.material]));
        }
    }
});

test('public encoder rejects missing/nonfinite attributes and invalid triangle domains', () => {
    const missing = readUnityMesh(fixture()); delete missing.attributes.NORMAL;
    assert.throws(() => encodeGlb(missing), /attributes/);
    const bad = readUnityMesh(fixture()); bad.attributes.TANGENT[0] = NaN;
    assert.throws(() => encodeGlb(bad), /attribute: TANGENT/);
    const handedness = readUnityMesh(fixture()); handedness.attributes.TANGENT[3] = 0;
    assert.throws(() => encodeGlb(handedness), /tangent handedness/);
    const indices = readUnityMesh(fixture()); indices.submeshes[0][0] = 100;
    assert.throws(() => encodeGlb(indices), /triangle indices/);
    assert.throws(() => encodeGlb(null), /Invalid static mesh/);
});
