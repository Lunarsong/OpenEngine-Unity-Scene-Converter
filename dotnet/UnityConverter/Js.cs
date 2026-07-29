using System.Globalization;
using System.Text;

namespace GameEngine.UnityConverter;

/// JS-semantics shims. The converter is a line-faithful port of a Node
/// reference implementation gated by a byte-parity harness; every helper here
/// replicates an ECMAScript behavior .NET does differently (number-to-string,
/// Math.round, parseFloat/parseInt prefix parsing, win32 path joins,
/// BOM-preserving UTF-8 reads). Do not "fix" these to idiomatic .NET —
/// divergence breaks byte parity with the JS reference.
internal static class Js
{
    // ---------------------------------------------------------- numbers ----
    // ECMA-262 Number::toString(10). .NET shortest-round-trip digits are the
    // same as V8's; only the rendering (exponent thresholds, casing) differs.
    public static string NumberToString(double v)
    {
        if (double.IsNaN(v)) return "NaN";
        if (double.IsPositiveInfinity(v)) return "Infinity";
        if (double.IsNegativeInfinity(v)) return "-Infinity";
        if (v == 0) return "0"; // String(-0) === "0"

        bool neg = v < 0;
        string s = Math.Abs(v).ToString("R", CultureInfo.InvariantCulture);

        int ePos = s.IndexOfAny(['E', 'e']);
        string mant = ePos >= 0 ? s[..ePos] : s;
        int exp = ePos >= 0 ? int.Parse(s[(ePos + 1)..], CultureInfo.InvariantCulture) : 0;
        int dot = mant.IndexOf('.');
        string digs = dot >= 0 ? mant.Remove(dot, 1) : mant;
        int intLen = dot >= 0 ? dot : mant.Length;
        int lead = 0;
        while (lead < digs.Length - 1 && digs[lead] == '0') { lead++; intLen--; }
        digs = digs[lead..].TrimEnd('0');
        if (digs.Length == 0) digs = "0";
        int n = intLen + exp;         // value == 0.<digs> * 10^n
        int k = digs.Length;

        string body;
        if (k <= n && n <= 21) body = digs + new string('0', n - k);
        else if (0 < n && n <= 21) body = digs[..n] + "." + digs[n..];
        else if (-6 < n && n <= 0) body = "0." + new string('0', -n) + digs;
        else
        {
            string mantissa = k > 1 ? digs[..1] + "." + digs[1..] : digs;
            body = mantissa + "e" + (n - 1 >= 0 ? "+" : "-")
                 + Math.Abs(n - 1).ToString(CultureInfo.InvariantCulture);
        }
        return neg ? "-" + body : body;
    }

    // Math.round: half-up toward +Infinity (Math.round(-2.5) === -2), exact
    // midpoint detection (floor(x + 0.5) misrounds 0.49999999999999994).
    public static double MathRound(double x)
    {
        if (double.IsNaN(x) || double.IsInfinity(x)) return x;
        double f = Math.Floor(x);
        double diff = x - f;
        if (diff > 0.5) return f + 1;
        if (diff < 0.5) return f;
        return f + 1;
    }

    // parseFloat: longest valid numeric prefix (sign, digits, '.', exponent,
    // 'Infinity'), NaN when none. Never throws.
    public static double ParseFloat(string? s)
    {
        if (s == null) return double.NaN;
        int i = 0;
        while (i < s.Length && IsJsWhitespace(s[i])) i++;
        int start = i;
        if (i < s.Length && (s[i] == '+' || s[i] == '-')) i++;
        if (s.AsSpan(i).StartsWith("Infinity"))
        {
            return s[start] == '-' ? double.NegativeInfinity : double.PositiveInfinity;
        }
        int digitsStart = i;
        while (i < s.Length && s[i] >= '0' && s[i] <= '9') i++;
        bool hasInt = i > digitsStart;
        bool hasFrac = false;
        if (i < s.Length && s[i] == '.')
        {
            int fracStart = ++i;
            while (i < s.Length && s[i] >= '0' && s[i] <= '9') i++;
            hasFrac = i > fracStart;
        }
        if (!hasInt && !hasFrac) return double.NaN;
        int mantEnd = i;
        if (i < s.Length && (s[i] == 'e' || s[i] == 'E'))
        {
            int save = i;
            i++;
            if (i < s.Length && (s[i] == '+' || s[i] == '-')) i++;
            int expStart = i;
            while (i < s.Length && s[i] >= '0' && s[i] <= '9') i++;
            if (i > expStart) mantEnd = i;
            else i = save;
        }
        return double.Parse(s[start..mantEnd], NumberStyles.Float, CultureInfo.InvariantCulture);
    }

