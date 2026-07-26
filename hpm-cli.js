#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_FILE = path.join(__dirname, 'proxy.config.json');

function getBaseUrl() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const port = config.localServer?.managementPort || 3543;
    return `http://localhost:${port}/v1/local`;
  } catch (e) {
    return 'http://localhost:3543/v1/local';
  }
}

const SERVER_URL = getBaseUrl();

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
};

async function request(path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
    };
    const req = http.request(SERVER_URL + path, options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve(data);
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function getProfilesDirect() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return config.profiles || [];
  } catch (e) {
    return [];
  }
}

async function setActiveDirect(profileId) {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    config.activeProfile = profileId;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
    return true;
  } catch (e) {
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (cmd === 'switch') {
    const target = args[1];
    if (!target) {
      console.log('Usage: hpm switch <profile-name-or-id>');
      return;
    }

    let profiles;
    try {
      const res = await request('/config');
      profiles = res.profiles || [];
    } catch (e) {
      profiles = await getProfilesDirect();
    }

    const profile = profiles.find(
      (p) => p.id === target || p.name.toLowerCase().includes(target.toLowerCase())
    );
    if (!profile) {
      console.error(`Error: Profile "${target}" not found.`);
      return;
    }

    try {
      const res = await request('/active', 'POST', { profileId: profile.id });
      if (res.ok) {
        console.log(
          `Successfully switched to profile: ${colors.green}${profile.name} (${profile.id})${colors.reset}`
        );

        // Smart Sync Logic
        if (profile.defaultPreset) {
          console.log(
            `${colors.cyan}Smart Sync: Automatically applying preset "${profile.defaultPreset}"...${colors.reset}`
          );
          const applyRes = await request('/prompts/presets/apply', 'POST', {
            action: 'apply',
            presetId: profile.defaultPreset,
          });
          if (applyRes.ok) {
            console.log(`  ${colors.green}[OK]${colors.reset} Smart Sync completed.`);
          } else {
            const errorMsg =
              typeof applyRes.error === 'object'
                ? JSON.stringify(applyRes.error)
                : String(applyRes.error);
            console.warn(`  ${colors.yellow}[WARN]${colors.reset} Smart Sync failed: ${errorMsg}`);
          }
        }
      } else {
        throw new Error(res.error || 'Unknown error');
      }
    } catch (e) {
      if (await setActiveDirect(profile.id)) {
        console.log(
          `Successfully switched to profile (via config file): ${profile.name} (${profile.id})`
        );
      } else {
        console.error(`Failed to switch profile: ${e.message}`);
      }
    }
  } else if (cmd === 'list') {
    let profiles;
    let activeId = '';
    try {
      const res = await request('/config');
      profiles = res.profiles || [];
      activeId = res.activeProfile;
    } catch (e) {
      profiles = await getProfilesDirect();
      try {
        activeId = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).activeProfile;
      } catch (e) {}
    }

    console.log(`${colors.bold}Available Profiles:${colors.reset}`);
    profiles.forEach((p) => {
      if (p.id === activeId) {
        console.log(
          `${colors.green}* ${p.name.padEnd(30)} (${p.id}) [${p.protocol}]${colors.reset}`
        );
      } else {
        console.log(`  ${p.name.padEnd(30)} (${p.id}) [${p.protocol}]`);
      }
    });
  } else if (cmd === 'prompt') {
    const target = args[1];
    if (!target) {
      console.log(`${colors.yellow}Usage: hpm prompt <preset-id-or-name>${colors.reset}`);
      return;
    }

    const configRes = await request('/config');
    const presets = configRes.promptPresets || [];
    const preset = presets.find(
      (p) => p.id === target || p.name.toLowerCase().includes(target.toLowerCase())
    );

    if (!preset) {
      console.error(`${colors.red}Error: Prompt preset "${target}" not found.${colors.reset}`);
      if (presets.length > 0) {
        console.log(
          'Available presets:',
          presets.map((p) => `${colors.cyan}${p.name} (${p.id})${colors.reset}`).join(', ')
        );
      }
      return;
    }

    console.log(`${colors.cyan}Applying prompt preset: ${preset.name}...${colors.reset}`);

    try {
      const applyRes = await request('/prompts/presets', 'POST', {
        action: 'apply',
        presetId: preset.id,
      });
      if (applyRes.ok && Array.isArray(applyRes.results)) {
        applyRes.results.forEach((res) => {
          if (res.ok) {
            console.log(`  ${colors.green}[OK]${colors.reset} Synced to ${res.type}`);
          } else {
            console.warn(
              `  ${colors.red}[FAIL]${colors.reset} Failed to sync to ${res.type}: ${res.error}`
            );
          }
        });
      } else {
        throw new Error(applyRes.error || 'Server-side apply failed');
      }
    } catch (e) {
      console.warn(`${colors.yellow}Falling back to client-side sync: ${e.message}${colors.reset}`);
      const tools = ['claude', 'codex', 'gemini', 'antigravity'];
      for (const tool of tools) {
        try {
          const syncRes = await request('/prompts/sync', 'POST', {
            type: tool,
            content: preset.content,
          });
          if (syncRes.ok) {
            console.log(`  ${colors.green}[OK]${colors.reset} Synced to ${tool}`);
          }
        } catch (e) {
          console.warn(
            `  ${colors.red}[FAIL]${colors.reset} Failed to sync to ${tool}: ${e.message}`
          );
        }
      }
    }
    console.log(`${colors.green}Done.${colors.reset}`);
  } else if (cmd === 'mcp') {
    try {
      const res = await request('/mcp-hub');
      const hub = res.mcpHub;
      console.log(`${colors.bold}MCP Hub Configuration:${colors.reset}`);
      console.log(`  Servers: ${colors.cyan}${hub.servers.length}${colors.reset}`);
      hub.servers.forEach((s) =>
        console.log(`    - ${s.name} (${colors.yellow}${s.url}${colors.reset})`)
      );
      console.log(`  Routing Rules: ${colors.cyan} ${hub.routing.length}${colors.reset}`);
      hub.routing.forEach((r) =>
        console.log(
          `    - ${colors.green}${r.toolName || r.pattern}${colors.reset} -> ${colors.yellow}${r.serverId}${colors.reset}`
        )
      );
    } catch (e) {
      console.error(`${colors.red}Failed to get MCP Hub info: ${e.message}${colors.reset}`);
    }
  } else if (cmd === 'mcp-logs') {
    try {
      const res = await request('/mcp-hub/logs');
      console.log(`${colors.cyan}${colors.bold}Recent MCP Tool Executions:${colors.reset}\n`);
      if (res.logs.length === 0) console.log('  No logs found.');
      res.logs.forEach((l) => {
        const statusColor = l.status === 'success' ? colors.green : colors.red;
        console.log(
          `[${new Date(l.time).toLocaleTimeString()}] ${statusColor}${l.status.toUpperCase()}${colors.reset} ${colors.bold}${l.toolName}${colors.reset} (${l.elapsed}ms)`
        );
        console.log(`  Server: ${l.serverId}`);
        console.log(`  Input:  ${JSON.stringify(l.input)}`);
        if (l.error) console.log(`  Error:  ${colors.red}${l.error}${colors.reset}`);
        console.log('');
      });
    } catch (e) {
      console.error(`${colors.red}Failed to get MCP logs: ${e.message}${colors.reset}`);
    }
  } else if (cmd === 'usage') {
    try {
      const res = await request('/usage/summary');
      const usage = res.usage;
      console.log(`${colors.cyan}${colors.bold}Token Usage Summary:${colors.reset}\n`);
      console.log(
        `  Total Input:  ${colors.yellow}${usage.totalInput.toLocaleString()}${colors.reset}`
      );
      console.log(
        `  Total Output: ${colors.yellow}${usage.totalOutput.toLocaleString()}${colors.reset}`
      );
      console.log(
        `  Total Tokens: ${colors.green}${(usage.totalInput + usage.totalOutput).toLocaleString()}${colors.reset}\n`
      );

      console.log(`${colors.bold}By Profile:${colors.reset}`);
      Object.entries(usage.byProfile).forEach(([id, data]) => {
        console.log(`  - ${colors.cyan}${id}${colors.reset}: ${data.input + data.output} tokens`);
        Object.entries(data.models).forEach(([model, mData]) => {
          console.log(
            `      ${model.padEnd(30)}: ${mData.input + mData.output} (In: ${mData.input}, Out: ${mData.output})`
          );
        });
      });
    } catch (e) {
      console.error(`${colors.red}Failed to get usage stats: ${e.message}${colors.reset}`);
    }
  } else if (cmd === 'log') {
    console.log(`${colors.cyan}Tailing proxy logs... (Ctrl+C to stop)${colors.reset}\n`);

    const fetchLogs = async () => {
      try {
        const res = await request('/log?lines=20');
        const lines = typeof res === 'string' ? res.split('\n') : [];
        lines.forEach((line) => {
          if (!line.trim()) return;
          console.log(line);
        });
      } catch (e) {
        console.error(`${colors.red}Error fetching logs: ${e.message}${colors.reset}`);
      }
    };

    fetchLogs();
    setInterval(fetchLogs, 3000);
    return; // Keep process alive
  } else if (cmd === 'doctor') {
    console.log(`${colors.cyan}${colors.bold}HPM Doctor - System Diagnostics${colors.reset}\n`);

    // 1. Check Config File
    if (fs.existsSync(CONFIG_FILE)) {
      console.log(`${colors.green}[OK]${colors.reset} Configuration file found.`);
      try {
        const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        console.log(`     Active Profile: ${colors.yellow}${config.activeProfile}${colors.reset}`);
        console.log(
          `     Management Port: ${colors.yellow}${config.localServer?.managementPort || 3543}${colors.reset}`
        );
      } catch (e) {
        console.log(`${colors.red}[ERROR]${colors.reset} Configuration file is not valid JSON.`);
      }
    } else {
      console.log(`${colors.red}[ERROR]${colors.reset} Configuration file missing.`);
    }

    // 2. Check Server
    try {
      const res = await request('/health');
      console.log(`${colors.green}[OK]${colors.reset} Proxy server is running (v${res.version}).`);
      console.log(`     Uptime: ${res.uptimeSec}s`);
    } catch (e) {
      console.log(
        `${colors.red}[ERROR]${colors.reset} Proxy server is not reachable on ${SERVER_URL}.`
      );
    }

    // 3. Check CA Cert
    const certPath = path.join(__dirname, 'data', 'certs', 'ca.crt');
    if (fs.existsSync(certPath)) {
      console.log(`${colors.green}[OK]${colors.reset} Root CA certificate found.`);
    } else {
      console.log(
        `${colors.yellow}[WARN]${colors.reset} Root CA certificate not found. HTTPS interception may not work.`
      );
    }

    // 4. Check Environment
    console.log(`${colors.green}[OK]${colors.reset} Platform: ${os.platform()} (${os.arch()})`);
    console.log(`${colors.green}[OK]${colors.reset} Node.js: ${process.version}`);
  } else if (cmd === 'status') {
    try {
      const res = await request('/health');
      console.log(`Proxy Server Status: ${colors.green}Running${colors.reset}`);
      console.log(`Version: ${colors.cyan}${res.version}${colors.reset}`);
      console.log(`Uptime: ${colors.yellow}${res.uptimeSec}s${colors.reset}`);
      console.log(
        `Active Profile ID: ${colors.green}${res.activeProfile || 'Unknown'}${colors.reset}`
      );
    } catch (e) {
      console.log(`Proxy Server Status: ${colors.red}Not Running${colors.reset}`);
    }
  } else {
    console.log(
      `${colors.cyan}${colors.bold}HPM CLI - HTTPS Proxy Manager Command Line Tool${colors.reset}`
    );
    console.log('\nUsage:');
    console.log(`  ${colors.green}hpm list${colors.reset}           List all available profiles`);
    console.log(`  ${colors.green}hpm switch <name>${colors.reset}  Switch the active profile`);
    console.log(
      `  ${colors.green}hpm prompt <name>${colors.reset}  Apply a prompt preset to all tools`
    );
    console.log(`  ${colors.green}hpm mcp${colors.reset}            Show MCP Hub status`);
    console.log(`  ${colors.green}hpm status${colors.reset}         Show proxy server status`);
  }
}

main();
