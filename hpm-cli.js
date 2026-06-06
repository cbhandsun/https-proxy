#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, 'proxy.config.json');
const SERVER_URL = 'http://localhost:3543/v1/local';

async function request(path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
    };
    const req = http.request(SERVER_URL + path, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
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

    let profiles = [];
    try {
      const res = await request('/config');
      profiles = res.profiles || [];
    } catch (e) {
      profiles = await getProfilesDirect();
    }

    const profile = profiles.find(p => p.id === target || p.name.toLowerCase().includes(target.toLowerCase()));
    if (!profile) {
      console.error(`Error: Profile "${target}" not found.`);
      return;
    }

    try {
      const res = await request('/active', 'POST', { profileId: profile.id });
      if (res.ok) {
        console.log(`Successfully switched to profile: ${profile.name} (${profile.id})`);
      } else {
        throw new Error(res.error || 'Unknown error');
      }
    } catch (e) {
      if (await setActiveDirect(profile.id)) {
        console.log(`Successfully switched to profile (via config file): ${profile.name} (${profile.id})`);
      } else {
        console.error(`Failed to switch profile: ${e.message}`);
      }
    }
  } else if (cmd === 'list') {
    let profiles = [];
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

    console.log('Available Profiles:');
    profiles.forEach(p => {
      const activeMarker = p.id === activeId ? '* ' : '  ';
      console.log(`${activeMarker}${p.name.padEnd(30)} (${p.id}) [${p.protocol}]`);
    });
  } else if (cmd === 'prompt') {
    const target = args[1];
    if (!target) {
      console.log('Usage: hpm prompt <preset-id-or-name>');
      return;
    }

    const configRes = await request('/config');
    const presets = configRes.promptPresets || [];
    const preset = presets.find(p => p.id === target || p.name.toLowerCase().includes(target.toLowerCase()));

    if (!preset) {
      console.error(`Error: Prompt preset "${target}" not found.`);
      if (presets.length > 0) {
        console.log('Available presets:', presets.map(p => `${p.name} (${p.id})`).join(', '));
      }
      return;
    }

    console.log(`Applying prompt preset: ${preset.name}...`);
    const tools = ['claude', 'codex', 'gemini', 'antigravity'];
    for (const tool of tools) {
      try {
        const syncRes = await request('/prompts/sync', 'POST', { type: tool, content: preset.content });
        if (syncRes.ok) {
          console.log(`  [OK] Synced to ${tool}`);
        }
      } catch (e) {
        console.warn(`  [FAIL] Failed to sync to ${tool}: ${e.message}`);
      }
    }
    console.log('Done.');
  } else if (cmd === 'mcp') {
    try {
      const res = await request('/mcp-hub');
      const hub = res.mcpHub;
      console.log('MCP Hub Configuration:');
      console.log(`  Servers: ${hub.servers.length}`);
      hub.servers.forEach(s => console.log(`    - ${s.name} (${s.url})`));
      console.log(`  Routing Rules: ${hub.routing.length}`);
      hub.routing.forEach(r => console.log(`    - ${r.toolName || r.pattern} -> ${r.serverId}`));
    } catch (e) {
      console.error('Failed to get MCP Hub info:', e.message);
    }
  } else if (cmd === 'status') {
    try {
      const res = await request('/health');
      console.log('Proxy Server Status: Running');
      console.log(`Version: ${res.version}`);
      console.log(`Uptime: ${res.uptimeSec}s`);
      console.log(`Active Profile ID: ${res.activeProfile || 'Unknown'}`);
    } catch (e) {
      console.log('Proxy Server Status: Not Running');
    }
  } else {
    console.log('HPM CLI - HTTPS Proxy Manager Command Line Tool');
    console.log('\nUsage:');
    console.log('  hpm list           List all available profiles');
    console.log('  hpm switch <name>  Switch the active profile');
    console.log('  hpm status         Show proxy server status');
  }
}

main();
