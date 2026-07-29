using System.Buffers.Binary;
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace GameEngine.UnityConverter;

/// Faithful Unity skybox -> engine Skybox HDRI pipeline — port of skybox.js.
/// DDS cubemap ingest, D3D face lookup, equirect bake (inverse of the
/// engine's EncodeDirToLatLongUv), sRGB decode, and a bit-faithful Radiance
/// RGBE writer with new-style RLE scanlines.
internal static class Skybox
{
    public const double kUnityColorSpaceDouble = 4.59479380;
    public const double kIdentitySnapTolerance = 0.02;
    public const int kBuiltinSkyboxCubemapFileId = 103;

    public static double SrgbToLinear(double c)
    {
        if (c <= 0) return 0;
        return c <= 0.04045 ? c / 12.92 : Math.Pow((c + 0.055) / 1.055, 2.4);
    }

    // 8-bit sRGB -> linear LUT (float precision, matching the JS Float32Array).
    private static readonly float[] kSrgbLut = BuildSrgbLut();
    private static float[] BuildSrgbLut()
    {
        var lut = new float[256];
        for (int i = 0; i < 256; i++) lut[i] = (float)SrgbToLinear(i / 255.0);
        return lut;
    }

    // ------------------------------------------------ Unity material parse --
    public sealed class SkyboxMat
    {
        public int ShaderFileId;
        public bool IsBuiltinCubemap;
        public string? TexGuid;
        public double Exposure;
        public double RotationDegrees;
        public double[] Tint = [0.5, 0.5, 0.5];
    }

    private static readonly Regex kShaderRe = new(
        @"m_Shader:\s*\{fileID:\s*(-?[0-9]+)(?:,\s*guid:\s*([0-9a-fA-F]{32}))?", RegexOptions.Compiled);
    private static readonly Regex kBuiltinGuidRe = new(@"^0+f0+$", RegexOptions.Compiled);
    private static readonly Regex kTexRe = new(
        @"_Tex:\s*\n\s*m_Texture:\s*\{fileID:\s*[0-9]+,\s*guid:\s*([0-9a-f]{32})", RegexOptions.Compiled);
    private static readonly Regex kTintRe = new(
        @"_Tint:\s*\{r:\s*([-0-9.eE]+),\s*g:\s*([-0-9.eE]+),\s*b:\s*([-0-9.eE]+)", RegexOptions.Compiled);

    public static SkyboxMat? ParseUnitySkyboxMat(string text)
    {
        Match sh = kShaderRe.Match(text);
        if (!sh.Success) return null;
        int shaderFileId = (int)Js.ParseInt(sh.Groups[1].Value, 10);
        string? shaderGuid = sh.Groups[2].Success ? sh.Groups[2].Value.ToLowerInvariant() : null;
        bool isBuiltinCubemap = shaderFileId == kBuiltinSkyboxCubemapFileId
            && (shaderGuid == null || kBuiltinGuidRe.IsMatch(shaderGuid));
        Match tex = kTexRe.Match(text);
        double Num(string name, double dflt)
        {
            Match m = Regex.Match(text, @"-\s*" + name + @":\s*(-?[0-9.eE]+)\s*$", RegexOptions.Multiline);
            return m.Success ? Js.ParseFloat(m.Groups[1].Value) : dflt;
        }
        Match tint = kTintRe.Match(text);
        return new SkyboxMat
        {
            ShaderFileId = shaderFileId,
            IsBuiltinCubemap = isBuiltinCubemap,
            TexGuid = tex.Success ? tex.Groups[1].Value.ToLowerInvariant() : null,
            Exposure = Num("_Exposure", 1),
            RotationDegrees = Num("_Rotation", 0),
            Tint = tint.Success
                ? [Js.ParseFloat(tint.Groups[1].Value), Js.ParseFloat(tint.Groups[2].Value), Js.ParseFloat(tint.Groups[3].Value)]
                : [0.5, 0.5, 0.5],
        };
    }

