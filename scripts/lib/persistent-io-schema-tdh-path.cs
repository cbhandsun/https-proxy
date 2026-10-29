using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace HpmIoSchemaTdh {
    public sealed class TracePinFailure : InvalidOperationException {
        public string phase { get; private set; }
        public uint? status { get; private set; }
        internal TracePinFailure(string phase,uint? status=null):base("io_schema_tdh_failed"){this.phase=phase;this.status=status;}
    }
    // Never read or hash ETL bytes. Hold physical identities and deny rename
    // for the complete pathname while the metadata-only consumer runs.
    public sealed class TracePins : IDisposable {
        private static TracePinFailure Failed(string phase,uint? status=null) { return new TracePinFailure(phase,status); }
        public static TracePins OpenOwned(string file) {
            if (!OperatingSystem.IsWindows() || RuntimeInformation.ProcessArchitecture != Architecture.X64 ||
                Environment.GetEnvironmentVariable("CI") != "true" || Environment.GetEnvironmentVariable("GITHUB_ACTIONS") != "true" ||
                Environment.GetEnvironmentVariable("RUNNER_ENVIRONMENT") != "github-hosted" || Environment.GetEnvironmentVariable("RUNNER_OS") != "Windows") throw Failed("path-platform");
            string parent = Environment.GetEnvironmentVariable("RUNNER_TEMP");
            if (String.IsNullOrEmpty(parent) || String.IsNullOrEmpty(file) || !Path.IsPathFullyQualified(file) ||
                file.StartsWith(@"\\", StringComparison.Ordinal) || !String.Equals(file, Path.GetFullPath(file), StringComparison.Ordinal)) throw Failed("path-shape");
            string root = Path.GetDirectoryName(file);
            if (!String.Equals(Path.GetDirectoryName(root), Path.GetFullPath(parent), StringComparison.OrdinalIgnoreCase) ||
                !System.Text.RegularExpressions.Regex.IsMatch(Path.GetFileName(root), "\\Ahpm-io-schema-[a-f0-9]{32}\\z") ||
                Path.GetFileName(file) != "owned.etl") throw Failed("path-shape");
            return new TracePins(file);
        }
        [StructLayout(LayoutKind.Sequential)] internal struct Time {
            public uint Low, High;
        }
        [StructLayout(LayoutKind.Sequential)] internal struct Info {
            public uint Attributes; public Time Created, Accessed, Written;
            public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
        }
        private sealed class Pin {
            internal string Path; internal bool Leaf; internal SafeFileHandle Handle; internal Info Identity;
        }
        [DllImport("kernel32.dll", EntryPoint="CreateFileW", ExactSpelling=true, CharSet=CharSet.Unicode, SetLastError=true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        private static extern SafeFileHandle Open(string path, uint access, uint share, IntPtr security, uint mode, uint flags, IntPtr template);
        [DllImport("kernel32.dll", ExactSpelling=true, SetLastError=true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info value);
        private readonly List<Pin> pins = new List<Pin>();
        internal static bool Matches(Info original, Info value, bool leaf) {
            return value.Volume == original.Volume && value.IndexHigh == original.IndexHigh && value.IndexLow == original.IndexLow &&
                value.Created.Low == original.Created.Low && value.Created.High == original.Created.High &&
                (!leaf || (value.SizeHigh == original.SizeHigh && value.SizeLow == original.SizeLow &&
                    value.Written.Low == original.Written.Low && value.Written.High == original.Written.High));
        }
        private static Info Read(SafeFileHandle handle, bool leaf) {
            Info value;
            if (handle.IsInvalid) throw Failed("path-open");
            if (!GetFileInformationByHandle(handle, out value)) throw Failed("path-information",unchecked((uint)Marshal.GetLastPInvokeError()));
            if ((value.Attributes & 0x400) != 0 || ((value.Attributes & 0x10) == 0) != leaf) throw Failed("path-type");
            if (leaf && value.Links != 1) throw Failed("path-links");
            if (leaf && (value.SizeHigh != 0 || value.SizeLow == 0 || value.SizeLow > 268435456)) throw Failed("path-size");
            return value;
        }
        private static SafeFileHandle Acquire(string path, bool leaf) {
            var handle=Open(path, 0x81, leaf ? 1u : 3u, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
            if(handle.IsInvalid){uint status=unchecked((uint)Marshal.GetLastPInvokeError());handle.Dispose();throw Failed("path-open",status);}
            return handle;
        }
        internal TracePins(string file) {
            try {
                for (string current = file; !String.IsNullOrEmpty(current); current = System.IO.Path.GetDirectoryName(current)) {
                    bool leaf = current == file;
                    var handle = Acquire(current, leaf);
                    try { pins.Add(new Pin { Path = current, Leaf = leaf, Handle = handle, Identity = Read(handle, leaf) }); }
                    catch { handle.Dispose(); throw; }
                }
                Verify();
            } catch { Dispose(); throw; }
        }
        public void Verify() {
            if (pins.Count == 0) throw Failed("path-closed");
            foreach (var pin in pins) {
                using (var current = Acquire(pin.Path, pin.Leaf)) {
                    var value = Read(current, pin.Leaf);
                    if (!Matches(pin.Identity, value, pin.Leaf)) throw Failed("path-identity");
                }
            }
        }
        public void Dispose() {
            bool failed = false;
            for (int i = pins.Count - 1; i >= 0; i--) { try { pins[i].Handle.Dispose(); } catch { failed = true; } }
            pins.Clear();
            if (failed) throw Failed("cleanup");
        }
    }
}
