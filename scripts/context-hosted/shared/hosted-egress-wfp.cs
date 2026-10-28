using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;

// Harness-only dynamic WFP session. Never called by the installed application.
// Native layouts/constants follow Windows SDK 10.0.26100 fwpmtypes.h/fwptypes.h.
public sealed class HpmHostedEgressLease : IDisposable {
    [StructLayout(LayoutKind.Sequential)] internal struct Display { internal IntPtr name, description; }
    [StructLayout(LayoutKind.Sequential)] internal struct Blob { internal uint size; internal IntPtr data; }
    [StructLayout(LayoutKind.Explicit)] internal struct Union {
        [FieldOffset(0)] internal uint number;
        [FieldOffset(0)] internal IntPtr pointer;
    }
    [StructLayout(LayoutKind.Sequential)] internal struct Value { internal uint type; internal Union value; }
    [StructLayout(LayoutKind.Sequential)] internal struct Session {
        internal Guid key; internal Display display; internal uint flags, timeout, pid;
        internal IntPtr sid, username; internal int kernel;
    }
    [StructLayout(LayoutKind.Sequential)] internal struct Sublayer {
        internal Guid key; internal Display display; internal uint flags;
        internal IntPtr provider; internal Blob data; internal ushort weight;
    }
    [StructLayout(LayoutKind.Sequential)] internal struct Condition {
        internal Guid field; internal uint match; internal Value value;
    }
    [StructLayout(LayoutKind.Sequential)] internal struct Action {
        internal uint type; internal Guid key;
    }
    [StructLayout(LayoutKind.Explicit, Size = 16)] internal struct Context {
        [FieldOffset(0)] internal ulong raw;
        [FieldOffset(0)] internal Guid provider;
    }
    [StructLayout(LayoutKind.Sequential)] internal struct Filter {
        internal Guid key; internal Display display; internal uint flags; internal IntPtr provider;
        internal Blob data; internal Guid layer, sublayer; internal Value weight;
        internal uint count; internal IntPtr conditions; internal Action action;
        internal Context context; internal IntPtr reserved; internal ulong id; internal Value effectiveWeight;
    }
    internal interface Api {
        uint Open(ref Session session, out IntPtr engine);
        uint AppId(string program, out IntPtr blob);
        uint AddSublayer(IntPtr engine, ref Sublayer sublayer);
        uint AddFilter(IntPtr engine, ref Filter filter, out ulong id);
        uint GetFilter(IntPtr engine, ulong id, out IntPtr filter);
        void Free(ref IntPtr memory);
        uint Close(IntPtr engine);
    }
    private sealed class Native : Api {
        [DllImport("fwpuclnt.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] private static extern uint FwpmEngineOpen0(string server, uint authentication, IntPtr identity, ref Session session, out IntPtr engine);
        [DllImport("fwpuclnt.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] private static extern uint FwpmGetAppIdFromFileName0(string program, out IntPtr blob);
        [DllImport("fwpuclnt.dll")] private static extern uint FwpmSubLayerAdd0(IntPtr engine, ref Sublayer sublayer, IntPtr security);
        [DllImport("fwpuclnt.dll")] private static extern uint FwpmFilterAdd0(IntPtr engine, ref Filter filter, IntPtr security, out ulong id);
        [DllImport("fwpuclnt.dll")] private static extern uint FwpmFilterGetById0(IntPtr engine, ulong id, out IntPtr filter);
        [DllImport("fwpuclnt.dll")] private static extern void FwpmFreeMemory0(ref IntPtr memory);
        [DllImport("fwpuclnt.dll")] private static extern uint FwpmEngineClose0(IntPtr engine);
        public uint Open(ref Session session, out IntPtr engine) { return FwpmEngineOpen0(null, 10, IntPtr.Zero, ref session, out engine); }
        public uint AppId(string program, out IntPtr blob) { return FwpmGetAppIdFromFileName0(program, out blob); }
        public uint AddSublayer(IntPtr engine, ref Sublayer sublayer) { return FwpmSubLayerAdd0(engine, ref sublayer, IntPtr.Zero); }
        public uint AddFilter(IntPtr engine, ref Filter filter, out ulong id) { return FwpmFilterAdd0(engine, ref filter, IntPtr.Zero, out id); }
        public uint GetFilter(IntPtr engine, ulong id, out IntPtr filter) { return FwpmFilterGetById0(engine, id, out filter); }
        public void Free(ref IntPtr memory) { FwpmFreeMemory0(ref memory); }
        public uint Close(IntPtr engine) { return FwpmEngineClose0(engine); }
    }
    private static readonly Guid AppField = new Guid("d78e1e87-8644-4ea5-9437-d809ecefc971");
    private static readonly Guid RemoteField = new Guid("b235ae9a-1d64-49b8-a44c-5ff3d9095045");
    private static readonly Guid V4 = new Guid("c38d57d1-05a7-4c33-904f-7fbceee60e82");
    private static readonly Guid V6 = new Guid("4a72393b-319f-44bc-84c3-ba54dcb3b6b4");
    // Keep a failed-to-close scope alive until process exit. BFE removes its
    // dynamic session on disconnection; ordinary firewall containment remains.
    private static readonly List<HpmHostedEgressLease> Live = new List<HpmHostedEgressLease>();
    private readonly Api api;
    private IntPtr engine;
    public static int LastFailurePhase { get; private set; }
    private static Exception Rejected() { return new InvalidOperationException("hosted_egress_wfp_rejected"); }
    private static void Check(uint status) { if (status != 0) throw Rejected(); }
    public static bool ValidateAbi() {
        return IntPtr.Size == 8 && Marshal.SizeOf<Session>() == 72 && Marshal.SizeOf<Sublayer>() == 72 &&
            Marshal.SizeOf<Condition>() == 40 && Marshal.SizeOf<Filter>() == 200 &&
            Marshal.OffsetOf<Filter>("conditions").ToInt32() == 120 &&
            Marshal.OffsetOf<Filter>("context").ToInt32() == 152;
    }
    internal static string Guard(string program) {
        LastFailurePhase = 1;
        try {
            if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows) || !ValidateAbi() ||
                Environment.GetEnvironmentVariable("GITHUB_ACTIONS") != "true" ||
                Environment.GetEnvironmentVariable("RUNNER_ENVIRONMENT") != "github-hosted" ||
                Environment.GetEnvironmentVariable("RUNNER_OS") != "Windows") throw Rejected();
            string temp = Environment.GetEnvironmentVariable("RUNNER_TEMP");
            if (String.IsNullOrEmpty(program) || String.IsNullOrEmpty(temp)) throw Rejected();
            string full = Path.GetFullPath(program), root = Path.GetFullPath(temp).TrimEnd('\\');
            bool approved = false;
            foreach (string scenario in new [] { "n08", "n09", "n09-sending-ack", "n09-finished-ack" }) {
                string expected = Path.Combine(root, "hpm-context-" + scenario, "payload", "runtime", "node", "node.exe");
                if (String.Equals(program, full, StringComparison.Ordinal) && String.Equals(full, expected, StringComparison.OrdinalIgnoreCase)) approved = true;
            }
            if (!approved || full.StartsWith("\\\\", StringComparison.Ordinal)) throw Rejected();
            return PhysicalProgram(full);
        } catch { throw Rejected(); }
    }
    private static string PhysicalProgram(string full) {
        string current = full;
        bool first = true;
        while (!String.IsNullOrEmpty(current)) {
            FileAttributes attributes = File.GetAttributes(current);
            if ((attributes & FileAttributes.ReparsePoint) != 0 ||
                (first ? (attributes & FileAttributes.Directory) != 0 : (attributes & FileAttributes.Directory) == 0)) throw Rejected();
            first = false;
            current = Path.GetDirectoryName(current);
        }
        return full;
    }
    internal static string GuardInstalledClient(string program) {
        LastFailurePhase = 1;
        try {
            if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows) || !ValidateAbi() ||
                Environment.GetEnvironmentVariable("GITHUB_ACTIONS") != "true" ||
                Environment.GetEnvironmentVariable("RUNNER_ENVIRONMENT") != "github-hosted" ||
                Environment.GetEnvironmentVariable("RUNNER_OS") != "Windows") throw Rejected();
            string temp = Environment.GetEnvironmentVariable("RUNNER_TEMP");
            if (String.IsNullOrEmpty(program) || String.IsNullOrEmpty(temp) || program.Length > 4096 || temp.Length > 4096 ||
                !Path.IsPathFullyQualified(program) || !Path.IsPathFullyQualified(temp) ||
                program.IndexOfAny(new [] {'\0', '\r', '\n'}) >= 0 || temp.IndexOfAny(new [] {'\0', '\r', '\n'}) >= 0) throw Rejected();
            string full = Path.GetFullPath(program), root = Path.GetFullPath(temp).TrimEnd('\\');
            if (root.Length < 3 || !String.Equals(program, full, StringComparison.Ordinal) ||
                !String.Equals(temp.TrimEnd('\\'), root, StringComparison.Ordinal) ||
                full.StartsWith("\\\\", StringComparison.Ordinal) || root.StartsWith("\\\\", StringComparison.Ordinal)) throw Rejected();
            string installed = Path.Combine(root, "hpm-installed-clients");
            bool approved = false;
            foreach (string relative in new [] {Path.Combine("payload", "runtime", "node", "node.exe"),
                Path.Combine("clients", "codex.exe"), Path.Combine("clients", "claude.exe")}) {
                if (String.Equals(full, Path.Combine(installed, relative), StringComparison.OrdinalIgnoreCase)) approved = true;
            }
            if (!approved) throw Rejected();
            return PhysicalProgram(full);
        } catch { throw Rejected(); }
    }
    public HpmHostedEgressLease(string program) : this(Guard(program), new Native()) { }
    public static HpmHostedEgressLease ForInstalledClient(string program) {
        return new HpmHostedEgressLease(GuardInstalledClient(program), new Native());
    }
    // Same-assembly fixture injection only. No public factory accepts a backend.
    internal static HpmHostedEgressLease ForInstalledClient(string program, Api backend) {
        return new HpmHostedEgressLease(GuardInstalledClient(program), backend);
    }
    // Same-assembly fixture injection only; the public entry always guards first.
    internal HpmHostedEgressLease(string program, Api backend) {
        api = backend;
        IntPtr app = IntPtr.Zero;
        IntPtr display = IntPtr.Zero;
        try {
            LastFailurePhase = 2;
            if (!ValidateAbi() || api == null) throw Rejected();
            display = Marshal.StringToHGlobalUni("HPM disposable owned egress");
            Session session = new Session { key = Guid.NewGuid(), flags = 1, display = new Display {name = display} };
            LastFailurePhase = 3;
            Check(api.Open(ref session, out engine));
            if (engine == IntPtr.Zero) throw Rejected();
            lock (Live) Live.Add(this);
            LastFailurePhase = 4;
            Check(api.AppId(program, out app));
            if (app == IntPtr.Zero) throw Rejected();
            Blob identity = Marshal.PtrToStructure<Blob>(app);
            if (identity.size < 2 || identity.size > 65536 || identity.data == IntPtr.Zero) throw Rejected();
            Sublayer sublayer = new Sublayer { key = Guid.NewGuid(), weight = UInt16.MaxValue, display = new Display {name = display} };
            LastFailurePhase = 5;
            Check(api.AddSublayer(engine, ref sublayer));
            Add(V4, sublayer.key, app, display, true);
            Add(V6, sublayer.key, app, display, false);
            LastFailurePhase = 0;
        } catch {
            // A partial filter set must never be treated as containment.
            int primaryPhase = LastFailurePhase;
            try { Dispose(); } catch { /* retained scope; caller still fails */ }
            LastFailurePhase = primaryPhase;
            throw Rejected();
        } finally {
            if (app != IntPtr.Zero) api.Free(ref app);
            if (display != IntPtr.Zero) Marshal.FreeHGlobal(display);
        }
    }
    private void Add(Guid layer, Guid sublayer, IntPtr app, IntPtr display, bool ipv4) {
        int stride = Marshal.SizeOf<Condition>();
        IntPtr conditions = Marshal.AllocHGlobal(stride * (ipv4 ? 2 : 1));
        IntPtr observed = IntPtr.Zero;
        try {
            Condition application = new Condition { field = AppField, match = 0, value = new Value { type = 12, value = new Union { pointer = app } } };
            Marshal.StructureToPtr(application, conditions, false);
            if (ipv4) {
                Condition remote = new Condition { field = RemoteField, match = 10, value = new Value { type = 3, value = new Union { number = 0x7f000001 } } };
                Marshal.StructureToPtr(remote, IntPtr.Add(conditions, stride), false);
            }
            Filter filter = new Filter { key = Guid.NewGuid(), layer = layer, sublayer = sublayer,
                count = ipv4 ? 2u : 1u, conditions = conditions, action = new Action { type = 0x1001 }, display = new Display {name = display} };
            ulong id;
            LastFailurePhase = ipv4 ? 6 : 8;
            Check(api.AddFilter(engine, ref filter, out id));
            if (id == 0) throw Rejected();
            LastFailurePhase = ipv4 ? 7 : 9;
            Check(api.GetFilter(engine, id, out observed));
            if (observed == IntPtr.Zero) throw Rejected();
            LastFailurePhase = 10;
            Filter actual = Marshal.PtrToStructure<Filter>(observed);
            LastFailurePhase = 12;
            if (actual.id != id || actual.key != filter.key) throw Rejected();
            LastFailurePhase = 13;
            if (actual.layer != layer || actual.sublayer != sublayer) throw Rejected();
            LastFailurePhase = 14;
            // INDEXED (SDK 0x40) changes lookup optimization, not rule semantics.
            // Persistent, disabled, permit-if-unregistered and unknown flags fail.
            if ((actual.flags & ~0x40u) != 0) throw Rejected();
            LastFailurePhase = 15;
            if (actual.action.type != 0x1001) throw Rejected();
            LastFailurePhase = 16;
            if (actual.count != filter.count || actual.conditions == IntPtr.Zero) throw Rejected();
            bool sawApp = false, sawRemote = false;
            for (int index = 0; index < filter.count; index++) {
                Condition seen = Marshal.PtrToStructure<Condition>(IntPtr.Add(actual.conditions, stride * index));
                LastFailurePhase = 17;
                // WFP owns the returned representation; condition identity is
                // its field GUID, not the position in the submitted array.
                if (seen.field == AppField && !sawApp) {
                    sawApp = true;
                    LastFailurePhase = 18;
                    if (seen.match != 0) throw Rejected();
                    LastFailurePhase = 19;
                    if (seen.value.type != 12 || seen.value.value.pointer == IntPtr.Zero) throw Rejected();
                    LastFailurePhase = 20;
                    Blob original = Marshal.PtrToStructure<Blob>(app), copy = Marshal.PtrToStructure<Blob>(seen.value.value.pointer);
                    if (copy.size != original.size || copy.data == IntPtr.Zero) throw Rejected();
                    byte[] before = new byte[original.size], after = new byte[copy.size];
                    Marshal.Copy(original.data, before, 0, before.Length); Marshal.Copy(copy.data, after, 0, after.Length);
                    LastFailurePhase = 21;
                    for (int offset = 0; offset < before.Length; offset++) if (before[offset] != after[offset]) throw Rejected();
                } else if (ipv4 && seen.field == RemoteField && !sawRemote) {
                    sawRemote = true;
                    LastFailurePhase = 18;
                    if (seen.match != 10) throw Rejected();
                    LastFailurePhase = 19;
                    if (seen.value.type != 3) throw Rejected();
                    LastFailurePhase = 22;
                    if (seen.value.value.number != 0x7f000001) throw Rejected();
                } else throw Rejected();
            }
            LastFailurePhase = 17;
            if (!sawApp || (ipv4 && !sawRemote)) throw Rejected();
        } finally {
            if (observed != IntPtr.Zero) api.Free(ref observed);
            Marshal.FreeHGlobal(conditions);
        }
    }
    public void Dispose() {
        if (engine == IntPtr.Zero) return;
        LastFailurePhase = 11;
        try { Check(api.Close(engine)); } catch { throw Rejected(); }
        engine = IntPtr.Zero;
        lock (Live) Live.Remove(this);
        LastFailurePhase = 0;
    }
}