    // parseInt(s, radix): whitespace, sign, longest radix-digit prefix.
    public static double ParseInt(string? s, int radix)
    {
        if (s == null) return double.NaN;
        int i = 0;
        while (i < s.Length && IsJsWhitespace(s[i])) i++;
        int sign = 1;
        if (i < s.Length && (s[i] == '+' || s[i] == '-'))
        {
            if (s[i] == '-') sign = -1;
            i++;
        }
        double value = 0;
        int digits = 0;
        for (; i < s.Length; i++)
        {
            int d = DigitValue(s[i]);
            if (d < 0 || d >= radix) break;
            value = value * radix + d;
            digits++;
        }
        if (digits == 0) return double.NaN;
        return sign * value;
    }

    private static int DigitValue(char c)
    {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'a' && c <= 'z') return c - 'a' + 10;
        if (c >= 'A' && c <= 'Z') return c - 'A' + 10;
        return -1;
    }

    private static bool IsJsWhitespace(char c) =>
        c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v'
        || c == ' ' || c == '﻿' || char.IsWhiteSpace(c);

    // String(value) for the few dynamic call sites (YAML values).
    public static string ToJsString(object? v) => v switch
    {
        null => "null",
        string s => s,
        bool b => b ? "true" : "false",
        double d => NumberToString(d),
        long l => l.ToString(CultureInfo.InvariantCulture),
        YamlList list => string.Join(",", list.Select(ToJsString)),
        YamlMap => "[object Object]",
        _ => v.ToString() ?? "",
    };

    // -------------------------------------------------------------- path ---
    // Node path.win32.join, ported structurally from Node's lib/path.js.
    // Path.Combine is not a faithful stand-in — it discards every earlier part
    // when a later part is rooted, so a crafted archive entry name could
    // re-root a write outside the destination. Node's join keeps later parts
    // under the first, and its normalize carries the CVE-2024-36139 guard
    // (relative results that Windows could reparse as drive paths get a ".\"
    // prefix). Verified against node path.win32.join over curated + 20k
    // fuzzed vectors.
    public static string PathJoin(params string[] parts)
    {
        string? firstPart = null;
        var sb = new StringBuilder();
        foreach (string part in parts)
        {
            if (part.Length == 0) continue;
            if (firstPart == null) firstPart = part;
            else sb.Append('\\');
            sb.Append(part);
        }
        if (firstPart == null) return ".";
        string joined = sb.ToString();

        // join()'s UNC guard: collapse leading separator runs unless the first
        // part itself is shaped like an intentional UNC prefix.
        bool needsReplace = true;
        int slashCount = 0;
        if (IsSep(firstPart[0]))
        {
            slashCount = 1;
            if (firstPart.Length > 1 && IsSep(firstPart[1]))
            {
                slashCount = 2;
                if (firstPart.Length > 2)
                {
                    if (IsSep(firstPart[2])) slashCount = 3;
                    else needsReplace = false;
                }
            }
        }
        if (needsReplace)
        {
            while (slashCount < joined.Length && IsSep(joined[slashCount])) slashCount++;
            if (slashCount >= 2) joined = "\\" + joined[slashCount..];
        }

        string normalized = NormalizeWin32(joined);
        return OperatingSystem.IsWindows() ? normalized : normalized.Replace('\\', '/');
    }

    private static bool IsSep(char c) => c == '/' || c == '\\';

    // Node path.win32.normalize.
    private static string NormalizeWin32(string p)
    {
        int len = p.Length;
        if (len == 0) return ".";
        if (len == 1) return p[0] == '/' ? "\\" : p;

        string? device = null;
        bool isAbsolute = false;
        int rootEnd = 0;

        if (IsSep(p[0]))
        {
            isAbsolute = true;
            if (IsSep(p[1]))
            {
                int j = 2;
                int last = j;
                while (j < len && !IsSep(p[j])) j++;
                if (j < len && j != last)
                {
                    string first = p[last..j];
                    last = j;
                    while (j < len && IsSep(p[j])) j++;
                    if (j < len && j != last)
                    {
                        last = j;
                        while (j < len && !IsSep(p[j])) j++;
                        if (j == len || j != last)
                        {
                            if (first is "." or "?")
                            {
                                device = "\\\\" + first;
                                rootEnd = 4;
                            }
                            else if (j == len)
                            {
                                return "\\\\" + first + "\\" + p[last..] + "\\";
                            }
                            else
                            {
                                device = "\\\\" + first + "\\" + p[last..j];
                                rootEnd = j;
                            }
                        }
                    }
                }
                // No UNC match: rootEnd stays 0; the tail pass eats the slashes.
            }
            else
            {
                rootEnd = 1;
            }
        }
        else if (char.IsAsciiLetter(p[0]) && p[1] == ':')
        {
            device = p[..2];
            rootEnd = 2;
            if (len > 2 && IsSep(p[2]))
            {
                isAbsolute = true;
                rootEnd = 3;
            }
        }

        string tail = rootEnd < len ? NormalizeSegments(p[rootEnd..], allowAboveRoot: !isAbsolute) : "";
        if (tail.Length == 0 && !isAbsolute) tail = ".";
        if (tail.Length > 0 && IsSep(p[len - 1])) tail += "\\";
        if (!isAbsolute && device == null && p.Contains(':'))
        {
            // CVE-2024-36139: a relative result must not be something Windows
            // would reparse as a drive path.
            if (tail.Length >= 2 && char.IsAsciiLetter(tail[0]) && tail[1] == ':')
                return ".\\" + tail;
            for (int idx = p.IndexOf(':'); idx != -1; idx = p.IndexOf(':', idx + 1))
            {
                if (idx == len - 1 || IsSep(p[idx + 1]))
                    return ".\\" + tail;
            }
        }
        if (device == null) return isAbsolute ? "\\" + tail : tail;
        return isAbsolute ? device + "\\" + tail : device + tail;
    }

    private static string NormalizeSegments(string path, bool allowAboveRoot)
    {
        var segments = new List<string>();
        int segStart = 0;
        for (int j = 0; j <= path.Length; j++)
        {
            if (j < path.Length && !IsSep(path[j])) continue;
            if (j > segStart)
            {
                string seg = path[segStart..j];
                if (seg == ".")
                {
                    // dropped
                }
                else if (seg == "..")
                {
                    if (segments.Count > 0 && segments[^1] != "..") segments.RemoveAt(segments.Count - 1);
                    else if (allowAboveRoot) segments.Add("..");
                }
                else
                {
                    segments.Add(seg);
                }
            }
            segStart = j + 1;
        }
        return string.Join('\\', segments);
    }

    public static string PathResolve(string p) => System.IO.Path.GetFullPath(p);

    public static string PathBasename(string p)
    {
        ReadOnlySpan<char> span = p;
        int end = span.Length;
        while (end > 0 && (span[end - 1] == '/' || span[end - 1] == '\\')) end--;
        int start = end;
        while (start > 0 && span[start - 1] != '/' && span[start - 1] != '\\') start--;
        return p[start..end];
    }

    public static string PathBasename(string p, string ext)
    {
        string name = PathBasename(p);
        if (ext.Length > 0 && name.Length > ext.Length && name.EndsWith(ext, StringComparison.Ordinal))
            return name[..^ext.Length];
        return name;
    }

    // Node extname: substring from the last '.' of the basename; '' for
    // dotfiles and extensionless names, '.' for a trailing dot.
    public static string PathExtname(string p)
    {
        string name = PathBasename(p);
        int dot = name.LastIndexOf('.');
        if (dot <= 0) return "";
        return name[dot..];
    }

    public static string PathDirname(string p)
    {
        string? d = System.IO.Path.GetDirectoryName(p);
        if (string.IsNullOrEmpty(d))
            return System.IO.Path.IsPathRooted(p) ? p : ".";
        return d;
    }

    public static bool PathIsAbsolute(string p) => System.IO.Path.IsPathRooted(p);

    public static string PathRelative(string from, string to) => System.IO.Path.GetRelativePath(from, to);

    // ---------------------------------------------------------------- fs ---
    // Node readFileSync(p, 'utf8'): raw UTF-8 decode with U+FFFD replacement.
    // Never BOM-strips (File.ReadAllText does — do not use it).
    public static string ReadFileUtf8(string p) => Encoding.UTF8.GetString(File.ReadAllBytes(p));

    public static void WriteFileUtf8(string p, string text) =>
        File.WriteAllBytes(p, Encoding.UTF8.GetBytes(text));

    // Node fs.Stats.mtimeMs: libuv FILETIME -> timespec, then
    // sec * 1e3 + nsec / 1e6 in double arithmetic.
    public static double StatMtimeMs(string p)
    {
        long filetime = File.GetLastWriteTimeUtc(p).ToFileTimeUtc();
        long unix100Ns = filetime - 116444736000000000L;
        long sec = unix100Ns / 10000000L;
        long nsec = (unix100Ns % 10000000L) * 100L;
        return sec * 1000.0 + nsec / 1e6;
    }
}
