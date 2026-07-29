using System.Text.RegularExpressions;

namespace GameEngine.UnityConverter;

/// Insertion-ordered map mirroring a JS object built by the YAML parser
/// (string keys, values: string | YamlMap | YamlList | null). Setting an
/// existing key overwrites in place, preserving its original position —
/// the JS object semantics emission order depends on.
internal sealed class YamlMap
{
    private readonly List<string> m_Keys = [];
    private readonly Dictionary<string, object?> m_Values = [];

    public IReadOnlyList<string> Keys => m_Keys;

    public object? this[string key]
    {
        get => m_Values.GetValueOrDefault(key);
        set
        {
            if (!m_Values.ContainsKey(key)) m_Keys.Add(key);
            m_Values[key] = value;
        }
    }

    public bool Has(string key) => m_Values.ContainsKey(key);

    // Convenience for the `a && a.b` chains in the reference.
    public string? Str(string key) => this[key] as string;
    public YamlMap? Map(string key) => this[key] as YamlMap;
    public YamlList? List(string key) => this[key] as YamlList;
}

internal sealed class YamlList : List<object?>;

internal sealed class UnityYamlDoc
{
    public required string ClassId;
    public required string Anchor;
    public bool Stripped;
    public string? Type;
    public YamlMap? Data;
}

/// Minimal Unity-YAML subset parser — line-faithful port of unityyaml.js.
/// fileIDs routinely exceed 2^53, so every anchor, fileID and guid stays a
/// STRING; nothing here is ever parsed to a number.
internal static class UnityYaml
{
    private static readonly Regex kDocRe = new(@"^--- !u!([0-9]+) &(-?[0-9]+)( stripped)?\s*$", RegexOptions.Compiled);
    private static readonly Regex kSeqItemMapRe = new(@"^([A-Za-z_][A-Za-z0-9_ .\-\[\]$]*?):(?: (.*))?$", RegexOptions.Compiled);
    private static readonly Regex kMapKeyRe = new(@"^(\S[^:]*?):(?: (.*))?$", RegexOptions.Compiled);
    private static readonly Regex kHeadRe = new(@"^([A-Za-z_][A-Za-z0-9_]*):\s*$", RegexOptions.Compiled);

    private static string Unquote(string s)
    {
        if (s.Length >= 2 && s[0] == '\'' && s[^1] == '\'')
            return s[1..^1].Replace("''", "'");
        if (s.Length >= 2 && s[0] == '"' && s[^1] == '"')
        {
            string? parsed = TryParseJsonString(s);
            return parsed ?? s[1..^1];
        }
        return s;
    }

    // JSON.parse of a double-quoted scalar; null on malformed input.
    private static string? TryParseJsonString(string s)
    {
        var sb = new System.Text.StringBuilder();
        int i = 1;
        while (i < s.Length - 1)
        {
            char c = s[i];
            if (c == '"') return null; // unescaped quote before the end
            if (c == '\\')
            {
                if (i + 1 >= s.Length - 1) return null;
                char e = s[++i];
                switch (e)
                {
                    case '"': sb.Append('"'); break;
                    case '\\': sb.Append('\\'); break;
                    case '/': sb.Append('/'); break;
                    case 'b': sb.Append('\b'); break;
                    case 'f': sb.Append('\f'); break;
                    case 'n': sb.Append('\n'); break;
                    case 'r': sb.Append('\r'); break;
                    case 't': sb.Append('\t'); break;
                    case 'u':
                        if (i + 4 >= s.Length - 1 + 1) return null;
                        string hex = s.Substring(i + 1, 4);
                        if (!int.TryParse(hex, System.Globalization.NumberStyles.HexNumber, null, out int cp)) return null;
                        sb.Append((char)cp);
                        i += 4;
                        break;
                    default: return null;
                }
                i++;
            }
            else if (c < 0x20)
            {
                return null; // raw control char is invalid JSON
            }
            else
            {
                sb.Append(c);
                i++;
            }
        }
        return sb.ToString();
    }

    // Parse an inline flow value: {k: v, ...} or [a, b] or scalar.
    public static object? ParseFlow(string s)
    {
        s = s.Trim();
        if (s.StartsWith('{'))
        {
            string inner = s[1..(s.EndsWith('}') ? ^1 : ^0)].Trim();
            var obj = new YamlMap();
            foreach (string part in SplitTop(inner))
            {
                int ci = part.IndexOf(':');
                if (ci < 0) continue;
                obj[part[..ci].Trim()] = ParseFlow(part[(ci + 1)..].Trim());
            }
            return obj;
        }
        if (s.StartsWith('['))
        {
            string inner = s[1..(s.EndsWith(']') ? ^1 : ^0)].Trim();
            var list = new YamlList();
            if (inner != "")
                foreach (string p in SplitTop(inner)) list.Add(ParseFlow(p.Trim()));
            return list;
        }
        return Unquote(s);
    }

    // Split on top-level commas (depth-aware for nested {}/[] and quotes).
    private static List<string> SplitTop(string s)
    {
        var outParts = new List<string>();
        int depth = 0, start = 0;
        char q = '\0';
        for (int i = 0; i < s.Length; i++)
        {
            char c = s[i];
            if (q != '\0')
            {
                if (c == q && (i == 0 || s[i - 1] != '\\')) q = '\0';
                continue;
            }
            if (c == '\'' || c == '"') q = c;
            else if (c == '{' || c == '[') depth++;
            else if (c == '}' || c == ']') depth--;
            else if (c == ',' && depth == 0) { outParts.Add(s[start..i]); start = i + 1; }
        }
        if (start < s.Length) outParts.Add(s[start..]);
        return outParts;
    }

