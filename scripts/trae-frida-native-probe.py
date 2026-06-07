#!/usr/bin/env python
"""
Attach-only Trae native network probe.

Default mode is intentionally redacted: it reports call boundaries, request
method/path, byte lengths, and protocol-keyword hints without printing request
bodies, headers, prompts, or tokens. Use --capture-preview only for a local,
short diagnostic run when you are prepared to handle sensitive data.
"""
import argparse
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


def build_js(capture_preview, max_preview):
    return r"""
const capturePreview = __CAPTURE_PREVIEW__;
const maxPreview = __MAX_PREVIEW__;
const protocolNeedles = [
  "api/agent/v3/create_agent_task",
  "api/agent/v3/commit_toolcall_result",
  "api/agent/v3/resume_agent_task",
  "api/agent/v3/llm_utils_chattrae",
  "api/ide/v1/llm_raw_chat",
  "api/ide/v2/llm_raw_chat",
  "LLMClientRequestRaw",
  "LLMRawChatMessage",
  "LLMRawMessage",
  "messages",
  "model",
  "tools",
  "tool_calls",
];

const connectMeta = {};
const requestMeta = {};

function lower(value) {
  return String(value || "").toLowerCase();
}

function moduleLoaded(name) {
  try {
    return Process.findModuleByName(name) !== null;
  } catch (_) {
    return false;
  }
}

function findExport(moduleName, exportName) {
  try {
    const mod = Process.findModuleByName(moduleName);
    if (!mod) return null;
    const exp = mod.enumerateExports().find((item) => item.name === exportName);
    return exp ? exp.address : null;
  } catch (_) {
    return null;
  }
}

function wide(ptrValue) {
  try {
    if (ptrValue.isNull()) return "";
    return ptrValue.readUtf16String() || "";
  } catch (_) {
    return "";
  }
}

function cstr(ptrValue) {
  try {
    if (ptrValue.isNull()) return "";
    return ptrValue.readCString() || "";
  } catch (_) {
    return "";
  }
}

function safePath(value) {
  const text = String(value || "");
  if (!text) return "";
  if (/^eyJ[A-Za-z0-9_-]+/i.test(text) || /token|authorization|cookie/i.test(text)) return "<redacted>";
  const noQuery = text.split("?")[0];
  return noQuery.length > 180 ? noQuery.slice(0, 180) + "..." : noQuery;
}

function summarizeText(value) {
  const text = String(value || "");
  const hasUrl = /https?:\/\//i.test(text);
  const isMethod = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/i.test(text);
  const isHeaderName = /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(text);
  const safeHeaderNames = new Set([
    "accept",
    "accept-encoding",
    "accept-language",
    "content-length",
    "content-type",
    "origin",
    "referer",
    "sec-fetch-dest",
    "sec-fetch-mode",
    "sec-fetch-site",
    "sec-ch-ua",
    "sec-ch-ua-mobile",
    "sec-ch-ua-platform",
    "user-agent",
    "x-request-id",
    "x-tt-logid",
    "x-lgw-req-sdk-type",
    "x-net-sdk-domain-dispatch",
    "x-ttnet-bypass-decompression",
    "x-ttnet-bypass-cookie",
  ]);
  const looksSensitive = /^eyJ[A-Za-z0-9_-]+/i.test(text) ||
    /(authorization|bearer|api[_-]?key|token|access[_-]?token|refresh[_-]?token|cookie|secret)/i.test(text);
  const result = {
    length: text.length,
    hasUrl,
    hasProtocolNeedle: protocolNeedles.some((needle) => text.includes(needle)),
    kind: isMethod ? "http-method" : hasUrl ? "url" : isHeaderName ? "header-name-or-token-key" : "string",
  };
  if (capturePreview) {
    result.preview = redactPreview(text);
  } else if (isMethod) {
    result.value = text.toUpperCase();
  } else if (hasUrl) {
    result.value = safePath(text);
  } else if (isHeaderName && safeHeaderNames.has(lower(text)) && !looksSensitive) {
    result.value = text;
  } else if (looksSensitive) {
    result.redacted = true;
  }
  return result;
}

function redactPreview(text) {
  let value = String(text || "");
  value = value.replace(/(authorization|bearer|api[_-]?key|token|access[_-]?token|refresh[_-]?token|cookie)["'\s:=]+[^"',}\s]+/ig, "$1=<redacted>");
  value = value.replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-<redacted>");
  value = value.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "jwt-<redacted>");
  value = value.replace(/\s+/g, " ").trim();
  return value.length > maxPreview ? value.slice(0, maxPreview) + "..." : value;
}

function inspectBuffer(bufferPtr, length) {
  const len = Number(length) || 0;
  const result = {
    length: len,
    readable: false,
    startsLikeJson: false,
    hasProtocolNeedle: false,
    hasUrl: false,
    printableRatio: null,
  };
  if (!bufferPtr || bufferPtr.isNull() || len <= 0 || len > 8 * 1024 * 1024) return result;
  const sampleLen = Math.min(len, 4096);
  try {
    const bytes = new Uint8Array(bufferPtr.readByteArray(sampleLen));
    let printable = 0;
    let text = "";
    for (const byte of bytes) {
      if ((byte >= 32 && byte <= 126) || byte === 9 || byte === 10 || byte === 13) {
        printable += 1;
        text += String.fromCharCode(byte);
      } else {
        text += " ";
      }
    }
    const compact = text.replace(/\s+/g, " ").trim();
    result.readable = true;
    result.printableRatio = sampleLen ? Number((printable / sampleLen).toFixed(3)) : null;
    result.startsLikeJson = compact.startsWith("{") || compact.startsWith("[");
    result.hasUrl = /https?:\/\//i.test(compact);
    result.hasProtocolNeedle = protocolNeedles.some((needle) => compact.includes(needle));
    if (capturePreview) result.preview = redactPreview(compact);
  } catch (_) {
    return result;
  }
  return result;
}

function inspectPossibleString(ptrValue) {
  const raw = cstr(ptrValue) || wide(ptrValue);
  const text = String(raw || "");
  const result = {
    pointer: String(ptrValue),
    readable: Boolean(text),
    length: text.length,
    hasUrl: /https?:\/\//i.test(text),
    hasProtocolNeedle: protocolNeedles.some((needle) => text.includes(needle)),
  };
  if (capturePreview && text) result.preview = redactPreview(text);
  return result;
}

function emit(event) {
  send(Object.assign({
    pid: Process.id,
    at: Date.now(),
  }, event));
}

function attach(moduleName, exportName, hooks) {
  const address = findExport(moduleName, exportName);
  if (!address) return false;
  try {
    Interceptor.attach(address, hooks);
    emit({ event: "hooked", module: moduleName, export: exportName, address: String(address) });
    return true;
  } catch (err) {
    emit({ event: "hook_error", module: moduleName, export: exportName, error: String(err) });
    return false;
  }
}

function hookWinHttp() {
  if (!moduleLoaded("ai_agent.dll")) return 0;
  let count = 0;
  if (attach("winhttp.dll", "WinHttpConnect", {
    onEnter(args) {
      this.server = wide(args[1]);
      this.port = Number(args[2].toInt32());
    },
    onLeave(retval) {
      if (!retval.isNull()) connectMeta[String(retval)] = { server: this.server, port: this.port };
      emit({ event: "WinHttpConnect", handle: String(retval), server: this.server, port: this.port });
    }
  })) count += 1;

  if (attach("winhttp.dll", "WinHttpOpenRequest", {
    onEnter(args) {
      this.connect = String(args[0]);
      this.method = wide(args[1]);
      this.path = safePath(wide(args[2]));
    },
    onLeave(retval) {
      const connect = connectMeta[this.connect] || {};
      if (!retval.isNull()) {
        requestMeta[String(retval)] = {
          server: connect.server || "",
          port: connect.port || 0,
          method: this.method,
          path: this.path,
        };
      }
      emit({
        event: "WinHttpOpenRequest",
        handle: String(retval),
        server: connect.server || "",
        port: connect.port || 0,
        method: this.method,
        path: this.path,
      });
    }
  })) count += 1;

  if (attach("winhttp.dll", "WinHttpSendRequest", {
    onEnter(args) {
      const handle = String(args[0]);
      const meta = requestMeta[handle] || {};
      emit({
        event: "WinHttpSendRequest",
        handle,
        meta,
        headerChars: Number(args[2].toInt32()),
        optionalLength: Number(args[4].toInt32()),
        totalLength: Number(args[5].toInt32()),
        optional: inspectBuffer(args[3], args[4].toInt32()),
      });
    }
  })) count += 1;

  if (attach("winhttp.dll", "WinHttpWriteData", {
    onEnter(args) {
      const handle = String(args[0]);
      emit({
        event: "WinHttpWriteData",
        handle,
        meta: requestMeta[handle] || {},
        data: inspectBuffer(args[1], args[2].toInt32()),
      });
    }
  })) count += 1;
  return count;
}

function hookAhaNet() {
  if (!moduleLoaded("aha_net.dll")) return 0;
  let count = 0;
  if (attach("aha_net.dll", "AhaNet_fetch", {
    onEnter(args) {
      emit({
        event: "AhaNet_fetch",
        args: [0, 1, 2, 3, 4, 5].map((index) => inspectPossibleString(args[index])),
      });
    }
  })) count += 1;
  if (attach("aha_net.dll", "AhaNet_WsClient_send", {
    onEnter(args) {
      emit({
        event: "AhaNet_WsClient_send",
        client: String(args[0]),
        arg1: inspectPossibleString(args[1]),
        arg2: inspectPossibleString(args[2]),
      });
    }
  })) count += 1;
  if (attach("sscronet.dll", "Cronet_HttpHeader_name_set", {
    onEnter(args) {
      emit({
        event: "Cronet_HttpHeader_name_set",
        header: String(args[0]),
        text: summarizeText(cstr(args[1])),
      });
    }
  })) count += 1;
  if (attach("sscronet.dll", "Cronet_HttpHeader_value_set", {
    onEnter(args) {
      const value = cstr(args[1]);
      emit({
        event: "Cronet_HttpHeader_value_set",
        header: String(args[0]),
        valueLength: value.length,
        valueHasProtocolNeedle: protocolNeedles.some((needle) => value.includes(needle)),
        text: summarizeText(value),
      });
    }
  })) count += 1;
  if (attach("sscronet.dll", "Cronet_UrlRequestParams_http_method_set", {
    onEnter(args) {
      emit({
        event: "Cronet_UrlRequestParams_http_method_set",
        params: String(args[0]),
        text: summarizeText(cstr(args[1])),
      });
    }
  })) count += 1;
  if (attach("sscronet.dll", "Cronet_UrlRequestParams_upload_data_provider_set", {
    onEnter(args) {
      emit({
        event: "Cronet_UrlRequestParams_upload_data_provider_set",
        params: String(args[0]),
        provider: String(args[1]),
      });
    }
  })) count += 1;
  if (attach("sscronet.dll", "Cronet_UrlRequest_InitWithParams", {
    onEnter(args) {
      emit({
        event: "Cronet_UrlRequest_InitWithParams",
        request: String(args[0]),
        url: summarizeText(cstr(args[2])),
        params: String(args[3]),
      });
    }
  })) count += 1;
  if (attach("sscronet.dll", "Cronet_UrlRequest_Start", {
    onEnter(args) {
      emit({
        event: "Cronet_UrlRequest_Start",
        request: String(args[0]),
      });
    }
  })) count += 1;
  if (attach("sscronet.dll", "Cronet_WSClient_AsyncSendBinary", {
    onEnter(args) {
      emit({
        event: "Cronet_WSClient_AsyncSendBinary",
        client: String(args[0]),
        arg1: inspectPossibleString(args[1]),
        arg2: inspectPossibleString(args[2]),
        arg3: inspectPossibleString(args[3]),
      });
    }
  })) count += 1;
  return count;
}

const hooks = hookWinHttp() + hookAhaNet();
emit({
  event: "ready",
  hooks,
  hasAiAgent: moduleLoaded("ai_agent.dll"),
  hasAhaNet: moduleLoaded("aha_net.dll"),
  modules: Process.enumerateModules()
    .filter((m) => lower(m.name).includes("ai_agent") || lower(m.name).includes("aha") || lower(m.name).includes("winhttp"))
    .map((m) => ({ name: m.name, path: m.path, base: String(m.base), size: m.size })),
});
""".replace("__CAPTURE_PREVIEW__", "true" if capture_preview else "false").replace("__MAX_PREVIEW__", str(max_preview))


