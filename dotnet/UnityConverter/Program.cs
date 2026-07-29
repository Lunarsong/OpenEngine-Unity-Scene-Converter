using System.Text;

namespace GameEngine.UnityConverter;

/// CLI entry — port of bin/unity-scene-convert.js: positional sugar
/// (<pkg-dir> [<project-dir>]), single-scene auto-pick, everything else
/// forwarded verbatim to the converter driver.
internal static class Program
{
    private static readonly HashSet<string> kValueFlags =
    [
        "--pkg", "--scene", "--project", "--assetdb", "--unity-project", "--out",
        "--local-shadows", "--texc", "--list-scenes",
    ];

    private static List<string> ListScenes(string pkgDir)
    {
        var scenes = new List<string>();
        if (UnityPackage.IsUnityPackageFile(pkgDir))
        {
            try
            {
                (List<string> order, Dictionary<string, UnityPackage.IndexEntry> byGuid) =
                    UnityPackage.IndexUnityPackage(pkgDir);
                foreach (string g in order)
                {
                    string? p = byGuid[g].AssetPath;
                    if (p != null && p.ToLowerInvariant().EndsWith(".unity", StringComparison.Ordinal))
                        scenes.Add(p);
                }
            }
            catch
            {
                // unreadable pack falls through to the converter's error
            }
            return scenes;
        }
        string[] entries;
        try
        {
            entries = [.. Directory.EnumerateFileSystemEntries(pkgDir).Select(Js.PathBasename)];
        }
        catch
        {
            return scenes;
        }
        foreach (string entry in entries)
        {
            string pn = Js.PathJoin(pkgDir, entry, "pathname");
            try
            {
                string assetPath = Js.ReadFileUtf8(pn).Split('\n')[0].Trim();
                if (assetPath.ToLowerInvariant().EndsWith(".unity", StringComparison.Ordinal)) scenes.Add(assetPath);
            }
            catch
            {
                // not a package entry dir
            }
        }
        return scenes;
    }

    public static int Main(string[] argv)
    {
        // Byte-exact stream setup: UTF-8, no BOM, '\n' newlines.
        var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { NewLine = "\n", AutoFlush = false };
        var stderr = new StreamWriter(Console.OpenStandardError(), new UTF8Encoding(false)) { NewLine = "\n", AutoFlush = false };
        G.Out = stdout;
        G.Err = stderr;
        try
        {
            return WrapperMain(argv);
        }
        catch (Exception ex)
        {
            // Node exits 1 on an uncaught error; .NET's unhandled-exception
            // exit code differs, so match Node here.
            stderr.WriteLine(ex.ToString());
            return 1;
        }
        finally
        {
            stdout.Flush();
            stderr.Flush();
        }
    }

    private static int WrapperMain(string[] argv)
    {
        // Shader-graph conversion is its own command, not a scene-conversion option:
        // the scene path's byte parity with the JS reference stays untouched.
        if (Array.IndexOf(argv, ShaderGraphCli.kFlag) >= 0)
            return ShaderGraphCli.Run(argv);

        var flags = new List<string>();
        var positionals = new List<string>();
        var seen = new HashSet<string>();
        for (int i = 0; i < argv.Length; i++)
        {
            string a = argv[i];
            if (a.StartsWith("--", StringComparison.Ordinal))
            {
                seen.Add(a);
                flags.Add(a);
                if (kValueFlags.Contains(a) && i + 1 < argv.Length) flags.Add(argv[++i]);
            }
            else
            {
                positionals.Add(a);
            }
        }

        if (positionals.Count > 2)
        {
            G.LogErr($"ERROR: at most two positional args (<pkg-dir> <project-dir>), got: {string.Join(" ", positionals)}");
            return 2;
        }
        if (positionals.Count > 0 && positionals[0].Length > 0 && !seen.Contains("--pkg"))
        {
            flags.Add("--pkg");
            flags.Add(positionals[0]);
        }
        if (positionals.Count > 1 && positionals[1].Length > 0 && !seen.Contains("--project"))
        {
            flags.Add("--project");
            flags.Add(positionals[1]);
        }

        if (!seen.Contains("--scene") && !seen.Contains("--list-scenes"))
        {
            int pkgIdx = flags.IndexOf("--pkg");
            string? pkgDir = pkgIdx >= 0 && pkgIdx + 1 < flags.Count ? flags[pkgIdx + 1] : null;
            List<string> scenes = pkgDir != null ? ListScenes(pkgDir) : [];
            if (scenes.Count == 1)
            {
                G.LogErr($"scene auto-picked: {scenes[0]} (only .unity in package)");
                flags.Add("--scene");
                flags.Add(scenes[0].ToLowerInvariant());
            }
            else if (scenes.Count > 1)
            {
                G.LogErr("ERROR: --scene required; the package contains multiple scenes:");
                foreach (string s in scenes.OrderBy(x => x, StringComparer.Ordinal)) G.LogErr("  " + s);
                return 2;
            }
        }

        return ConvertCli.Run([.. flags]);
    }
}