    private static int IndentOf(string line)
    {
        int i = 0;
        while (i < line.Length && line[i] == ' ') i++;
        return i;
    }

    private readonly record struct ParseResult(object? Value, int Next);

    private static ParseResult ParseBlock(IReadOnlyList<string> lines, int from, int to, int indent)
    {
        if (from >= to) return new ParseResult(null, from);
        string firstTrim = lines[from][IndentOf(lines[from])..];
        if (IndentOf(lines[from]) == indent && firstTrim.StartsWith("- ", StringComparison.Ordinal))
            return ParseSequence(lines, from, to, indent);
        return ParseMapping(lines, from, to, indent);
    }

    private static ParseResult ParseSequence(IReadOnlyList<string> lines, int from, int to, int indent)
    {
        var arr = new YamlList();
        int i = from;
        while (i < to)
        {
            string line = lines[i];
            int ind = IndentOf(line);
            if (ind != indent || !line[ind..].StartsWith("- ", StringComparison.Ordinal)) break;
            string rest = line[(ind + 2)..];
            Match mapMatch = kSeqItemMapRe.Match(rest);
            if (mapMatch.Success && !rest.StartsWith('{') && !rest.StartsWith('['))
            {
                int j = i + 1;
                while (j < to)
                {
                    int jInd = IndentOf(lines[j]);
                    if (jInd <= indent) break;
                    j++;
                }
                var virtualLines = new List<string> { new string(' ', indent + 2) + rest };
                for (int k = i + 1; k < j; k++) virtualLines.Add(lines[k]);
                ParseResult r = ParseMapping(virtualLines, 0, virtualLines.Count, indent + 2);
                arr.Add(r.Value);
                i = j;
            }
            else
            {
                arr.Add(ParseFlow(rest));
                i++;
            }
        }
        return new ParseResult(arr, i);
    }

    private static ParseResult ParseMapping(IReadOnlyList<string> lines, int from, int to, int indent)
    {
        var obj = new YamlMap();
        int i = from;
        string? lastKey = null;
        while (i < to)
        {
            string line = lines[i];
            int ind = IndentOf(line);
            if (ind < indent) break;
            string trimmed = line[ind..];
            if (ind == indent && trimmed.StartsWith("- ", StringComparison.Ordinal)) break;
            if (ind > indent)
            {
                // Continuation of the previous scalar (Unity wraps some long strings).
                if (lastKey != null && obj[lastKey] is string prev)
                    obj[lastKey] = prev + " " + trimmed;
                i++;
                continue;
            }
            Match m = kMapKeyRe.Match(trimmed);
            if (!m.Success) { i++; continue; }
            string key = Unquote(m.Groups[1].Value);
            string? rest = m.Groups[2].Success ? m.Groups[2].Value : null;
            if (rest == null || rest == "")
            {
                int j = i + 1;
                if (j < to)
                {
                    int jInd = IndentOf(lines[j]);
                    string jTrim = lines[j][jInd..];
                    if (jInd == indent && jTrim.StartsWith("- ", StringComparison.Ordinal))
                    {
                        ParseResult r = ParseSequence(lines, j, to, indent);
                        obj[key] = r.Value;
                        i = r.Next; lastKey = key;
                        continue;
                    }
                    if (jInd > indent)
                    {
                        ParseResult r = ParseBlock(lines, j, to, jInd);
                        obj[key] = r.Value;
                        i = r.Next; lastKey = key;
                        continue;
                    }
                }
                obj[key] = "";
                i++; lastKey = key;
            }
            else
            {
                obj[key] = (rest.StartsWith('{') || rest.StartsWith('['))
                    ? ParseFlow(rest) : Unquote(rest);
                i++; lastKey = key;
            }
        }
        return new ParseResult(obj, i);
    }

    // Parse a full Unity YAML file (scene/prefab) into documents. Docs whose
    // classId is not in `wantedClassIds` keep Data == null (still counted).
    public static List<UnityYamlDoc> Parse(string text, HashSet<string>? wantedClassIds)
    {
        string[] lines = text.Split('\n');
        var docs = new List<UnityYamlDoc>();
        int i = 0;
        int n = lines.Length;
        while (i < n)
        {
            Match m = kDocRe.Match(TrimCr(lines[i]));
            if (!m.Success) { i++; continue; }
            string classId = m.Groups[1].Value;
            string anchor = m.Groups[2].Value;
            bool stripped = m.Groups[3].Success;
            int j = i + 1;
            while (j < n && !lines[j].StartsWith("--- ", StringComparison.Ordinal)) j++;
            string? type = null;
            YamlMap? data = null;
            if (wantedClassIds == null || wantedClassIds.Contains(classId))
            {
                if (j > i + 1)
                {
                    Match head = kHeadRe.Match(TrimCr(lines[i + 1]));
                    if (head.Success)
                    {
                        type = head.Groups[1].Value;
                        var body = new List<string>();
                        for (int k = i + 2; k < j; k++) body.Add(TrimCr(lines[k]));
                        data = ParseMapping(body, 0, body.Count, 2).Value as YamlMap;
                    }
                    else
                    {
                        var body = new List<string>();
                        for (int k = i + 1; k < j; k++) body.Add(TrimCr(lines[k]));
                        data = ParseMapping(body, 0, body.Count, 0).Value as YamlMap;
                    }
                }
            }
            docs.Add(new UnityYamlDoc { ClassId = classId, Anchor = anchor, Stripped = stripped, Type = type, Data = data });
            i = j;
        }
        return docs;
    }

    private static string TrimCr(string line) =>
        line.EndsWith('\r') ? line[..^1] : line;
}
