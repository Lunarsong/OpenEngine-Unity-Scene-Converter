using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.Loader;
using System.Text;

namespace GameEngine.UnityConverter;

/// Native-facing entry for the editor-hosted converter. The editor's CoreCLR
/// host resolves Run via hostfxr and calls it on a worker thread; each call
/// executes ConvertCli.RunWithIO inside a fresh collectible
/// AssemblyLoadContext so every conversion starts with pristine statics (the
/// G caches deliberately persist across scenes within one run and must NOT
/// persist across runs — the per-process CLI gets that reset for free).
/// Output crosses the boundary through a single write callback; a nonzero
/// callback return requests cooperative cancellation, surfaced by throwing
/// from the writer so the conversion unwinds at its next output line.
///
/// In-process trade (vs the retired subprocess): a converter
/// StackOverflowException or OOM-class failure inside the catch handler
/// fail-fasts the whole editor — the catch-all below contains ordinary
/// exceptions only. Accepted residual of the hosted design; the converter is
/// pure managed single-threaded code, which keeps that class remote.
///
/// Cancellation contract: the native callback must KEEP returning nonzero
/// once cancelled (sticky). RunWithIO's catch-all writes the first
/// OperationCanceledException to stderr, and only a re-triggered cancel on
/// that write preserves exit 130 — a one-shot cancel flag would silently
/// degrade cancellation to exit 1.
public static class EditorHost
{
    // Keep in sync with kConverterCancelExitCode in
    // Apps/Editor/Include/Editor/UnityImportHostedConverter.h.
    private const int kExitCancelled = 130;
    private const int kExitHostFailure = 254;

    private const int kStreamStdout = 1;
    private const int kStreamStderr = 2;

    /// writeFn: int32 (*)(void* user, int32 stream, const uint8_t* utf8, int32 len)
    /// returning 0 to continue or nonzero to request cancellation.
    /// argvUtf8 is a '\0'-separated UTF-8 block of argvByteLen bytes; empty
    /// entries are dropped by the decoder (the editor never produces them).
    [UnmanagedCallersOnly]
    public static int Run(nint argvUtf8, int argvByteLen, nint writeFn, nint user)
    {
        var stdout = new CallbackWriter(writeFn, user, kStreamStdout);
        var stderr = new CallbackWriter(writeFn, user, kStreamStderr);
        try
        {
            string[] argv = DecodeArgv(argvUtf8, argvByteLen);
            var alc = new AssemblyLoadContext("UnityConverterRun", isCollectible: true);
            try
            {
                Assembly asm = alc.LoadFromAssemblyPath(typeof(EditorHost).Assembly.Location);
                MethodInfo run = asm.GetType(typeof(ConvertCli).FullName!)!
                    .GetMethod(nameof(ConvertCli.RunWithIO), BindingFlags.Public | BindingFlags.Static)!;
                return (int)run.Invoke(null, [argv, stdout, stderr])!;
            }
            finally
            {
                alc.Unload();
                // Unload is asynchronous and the run's G caches can hold a
                // whole pack's parsed state; collect now so back-to-back
                // imports don't plateau on Gen2 latency.
                GC.Collect();
                GC.WaitForPendingFinalizers();
            }
        }
        catch (Exception ex)
        {
            if (IsCancellation(ex)) return kExitCancelled;
            try
            {
                stderr.Write("hosted converter failure: " + ex + "\n");
            }
            catch (OperationCanceledException)
            {
                return kExitCancelled;
            }
            return kExitHostFailure;
        }
    }

    private static bool IsCancellation(Exception ex) =>
        ex is OperationCanceledException ||
        (ex is TargetInvocationException tie && tie.InnerException is OperationCanceledException);

    private static unsafe string[] DecodeArgv(nint argvUtf8, int byteLen)
    {
        if (argvUtf8 == 0 || byteLen <= 0) return [];
        var bytes = new ReadOnlySpan<byte>((void*)argvUtf8, byteLen);
        var args = new List<string>();
        int start = 0;
        for (int i = 0; i <= bytes.Length; i++)
        {
            if (i == bytes.Length || bytes[i] == 0)
            {
                if (i > start) args.Add(Encoding.UTF8.GetString(bytes[start..i]));
                start = i + 1;
            }
        }
        return [.. args];
    }
}

/// TextWriter over the native write callback: UTF-8 out, one callback per
/// Write call, unbuffered (the converter emits whole '\n'-terminated lines,
/// so the editor sees each protocol line as it happens). A nonzero callback
/// return means the editor requested cancellation.
internal sealed class CallbackWriter : TextWriter
{
    private readonly nint m_WriteFn;
    private readonly nint m_User;
    private readonly int m_Stream;

    public CallbackWriter(nint writeFn, nint user, int stream)
    {
        m_WriteFn = writeFn;
        m_User = user;
        m_Stream = stream;
        NewLine = "\n";
    }

    public override Encoding Encoding => Encoding.UTF8;

    public override void Write(char value) => Write(value.ToString());

    public override void Write(char[] buffer, int index, int count) =>
        Write(new string(buffer, index, count));

    public override unsafe void Write(string? value)
    {
        if (string.IsNullOrEmpty(value)) return;
        byte[] bytes = Encoding.UTF8.GetBytes(value);
        fixed (byte* p = bytes)
        {
            var fn = (delegate* unmanaged<nint, int, nint, int, int>)m_WriteFn;
            if (fn(m_User, m_Stream, (nint)p, bytes.Length) != 0)
                throw new OperationCanceledException("editor requested cancellation");
        }
    }

    public override void Flush()
    {
        // Unbuffered; must never throw (called from RunWithIO's finally after
        // a cancellation has already poisoned the write path).
    }
}
