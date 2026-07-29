using System.Buffers.Binary;
using System.Text;
using System.Text.RegularExpressions;

namespace GameEngine.UnityConverter;

/// Binary-FBX node-table scanner — port of the convert.js multi-node prop
/// recovery. Reads the Objects/Connections/GlobalSettings node table (never
/// the geometry payloads) and returns the mesh-bearing nodes with their rest
/// model-frame offsets. Returns null for ASCII/single-mesh/unreadable FBX.
internal static class FbxScanner
{
    public const double kFbxCmToMeters = 0.01;
    public static readonly Regex kFbxAuxNodeRe = new(
        @"(_LOD[0-9]+$|^UCX_|^UBX_|^USP_|^UCP_|_?collider$|_?collision$)",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    public sealed class MeshNode
    {
        public required string Id;
        public required string Name;
        public string? Parent;
        public double[] Offset = [0, 0, 0];
    }

    private sealed class FbxNode
    {
        public required string Name;
        public List<object?> Props = [];
        public List<FbxNode> Children = [];
        public long End;
    }

    private sealed class ParsedFbx
    {
        public uint Version;
        public List<FbxNode> Roots = [];
    }

    private const int kMaxNodeDepth = 256;

    private static ParsedFbx? ParseFbxBinary(byte[] buf)
    {
        if (buf.Length < 27) return null;
        if (Encoding.Latin1.GetString(buf, 0, 20) != "Kaydara FBX Binary  ") return null;
        uint version = BinaryPrimitives.ReadUInt32LittleEndian(buf.AsSpan(23, 4));
        bool big = version >= 7500;
        int nullLen = big ? 25 : 13;

        FbxNode? ReadNode(long off, int depth)
        {
            // JS survives hostile nesting via a caught RangeError; .NET stack
            // overflow is uncatchable, so cap explicitly (legit FBX stays <64).
            if (depth > kMaxNodeDepth) throw new InvalidDataException("FBX node nesting exceeds depth cap");
            long endOffset = big
                ? (long)BinaryPrimitives.ReadUInt64LittleEndian(buf.AsSpan((int)off, 8))
                : BinaryPrimitives.ReadUInt32LittleEndian(buf.AsSpan((int)off, 4));
            long numProps = big
                ? (long)BinaryPrimitives.ReadUInt64LittleEndian(buf.AsSpan((int)(off + 8), 8))
                : BinaryPrimitives.ReadUInt32LittleEndian(buf.AsSpan((int)(off + 4), 4));
            byte nameLen = buf[big ? (int)(off + 24) : (int)(off + 12)];
            long p = big ? off + 25 : off + 13;
            string name = Encoding.Latin1.GetString(buf, (int)p, nameLen);
            p += nameLen;
            if (endOffset == 0) return null;
            var props = new List<object?>();
            long q = p;
            for (long i = 0; i < numProps; i++)
            {
                char t = (char)buf[(int)q];
                q += 1;
                switch (t)
                {
                    case 'Y':
                        props.Add((double)BinaryPrimitives.ReadInt16LittleEndian(buf.AsSpan((int)q, 2)));
                        q += 2;
                        break;
                    case 'C':
                        props.Add(buf[(int)q] != 0);
                        q += 1;
                        break;
                    case 'I':
                        props.Add((double)BinaryPrimitives.ReadInt32LittleEndian(buf.AsSpan((int)q, 4)));
                        q += 4;
                        break;
                    case 'F':
                        props.Add((double)BinaryPrimitives.ReadSingleLittleEndian(buf.AsSpan((int)q, 4)));
                        q += 4;
                        break;
                    case 'D':
                        props.Add(BinaryPrimitives.ReadDoubleLittleEndian(buf.AsSpan((int)q, 8)));
                        q += 8;
                        break;
                    case 'L':
                        props.Add(BinaryPrimitives.ReadInt64LittleEndian(buf.AsSpan((int)q, 8)));
                        q += 8;
                        break;
                    case 'S':
                    case 'R':
                    {
                        uint n = BinaryPrimitives.ReadUInt32LittleEndian(buf.AsSpan((int)q, 4));
                        q += 4;
                        props.Add(t == 'S' ? Encoding.Latin1.GetString(buf, (int)q, (int)n) : null);
                        q += n;
                        break;
                    }
                    case 'f':
                    case 'd':
                    case 'l':
                    case 'i':
                    case 'b':
                    {
                        uint n = BinaryPrimitives.ReadUInt32LittleEndian(buf.AsSpan((int)q, 4));
                        uint enc = BinaryPrimitives.ReadUInt32LittleEndian(buf.AsSpan((int)(q + 4), 4));
                        uint clen = BinaryPrimitives.ReadUInt32LittleEndian(buf.AsSpan((int)(q + 8), 4));
                        q += 12;
                        props.Add(null);
                        int elem = t switch { 'f' => 4, 'd' => 8, 'l' => 8, 'i' => 4, 'b' => 1, _ => 0 };
                        q += enc == 1 ? clen : n * (uint)elem;
                        break;
                    }
                    default:
                        return null;
                }
            }
            var children = new List<FbxNode>();
            long pp = q;
            while (pp < endOffset - nullLen + 1 && pp < endOffset)
            {
                FbxNode? c = ReadNode(pp, depth + 1);
                if (c == null) { pp += nullLen; break; }
                children.Add(c);
                pp = c.End;
            }
            return new FbxNode { Name = name, Props = props, Children = children, End = endOffset };
        }

        var roots = new List<FbxNode>();
        long offTop = 27;
        while (offTop < buf.Length)
        {
            FbxNode? n = ReadNode(offTop, 0);
            if (n == null) break;
            roots.Add(n);
            offTop = n.End;
            bool allFound = true;
            foreach (string k in (string[])["Objects", "Connections", "GlobalSettings"])
                if (!roots.Any(r => r.Name == k)) { allFound = false; break; }
            if (allFound) break;
        }
        return new ParsedFbx { Version = version, Roots = roots };
    }

    private sealed class Model
    {
        public required string Id;
        public required string Name;
        public double[] LclT = [0, 0, 0];
        public double[] Pivot = [0, 0, 0];
        public string? Parent;
        public bool Mesh;
        public double[]? Offset;
    }

    public static List<MeshNode>? ScanFbxMeshNodes(string file)
    {
        ParsedFbx? fbx;
        try
        {
            fbx = ParseFbxBinary(File.ReadAllBytes(file));
        }
        catch
        {
            return null;
        }
        if (fbx == null) return null;
        FbxNode? objects = fbx.Roots.FirstOrDefault(r => r.Name == "Objects");
        FbxNode? conns = fbx.Roots.FirstOrDefault(r => r.Name == "Connections");
        FbxNode? gs = fbx.Roots.FirstOrDefault(r => r.Name == "GlobalSettings");
        if (objects == null) return null;

        double unitScaleFactor = 1;
        if (gs != null)
        {
            FbxNode? p70 = gs.Children.FirstOrDefault(c => c.Name == "Properties70");
            if (p70 != null)
                foreach (FbxNode p in p70.Children)
                    if (p.Props.Count > 4 && (p.Props[0] as string) == "UnitScaleFactor" && p.Props[4] is double d)
                        unitScaleFactor = d;
        }
        double cm = unitScaleFactor / 100;
        if (cm == 0) cm = kFbxCmToMeters; // JS `|| kFbxCmToMeters` falsy-0 fallback

        double[] Vec3(FbxNode? p70, string key)
        {
            if (p70 == null) return [0, 0, 0];
            FbxNode? p = p70.Children.FirstOrDefault(c => c.Props.Count > 0 && (c.Props[0] as string) == key);
            if (p == null) return [0, 0, 0];
            double At(int i) => p.Props.Count > i && p.Props[i] is double d ? d : 0;
            return [At(4), At(5), At(6)];
        }

        var models = new Dictionary<string, Model>();
        var modelOrder = new List<string>();
        var geometryIds = new HashSet<string>();
        bool hasNamedGeometry = false;
        foreach (FbxNode o in objects.Children)
        {
            string id = o.Props.Count > 0 ? PropIdString(o.Props[0]) : "undefined";
            if (o.Name == "Geometry")
            {
                geometryIds.Add(id);
                string geoName = o.Props.Count > 1 ? Js.ToJsString(o.Props[1] ?? "") : "";
                if (geoName.Split('\0')[0].Length > 0) hasNamedGeometry = true;
                continue;
            }
            if (o.Name != "Model") continue;
            FbxNode? p70 = o.Children.FirstOrDefault(c => c.Name == "Properties70");
            var model = new Model
            {
                Id = id,
                Name = (o.Props.Count > 1 ? Js.ToJsString(o.Props[1] ?? "") : "").Split('\0')[0],
                LclT = Vec3(p70, "Lcl Translation"),
                Pivot = Vec3(p70, "RotationPivot"),
            };
            if (!models.ContainsKey(id)) modelOrder.Add(id);
            models[id] = model;
        }
        if (conns != null)
        {
            foreach (FbxNode c in conns.Children)
            {
                if (c.Name != "C" || c.Props.Count < 3 || (c.Props[0] as string) != "OO") continue;
                string child = PropIdString(c.Props[1]);
                string parent = PropIdString(c.Props[2]);
                if (models.ContainsKey(child) && models.ContainsKey(parent)) models[child].Parent = parent;
                if (geometryIds.Contains(child) && models.ContainsKey(parent)) models[parent].Mesh = true;
            }
        }
        if (models.Count <= 1 || hasNamedGeometry) return null;

        var accCache = new Dictionary<string, double[]>();
        double[] AccLclT(string id)
        {
            if (accCache.TryGetValue(id, out double[]? cached)) return cached;
            Model m = models[id];
            double[] par = m.Parent != null ? AccLclT(m.Parent) : [0, 0, 0];
            double[] v = [par[0] + m.LclT[0], par[1] + m.LclT[1], par[2] + m.LclT[2]];
            accCache[id] = v;
            return v;
        }
        var result = new List<MeshNode>();
        foreach (string id in modelOrder)
        {
            Model m = models[id];
            if (!m.Mesh) continue;
            double[] a = AccLclT(m.Id);
            m.Offset = [(a[0] + m.Pivot[0]) * cm, (a[1] + m.Pivot[1]) * cm, (a[2] + m.Pivot[2]) * cm];
            result.Add(new MeshNode { Id = m.Id, Name = m.Name, Parent = m.Parent, Offset = m.Offset });
        }
        return result;
    }

    // JS: `typeof p === 'bigint' ? p.toString() : String(p)` — L props are
    // long here, numeric props are double.
    private static string PropIdString(object? p) => p switch
    {
        long l => l.ToString(System.Globalization.CultureInfo.InvariantCulture),
        _ => Js.ToJsString(p),
    };
}
