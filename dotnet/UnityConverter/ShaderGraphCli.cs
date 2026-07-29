namespace GameEngine.UnityConverter;

/// `--convert-shadergraph <in.shadergraph> [--out <out.glsl>]`
///
/// A separate entry from scene conversion: it reads one Unity shader graph and
/// writes one engine SG v2 graph source. Kept off the scene path so the
/// byte-parity fixtures shared with the JS reference are untouched.
internal static class ShaderGraphCli
{
    public const string kFlag = "--convert-shadergraph";
    const string kOutFlag = "--out";
    const string kGeneratedExtension = ".glsl";

    /// Converter-owned node-library directory, named like the material converter's
    /// other output dirs (Materials_Unity, Textures_Unity).
    const string kGeneratedNodeDirName = "ShaderNodes_Unity";

    public static int Run(string[] argv)
    {
        string? input = null;
        string? output = null;

        for (int i = 0; i < argv.Length; i++)
        {
            if (argv[i] == kFlag && i + 1 < argv.Length)
                input = argv[++i];
            else if (argv[i] == kOutFlag && i + 1 < argv.Length)
                output = argv[++i];
        }

        if (input == null)
        {
            G.LogErr($"ERROR: {kFlag} needs a path to a Unity .shadergraph file");
            return 2;
        }
        if (!File.Exists(input))
        {
            G.LogErr($"ERROR: no such shader graph: {input}");
            return 2;
        }

        string graphName = Path.GetFileNameWithoutExtension(input);
        output ??= Path.ChangeExtension(input, kGeneratedExtension);

        ShaderGraphConversionResult result;
        try
        {
            result = ShaderGraphConverter.Convert(File.ReadAllText(input), graphName);
        }
        catch (Exception ex)
        {
            G.LogErr($"ERROR: {graphName}: {ex.Message}");
            return 1;
        }

        foreach ((string subject, string reason) in result.Report.Dropped)
            G.NoteDropped("shadergraph", $"{graphName}: {subject} — {reason}", verbose: true);

        if (!result.Success)
        {
            G.LogErr($"ERROR: {graphName} did not convert; see the entries above");
            return 1;
        }

        Js.WriteFileUtf8(output, result.Source);

        // Translated Custom Functions become node-library files beside the graph. The
        // reflector globs every .glsl under the project's Assets tree, so landing them
        // there is the whole registration step.
        if (result.Report.GeneratedNodeFiles.Count > 0)
        {
            string nodeDir = Path.Combine(Path.GetDirectoryName(output) ?? ".", kGeneratedNodeDirName);
            Directory.CreateDirectory(nodeDir);
            foreach ((string fileName, string source) in result.Report.GeneratedNodeFiles)
            {
                string nodePath = Path.Combine(nodeDir, fileName);
                Js.WriteFileUtf8(nodePath, source);
                G.Log($"  custom-function node: {nodePath}");
            }
        }

        G.Log($"shader graph converted: {output}");
        G.Log($"  alphaMode: {result.Report.AlphaMode}");
        foreach ((string key, double[] values) in result.Report.MaterialProperties)
            G.Log($"  material property {key} = [{string.Join(", ", values)}]");
        foreach ((string slot, string source) in result.Report.TextureSlots)
            G.Log($"  texture slot {slot} <- {source}");
        G.Log($"  reported drops: {result.Report.Dropped.Count}");
        return 0;
    }
}
