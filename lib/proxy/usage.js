const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

const USAGE_LOG_FILE = path.join(DATA_DIR, 'usage-stats.jsonl');

function logUsage(data) {
  const record = {
    time: new Date().toISOString(),
    profileId: data.profileId,
    model: data.model,
    inputTokens: data.inputTokens || 0,
    outputTokens: data.outputTokens || 0,
    type: data.type || 'api'
  };

  try {
    fs.appendFileSync(USAGE_LOG_FILE, JSON.stringify(record) + '\n');
  } catch (err) {
    console.warn('Failed to log usage:', err.message);
  }
}

function getUsageSummary() {
  if (!fs.existsSync(USAGE_LOG_FILE)) return { totalInput: 0, totalOutput: 0, byProfile: {} };

  const content = fs.readFileSync(USAGE_LOG_FILE, 'utf8');
  const lines = content.split('\n').filter(l => l.trim());

  const summary = {
    totalInput: 0,
    totalOutput: 0,
    byProfile: {}
  };

  lines.forEach(line => {
    try {
      const record = JSON.parse(line);
      summary.totalInput += record.inputTokens;
      summary.totalOutput += record.outputTokens;

      if (!summary.byProfile[record.profileId]) {
        summary.byProfile[record.profileId] = { input: 0, output: 0, models: {} };
      }
      summary.byProfile[record.profileId].input += record.inputTokens;
      summary.byProfile[record.profileId].output += record.outputTokens;

      const model = record.model || 'unknown';
      if (!summary.byProfile[record.profileId].models[model]) {
        summary.byProfile[record.profileId].models[model] = { input: 0, output: 0 };
      }
      summary.byProfile[record.profileId].models[model].input += record.inputTokens;
      summary.byProfile[record.profileId].models[model].output += record.outputTokens;
    } catch (e) {}
  });

  return summary;
}

module.exports = {
  logUsage,
  getUsageSummary
};
