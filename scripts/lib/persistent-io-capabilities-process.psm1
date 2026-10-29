Set-StrictMode -Version Latest

function Initialize-HpmCapabilityProcess {
    if ('HpmCapabilityProcess' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading.Tasks;
public static class HpmCapabilityProcess {
    // Limit the transport bytes before decoding, independently on both pipes.
    // Without a BOM the only accepted encoding is strict UTF-8; never use ACP.
    private static async Task<string> Read(Stream stream) {
        using (var result = new MemoryStream()) {
            var buffer = new byte[1024];
            int count;
            while ((count = await stream.ReadAsync(buffer, 0, buffer.Length)) != 0) {
                if (result.Length + count > 16384) throw new InvalidOperationException();
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
    public static string Run(string executable, string[] arguments) {
        using (var process = new Process()) {
            process.StartInfo = new ProcessStartInfo(executable) {
                UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardOutput = true, RedirectStandardError = true
            };
            foreach (var argument in arguments) process.StartInfo.ArgumentList.Add(argument);
            bool started = false;
            try {
                if (!process.Start()) throw new InvalidOperationException();
                started = true;
                var output = Read(process.StandardOutput.BaseStream);
                var error = Read(process.StandardError.BaseStream);
                var clock = Stopwatch.StartNew();
                while (!process.WaitForExit(20) || !output.IsCompleted || !error.IsCompleted) {
                    if (clock.ElapsedMilliseconds >= 5000 || output.IsFaulted || error.IsFaulted)
                        throw new InvalidOperationException();
                }
                if (process.ExitCode != 0) throw new InvalidOperationException();
                var text = output.GetAwaiter().GetResult();
                error.GetAwaiter().GetResult();
                return text;
            } catch {
                throw new InvalidOperationException("persistent_io_capabilities_failed");
            } finally {
                if (started && !process.HasExited) {
                    try { process.Kill(true); }
                    catch { throw new InvalidOperationException("persistent_io_capabilities_cleanup_failed"); }
                    if (!process.WaitForExit(5000))
                        throw new InvalidOperationException("persistent_io_capabilities_cleanup_failed");
                }
            }
        }
    }
}
'@
}

function Invoke-HpmCapabilityProcess([string]$Executable, [string[]]$Arguments) {
    Initialize-HpmCapabilityProcess
    try { return [HpmCapabilityProcess]::Run($Executable, $Arguments) }
    catch { throw 'persistent_io_capabilities_failed' }
}

Export-ModuleMember -Function Invoke-HpmCapabilityProcess
