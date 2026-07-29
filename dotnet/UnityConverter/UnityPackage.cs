using System.Buffers.Binary;
using System.IO.Compression;
using System.Text;
using System.Text.RegularExpressions;

namespace GameEngine.UnityConverter;

/// Minimal .unitypackage reader — port of unitypackage.js. Gunzips the ustar
/// archive in memory and indexes/extracts only <guid>/{pathname,asset[.meta]}.
internal static class UnityPackage
{
    public sealed class IndexEntry
    {
        public string? AssetPath;
        public long AssetSize;
    }

    private static readonly Regex kPackageExtRe = new(@"\.(unitypackage|tgz|tar\.gz)$",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex kIndexEntryRe = new(@"^([^/]+)/(pathname|asset)$", RegexOptions.Compiled);
    private static readonly Regex kExtractEntryRe = new(@"^([^/]+)/(pathname|asset|asset\.meta)$", RegexOptions.Compiled);
    private static readonly Regex kPaxRecordRe = new("[0-9]+ ([^=]+)=([^\n]*)\n", RegexOptions.Compiled);

    public static bool IsUnityPackageFile(string p)
    {
        try
        {
            if (!File.Exists(p)) return false;
        }
        catch
        {
            return false;
        }
        return kPackageExtRe.IsMatch(p);
    }

    // Iterate tar entries. Handles ustar name+prefix, GNU 'L' longnames and
    // pax 'x'/'g' path overrides.
    public static void WalkTar(byte[] buf, Action<string, byte[]> onEntry)
    {
        long off = 0;
        string? pendingLongName = null;
        string? pendingPaxPath = null;
        while (off + 512 <= buf.Length)
        {
            var header = buf.AsSpan((int)off, 512);
            bool allZero = true;
            foreach (byte b in header)
                if (b != 0) { allZero = false; break; }
            if (allZero) break;

            var sizeChars = new StringBuilder();
            for (int i = 124; i < 136; i++)
            {
                char c = (char)header[i];
                if (c >= '0' && c <= '7') sizeChars.Append(c);
            }
            string sizeField = sizeChars.ToString();
            long size = sizeField.Length > 0 ? (long)Js.ParseInt(sizeField, 8) : 0;
            char type = (char)(header[156] != 0 ? header[156] : (byte)48);
            long bodyStart = off + 512;
            byte[] body = new byte[Math.Max(0, Math.Min(size, buf.Length - bodyStart))];
            if (body.Length > 0) Array.Copy(buf, bodyStart, body, 0, body.Length);
            off += 512 + (size + 511) / 512 * 512;

            if (type == 'L')
            {
                pendingLongName = Encoding.UTF8.GetString(body).TrimEnd('\0');
                continue;
            }
            if (type == 'x' || type == 'g')
            {
                foreach (Match m in kPaxRecordRe.Matches(Encoding.UTF8.GetString(body)))
                    if (m.Groups[1].Value == "path") pendingPaxPath = m.Groups[2].Value;
                continue;
            }
            if (type != '0' && type != '\0')
            {
                pendingLongName = pendingPaxPath = null;
                continue;
            }

            string name = NulTerminated(header[..100]);
            if (Encoding.ASCII.GetString(header.Slice(257, 5)) == "ustar")
            {
                string prefix = NulTerminated(header.Slice(345, 155));
                if (prefix.Length > 0) name = prefix + "/" + name;
            }
            if (pendingLongName != null) { name = pendingLongName; pendingLongName = null; }
            if (pendingPaxPath != null) { name = pendingPaxPath; pendingPaxPath = null; }
            if (name.StartsWith("./", StringComparison.Ordinal)) name = name[2..];
            onEntry(name, body);
        }
    }

    private static string NulTerminated(ReadOnlySpan<byte> span)
    {
        int nul = span.IndexOf((byte)0);
        return Encoding.UTF8.GetString(nul >= 0 ? span[..nul] : span);
    }

    public static byte[] GunzipPackage(string file)
    {
        try
        {
            using var input = new MemoryStream(File.ReadAllBytes(file));
            using var gz = new GZipStream(input, CompressionMode.Decompress);
            using var output = new MemoryStream();
            gz.CopyTo(output);
            return output.ToArray();
        }
        catch (Exception e)
        {
            throw new InvalidOperationException(
                $"cannot read {file} as a .unitypackage (gzipped tar): {e.Message}"
                + " — for very large packs, pre-extract with tar -xzf and pass the directory");
        }
    }

    // Index without extraction: guid -> { assetPath, assetSize }. Preserves
    // first-seen (tar walk) order like the JS Map.
    public static (List<string> Order, Dictionary<string, IndexEntry> ByGuid) IndexUnityPackage(string file)
    {
        var order = new List<string>();
        var byGuid = new Dictionary<string, IndexEntry>();
        IndexEntry Rec(string guid)
        {
            if (!byGuid.TryGetValue(guid, out IndexEntry? e))
            {
                e = new IndexEntry();
                byGuid[guid] = e;
                order.Add(guid);
            }
            return e;
        }
        WalkTar(GunzipPackage(file), (name, body) =>
        {
            Match m = kIndexEntryRe.Match(name);
            if (!m.Success) return;
            string guid = m.Groups[1].Value.ToLowerInvariant();
            if (m.Groups[2].Value == "pathname")
                Rec(guid).AssetPath = Encoding.UTF8.GetString(body).Split('\n')[0].Trim();
            else
                Rec(guid).AssetSize = body.Length;
        });
        var kept = new List<string>();
        foreach (string guid in order)
        {
            if (byGuid[guid].AssetPath == null) byGuid.Remove(guid);
            else kept.Add(guid);
        }
        return (kept, byGuid);
    }

    // Extract to the <guid>/{pathname,asset,asset.meta} layout.
    public static string ExtractUnityPackage(string file, string destDir)
    {
        Directory.CreateDirectory(destDir);
        string rootFull = Path.GetFullPath(destDir);
        if (!rootFull.EndsWith(Path.DirectorySeparatorChar)) rootFull += Path.DirectorySeparatorChar;
        WalkTar(GunzipPackage(file), (name, body) =>
        {
            Match m = kExtractEntryRe.Match(name);
            if (!m.Success) return;
            string dir = Js.PathJoin(destDir, m.Groups[1].Value.ToLowerInvariant());
            // Entry names come from the archive; a guid dir has no legitimate
            // way to resolve outside destDir.
            if (!(Path.GetFullPath(dir) + Path.DirectorySeparatorChar).StartsWith(rootFull, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException($"unitypackage entry escapes extraction dir: {name}");
            Directory.CreateDirectory(dir);
            File.WriteAllBytes(Js.PathJoin(dir, m.Groups[2].Value), body);
        });
        return destDir;
    }
}
