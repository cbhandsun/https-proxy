#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { getAgentBindingsStatus, bindAgentToModel } = require('./lib/proxy/agent-bindings');

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
        const inputBytes = Number.isSafeInteger(l.inputBytes) ? `, ${l.inputBytes} bytes` : '';
        console.log(`  Input:  [redacted${inputBytes}]`);
        if (l.error) console.log(`  Error:  ${colors.red}[redacted]${colors.reset}`);
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
  } else if (cmd === 'agents') {
    const status = getAgentBindingsStatus();
    console.log(`${colors.bold}Agent Model Bindings:${colors.reset}`);
    for (const item of status.agents) {
      const stateText = item.proxyActive
        ? `${colors.green}Proxy Active${colors.reset}`
        : `${colors.yellow}Direct/Unconfigured${colors.reset}`;
      const modelText = item.model
        ? `${colors.cyan}${item.model}${colors.reset}${item.profileId ? ` -> ${item.profileId}:${item.targetModel}` : ''}`
        : '(default)';
      console.log(`  - ${item.name.padEnd(18)} [${item.agent}]  ${stateText}  model=${modelText}`);
    }
  } else if (cmd === 'bind') {
    const agent = args[1];
    const profileId = args[2];
    const model = args[3];
    if (!agent || !profileId || !model) {
      console.log('Usage: hpm bind <claude-code|codex|codex-desktop|antigravity-cli|gemini-cli|opencode|aider> <profile-id> <model>');
      return;
    }
    try {
      const result = bindAgentToModel({ agent, profileId, model });
      console.log(
        `${colors.green}[OK]${colors.reset} Bound ${colors.bold}${result.agent}${colors.reset} -> profile=${colors.cyan}${result.profileId}${colors.reset} model=${colors.yellow}${result.model}${colors.reset}`
      );
    } catch (e) {
      console.error(`${colors.red}Error:${colors.reset} ${e.message}`);
    }
  } else if (cmd === 'route' || cmd === 'routes') {
    const sub = args[1] || 'list';
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const routes = Array.isArray(config.modelRoutes) ? config.modelRoutes : [];
    if (sub === 'list') {
      console.log(`${colors.bold}Model Routes (${routes.length}):${colors.reset}`);
      routes.forEach((r, idx) => {
        const state = r.enabled === false ? `${colors.red}[OFF]${colors.reset}` : `${colors.green}[ON]${colors.reset}`;
        const fb = r.backupProfileId ? ` (backup=${r.backupProfileId})` : '';
        console.log(`  ${idx + 1}. ${state} ${colors.cyan}${r.from}${colors.reset} -> ${colors.yellow}${r.profileId}${colors.reset}:${r.to || r.from}${fb}`);
      });
    } else if (sub === 'set') {
      const from = args[2];
      const profileId = args[3];
      const to = args[4] || from;
      const backupProfileId = args[5] || '';
      if (!from || !profileId) {
        console.log('Usage: hpm route set <from> <profileId> [to] [backupProfileId]');
        return;
      }
      const nextRoute = {
        from,
        profileId,
        to,
        enabled: true,
        ...(backupProfileId ? { backupProfileId } : {}),
      };
      const existingIdx = routes.findIndex((r) => r && r.from === from);
      if (existingIdx >= 0) routes[existingIdx] = { ...routes[existingIdx], ...nextRoute };
      else routes.unshift(nextRoute);
      config.modelRoutes = routes;
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
      console.log(`${colors.green}[OK]${colors.reset} Route saved: ${from} -> ${profileId}:${to}`);
    } else if (sub === 'rm' || sub === 'delete') {
      const from = args[2];
      config.modelRoutes = routes.filter((r) => r && r.from !== from);
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
      console.log(`${colors.green}[OK]${colors.reset} Route removed: ${from}`);
    }
  } else if (cmd === 'mask') {
    const profileId = args[1];
    const mode = String(args[2] || '').toLowerCase();
    if (!profileId || !['on', 'off', 'true', 'false'].includes(mode)) {
      console.log('Usage: hpm mask <profile-id> <on|off>');
      return;
    }
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const profile = (config.profiles || []).find((p) => p && p.id === profileId);
    if (!profile) {
      console.error(`${colors.red}Profile "${profileId}" not found.${colors.reset}`);
      return;
    }
    profile.promptMasking = mode === 'on' || mode === 'true';
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
    console.log(
      `${colors.green}[OK]${colors.reset} Prompt Masking for ${colors.cyan}${profileId}${colors.reset} is now ${profile.promptMasking ? 'ENABLED' : 'DISABLED'}.`
    );
  } else if (cmd === 'tui') {
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q) => new Promise((res) => rl.question(q, res));
    console.log(`\n${colors.cyan}${colors.bold}=== HPM Interactive Control Center ===${colors.reset}`);
    console.log('  1) View Agent Model Bindings');
    console.log('  2) Switch Active Profile');
    console.log('  3) Bind Agent to Profile + Model');
    console.log('  4) Toggle Prompt Masking on Profile');
    console.log('  q) Quit');
    const choice = (await ask('\nSelect an action [1-4/q]: ')).trim();
    if (choice === '1') {
      const status = getAgentBindingsStatus();
      status.agents.forEach((a) =>
        console.log(`  - ${a.name.padEnd(16)} [${a.agent}]  proxy=${a.proxyActive ? 'ON' : 'OFF'}  model=${a.model || '(default)'}`)
      );
    } else if (choice === '2') {
      const profiles = await getProfilesDirect();
      profiles.forEach((p, i) => console.log(`  ${i + 1}) ${p.id} (${p.name || p.id})`));
      const target = (await ask('Enter profile ID: ')).trim();
      if (target) await setActiveDirect(target);
    } else if (choice === '3') {
      const agent = (await ask('Agent (claude-code/codex/antigravity-cli/gemini-cli/opencode/aider): ')).trim();
      const profileId = (await ask('Profile ID: ')).trim();
      const model = (await ask('Model Name: ')).trim();
      if (agent && profileId && model) {
        const res = bindAgentToModel({ agent, profileId, model });
        console.log(`${colors.green}[OK]${colors.reset} Bound ${res.agent} -> ${res.profileId}:${res.model}`);
      }
    } else if (choice === '4') {
      const profileId = (await ask('Profile ID: ')).trim();
      const enable = (await ask('Enable Prompt Masking? (y/n): ')).trim().toLowerCase() === 'y';
      const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      const profile = (config.profiles || []).find((p) => p && p.id === profileId);
      if (profile) {
        profile.promptMasking = enable;
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
        console.log(`${colors.green}[OK]${colors.reset} Updated ${profileId} promptMasking=${enable}`);
      }
    }
    rl.close();
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
    console.log(`  ${colors.green}hpm agents${colors.reset}         Show coding agent proxy & model bindings`);
    console.log(`  ${colors.green}hpm bind <agent> <profile> <model>${colors.reset}  Bind an agent to a provider model`);
    console.log(`  ${colors.green}hpm route <list|set|rm>${colors.reset}  Manage model routes`);
    console.log(`  ${colors.green}hpm mask <profile> <on|off>${colors.reset}  Toggle reversible prompt masking`);
    console.log(`  ${colors.green}hpm tui${colors.reset}            Interactive terminal control menu`);
  }
}

main();