def parse_args():
    parser = argparse.ArgumentParser(description="Attach to Trae native network boundaries with redacted output by default.")
    parser.add_argument("--pid", type=int, default=0, help="Attach to one Trae PID. Run trae-frida-scan.py first to identify ai_agent.dll or aha_net.dll PIDs.")
    parser.add_argument("--all", action="store_true", help="Attach to every Trae.exe process. This can hang if a process refuses injection.")
    parser.add_argument("--duration", type=float, default=45.0, help="Seconds to keep hooks active.")
    parser.add_argument("--capture-preview", action="store_true", help="Print redacted string/body previews. May still contain sensitive data.")
    parser.add_argument("--max-preview", type=int, default=240, help="Maximum preview characters when --capture-preview is enabled.")
    return parser.parse_args()


def main():
    args = parse_args()
    device = frida.get_local_device()
    if args.pid:
        processes = [p for p in device.enumerate_processes() if p.pid == args.pid]
    elif args.all:
        processes = [p for p in device.enumerate_processes() if "trae" in p.name.lower()]
    else:
        trae_processes = [p for p in device.enumerate_processes() if "trae" in p.name.lower()]
        print(json.dumps({
            "ok": False,
            "error": "Pass --pid for a targeted hook run, or --all for a best-effort all-process run.",
            "hint": "Run: python scripts/trae-frida-scan.py, then choose the PID that has ai_agent.dll or aha_net.dll.",
            "processes": [{"pid": p.pid, "name": p.name} for p in trae_processes],
        }, ensure_ascii=False, indent=2), flush=True)
        return 2
    if not processes:
        print(json.dumps({"ok": False, "error": "No Trae process found"}, ensure_ascii=False, indent=2))
        return 1

    print(json.dumps({
        "ok": True,
        "mode": "preview" if args.capture_preview else "redacted",
        "durationSeconds": args.duration,
        "processes": [{"pid": p.pid, "name": p.name} for p in processes],
    }, ensure_ascii=False), flush=True)

    sessions = []

    def on_message(message, payload):
        if message.get("type") == "send":
            print(json.dumps(message.get("payload"), ensure_ascii=False), flush=True)
        else:
            print(json.dumps(message, ensure_ascii=False), flush=True)

    source = build_js(args.capture_preview, args.max_preview)
    for process in processes:
        try:
            session = device.attach(process.pid)
            script = session.create_script(source)
            script.on("message", on_message)
            script.load()
            sessions.append(session)
        except Exception as exc:
            print(json.dumps({
                "pid": process.pid,
                "name": process.name,
                "error": str(exc),
            }, ensure_ascii=False), flush=True)

    if not sessions:
        return 1

    try:
        time.sleep(max(args.duration, 0.5))
    finally:
        for session in sessions:
            try:
                session.detach()
            except Exception:
                pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
