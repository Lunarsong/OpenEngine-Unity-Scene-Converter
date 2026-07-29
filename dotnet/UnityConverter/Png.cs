using System.IO.Compression;

namespace GameEngine.UnityConverter;

/// Minimal PNG decoder for ColorLookup LUT strips — port of convert.js
/// decodePng. Scope: 8/16-bit truecolor (color types 2 RGB / 6 RGBA),
/// non-interlaced. Error strings are part of the parity surface (they land in
/// the drop-note report), so they must match the JS twin byte-for-byte.
///
/// Hostile-input hardening (mirrors the JS reference semantics exactly):
/// chunk lengths are UNSIGNED and offset math is done in long, so a declared
/// length like 0xFFFFFFF4 advances past the buffer and falls out of the loop
/// (JS: off becomes a large double and the while condition ends) instead of
/// wrapping negative and wedging the loop; dimensions are unsigned and
/// bounded to the largest possible LUT strip; inflate output is capped at the
/// byte count the bounded IHDR declares; a zlib stream cut mid-deflate is an
/// inflate failure (Node throws there, .NET alone returns partial output);
/// every inflate failure normalizes to one fixed string (underlying zlib
/// messages differ between Node and .NET).
internal sealed class PngImage
{
    public int Width;
    public int Height;
    public int Channels;
    public int BitDepth;
    public byte[] Px = [];
}

internal static class Png
{
    public static PngImage DecodePng(byte[] buf)
    {
        if (buf.Length < 8 || buf[0] != 0x89 || buf[1] != 0x50 || buf[2] != 0x4e || buf[3] != 0x47)
            throw new InvalidDataException("not a PNG");
        long w = 0, h = 0;
        int bitDepth = 0, colorType = 0;
        using var idat = new MemoryStream();
        int off = 8;
        while (off + 8 <= buf.Length)
        {
            long len = ReadU32(buf, off);
            string type = System.Text.Encoding.Latin1.GetString(buf, off + 4, 4);
            int dataAt = off + 8;
            int dataLen = (int)Math.Min(len, buf.Length - dataAt);
            if (type == "IHDR")
            {
                if (dataLen < 13) throw new InvalidDataException("truncated PNG chunk");
                w = ReadU32(buf, dataAt);
                h = ReadU32(buf, dataAt + 4);
                bitDepth = buf[dataAt + 8];
                colorType = buf[dataAt + 9];
                if (buf[dataAt + 12] != 0) throw new InvalidDataException("interlaced PNG not supported");
                if (colorType != 2 && colorType != 6) throw new InvalidDataException($"PNG color type {colorType} not supported (need truecolor RGB/RGBA)");
                if (bitDepth != 8 && bitDepth != 16) throw new InvalidDataException($"PNG bit depth {bitDepth} not supported");
                // Hostile-input bound: LUT strips are at most 256^3 (65536x256).
                // Also what makes the inflate cap below trustworthy.
                if (w > 65536 || h > 256) throw new InvalidDataException($"PNG dimensions {w}x{h} not supported (LUT strips are at most 65536x256)");
            }
            else if (type == "IDAT") idat.Write(buf, dataAt, dataLen);
            else if (type == "IEND") break;
            // len + type + crc (crc not verified; zlib integrity covers the
            // pixels). Strictly advances >= 12; an overrunning declared length
            // exits the loop like the JS twin's out-of-range offset does.
            long next = (long)off + 12 + len;
            if (next > buf.Length) break;
            off = (int)next;
        }
        if (w == 0 || h == 0 || idat.Length == 0) throw new InvalidDataException("missing IHDR/IDAT");
        int channels = colorType == 6 ? 4 : 3;
        int bpp = channels * (bitDepth >> 3);
        int stride = (int)w * bpp;
        int expected = (int)h * (stride + 1);
        byte[] raw = Inflate(idat.ToArray(), expected);
        if (raw.Length < expected) throw new InvalidDataException("truncated PNG pixel data");
        // Un-filter (spec filters 0-4). Recon works on BYTES regardless of depth.
        byte[] px = new byte[(int)h * stride];
        for (int y = 0; y < h; y++)
        {
            int f = raw[y * (stride + 1)];
            int lineAt = y * (stride + 1) + 1;
            int outAt = y * stride, prevAt = outAt - stride;
            for (int x = 0; x < stride; x++)
            {
                int a = x >= bpp ? px[outAt + x - bpp] : 0;
                int b = y > 0 ? px[prevAt + x] : 0;
                int c = x >= bpp && y > 0 ? px[prevAt + x - bpp] : 0;
                int v = raw[lineAt + x];
                if (f == 1) v += a;
                else if (f == 2) v += b;
                else if (f == 3) v += (a + b) >> 1;
                else if (f == 4)
                {
                    int p = a + b - c, pa = Math.Abs(p - a), pb = Math.Abs(p - b), pc = Math.Abs(p - c);
                    v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
                }
                else if (f != 0) throw new InvalidDataException($"bad PNG filter {f}");
                px[outAt + x] = (byte)(v & 0xff);
            }
        }
        return new PngImage { Width = (int)w, Height = (int)h, Channels = channels, BitDepth = bitDepth, Px = px };
    }

