using System.Globalization;
using System.Text;

namespace GameEngine.UnityConverter;

/// Insertion-ordered object/array model + a JSON.stringify-compatible writer.
/// The --json protocol lines, .material documents and bake sidecars must be
/// byte-identical to the Node reference, so serialization is hand-rolled:
/// System.Text.Json differs on number rendering, escaping and key ordering.
internal sealed class JsonObj
{
    private readonly List<string> m_Keys = [];
    private readonly Dictionary<string, object?> m_Values = [];

    public IReadOnlyList<string> Keys => m_Keys;
    public int Count => m_Keys.Count;

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
}

internal sealed class JsonArr : List<object?>
{
    public JsonArr() { }
    public JsonArr(IEnumerable<object?> items) : base(items) { }
}

internal static class Json
{
    // JSON.stringify(value) / JSON.stringify(value, null, indent).
    public static string Stringify(object? value, int indent = 0)
    {
        var sb = new StringBuilder();
        WriteValue(sb, value, indent, 0);
        return sb.ToString();
    }

    private static void WriteValue(StringBuilder sb, object? v, int indent, int depth)
    {
        switch (v)
        {
            case null: sb.Append("null"); break;
            case bool b: sb.Append(b ? "true" : "false"); break;
            case string s: WriteString(sb, s); break;
            case double d:
                if (double.IsNaN(d) || double.IsInfinity(d)) sb.Append("null");
                else sb.Append(Js.NumberToString(d));
                break;
            case int i: sb.Append(i.ToString(CultureInfo.InvariantCulture)); break;
            case long l: sb.Append(l.ToString(CultureInfo.InvariantCulture)); break;
            case JsonArr arr: WriteArray(sb, arr, indent, depth); break;
            case JsonObj obj: WriteObject(sb, obj, indent, depth); break;
            case double[] da: WriteArray(sb, new JsonArr(da.Select(x => (object?)x)), indent, depth); break;
            default:
                throw new InvalidOperationException($"unsupported JSON value type {v.GetType()}");
        }
    }

    private static void WriteArray(StringBuilder sb, JsonArr arr, int indent, int depth)
    {
        if (arr.Count == 0) { sb.Append("[]"); return; }
        sb.Append('[');
        for (int i = 0; i < arr.Count; i++)
        {
            if (i > 0) sb.Append(',');
            if (indent > 0)
            {
                sb.Append('\n');
                sb.Append(' ', indent * (depth + 1));
            }
            WriteValue(sb, arr[i], indent, depth + 1);
        }
        if (indent > 0)
        {
            sb.Append('\n');
            sb.Append(' ', indent * depth);
        }
        sb.Append(']');
    }

    private static void WriteObject(StringBuilder sb, JsonObj obj, int indent, int depth)
    {
        if (obj.Count == 0) { sb.Append("{}"); return; }
        sb.Append('{');
        bool first = true;
        foreach (string key in obj.Keys)
        {
            if (!first) sb.Append(',');
            first = false;
            if (indent > 0)
            {
                sb.Append('\n');
                sb.Append(' ', indent * (depth + 1));
            }
            WriteString(sb, key);
            sb.Append(':');
            if (indent > 0) sb.Append(' ');
            WriteValue(sb, obj[key], indent, depth + 1);
        }
        if (indent > 0)
        {
            sb.Append('\n');
            sb.Append(' ', indent * depth);
        }
        sb.Append('}');
    }

    // JSON.stringify string escaping (ES2019 well-formed: lone surrogates as
    // \uXXXX, everything else >= 0x20 raw).
    public static void WriteString(StringBuilder sb, string s)
    {
        sb.Append('"');
        for (int i = 0; i < s.Length; i++)
        {
            char c = s[i];
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\b': sb.Append("\\b"); break;
                case '\f': sb.Append("\\f"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 0x20)
                    {
                        sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    }
                    else if (char.IsHighSurrogate(c))
                    {
                        if (i + 1 < s.Length && char.IsLowSurrogate(s[i + 1])) { sb.Append(c).Append(s[i + 1]); i++; }
                        else sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    }
                    else if (char.IsLowSurrogate(c))
                    {
                        sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    }
                    else
                    {
                        sb.Append(c);
                    }
                    break;
            }
        }
        sb.Append('"');
    }
}
