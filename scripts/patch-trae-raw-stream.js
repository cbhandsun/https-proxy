const fs = require('fs');
const path = require('path');

const TRAE_ROOT = process.env.TRAE_INSTALL_ROOT || path.join(
  process.env.LOCALAPPDATA || '',
  'Programs',
  'Trae'
);

const CHAT_MODULE = path.join(
  TRAE_ROOT,
  'resources',
  'app',
  'node_modules',
  '@byted-icube',
  'ai-modules-chat',
  'dist',
  'index.mjs'
);

const WORKBENCH = path.join(
  TRAE_ROOT,
  'resources',
  'app',
  'out',
  'vs',
  'workbench',
  'workbench.desktop.main.js'
);

const MARKER = '__httpsProxyTraeRawStream';

function readFile(file) {
  if (!fs.existsSync(file)) {
    throw new Error(`Trae file not found: ${file}`);
  }
  return fs.readFileSync(file, 'utf8');
}

function backupFile(file) {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const backup = `${file}.bak-https-proxy-raw-stream-${stamp}`;
  fs.copyFileSync(file, backup);
  return backup;
}

function patchFile(file, patcher) {
  const before = readFile(file);
  const after = patcher(before);
  if (after === before) {
    console.log(`unchanged: ${file}`);
    return null;
  }
  const backup = backupFile(file);
  fs.writeFileSync(file, after, 'utf8');
  console.log(`patched: ${file}`);
  console.log(`backup: ${backup}`);
  return backup;
}

function patchStreamHook(source, label) {
  if (source.includes(`${MARKER}RawEmitter`)) return source;

  const needle = 'onMessage(e,t){let{sessionId:i,context:r}=t;if(this.streamStallMonitor.onEvent(i,e.event,e.payload)';
  if (!source.includes(needle)) {
    throw new Error(`Could not find SideChatStreamService onMessage hook in ${label}`);
  }

  const emitHook = [
    'onMessage(e,t){try{',
    `const n=globalThis.${MARKER}||(globalThis.${MARKER}={events:[],listeners:new Set});`,
    'const o={ts:Date.now(),sessionId:t?.sessionId,agentMessageId:t?.context?.agentMessageId,event:e?.event,payload:e?.payload};',
    'n.events.push(o);',
    'n.events.length>500&&n.events.shift();',
    'for(const e of n.listeners)try{e(o)}catch{}',
    `}catch(${MARKER}RawEmitter){}`,
    'let{sessionId:i,context:r}=t;if(this.streamStallMonitor.onEvent(i,e.event,e.payload)'
  ].join('');

  return source.replace(needle, emitHook);
}

function patchChatModule(source) {
  return patchStreamHook(source, 'ai-modules-chat');
}

function patchTransportHook(source) {
  if (source.includes(`${MARKER}TransportEmitter`)) return source;

  const needle = 'const d=f=>{if(!f)return;if(f.code!==0){const m=Yge.create(f.code,f.message,void 0,void 0,f.data);e.getController().error(m),c(m);return}n||(n=!0),f.data&&e.getController().write(f.data),f.data?.event===_vt.Done&&(e.getController().complete(f.data||void 0),l())}';
  if (!source.includes(needle)) {
    throw new Error('Could not find TransportManager stream callback in workbench');
  }

  const replacement = [
    'const d=f=>{if(!f)return;',
    'try{',
    `const o=globalThis.${MARKER}||(globalThis.${MARKER}={events:[],listeners:new Set});`,
    'const a={ts:Date.now(),service:t?.request?.service,method:t?.request?.method,channelId:r?.channel_id,event:f?.data?.event,payload:f?.data};',
    'o.events.push(a);',
    'o.events.length>500&&o.events.shift();',
    'for(const e of o.listeners)try{e(a)}catch{}',
    `}catch(${MARKER}TransportEmitter){}`,
    'if(f.code!==0){const m=Yge.create(f.code,f.message,void 0,void 0,f.data);e.getController().error(m),c(m);return}n||(n=!0),f.data&&e.getController().write(f.data),f.data?.event===_vt.Done&&(e.getController().complete(f.data||void 0),l())}'
  ].join('');

  return source.replace(needle, replacement);
}

function patchWorkbench(source) {
  let patched = patchTransportHook(source);
  if (patched.includes('im.bridge.subscribeRawStream')) return patched;

  const needle = 'K(NRr);var ORr=class extends ee{constructor(){super({id:"im.bridge.respondToInteraction"';
  if (!patched.includes(needle)) {
    throw new Error('Could not find IM bridge command registration point in workbench');
  }

  const command = [
    'K(NRr);',
    'var HPMRawStreamBridgeCommand=class extends ee{',
    'constructor(){super({id:"im.bridge.subscribeRawStream",title:{value:"IM Bridge: Subscribe Raw Stream",original:"IM Bridge: Subscribe Raw Stream"},category:Mw})}',
    'async run(i,e){',
    `const t=globalThis.${MARKER}||(globalThis.${MARKER}={events:[],listeners:new Set});`,
    'if(typeof e=="function"){t.listeners.add(e);return{dispose:()=>t.listeners.delete(e)}}',
    'return Array.isArray(t.events)?t.events.slice(-100):[]',
    '}',
    '};',
    'K(HPMRawStreamBridgeCommand);',
    'var ORr=class extends ee{constructor(){super({id:"im.bridge.respondToInteraction"'
  ].join('');

  return patched.replace(needle, command);
}

function main() {
  console.log(`Trae install root: ${TRAE_ROOT}`);
  patchFile(CHAT_MODULE, patchChatModule);
  patchFile(WORKBENCH, patchWorkbench);
  console.log('Raw stream probe patch is installed. Restart Trae to load it.');
}

main();
