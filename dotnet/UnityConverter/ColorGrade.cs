namespace GameEngine.UnityConverter;

/// Unity colour-grade wheels -> native ColorGradeEffect bands (+ the legacy
/// --grade-lut .cube bake) — port of the convert.js grade block.
internal sealed class GradeBand
{
    public double[] Color = [0, 0, 0];
    public double Lightness;
}

internal sealed class GradeBands
{
    public required GradeBand Shadows;
    public required GradeBand Midtones;
    public required GradeBand Highlights;
}

internal static class ColorGrade
{
    public const double kGradeEncSlope = 17.52;
    public const double kGradeOffsetScale = 0.5;
    public const double kGradeMidGrey = 0.18;
    public const double kGradeOffsetClamp = 1.0;
    public static readonly double[] kRec709Luma = [0.2126729, 0.7151522, 0.0721750];

    public static bool IsIdentityWheel(object? v)
    {
        if (v is not double[] a) return true;
        double w = a.Length > 3 ? a[3] : 0;
        return Math.Abs(a[0] - 1) < 1e-4 && Math.Abs(a[1] - 1) < 1e-4
            && Math.Abs(a[2] - 1) < 1e-4 && Math.Abs(w) < 1e-4;
    }

    public static double Smoothstep(double e0, double e1, double x)
    {
        double t = Math.Min(1, Math.Max(0, (x - e0) / (e1 - e0)));
        return t * t * (3 - 2 * t);
    }

    public static GradeBand BandFromMultiplier(double[] m)
    {
        double[] o = [.. m.Select(v => Math.Log2(Math.Max(v, 1e-6)) / kGradeEncSlope / kGradeOffsetScale)];
        double master = (o[0] + o[1] + o[2]) / 3;
        double Clamp(double v) => Math.Max(-kGradeOffsetClamp, Math.Min(kGradeOffsetClamp, v));
        return new GradeBand
        {
            Color = [.. o.Select(v => Clamp(v - master))],
            Lightness = Clamp(master),
        };
    }

    // URP core ColorUtils.PrepareShadowsMidtonesHighlights (verbatim).
    public static double[] PrepSmhWheel(object? v)
    {
        double[] a = v as double[] ?? [1, 1, 1, 0];
        double w0 = a.Length > 3 ? a[3] : 0;
        double w = w0 * (w0 < 0 ? 1 : 4);
        return [.. new[] { 0, 1, 2 }.Select(i => Math.Max(Skybox.SrgbToLinear(a[i]) + w, 0))];
    }

    public sealed class LggPrep
    {
        public double[] Lift = [0, 0, 0];
        public double[] Gamma = [1, 1, 1];
        public double[] Gain = [1, 1, 1];
    }

    // URP core ColorUtils.PrepareLiftGammaGain (verbatim).
    public static LggPrep PrepLiftGammaGain(object? liftV, object? gammaV, object? gainV)
    {
        double Lum(double[] v) => kRec709Luma[0] * v[0] + kRec709Luma[1] * v[1] + kRec709Luma[2] * v[2];
        double[] la = liftV as double[] ?? [1, 1, 1, 0];
        double[] ga = gammaV as double[] ?? [1, 1, 1, 0];
        double[] na = gainV as double[] ?? [1, 1, 1, 0];
        double W(double[] a) => a.Length > 3 ? a[3] : 0;

        double[] lift = [Skybox.SrgbToLinear(la[0]) * 0.15, Skybox.SrgbToLinear(la[1]) * 0.15, Skybox.SrgbToLinear(la[2]) * 0.15];
        double lumL = Lum(lift), lw = W(la);
        lift = [.. lift.Select(v => v - lumL + lw)];
        double[] gamma = [Skybox.SrgbToLinear(ga[0]) * 0.8, Skybox.SrgbToLinear(ga[1]) * 0.8, Skybox.SrgbToLinear(ga[2]) * 0.8];
        double lumG = Lum(gamma), gw = W(ga) + 1;
        gamma = [.. gamma.Select(v => 1 / Math.Max(v - lumG + gw, 1e-3))];
        double[] gain = [Skybox.SrgbToLinear(na[0]) * 0.8, Skybox.SrgbToLinear(na[1]) * 0.8, Skybox.SrgbToLinear(na[2]) * 0.8];
        double lumN = Lum(gain), nw = W(na) + 1;
        gain = [.. gain.Select(v => v - lumN + nw)];
        return new LggPrep { Lift = lift, Gamma = gamma, Gain = gain };
    }

