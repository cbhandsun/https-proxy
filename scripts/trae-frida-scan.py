#!/usr/bin/env python
import json
import sys
import time

try:
    import frida
except Exception as exc:
    print(json.dumps({
        "ok": False,
        "error": "frida is not importable",
        "detail": str(exc),
    }, ensure_ascii=False, indent=2))
    sys.exit(1)


JS = r"""
const needles = [
  "LLMClientRequestRaw",
  "LLMRawChatMessage",
  "api/ide/v2/llm_raw_chat",
  "api/agent/v3/create_agent_task",
  "request body",
  "response body",
];

function safeLower(value) {
  return String(value || "").toLowerCase();
}

function interestingModule(module) {
  const name = safeLower(module.name);
  const path = safeLower(module.path);
  return name.includes("ai_agent") ||
    name.includes("aha") ||
    name.includes("network") ||
    name.includes("ssl") ||
    name.includes("crypto") ||
    name.includes("trae") ||
    path.includes("trae");
}

function interestingExport(exp) {
  const name = safeLower(exp.name);
  const moduleName = safeLower(exp.moduleName);
  return name.includes("http") ||
    name.includes("fetch") ||
    name.includes("request") ||
    name.includes("response") ||
    name.includes("send") ||
    name.includes("stream") ||
    name.includes("agent") ||
    name.includes("aha") ||
    name.includes("llm") ||
    moduleName.includes("http") ||
    moduleName.includes("winhttp") ||
    moduleName.includes("wininet") ||
    moduleName.includes("websocket") ||
    moduleName.includes("cronet") ||
    moduleName.includes("ssl");
}

function enumerateExports(module) {
  const attempts = [
    () => module.enumerateExports && module.enumerateExports(),
    () => Process.getModuleByName && Process.getModuleByName(module.name).enumerateExports(),
    () => typeof Module !== "undefined" && Module.enumerateExportsSync && Module.enumerateExportsSync(module.name),
    () => typeof Module !== "undefined" && Module.enumerateExports && Module.enumerateExports(module.name),
  ];
  const errors = [];
  for (const attempt of attempts) {
    try {
      const value = attempt();
      if (value) return { items: value, errors };
    } catch (err) {
      errors.push(String(err));
    }
  }
  return { items: [], errors };
}

function enumerateImports(module) {
  const attempts = [
    () => module.enumerateImports && module.enumerateImports(),
    () => Process.getModuleByName && Process.getModuleByName(module.name).enumerateImports(),
    () => typeof Module !== "undefined" && Module.enumerateImportsSync && Module.enumerateImportsSync(module.name),
    () => typeof Module !== "undefined" && Module.enumerateImports && Module.enumerateImports(module.name),
  ];
  const errors = [];
  for (const attempt of attempts) {
    try {
      const value = attempt();
      if (value) return { items: value, errors };
    } catch (err) {
      errors.push(String(err));
    }
  }
  return { items: [], errors };
}

const modules = Process.enumerateModules();
const interesting = modules.filter(interestingModule).map((m) => ({
  name: m.name,
  path: m.path,
  base: String(m.base),
  size: m.size
}));

const nativeBoundaryByModule = [];
for (const m of modules) {
  const lname = safeLower(m.name);
  if (!lname.includes("ai_agent") && !lname.includes("aha")) continue;
  const exportResult = enumerateExports(m);
  const importResult = enumerateImports(m);
  const exports = exportResult.items
    .filter(interestingExport)
    .slice(0, 120)
    .map((item) => ({ name: item.name, type: item.type, address: String(item.address) }));
  const imports = importResult.items
    .filter(interestingExport)
    .slice(0, 120)
    .map((item) => ({
      name: item.name,
      type: item.type,
      module: item.module || item.moduleName || "",
      address: item.address ? String(item.address) : "",
    }));
  nativeBoundaryByModule.push({
    module: m.name,
    path: m.path,
    exportCount: exportResult.items.length,
    importCount: importResult.items.length,
    exports,
    imports,
    exportErrors: exportResult.errors.slice(0, 3),
    importErrors: importResult.errors.slice(0, 3),
  });
}

function scanNeedle(module, needle) {
  const pattern = Array.prototype.map.call(needle, (ch) => ch.charCodeAt(0).toString(16).padStart(2, "0")).join(" ");
  try {
    const matches = Memory.scanSync(module.base, module.size, pattern).slice(0, 8);
    return matches.map((item) => String(item.address));
  } catch (err) {
    return [];
  }
}

const memoryNeedles = [];
for (const m of modules) {
  const lname = safeLower(m.name);
  if (!lname.includes("ai_agent")) continue;
  for (const needle of needles) {
    const matches = scanNeedle(m, needle);
    if (matches.length) memoryNeedles.push({ module: m.name, needle, matches });
  }
}

send({
  pid: Process.id,
  arch: Process.arch,
  platform: Process.platform,
  modules: interesting,
  nativeBoundaryByModule,
  memoryNeedles,
});
"""


def on_message(messages, payload):
    if messages.get("type") == "send":
        print(json.dumps(messages.get("payload"), ensure_ascii=False, indent=2))
    else:
        print(json.dumps(messages, ensure_ascii=False, indent=2))


def main():
    device = frida.get_local_device()
    processes = [p for p in device.enumerate_processes() if "trae" in p.name.lower()]
    if not processes:
        print(json.dumps({"ok": False, "error": "No Trae process found"}, ensure_ascii=False, indent=2))
        return 1

    print(json.dumps({
        "ok": True,
        "processes": [{"pid": p.pid, "name": p.name} for p in processes],
    }, ensure_ascii=False, indent=2))

    for process in processes:
        print(f"--- attach {process.pid} {process.name}", flush=True)
        try:
            session = device.attach(process.pid)
            script = session.create_script(JS)
            script.on("message", on_message)
            script.load()
            time.sleep(0.4)
            session.detach()
        except Exception as exc:
            print(json.dumps({
                "pid": process.pid,
                "name": process.name,
                "error": str(exc),
            }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
