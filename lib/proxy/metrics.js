/**
 * Prometheus-style 指标 + /metrics 渲染
 *
 * 设计:
 *   - 进程内 in-memory store,无外部依赖
 *   - 支持 counter / gauge / histogram 三种类型
 *   - 标签通过在创建时声明(labelNames)
 *   - 输出符合 OpenMetrics 1.0 文本格式,Prometheus 可直接抓取
 *
 * 公共 API:
 *   createMetrics(opts)            工厂,返回 {counter, gauge, histogram, render, reset}
 *   metric.counter(name, help).inc({label1: 'a'})
 *   metric.gauge(name, help).set(42, {label1: 'a'})
 *   metric.histogram(name, help, { buckets: [...] }).observe(0.123, {label1: 'a'})
 *   metric.render()                -> Prometheus text format
 *   metric.reset()                 -> 清空(测试用)
 *   collectDefaultProcessMetrics()  注入 process_*, nodejs_* 指标
 */

function escapeLabelValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function labelKey(labelObj) {
  if (!labelObj) return '';
  const keys = Object.keys(labelObj);
  if (!keys.length) return '';
  return keys.map((k) => k + '=' + escapeLabelValue(labelObj[k])).join(',');
}

function formatHelp(name, help) {
  return '# HELP ' + name + ' ' + (help || '').replace(/\n/g, ' ').trim() + '\n';
}

function formatType(name, type) {
  return '# TYPE ' + name + ' ' + type + '\n';
}

function formatLabels(labelObj) {
  if (!labelObj) return '';
  const keys = Object.keys(labelObj);
  if (!keys.length) return '';
  return '{' + keys.map((k) => k + '="' + escapeLabelValue(labelObj[k]) + '"').join(',') + '}';
}