    public static double[] ComputeSkyboxMultiplier(double[] tint, double exposure)
    {
        double[] m = [.. tint.Select(c => SrgbToLinear(c) * kUnityColorSpaceDouble * exposure)];
        return m.All(c => Math.Abs(c - 1) <= kIdentitySnapTolerance) ? [1, 1, 1] : m;
    }

    // -------------------------------------------------------- DDS ingest ---
    public sealed class DdsCubemap
    {
        public int Size;
        public byte[][] Faces = [];
        public int OffR, OffG, OffB;
    }

    public static DdsCubemap ReadDdsCubemap(byte[] buf)
    {
        if (buf.Length < 128 || U32(buf, 0) != 0x20534444) // "DDS "
            throw new InvalidOperationException("not a DDS file");
        uint height = U32(buf, 12);
        uint width = U32(buf, 16);
        uint mipCount = Math.Max(1, U32(buf, 28));
        uint pfFlags = U32(buf, 80);
        uint fourCC = U32(buf, 84);
        uint bitCount = U32(buf, 88);
        uint maskR = U32(buf, 92);
        uint maskG = U32(buf, 96);
        uint maskB = U32(buf, 100);
        uint caps2 = U32(buf, 112);
        if ((caps2 & 0x200) == 0 || (caps2 & 0xFC00) != 0xFC00)
            throw new InvalidOperationException("DDS is not a full 6-face cubemap");
        if (fourCC != 0 || (pfFlags & 0x40) == 0 || bitCount != 32)
            throw new InvalidOperationException(
                $"unsupported DDS pixel format (fourCC {fourCC}, {bitCount}bpp) — only uncompressed 32-bit supported");
        if (width != height)
            throw new InvalidOperationException($"cubemap faces must be square (got {width}x{height})");
        int MaskToByte(uint mask) => mask switch
        {
            0x000000FF => 0,
            0x0000FF00 => 1,
            0x00FF0000 => 2,
            0xFF000000 => 3,
            _ => throw new InvalidOperationException(
                $"non-byte-aligned DDS channel mask 0x{mask.ToString("x", CultureInfo.InvariantCulture)}"),
        };
        int offR = MaskToByte(maskR), offG = MaskToByte(maskG), offB = MaskToByte(maskB);
        long faceStride = 0;
        for (int m = 0; m < mipCount; m++)
        {
            long w = Math.Max(1, (int)width >> m), h = Math.Max(1, (int)height >> m);
            faceStride += w * h * 4;
        }
        long expected = 128 + 6 * faceStride;
        if (buf.Length < expected)
            throw new InvalidOperationException(
                $"DDS truncated: {buf.Length} bytes, need {expected} (6 faces x {mipCount} mips)");
        var faces = new byte[6][];
        for (int f = 0; f < 6; f++)
        {
            long start = 128 + f * faceStride;
            faces[f] = new byte[width * width * 4];
            Array.Copy(buf, start, faces[f], 0, faces[f].Length);
        }
        return new DdsCubemap { Size = (int)width, Faces = faces, OffR = offR, OffG = offG, OffB = offB };
    }

    private static uint U32(byte[] buf, int off) =>
        BinaryPrimitives.ReadUInt32LittleEndian(buf.AsSpan(off, 4));