    private static long ReadU32(byte[] buf, int at) =>
        ((long)buf[at] << 24) | ((long)buf[at + 1] << 16) | ((long)buf[at + 2] << 8) | buf[at + 3];

    // zlib.inflateSync(..., { maxOutputLength: expected }) twin: decompress a
    // raw zlib (RFC 1950) stream into at most `expected` bytes. Producing MORE
    // than `expected` throws (Node throws past maxOutputLength); a stream that
    // ends cleanly on LESS returns the short buffer (the caller reports
    // truncated pixel data); a stream that never ends throws like Node does.
    // Every failure normalizes to the same fixed string as the JS twin.
    private static byte[] Inflate(byte[] compressed, int expected)
    {
        try
        {
            using var src = new IdatSource(compressed);
            using var z = new ZLibStream(src, CompressionMode.Decompress);
            byte[] outBuf = new byte[expected];
            int at = 0;
            while (at < expected)
            {
                int n = z.Read(outBuf, at, expected - at);
                if (n == 0) break;
                at += n;
            }
            if (at == expected && z.ReadByte() != -1)
                throw new InvalidDataException("output past declared size");
            // Node's inflateSync returns only on a stream that reached
            // Z_STREAM_END and throws ("unexpected end of file") on one cut
            // mid-deflate; .NET's ZLibStream hands back the partial output
            // silently instead. DeflateStream re-reads its source ONLY while
            // the zlib stream is unfinished, so a read past the end of the IDAT
            // payload is exactly the "never terminated" signal — measured on
            // net9.0/net10.0: every cut of a valid stream trips it (including
            // one missing only its 4-byte Adler-32, which still yields all
            // `expected` bytes and would otherwise be accepted silently), and
            // no complete stream trips it, at any internal-buffer boundary.
            if (src.ReadPastEnd)
                throw new InvalidDataException("zlib stream never terminated");
            return at == expected ? outBuf : outBuf[..at];
        }
        catch (Exception)
        {
            throw new InvalidDataException("PNG inflate failed");
        }
    }

    /// IDAT payload reader that records the inflater asking for input past the
    /// end of the payload. MemoryStream routes Read(Span) back through the array
    /// overload for derived types, so this override observes every read.
    private sealed class IdatSource(byte[] data) : MemoryStream(data, writable: false)
    {
        public bool ReadPastEnd { get; private set; }

        public override int Read(byte[] buffer, int offset, int count)
        {
            int n = base.Read(buffer, offset, count);
            if (n == 0 && count > 0) ReadPastEnd = true;
            return n;
        }
    }
}
