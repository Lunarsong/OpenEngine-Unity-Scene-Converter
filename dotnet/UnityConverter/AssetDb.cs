using System.Text.Json;

namespace GameEngine.UnityConverter;

/// AssetDatabase.assetdb JSONL journal reader — port of loadAssetDb().
/// Upserts {guid,path,type}, deletes {guid,deleted:true}, redirects
/// {redirect_from, redirect_to}; last write wins. Builds the model/texture
/// stem indices mesh/texture resolution use.
internal sealed class AssetDb
{
    public sealed class Entry
    {
        public required string Path;
        public required string Type;
    }

    public readonly Dictionary<string, Entry> ByGuid = [];
    public readonly List<string> GuidOrder = [];
    private readonly Dictionary<string, string> m_Redirects = [];
    public readonly Dictionary<string, List<AssetRef>> ByStem = [];
    public readonly Dictionary<string, List<AssetRef>> TexByStem = [];
    public readonly Dictionary<string, List<AssetRef>> TexByNormStem = [];

    private static readonly HashSet<string> kModelExts = [".fbx", ".gltf", ".glb", ".obj"];
    private static readonly HashSet<string> kTexExts =
        [".tga", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".psd", ".exr", ".bmp"];

    public static AssetDb Load(string file)
    {
        var db = new AssetDb();
        foreach (string raw in Js.ReadFileUtf8(file).Split('\n'))
        {
            string line = raw.Trim();
            if (line.Length == 0 || line.StartsWith('#')) continue;
            JsonDocument doc;
            try
            {
                doc = JsonDocument.Parse(line);
            }
            catch
            {
                continue;
            }
            using (doc)
            {
                if (doc.RootElement.ValueKind != JsonValueKind.Object) continue;
                JsonElement root = doc.RootElement;
                if (root.TryGetProperty("format", out JsonElement fmt) && Truthy(fmt)) continue;
                if (root.TryGetProperty("redirect_from", out JsonElement rf))
                {
                    string? from = rf.ValueKind == JsonValueKind.String ? rf.GetString() : null;
                    bool hasTo = root.TryGetProperty("redirect_to", out JsonElement rt)
                        && rt.ValueKind == JsonValueKind.String && Truthy(rt);
                    if (from == null) continue;
                    if (hasTo) db.m_Redirects[from] = rt.GetString()!;
                    else db.m_Redirects.Remove(from);
                    continue;
                }
                if (!root.TryGetProperty("guid", out JsonElement g) || !Truthy(g)) continue;
                string guid = g.GetString() ?? "";
                if (root.TryGetProperty("deleted", out JsonElement del) && Truthy(del))
                {
                    if (db.ByGuid.Remove(guid)) db.GuidOrder.Remove(guid);
                    continue;
                }
                string path = root.TryGetProperty("path", out JsonElement p) && p.ValueKind == JsonValueKind.String
                    ? p.GetString() ?? "" : "";
                string type = root.TryGetProperty("type", out JsonElement t) && t.ValueKind == JsonValueKind.String
                    && Truthy(t) ? t.GetString()! : "Unknown";
                if (!db.ByGuid.ContainsKey(guid)) db.GuidOrder.Add(guid);
                db.ByGuid[guid] = new Entry { Path = path, Type = type };
            }
        }
        db.BuildIndices();
        return db;
    }

    private static bool Truthy(JsonElement e) => e.ValueKind switch
    {
        JsonValueKind.String => e.GetString()!.Length > 0,
        JsonValueKind.Number => e.GetDouble() != 0,
        JsonValueKind.True => true,
        _ => false,
    };

    public string ResolveGuid(string g)
    {
        var seen = new HashSet<string>();
        while (m_Redirects.ContainsKey(g) && !seen.Contains(g))
        {
            seen.Add(g);
            g = m_Redirects[g];
        }
        return g;
    }

    private void BuildIndices()
    {
        foreach (string guid in GuidOrder)
        {
            Entry rec = ByGuid[guid];
            string ext = Js.PathExtname(rec.Path).ToLowerInvariant();
            string stem = Js.PathBasename(rec.Path, Js.PathExtname(rec.Path)).ToLowerInvariant();
            if (kModelExts.Contains(ext))
            {
                if (!ByStem.TryGetValue(stem, out List<AssetRef>? list))
                    ByStem[stem] = list = [];
                list.Add(new AssetRef { Guid = ResolveGuid(guid), Path = rec.Path });
            }
            else if (kTexExts.Contains(ext))
            {
                var entry = new AssetRef { Guid = ResolveGuid(guid), Path = rec.Path };
                if (!TexByStem.TryGetValue(stem, out List<AssetRef>? list))
                    TexByStem[stem] = list = [];
                list.Add(entry);
                string norm = NormalizeStem(stem);
                if (!TexByNormStem.TryGetValue(norm, out List<AssetRef>? nlist))
                    TexByNormStem[norm] = nlist = [];
                nlist.Add(entry);
            }
        }
    }

    public static string NormalizeStem(string stem)
    {
        var sb = new System.Text.StringBuilder(stem.Length);
        foreach (char c in stem)
            if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) sb.Append(c);
        return sb.ToString();
    }
}