    // ---------------------------------------------------- cubemap sampling --
    public static void SampleCubemapLinear(DdsCubemap cube, double[] dir, double[] outRgb)
    {
        double ax = Math.Abs(dir[0]), ay = Math.Abs(dir[1]), az = Math.Abs(dir[2]);
        int face;
        double sc, tc, ma;
        if (ax >= ay && ax >= az)
        {
            ma = ax;
            if (dir[0] >= 0) { face = 0; sc = -dir[2]; tc = -dir[1]; }
            else { face = 1; sc = dir[2]; tc = -dir[1]; }
        }
        else if (ay >= az)
        {
            ma = ay;
            if (dir[1] >= 0) { face = 2; sc = dir[0]; tc = dir[2]; }
            else { face = 3; sc = dir[0]; tc = -dir[2]; }
        }
        else
        {
            ma = az;
            if (dir[2] >= 0) { face = 4; sc = dir[0]; tc = -dir[1]; }
            else { face = 5; sc = -dir[0]; tc = -dir[1]; }
        }
        int n = cube.Size;
        byte[] data = cube.Faces[face];
        int or_ = cube.OffR, og = cube.OffG, ob = cube.OffB;
        double u = (sc / ma + 1) * 0.5 * n - 0.5;
        double v = (tc / ma + 1) * 0.5 * n - 0.5;
        int x0 = (int)Math.Floor(u), y0 = (int)Math.Floor(v);
        double fx = u - x0, fy = v - y0;
        int x1 = x0 + 1, y1 = y0 + 1;
        if (x0 < 0) x0 = 0;
        if (y0 < 0) y0 = 0;
        if (x1 > n - 1) x1 = n - 1;
        if (y1 > n - 1) y1 = n - 1;
        if (x0 > n - 1) x0 = n - 1;
        if (y0 > n - 1) y0 = n - 1;
        int i00 = (y0 * n + x0) * 4, i10 = (y0 * n + x1) * 4;
        int i01 = (y1 * n + x0) * 4, i11 = (y1 * n + x1) * 4;
        double w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy);
        double w01 = (1 - fx) * fy, w11 = fx * fy;
        outRgb[0] = kSrgbLut[data[i00 + or_]] * w00 + kSrgbLut[data[i10 + or_]] * w10
                  + kSrgbLut[data[i01 + or_]] * w01 + kSrgbLut[data[i11 + or_]] * w11;
        outRgb[1] = kSrgbLut[data[i00 + og]] * w00 + kSrgbLut[data[i10 + og]] * w10
                  + kSrgbLut[data[i01 + og]] * w01 + kSrgbLut[data[i11 + og]] * w11;
        outRgb[2] = kSrgbLut[data[i00 + ob]] * w00 + kSrgbLut[data[i10 + ob]] * w10
                  + kSrgbLut[data[i01 + ob]] * w01 + kSrgbLut[data[i11 + ob]] * w11;
    }

    // ------------------------------------------------------ equirect bake --
    public static float[] BakeEquirect(DdsCubemap cube, int width, int height, double[] mult)
    {
        var outRgb = new float[width * height * 3];
        double[] dir = [0, 0, 0];
        double[] rgb = [0, 0, 0];
        double mr = mult[0], mg = mult[1], mb = mult[2];
        for (int py = 0; py < height; py++)
        {
            double theta = ((py + 0.5) / height) * Math.PI;
            double y = Math.Cos(theta);
            double r = Math.Sin(theta);
            int o = py * width * 3;
            for (int px = 0; px < width; px++, o += 3)
            {
                double phi = (((px + 0.5) / width) - 0.5) * 2 * Math.PI;
                dir[0] = r * Math.Cos(phi);
                dir[1] = y;
                dir[2] = r * Math.Sin(phi);
                SampleCubemapLinear(cube, dir, rgb);
                outRgb[o] = (float)(rgb[0] * mr);
                outRgb[o + 1] = (float)(rgb[1] * mg);
                outRgb[o + 2] = (float)(rgb[2] * mb);
            }
        }
        return outRgb;
    }

    // -------------------------------------------------------- Radiance IO --
    private static void RgbeEncode(double r, double g, double b, byte[] outBuf, int o)
    {
        double m = Math.Max(r, Math.Max(g, b));
        if (m < 1e-32)
        {
            outBuf[o] = 0; outBuf[o + 1] = 0; outBuf[o + 2] = 0; outBuf[o + 3] = 0;
            return;
        }
        double e = Math.Floor(Math.Log2(m)) + 1;
        double scale = Math.Pow(2, -e) * 256;
        if (m * scale >= 256) { e += 1; scale *= 0.5; }
        outBuf[o] = (byte)Math.Min(255, Math.Floor(r * scale));
        outBuf[o + 1] = (byte)Math.Min(255, Math.Floor(g * scale));
        outBuf[o + 2] = (byte)Math.Min(255, Math.Floor(b * scale));
        outBuf[o + 3] = (byte)(e + 128);
    }

    private static void RlePlane(byte[] src, int w, List<byte> bytes)
    {
        int i = 0;
        while (i < w)
        {
            int runStart = i;
            while (runStart < w)
            {
                int runLen = 1;
                while (runLen < 127 && runStart + runLen < w && src[runStart + runLen] == src[runStart]) runLen++;
                if (runLen >= 4) break;
                runStart += runLen;
            }
            int lit = runStart - i;
            while (lit > 0)
            {
                int n = Math.Min(128, lit);
                bytes.Add((byte)n);
                for (int k = 0; k < n; k++) bytes.Add(src[i + k]);
                i += n;
                lit -= n;
            }
            if (i >= w) break;
            int run = 1;
            while (run < 127 && i + run < w && src[i + run] == src[i]) run++;
            bytes.Add((byte)(128 + run));
            bytes.Add(src[i]);
            i += run;
        }
    }

    public static void WriteRadianceHdr(string filePath, int width, int height, float[] rgbFloat)
    {
        using var stream = new MemoryStream();
        byte[] header = Encoding.ASCII.GetBytes(
            $"#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y {height} +X {width}\n");
        stream.Write(header);
        var line = new byte[width * 4];
        var plane = new byte[width];
        bool rleCapable = width >= 8 && width < 32768;
        var bytes = new List<byte>();
        for (int y = 0; y < height; y++)
        {
            for (int x = 0; x < width; x++)
            {
                int o = (y * width + x) * 3;
                RgbeEncode(rgbFloat[o], rgbFloat[o + 1], rgbFloat[o + 2], line, x * 4);
            }
            if (!rleCapable)
            {
                stream.Write(line);
                continue;
            }
            bytes.Clear();
            bytes.Add(2); bytes.Add(2);
            bytes.Add((byte)((width >> 8) & 0xFF)); bytes.Add((byte)(width & 0xFF));
            for (int c = 0; c < 4; c++)
            {
                for (int x = 0; x < width; x++) plane[x] = line[x * 4 + c];
                RlePlane(plane, width, bytes);
            }
            stream.Write(bytes.ToArray());
        }
        File.WriteAllBytes(filePath, stream.ToArray());
    }

    // -------------------------------------------------------- top level ----
    public sealed class BakeStats
    {
        public int FaceSize;
        public int Width;
        public int Height;
        public double MeanLuminance;
        public double MaxLuminance;
    }

    public static BakeStats ConvertDdsCubemapToEquirectHdr(byte[] ddsBuffer, string outPath, int maxWidth, double[] mult)
    {
        DdsCubemap cube = ReadDdsCubemap(ddsBuffer);
        int width = Math.Min(maxWidth, cube.Size * 4);
        int height = width / 2;
        float[] rgb = BakeEquirect(cube, width, height, mult);
        WriteRadianceHdr(outPath, width, height, rgb);
        double maxL = 0, sumL = 0;
        for (int i = 0; i < rgb.Length; i += 3)
        {
            double l = 0.2126 * rgb[i] + 0.7152 * rgb[i + 1] + 0.0722 * rgb[i + 2];
            if (l > maxL) maxL = l;
            sumL += l;
        }
        return new BakeStats
        {
            FaceSize = cube.Size,
            Width = width,
            Height = height,
            MeanLuminance = sumL / (rgb.Length / 3),
            MaxLuminance = maxL,
        };
    }
}