    public static GradeBands SmhToBands(JsonObj smh) => new()
    {
        Shadows = BandFromMultiplier(PrepSmhWheel(smh["shadows"])),
        Midtones = BandFromMultiplier(PrepSmhWheel(smh["midtones"])),
        Highlights = BandFromMultiplier(PrepSmhWheel(smh["highlights"])),
    };

    // EncodeGradeLog mirror (ACEScct-shaped linear toe + log2 body).
    public static double EncodeGradeLog(double x) =>
        x <= 0.0078125 ? x * 10.5402 + 0.0729
                       : (Math.Log2(Math.Max(x, 1e-10)) + 9.72) / kGradeEncSlope;

    public sealed class BandLimits
    {
        public double ShadowsStart;
        public double ShadowsEnd;
        public double HighlightsStart;
        public double HighlightsEnd;
    }

    public static BandLimits SmhLimitsToNative(JsonObj smh)
    {
        double Enc(double v) => Math.Min(Math.Max(EncodeGradeLog(Math.Max(v, 0)), 0), 1);
        double Field(string key, double dflt) => smh[key] is double d ? d : dflt;
        return new BandLimits
        {
            ShadowsStart = Enc(Field("shadowsStart", 0)),
            ShadowsEnd = Enc(Field("shadowsEnd", 0.3)),
            HighlightsStart = Enc(Field("highlightsStart", 0.55)),
            HighlightsEnd = Enc(Field("highlightsEnd", 1)),
        };
    }

    public static GradeBands LggToBands(JsonObj lgg)
    {
        LggPrep p = PrepLiftGammaGain(lgg["lift"], lgg["gamma"], lgg["gain"]);
        double[] liftMul = [.. p.Lift.Select(v => 1 + v / kGradeMidGrey)];
        double[] gammaMul = [.. p.Gamma.Select(e => Math.Pow(kGradeMidGrey, e - 1))];
        return new GradeBands
        {
            Shadows = BandFromMultiplier(liftMul),
            Midtones = BandFromMultiplier(gammaMul),
            Highlights = BandFromMultiplier(p.Gain),
        };
    }

    public static GradeBands AddBands(GradeBands a, GradeBands b)
    {
        GradeBand Add(GradeBand x, GradeBand y) => new()
        {
            Color = [x.Color[0] + y.Color[0], x.Color[1] + y.Color[1], x.Color[2] + y.Color[2]],
            Lightness = x.Lightness + y.Lightness,
        };
        return new GradeBands
        {
            Shadows = Add(a.Shadows, b.Shadows),
            Midtones = Add(a.Midtones, b.Midtones),
            Highlights = Add(a.Highlights, b.Highlights),
        };
    }

    public static bool BandsAreNeutral(GradeBands bands, double eps = 1e-5)
    {
        bool N(GradeBand b) => Math.Abs(b.Color[0]) < eps && Math.Abs(b.Color[1]) < eps
            && Math.Abs(b.Color[2]) < eps && Math.Abs(b.Lightness) < eps;
        return N(bands.Shadows) && N(bands.Midtones) && N(bands.Highlights);
    }

    public static List<string> EmitColorGradeBandLines(GradeBands bands)
    {
        var lines = new List<string>();
        const double eps = 1e-5;
        void Emit(string name, GradeBand b)
        {
            if (Math.Abs(b.Color[0]) >= eps) lines.Add($"ColorGradeEffect.{name}ColorR = {Emitter.FmtF(b.Color[0])}");
            if (Math.Abs(b.Color[1]) >= eps) lines.Add($"ColorGradeEffect.{name}ColorG = {Emitter.FmtF(b.Color[1])}");
            if (Math.Abs(b.Color[2]) >= eps) lines.Add($"ColorGradeEffect.{name}ColorB = {Emitter.FmtF(b.Color[2])}");
            if (Math.Abs(b.Lightness) >= eps) lines.Add($"ColorGradeEffect.{name}Lightness = {Emitter.FmtF(b.Lightness)}");
        }
        Emit("shadows", bands.Shadows);
        Emit("midtones", bands.Midtones);
        Emit("highlights", bands.Highlights);
        return lines;
    }

