using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;

public static class HpmHostedEgressFixture {
    private sealed class Fake : HpmHostedEgressLease.Api {
        internal string fail;
        internal int closed, added, read;
        internal string program;
        private IntPtr blob, data;
        private HpmHostedEgressLease.Filter pending;
        internal HashSet<IntPtr> allocations = new HashSet<IntPtr>();
        private Dictionary<IntPtr,IntPtr> conditionCopies = new Dictionary<IntPtr,IntPtr>();
        private static void Require(bool accepted) { if (!accepted) throw new Exception("fixture_assertion_failed"); }
        public uint Open(ref HpmHostedEgressLease.Session session, out IntPtr engine) {
            Require(session.flags == 1 && session.key != Guid.Empty);
            engine = fail == "open" || fail == "engine-null" ? IntPtr.Zero : new IntPtr(123);
            return fail == "open" ? 5u : 0u;
        }
        public uint AppId(string program, out IntPtr app) {
            this.program = program;
            app = IntPtr.Zero;
            if (fail == "appid") return 5;
            if (fail == "appid-null") return 0;
            data = Marshal.AllocHGlobal(4); allocations.Add(data);
            Marshal.WriteInt32(data, 0x12345678);
            blob = Marshal.AllocHGlobal(Marshal.SizeOf<HpmHostedEgressLease.Blob>()); allocations.Add(blob);
            Marshal.StructureToPtr(new HpmHostedEgressLease.Blob {size = fail == "appid-size" ? UInt32.MaxValue : 4, data = data}, blob, false);
            app = blob;
            return 0;
        }
        public uint AddSublayer(IntPtr engine, ref HpmHostedEgressLease.Sublayer sublayer) {
            Require(sublayer.flags == 0 && sublayer.weight == UInt16.MaxValue && sublayer.key != Guid.Empty);
            return fail == "sublayer" ? 5u : 0u;
        }
        public uint AddFilter(IntPtr engine, ref HpmHostedEgressLease.Filter filter, out ulong id) {
            added++;
            Require(filter.flags == 0 && filter.action.type == 0x1001 && filter.count == (added == 1 ? 2u : 1u));
            Require(filter.layer == new Guid(added == 1 ? "c38d57d1-05a7-4c33-904f-7fbceee60e82" : "4a72393b-319f-44bc-84c3-ba54dcb3b6b4"));
            HpmHostedEgressLease.Condition application = Marshal.PtrToStructure<HpmHostedEgressLease.Condition>(filter.conditions);
            Require(application.field == new Guid("d78e1e87-8644-4ea5-9437-d809ecefc971") && application.match == 0 && application.value.type == 12 && application.value.value.pointer == blob);
            if (added == 1) {
                HpmHostedEgressLease.Condition remote = Marshal.PtrToStructure<HpmHostedEgressLease.Condition>(IntPtr.Add(filter.conditions, Marshal.SizeOf<HpmHostedEgressLease.Condition>()));
                Require(remote.field == new Guid("b235ae9a-1d64-49b8-a44c-5ff3d9095045") && remote.match == 10 && remote.value.type == 3 && remote.value.value.number == 0x7f000001);
            }
            pending = filter;
            id = fail == "id-zero" ? 0 : (ulong)added;
            pending.id = id;
            return fail == "add" + added ? 5u : 0u;
        }
        public uint GetFilter(IntPtr engine, ulong id, out IntPtr filter) {
            read++;
            filter = IntPtr.Zero;
            if (fail == "read" + read) return 5;
            if (fail == "read-null") return 0;
            filter = Marshal.AllocHGlobal(Marshal.SizeOf<HpmHostedEgressLease.Filter>()); allocations.Add(filter);
            HpmHostedEgressLease.Filter observed = pending;
            if (fail == "mismatch") observed.action.type = 0x1002;
            if (fail == "filter-count") observed.count = UInt32.MaxValue;
            if (fail == "indexed") observed.flags = 0x40;
            if (fail == "disabled") observed.flags = 0x20;
            if (fail == "persistent") observed.flags = 1;
            if (fail == "unknownflags") observed.flags = 0x80000000;
            int stride = Marshal.SizeOf<HpmHostedEgressLease.Condition>();
            IntPtr copy = Marshal.AllocHGlobal(stride * (int)pending.count); allocations.Add(copy);
            conditionCopies[filter] = copy;
            for (int index = 0; index < pending.count; index++) {
                int originalIndex = fail == "reordered" && pending.count == 2 ? 1 - index : index;
                if (fail == "duplicate") originalIndex = 0;
                HpmHostedEgressLease.Condition condition = Marshal.PtrToStructure<HpmHostedEgressLease.Condition>(IntPtr.Add(pending.conditions,stride * originalIndex));
                if (fail == "wrongremote" && originalIndex == 1) condition.value.value.number = 0x0100007f;
                Marshal.StructureToPtr(condition,IntPtr.Add(copy,stride * index),false);
            }
            observed.conditions = copy;
            Marshal.StructureToPtr(observed, filter, false);
            return 0;
        }
        public void Free(ref IntPtr memory) {
            IntPtr copy;
            if (conditionCopies.TryGetValue(memory,out copy)) { Require(allocations.Remove(copy)); Marshal.FreeHGlobal(copy); conditionCopies.Remove(memory); }
            Require(allocations.Remove(memory));
            Marshal.FreeHGlobal(memory);
            if (memory == blob) { Require(allocations.Remove(data)); Marshal.FreeHGlobal(data); }
            memory = IntPtr.Zero;
        }
        public uint Close(IntPtr engine) {
            Require(engine == new IntPtr(123));
            closed++;
            return fail == "close" && closed == 1 ? 5u : 0u;
        }
    }
    private static void Require(bool accepted) { if (!accepted) throw new Exception("fixture_assertion_failed"); }
    private static int GuardPaths() {
        string root = Path.Combine(Path.GetTempPath(), "hpm-wfp-guard-" + Guid.NewGuid().ToString("N"));
        var saved = new Dictionary<string,string>();
        foreach (string key in new [] {"GITHUB_ACTIONS", "RUNNER_ENVIRONMENT", "RUNNER_OS", "RUNNER_TEMP"}) saved[key] = Environment.GetEnvironmentVariable(key);
        int checkedPaths = 0;
        try {
            Directory.CreateDirectory(root);
            Environment.SetEnvironmentVariable("GITHUB_ACTIONS", "true");
            Environment.SetEnvironmentVariable("RUNNER_ENVIRONMENT", "github-hosted");
            Environment.SetEnvironmentVariable("RUNNER_OS", "Windows");
            Environment.SetEnvironmentVariable("RUNNER_TEMP", root);
            foreach (string scenario in new [] {"n08", "n09", "n09-sending-ack"}) {
                string node = Path.Combine(root, "hpm-context-" + scenario, "payload", "runtime", "node", "node.exe");
                Directory.CreateDirectory(Path.GetDirectoryName(node));
                File.WriteAllText(node, "synthetic inert file");
                Require(HpmHostedEgressLease.Guard(node) == node); checkedPaths++;
                string traversal = Path.Combine(Path.GetDirectoryName(node), "..", "node", "node.exe");
                foreach (string invalid in new [] {traversal, Path.Combine(root, "other.exe"), "\\\\server\\node.exe", "relative.exe"}) {
                    try { HpmHostedEgressLease.Guard(invalid); throw new Exception("fixture_missing_rejection"); }
                    catch (InvalidOperationException error) { Require(error.Message == "hosted_egress_wfp_rejected"); checkedPaths++; }
                }
            }
        } finally {
            foreach (var entry in saved) Environment.SetEnvironmentVariable(entry.Key, entry.Value);
            string full = Path.GetFullPath(root), parent = Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar);
            Require(Path.GetDirectoryName(full) == parent && Path.GetFileName(full).StartsWith("hpm-wfp-guard-", StringComparison.Ordinal));
            if (Directory.Exists(full)) { Require((File.GetAttributes(full) & FileAttributes.ReparsePoint) == 0); Directory.Delete(full, true); }
        }
        return checkedPaths;
    }
    public static string Run() {
        Require(HpmHostedEgressLease.ValidateAbi());
        var normal = new Fake();
        var lease = new HpmHostedEgressLease("synthetic-program", normal);
        Require(normal.added == 2 && normal.read == 2 && normal.closed == 0 && normal.allocations.Count == 0);
        lease.Dispose(); lease.Dispose();
        Require(normal.closed == 1);
        foreach (string canonical in new [] {"indexed", "reordered"}) {
            var representation = new Fake {fail = canonical};
            var canonicalLease = new HpmHostedEgressLease("synthetic-program", representation);
            canonicalLease.Dispose();
            Require(representation.closed == 1 && representation.allocations.Count == 0);
        }
        int rejected = 0;
        foreach (string stage in new [] {"open", "engine-null", "appid", "appid-null", "appid-size", "sublayer", "add1", "id-zero", "read1", "read-null", "add2", "read2", "mismatch", "filter-count", "disabled", "persistent", "unknownflags", "duplicate", "wrongremote"}) {
            var broken = new Fake {fail = stage};
            try { new HpmHostedEgressLease("synthetic-program", broken); throw new Exception("fixture_missing_rejection"); }
            catch (InvalidOperationException error) { Require(error.Message == "hosted_egress_wfp_rejected"); rejected++; }
            Require(HpmHostedEgressLease.LastFailurePhase >= 3 && HpmHostedEgressLease.LastFailurePhase <= 22);
            Require(broken.closed == (stage == "open" || stage == "engine-null" ? 0 : 1) && broken.allocations.Count == 0);
        }
        var close = new Fake {fail = "close"};
        var retry = new HpmHostedEgressLease("synthetic-program", close);
        try { retry.Dispose(); throw new Exception("fixture_missing_rejection"); }
        catch (InvalidOperationException error) { Require(error.Message == "hosted_egress_wfp_rejected"); }
        retry.Dispose(); Require(close.closed == 2);
        foreach (string invalid in new [] {null, "", "relative.exe", "PRIVATE_PROGRAM_SENTINEL", new string('x', 40000)}) {
            try { new HpmHostedEgressLease(invalid); throw new Exception("fixture_missing_rejection"); }
            catch (InvalidOperationException error) { Require(error.Message == "hosted_egress_wfp_rejected"); rejected++; }
        }
        return "wfpSyntheticRejected=" + rejected + "; nativeWfpCalls=0; networkRequests=0; guardedPaths=" + GuardPaths();
    }
    public static string RunInstalledClients() {
        Require(HpmHostedEgressLease.ValidateAbi());
        int publicFactories = 0;
        foreach (var method in typeof(HpmHostedEgressLease).GetMethods(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static)) {
            if (method.Name != "ForInstalledClient") continue;
            publicFactories++;
            Require(method.GetParameters().Length == 1 && method.GetParameters()[0].ParameterType == typeof(string));
        }
        Require(publicFactories == 1);
        try { HpmHostedEgressLease.ForInstalledClient(null); throw new Exception("fixture_missing_rejection"); }
        catch (InvalidOperationException error) { Require(error.Message == "hosted_egress_wfp_rejected"); }
        string root = Path.Combine(Path.GetTempPath(), "hpm-wfp-client-" + Guid.NewGuid().ToString("N"));
        var saved = new Dictionary<string,string>();
        foreach (string key in new [] {"GITHUB_ACTIONS", "RUNNER_ENVIRONMENT", "RUNNER_OS", "RUNNER_TEMP"}) saved[key] = Environment.GetEnvironmentVariable(key);
        int accepted = 0, rejected = 0, leases = 0;
        bool windows = RuntimeInformation.IsOSPlatform(OSPlatform.Windows);
        Action<string> refuse = program => {
            var backend = new Fake();
            try { HpmHostedEgressLease.ForInstalledClient(program, backend); throw new Exception("fixture_missing_rejection"); }
            catch (InvalidOperationException error) { Require(error.Message == "hosted_egress_wfp_rejected"); rejected++; }
            Require(backend.added == 0 && backend.closed == 0 && backend.allocations.Count == 0);
        };
        try {
            Directory.CreateDirectory(root);
            Environment.SetEnvironmentVariable("GITHUB_ACTIONS", "true");
            Environment.SetEnvironmentVariable("RUNNER_ENVIRONMENT", "github-hosted");
            Environment.SetEnvironmentVariable("RUNNER_OS", "Windows");
            Environment.SetEnvironmentVariable("RUNNER_TEMP", root);
            string installed = Path.Combine(root, "hpm-installed-clients");
            var live = new List<HpmHostedEgressLease>();
            var backends = new List<Fake>();
            foreach (string relative in new [] {Path.Combine("payload", "runtime", "node", "node.exe"), Path.Combine("clients", "codex.exe"), Path.Combine("clients", "claude.exe")}) {
                string program = Path.Combine(installed, relative);
                Directory.CreateDirectory(Path.GetDirectoryName(program)); File.WriteAllText(program, "synthetic inert file");
                if (windows) {
                    Require(HpmHostedEgressLease.GuardInstalledClient(program) == program); accepted++;
                } else refuse(program);
                // Non-Windows still exercises the existing native-layout algorithm
                // with a fake; this never grants a Windows path-guard witness.
                var backend = new Fake();
                live.Add(windows ? HpmHostedEgressLease.ForInstalledClient(program, backend) : new HpmHostedEgressLease(program, backend)); backends.Add(backend); leases++;
                Require(backend.program == program && backend.added == 2 && backend.read == 2 && backend.closed == 0 && backend.allocations.Count == 0);
                var broken = new Fake {fail = "read2"};
                try {
                    if (windows) HpmHostedEgressLease.ForInstalledClient(program, broken); else new HpmHostedEgressLease(program, broken);
                    throw new Exception("fixture_missing_rejection");
                } catch (InvalidOperationException error) { Require(error.Message == "hosted_egress_wfp_rejected"); }
                Require(broken.closed == 1 && broken.allocations.Count == 0);
                try { HpmHostedEgressLease.Guard(program); throw new Exception("fixture_missing_rejection"); }
                catch (InvalidOperationException error) { Require(error.Message == "hosted_egress_wfp_rejected"); rejected++; }
                refuse(Path.Combine(Path.GetDirectoryName(program), "..", Path.GetFileName(Path.GetDirectoryName(program)), Path.GetFileName(program)));
            }
            for (int index = 0; index < live.Count; index++) {
                live[index].Dispose(); live[index].Dispose(); Require(backends[index].closed == 1);
            }
            foreach (string invalid in new [] {null, "", "relative.exe", "\\\\server\\clients\\codex.exe", "PRIVATE_PROGRAM_SENTINEL", new string('x', 40000),
                Path.Combine(root, "other.exe"), Path.Combine(installed, "clients", "other.exe"), Path.Combine(installed, "payload", "runtime", "node", "codex.exe"),
                Path.Combine(root, "hpm-context-n08", "payload", "runtime", "node", "node.exe")}) refuse(invalid);
            string codex = Path.Combine(installed, "clients", "codex.exe"), claude = Path.Combine(installed, "clients", "claude.exe");
            File.Delete(codex); Directory.CreateDirectory(codex); refuse(codex); Directory.Delete(codex);
            File.CreateSymbolicLink(codex, claude);
            try { refuse(codex); } finally { File.Delete(codex); }
            string clients = Path.Combine(installed, "clients"), realClients = Path.Combine(installed, "real-clients");
            Directory.Move(clients, realClients); Directory.CreateSymbolicLink(clients, realClients);
            try { refuse(claude); } finally { Directory.Delete(clients); Directory.Move(realClients, clients); }
            File.Delete(claude); Directory.Delete(clients); File.WriteAllText(clients, "synthetic ancestor file"); refuse(claude); File.Delete(clients);
            foreach (string key in new [] {"GITHUB_ACTIONS", "RUNNER_ENVIRONMENT", "RUNNER_OS"}) {
                string before = Environment.GetEnvironmentVariable(key); Environment.SetEnvironmentVariable(key, "untrusted");
                refuse(Path.Combine(installed, "payload", "runtime", "node", "node.exe")); Environment.SetEnvironmentVariable(key, before);
            }
            Environment.SetEnvironmentVariable("RUNNER_TEMP", Path.Combine(root, "..", Path.GetFileName(root)));
            refuse(Path.Combine(installed, "payload", "runtime", "node", "node.exe"));
        } finally {
            foreach (var entry in saved) Environment.SetEnvironmentVariable(entry.Key, entry.Value);
            Require(Path.GetDirectoryName(Path.GetFullPath(root)) == Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar));
            if (Directory.Exists(root)) { Require((File.GetAttributes(root) & FileAttributes.ReparsePoint) == 0); Directory.Delete(root, true); }
        }
        return "installedPrograms=" + accepted + "; installedClientRejected=" + rejected + "; syntheticLeases=" + leases + "; nativeWfpCalls=0; networkRequests=0; windowsGuardQualified=" + windows;
    }
}