function createMetrics(_options) {
  const metricNamePattern = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
  const registry = new Map(); // name -> { type, help, instance }

  function validateName(name) {
    if (typeof name !== 'string' || !metricNamePattern.test(name)) {
      throw new Error('Invalid metric name: ' + name);
    }
  }

  function register(name, type, help, instance) {
    if (registry.has(name)) return registry.get(name);
    validateName(name);
    const entry = { name, type, help: help || '', instance };
    registry.set(name, entry);
    return entry;
  }

  function counter(name, help) {
    const instance = {
      values: new Map(), // key -> { count, labelObj }
      inc(by = 1, labels) {
        const key = labelKey(labels);
        const entry = this.values.get(key);
        if (entry) entry.count += by;
        else this.values.set(key, { count: by, labelObj: labels || null });
      },
      reset() {
        this.values.clear();
      },
    };
    return Object.assign(register(name, 'counter', help, instance), instance);
  }

  function gauge(name, help) {
    const instance = {
      values: new Map(),
      set(value, labels) {
        const key = labelKey(labels);
        this.values.set(key, { value: Number(value), labelObj: labels || null });
      },
      inc(by = 1, labels) {
        const key = labelKey(labels);
        const entry = this.values.get(key);
        if (entry) entry.value += by;
        else this.values.set(key, { value: by, labelObj: labels || null });
      },
      dec(by = 1, labels) {
        const key = labelKey(labels);
        const entry = this.values.get(key);
        if (entry) entry.value -= by;
        else this.values.set(key, { value: -by, labelObj: labels || null });
      },
      reset() {
        this.values.clear();
      },
    };
    return Object.assign(register(name, 'gauge', help, instance), instance);
  }

  function defaultBuckets() {
    return [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
  }

  function histogram(name, help, opts) {
    const buckets = (opts && opts.buckets) || defaultBuckets();
    const sortedBuckets = [...buckets].sort((a, b) => a - b);
    const instance = {
      buckets: sortedBuckets,
      values: new Map(), // key -> { counts: [...], sum, count }
      observe(value, labels) {
        const key = labelKey(labels);
        let entry = this.values.get(key);
        if (!entry) {
          entry = {
            counts: new Array(sortedBuckets.length).fill(0),
            sum: 0,
            count: 0,
            labelObj: labels || null,
          };
          this.values.set(key, entry);
        }
        const v = Number(value);
        entry.sum += v;
        entry.count += 1;
        for (let i = 0; i < sortedBuckets.length; i += 1) {
          if (v <= sortedBuckets[i]) entry.counts[i] += 1;
        }
      },
      reset() {
        this.values.clear();
      },
    };
    return Object.assign(register(name, 'histogram', help, instance), instance);
  }

  function render() {
    const out = [];
    for (const entry of registry.values()) {
      out.push(formatHelp(entry.name, entry.help));
      out.push(formatType(entry.name, entry.type));
      if (entry.type === 'counter' || entry.type === 'gauge') {
        for (const [, e] of entry.instance.values) {
          const value = entry.type === 'counter' ? e.count : e.value;
          out.push(entry.name + formatLabels(e.labelObj) + ' ' + value + '\n');
        }
      } else if (entry.type === 'histogram') {
        const buckets = entry.instance.buckets;
        for (const [k, e] of entry.instance.values) {
          const labelObj = e.labelObj || {};
          let cumulative = 0;
          for (let i = 0; i < buckets.length; i += 1) {
            cumulative = e.counts[i];
            const labels = Object.assign({}, labelObj, { le: String(buckets[i]) });
            out.push(entry.name + '_bucket' + formatLabels(labels) + ' ' + cumulative + '\n');
          }
          out.push(
            entry.name +
              '_bucket' +
              formatLabels(Object.assign({}, labelObj, { le: '+Inf' })) +
              ' ' +
              e.count +
              '\n'
          );
          out.push(entry.name + '_sum' + (k ? '{' + k + '}' : '') + ' ' + e.sum + '\n');
          out.push(entry.name + '_count' + (k ? '{' + k + '}' : '') + ' ' + e.count + '\n');
        }
      }
    }
    return out.join('');
  }

  function reset() {
    for (const entry of registry.values()) {
      entry.instance.reset();
    }
  }

  return { counter, gauge, histogram, render, reset, _registry: registry };
}

function collectDefaultProcessMetrics(metric) {
  // Standard process metrics used by prom-client
  const rss = metric.gauge('process_resident_memory_bytes', 'Resident memory size in bytes');
  const heapTotal = metric.gauge('nodejs_heap_size_total_bytes', 'Process heap size from V8');
  const heapUsed = metric.gauge('nodejs_heap_size_used_bytes', 'Process heap size used from V8');
  const external = metric.gauge(
    'nodejs_external_memory_bytes',
    'Node.js external memory size in bytes'
  );
  const uptime = metric.gauge('process_uptime_seconds', 'Process uptime in seconds');
  const cpuUser = metric.gauge('process_cpu_user_seconds_total', 'Total user CPU time spent');
  const cpuSystem = metric.gauge('process_cpu_system_seconds_total', 'Total system CPU time spent');
  const fds = metric.gauge('process_open_fds', 'Number of open file descriptors');
  const version = metric.gauge('nodejs_version_info', 'Node.js version info');

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  version.set(1, { version: process.versions.node, major: String(nodeMajor) });

  const update = () => {
    const mem = process.memoryUsage();
    rss.set(mem.rss);
    heapTotal.set(mem.heapTotal);
    heapUsed.set(mem.heapUsed);
    external.set(mem.external);
    uptime.set(process.uptime());
    const usage = process.cpuUsage();
    cpuUser.set(usage.user / 1e6);
    cpuSystem.set(usage.system / 1e6);
    if (typeof process._getActiveHandles === 'function') {
      fds.set(process._getActiveHandles().length, { type: 'all' });
    }
  };
  update();
  const timer = setInterval(update, 5000);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}

module.exports = {
  createMetrics,
  collectDefaultProcessMetrics,
  formatLabels,
  labelKey,
};
