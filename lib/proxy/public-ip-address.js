'use strict';

const net = require('net');

const blockedAddresses = new net.BlockList();
for (const [address, prefix, family] of [
  ['0.0.0.0', 8, 'ipv4'],
  ['10.0.0.0', 8, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.0.0.0', 24, 'ipv4'],
  ['192.0.2.0', 24, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['198.18.0.0', 15, 'ipv4'],
  ['198.51.100.0', 24, 'ipv4'],
  ['203.0.113.0', 24, 'ipv4'],
  ['224.0.0.0', 4, 'ipv4'],
  ['240.0.0.0', 4, 'ipv4'],
  ['::', 128, 'ipv6'],
  ['::1', 128, 'ipv6'],
  ['fc00::', 7, 'ipv6'],
  ['fe80::', 10, 'ipv6'],
  ['ff00::', 8, 'ipv6'],
  ['2001:db8::', 32, 'ipv6'],
]) {
  blockedAddresses.addSubnet(address, prefix, family);
}

function isPublicIpAddress(address) {
  const normalized = String(address || '').replace(/^\[|\]$/g, '');
  const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mappedIpv4) return isPublicIpAddress(mappedIpv4[1]);
  const family = net.isIP(normalized);
  if (!family) return false;
  const familyName = family === 6 ? 'ipv6' : 'ipv4';
  return !blockedAddresses.check(normalized, familyName);
}

module.exports = { isPublicIpAddress };