    // Legacy --grade-lut: URP ShadowsMidtonesHighlights -> Resolve-style .cube.
    public static void BakeSmhCubeLut(JsonObj smh, string file)
    {
        double[] Prep(object? v)
        {
            double[] a = v as double[] ?? [1, 1, 1, 0];
            double w0 = a.Length > 3 ? a[3] : 0;
            double w = w0 * (w0 < 0 ? 1 : 4);
            return [.. new[] { 0, 1, 2 }.Select(i => Math.Max(Skybox.SrgbToLinear(a[i]) + w, 0))];
        }
        double[] s = Prep(smh["shadows"]), m = Prep(smh["midtones"]), h = Prep(smh["highlights"]);
        double shStart = smh["shadowsStart"] is double v1 ? v1 : 0;
        double shEnd = smh["shadowsEnd"] is double v2 ? v2 : 0.3;
        double hiStart = smh["highlightsStart"] is double v3 ? v3 : 0.55;
        double hiEnd = smh["highlightsEnd"] is double v4 ? v4 : 1;
        const int kLutSize = 33;
        var lines = new List<string>
        {
            "TITLE \"URP ShadowsMidtonesHighlights bake (unity-scene-convert)\"",
            $"LUT_3D_SIZE {kLutSize}",
        };
        for (int b = 0; b < kLutSize; b++)
        {
            for (int g = 0; g < kLutSize; g++)
            {
                for (int r = 0; r < kLutSize; r++)
                {
                    double[] c = [r / (double)(kLutSize - 1), g / (double)(kLutSize - 1), b / (double)(kLutSize - 1)];
                    double luma = 0.2126729 * c[0] + 0.7151522 * c[1] + 0.0721750 * c[2];
                    double sh = 1 - Smoothstep(shStart, shEnd, luma);
                    double hi = Smoothstep(hiStart, hiEnd, luma);
                    double mid = 1 - sh - hi;
                    double[] o = [.. c.Select((v, i) => Math.Max(0, v * (s[i] * sh + m[i] * mid + h[i] * hi)))];
                    lines.Add($"{ToFixed6(o[0])} {ToFixed6(o[1])} {ToFixed6(o[2])}");
                }
            }
        }
        Js.WriteFileUtf8(file, string.Join("\n", lines) + "\n");
    }

    // [r,g,b] in 0..1 at (x, y) where y is a PNG ROW (file order, top row
    // first) — port of convert.js pngTexel.
    public static double[] PngTexel(PngImage img, int x, int y)
    {
        int bytes = img.BitDepth >> 3;
        int at = (y * img.Width + x) * img.Channels * bytes;
        double Read(int i) => img.BitDepth == 8
            ? img.Px[at + i] / 255.0
            : ((img.Px[at + i * 2] << 8) | img.Px[at + i * 2 + 1]) / 65535.0;
        return [Read(0), Read(1), Read(2)];
    }

    // URP ColorLookup 2D strip -> Resolve-style .cube 3D LUT — port of
    // convert.js bakeLookupCubeLut (see it for the strip-layout rationale;
    // GPU v=0 is the texture's bottom row = the PNG's LAST file row, so green
    // flips against file rows).
    public static void BakeLookupCubeLut(PngImage img, string file)
    {
        int size = img.Height;
        var lines = new List<string>
        {
            "TITLE \"URP ColorLookup strip transcode (unity-scene-convert)\"",
            $"LUT_3D_SIZE {size}",
        };
        for (int b = 0; b < size; b++)
        {
            for (int g = 0; g < size; g++)
            {
                for (int r = 0; r < size; r++)
                {
                    double[] t = PngTexel(img, b * size + r, size - 1 - g);
                    lines.Add($"{ToFixed6(t[0])} {ToFixed6(t[1])} {ToFixed6(t[2])}");
                }
            }
        }
        Js.WriteFileUtf8(file, string.Join("\n", lines) + "\n");
    }

    // Number.prototype.toFixed(6).
    public static string ToFixed6(double v) =>
        v.ToString("F6", System.Globalization.CultureInfo.InvariantCulture);
}
