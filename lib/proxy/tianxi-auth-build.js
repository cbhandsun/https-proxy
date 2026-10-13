'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const ROOT = 'C:/Program Files/Lenovo/AIAgent';
const FILES = Object.freeze({
  'XLSmartUI.exe': 'fbe67aa22b44c96b56c7a3eaf68306d0b53b0ef7a2fa990822cfc11270876f77',
  'WrapPlugin.dll': 'c11b1f6b0d827b657b261805a14aaa574d1176cb38bd573fe658030b5bfd0f61',
  'lsf/LsfSdk.dll': '30a8776611cf54d8a7ea19fca0f7a292ec088bf444b22f5d12860c6470053846',
  'plugins/XLAgentCorePlugin.dll':
    '09e580d1db28dd17fd3f74d21c72358914523f451d0f26498e1942b109ff5ba3',
});
function peData(data, rva, length) {
  if (!Buffer.isBuffer(data) || data.length < 64) throw new Error('tianxi_auth_build_invalid');
  const pe = data.readUInt32LE(60);
  if (pe > data.length - 24 || data.toString('ascii', pe, pe + 4) !== 'PE\0\0')
    throw new Error('tianxi_auth_build_invalid');
  const sections = data.readUInt16LE(pe + 6),
    start = pe + 24 + data.readUInt16LE(pe + 20);
  if (sections > 96 || start + sections * 40 > data.length)
    throw new Error('tianxi_auth_build_invalid');
  for (let i = 0; i < sections; i++) {
    const offset = start + i * 40,
      address = data.readUInt32LE(offset + 12),
      size = data.readUInt32LE(offset + 16);
    if (rva >= address && rva + length <= address + size) {
      const fileOffset = data.readUInt32LE(offset + 20) + rva - address;
      if (fileOffset + length > data.length) break;
      return data.subarray(fileOffset, fileOffset + length);
    }
  }
  throw new Error('tianxi_auth_build_invalid');
}
function loadAuthBuild(appId, readFile = fs.readFileSync) {
  const binaries = {};
  for (const [name, digest] of Object.entries(FILES)) {
    const data = readFile(path.join(ROOT, name));
    if (
      !Buffer.isBuffer(data) ||
      data.length > 64 * 1024 * 1024 ||
      createHash('sha256').update(data).digest('hex') !== digest
    )
      throw new Error('tianxi_auth_build_changed');
    binaries[name] = data;
  }
  // These offsets read public constants in a digest-pinned build. Never call an
  // internal native address or inspect its private signing configuration.
  const core = binaries['plugins/XLAgentCorePlugin.dll'],
    browser = binaries['XLSmartUI.exe'];
  const ascii = (data, rva, length) => peData(data, rva, length).toString('ascii').split('\0')[0];
  if (ascii(core, 0xf4370, 17) !== appId) throw new Error('tianxi_auth_application_mismatch');
  const endpoint =
    peData(core, 0xf43f0, 200).toString('utf16le').split('\0')[0] +
    peData(core, 0xf7be8, 56).toString('utf16le');
  if (endpoint !== 'https://laa.lenovomm.com/xiaotian/api/m/ai/token/out/v2/qoder')
    throw new Error('tianxi_auth_build_invalid');
  const alphabet = ascii(core, 0xf7448, 48);
  if (!/^[A-Za-z0-9]{48}$/.test(alphabet) || new Set(alphabet).size !== 48)
    throw new Error('tianxi_auth_build_invalid');
  return {
    root: ROOT,
    endpoint,
    alphabet,
    positionId: ascii(core, 0xf7be4, 4),
    initPayload: {
      realm: ascii(browser, 0x3bc468, 21),
      loginurl: peData(browser, 0x3baf40, 228).toString('utf8'),
    },
  };
}
module.exports = { loadAuthBuild, peData };
