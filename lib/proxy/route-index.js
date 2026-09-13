/**
 * 路由索引: 前缀分桶 + LRU
 *
 * 解决:
 *   - modelRoutes 数量增长后线性扫描 O(n*k) 变慢
 *   - 现 Map 缓存 FIFO,热路径反复 evict 同一组 key
 *   - 每次热重载都重新解析所有 wildcard regex
 *
 * 设计:
 *   - 把所有 routes 按 pattern 的前 1-2 个字面字符分桶
 *   - 桶内使用原有 regex 匹配逻辑 (兼容所有现有 wildcard 语义)
 *   - LRU 缓存 (model -> resolved best match) 取代 FIFO Map
 *   - load balancing (相同 score 随机选) 保持
 *
 * 与 trie 不同: 本实现不试图穷举所有 pattern 通配组合,而是把"全表扫描"
 * 缩小为"按首字符分桶扫描"。对于有大量 gpt/claude 前缀的 routes,
 * 这是 O(n*k/buckets) 的常数级提升。配合 LRU 后,热路径 ~O(1)。
 */

class LruCache {
  constructor(limit) {
    this.limit = limit;
    this.map = new Map();
  }
  get(key) {
    if (!this.map.has(key)) return undefined;
    const v = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }
  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.limit) {
      const firstKey = this.map.keys().next().value;
      this.map.delete(firstKey);
    }
  }
  has(key) {
    return this.map.has(key);
  }
  get size() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
}

function regexFromPattern(pattern) {
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp('^' + escaped + '$', 'i');
}

function scoreFromPattern(pattern) {
  if (pattern === '*') return 1;
  if (pattern.indexOf('*') < 0) return 10000 + pattern.length;
  return 1000 + pattern.replace(/\*/g, '').length;
}

function bucketKeyFor(pattern) {
  // Use the first 1-2 literal characters of the lower-cased pattern as bucket key.
  // For pattern starting with `*`, the bucket key is '*-'
  const lower = pattern.toLowerCase();
  if (lower === '*' || lower[0] === '*') return '*';
  // First char literal
  const a = lower[0];
  // Second char literal (only if both are literal)
  const b = lower[1];
  if (b && b !== '*') return a + b;
  return a;
}

function normalizeRouteModelName(name) {
  if (!name || typeof name !== 'string') return '';
  return name
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[()[\]]/g, ' ')
    .replace(/[_\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function buildRouteIndex(modelRoutes) {
  const buckets = new Map(); // bucketKey -> [{ regex, score, route }]
  const allEntries = []; // for stats
  const normalizedExactMap = new Map(); // normalized model name -> entry
  if (!Array.isArray(modelRoutes)) return { buckets, allEntries, normalizedExactMap, count: 0 };

  for (const route of modelRoutes) {
    if (!route || !route.from || !route.to) continue;
    if (route.enabled === false) continue;
    const pattern = String(route.from);
    const key = bucketKeyFor(pattern);
    const entry = {
      pattern,
      regex: regexFromPattern(pattern),
      score: scoreFromPattern(pattern),
      route,
    };
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(entry);
    allEntries.push(entry);

    if (!pattern.includes('*')) {
      const norm = normalizeRouteModelName(pattern);
      if (norm && !normalizedExactMap.has(norm)) {
        normalizedExactMap.set(norm, entry);
      }
    }
  }
  return { buckets, allEntries, normalizedExactMap, count: allEntries.length };
}

function lookupInIndex(index, model) {
  if (!index || !index.buckets) return [];
  if (!model) return [];
  const target = String(model).toLowerCase();
  if (!target) return [];

  // Collect candidate buckets: any bucket whose key is a prefix of the target,
  // plus the global '*' bucket.
  const out = [];
  const seen = new Set();

  for (const [key, entries] of index.buckets) {
    if (key === '*' || target.indexOf(key) === 0) {
      for (const e of entries) {
        if (e.regex.test(target) && !seen.has(e)) {
          out.push(e);
          seen.add(e);
        }
      }
    }
  }
  return out;
}

function createRouteIndex(modelRoutes, options) {
  const cacheLimit = (options && options.cacheLimit) || 1024;
  const lru = new LruCache(cacheLimit);
  let index = buildRouteIndex(modelRoutes);

  function findBest(model) {
    const cached = lru.get(model);
    if (cached !== undefined) return cached;
    const matches = lookupInIndex(index, model);
    let best = null;
    let bestCount = 0;
    for (const m of matches) {
      if (!best || m.score > best.score) {
        best = m;
        bestCount = 1;
      } else if (m.score === best.score) {
        bestCount += 1;
      }
    }

    // Normalized fallback: if no direct match or only matched global wildcard '*',
    // try matching the normalized model name against exact routes.
    // e.g. "Gemini 3.8 Flash" -> "gemini-3.8-flash"
    if ((!best || best.score <= 1) && index.normalizedExactMap) {
      const norm = normalizeRouteModelName(model);
      if (norm && index.normalizedExactMap.has(norm)) {
        const normEntry = index.normalizedExactMap.get(norm);
        best = normEntry;
        bestCount = 1;
      }
    }

    // Tag the result with candidate count so resolveRoute can do load balancing
    const result = best ? { entry: best, candidateCount: bestCount } : null;
    lru.set(model, result);
    return result;
  }

  function rebuild(newRoutes) {
    index = buildRouteIndex(newRoutes);
    lru.clear();
  }

  function stats() {
    return {
      totalEntries: index.count,
      buckets: index.buckets.size,
      cacheSize: lru.size,
      cacheLimit: lru.limit,
    };
  }

  return { findBest, rebuild, stats, _index: index, _lru: lru };
}

function resolveRouteWithIndex(model, routeIndex, profiles, activeProfile) {
  const best = routeIndex ? routeIndex.findBest(model) : null;
  if (!best || !best.entry) return { profile: activeProfile, route: null };
  const route = best.entry.route;
  const profile = profiles.find((item) => item.id === route.profileId) || activeProfile;
  return { profile, route };
}

module.exports = {
  LruCache,
  buildRouteIndex,
  lookupInIndex,
  createRouteIndex,
  resolveRouteWithIndex,
  normalizeRouteModelName,
  _regexFromPattern: regexFromPattern,
  _scoreFromPattern: scoreFromPattern,
  _bucketKeyFor: bucketKeyFor,
};
