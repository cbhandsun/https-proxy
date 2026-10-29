using System;
using System.IO;
using System.Threading.Tasks;

// Console stdout may be a synchronous OS pipe. Explicitly schedule blocking
// writes off the controller thread so parent/deadline/Job cleanup stays live.
// There is only one outstanding frame; callers poll its Task with fixed clocks.
public static class HpmN09IpcWriter {
    public static Task WriteAndFlushAsync(Stream stream, byte[] bytes) {
        if (stream == null || bytes == null || bytes.Length > 16384)
            throw new InvalidOperationException("n09_ipc_io_failed");
        return Task.Run(() => {
            stream.Write(bytes, 0, bytes.Length);
            stream.Flush();
        });
    }
}
