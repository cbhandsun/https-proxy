Set-StrictMode -Version Latest

function Initialize-HpmSchemaCaptureProcess {
    if ('HpmSchemaCaptureProcess' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading.Tasks;
public static class HpmSchemaCaptureProcess {
    // Limit the transport bytes before decoding, independently on both pipes.
    // Without a BOM the only accepted encoding is strict UTF-8; never use ACP.
    private static async Task<string> Read(Stream stream, int maximumBytes) {
        using (var result = new MemoryStream()) {
            var buffer = new byte[1024];
            int count;
            while ((count = await stream.ReadAsync(buffer, 0, buffer.Length)) != 0) {
                if (result.Length + count > maximumBytes) throw new InvalidOperationException();
                result.Write(buffer, 0, count);
            }
            var bytes = result.ToArray();
            int offset = 0;
            Encoding encoding = new UTF8Encoding(false, true);
            if (bytes.Length >= 4 &&
                ((bytes[0] == 255 && bytes[1] == 254 && bytes[2] == 0 && bytes[3] == 0) ||
                 (bytes[0] == 0 && bytes[1] == 0 && bytes[2] == 254 && bytes[3] == 255)))
                throw new InvalidOperationException();
            if (bytes.Length >= 3 && bytes[0] == 239 && bytes[1] == 187 && bytes[2] == 191)
                offset = 3;
            else if (bytes.Length >= 2 && bytes[0] == 255 && bytes[1] == 254) {
                encoding = new UnicodeEncoding(false, false, true);
                offset = 2;
            } else if (bytes.Length >= 2 && bytes[0] == 254 && bytes[1] == 255) {
                encoding = new UnicodeEncoding(true, false, true);
                offset = 2;
            }
            var text = encoding.GetString(bytes, offset, bytes.Length - offset);
            if (text.IndexOf('\0') >= 0) throw new InvalidOperationException();
            return text;
        }
    }
    public static object Run(string executable, string[] arguments, int deadlineMs, int maximumBytes, object job) {
        using (var process = new Process()) {
            process.StartInfo = new ProcessStartInfo(executable) {
                UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = job != null
            };
            foreach (var argument in arguments) process.StartInfo.ArgumentList.Add(argument);
            bool started = false, assigned = false;
            try {
                if (!process.Start()) throw new InvalidOperationException();
                started = true;
                if (job != null) {
                    job.GetType().GetMethod("Assign").Invoke(job, new object[] { process });
                    assigned = true;
                    process.StandardInput.Write("1");
                    process.StandardInput.Close();
                }
                var output = Read(process.StandardOutput.BaseStream, maximumBytes);
                var error = Read(process.StandardError.BaseStream, maximumBytes);
                var clock = Stopwatch.StartNew();
                Stopwatch drain = null;
                while (!process.WaitForExit(20) || !output.IsCompleted || !error.IsCompleted) {
                    if (process.HasExited && drain == null) drain = Stopwatch.StartNew();
                    if (clock.ElapsedMilliseconds >= deadlineMs || (drain != null && drain.ElapsedMilliseconds >= 5000) || output.IsFaulted || error.IsFaulted)
                        throw new InvalidOperationException();
                }
                var text = output.GetAwaiter().GetResult();
                error.GetAwaiter().GetResult();
                return new { ExitCode = process.ExitCode, Output = text };
            } catch {
                throw new InvalidOperationException("persistent_io_schema_failed");
            } finally {
                bool cleanupFailed = false;
                if (job != null) {
                    try { job.GetType().GetMethod("StopAndWait").Invoke(job, new object[] { 5000 }); }
                    catch { cleanupFailed = true; }
                    finally {
                        try { ((IDisposable)job).Dispose(); }
                        catch { cleanupFailed = true; }
                    }
                }
                if (started) {
                    try {
                        if (!assigned && !process.HasExited) process.Kill(true);
                        if (!process.WaitForExit(5000)) cleanupFailed = true;
                    } catch { cleanupFailed = true; }
                }
                if (cleanupFailed) throw new InvalidOperationException("persistent_io_schema_cleanup_failed");
            }
        }
    }
}
'@
}

function Invoke-HpmSchemaCaptureProcess([string]$Executable, [string[]]$Arguments,[int]$DeadlineMs,[int]$MaximumBytes,$OwnedJob=$null) {
    if ($DeadlineMs -notin @(30000,600000) -or $MaximumBytes -notin @(16384,2097152)) { throw 'persistent_io_schema_failed' }
    Initialize-HpmSchemaCaptureProcess
    try { return [HpmSchemaCaptureProcess]::Run($Executable, $Arguments, $DeadlineMs, $MaximumBytes, $OwnedJob) }
    catch { if ($_.Exception.GetBaseException().Message -ceq 'persistent_io_schema_cleanup_failed') { throw 'persistent_io_schema_cleanup_failed' }; throw 'persistent_io_schema_failed' }
}

Export-ModuleMember -Function Invoke-HpmSchemaCaptureProcess,Initialize-HpmSchemaCaptureProcess
