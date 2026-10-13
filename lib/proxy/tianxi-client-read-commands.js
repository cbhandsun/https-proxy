'use strict';

const quote = (value) => "'" + value.replace(/'/g, "''") + "'";
const OUTPUT_ENCODING = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ';
const SEARCH_EXCLUSIONS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.key',
];

function clientReadCommand(file, { offset, limit, tail, include_metadata: metadata }) {
  const source = `Get-Content -LiteralPath ${quote(file)} -Encoding UTF8 -ErrorAction Stop`;
  if (!metadata)
    return (
      OUTPUT_ENCODING +
      (tail === undefined
        ? `${source} -TotalCount ${offset - 1 + limit} | Select-Object -Skip ${offset - 1} -First ${limit}`
        : `${source} -Tail ${tail}`)
    );
  const count = tail === undefined ? limit : tail;
  const read =
    tail === undefined ? `${source} -TotalCount ${offset + limit}` : `${source} -Tail ${tail + 1}`;
  const selection = tail === undefined ? `-Skip ${offset - 1} -First ${count}` : `-Last ${count}`;
  return (
    OUTPUT_ENCODING +
    "$ErrorActionPreference = 'Stop'; " +
    `$readLines = @(${read}); $selectedLines = @($readLines | Select-Object ${selection} | ForEach-Object { $_.ToString() }); ` +
    '[ordered]@{' +
    `mode = '${tail === undefined ? 'range' : 'tail'}'; ` +
    `start_line = ${tail === undefined ? offset : '$null'}; ` +
    `returned_lines = $selectedLines.Count; ` +
    `has_more_before = ${tail === undefined ? `(${offset} -gt 1 -and $readLines.Count -gt 0)` : `($readLines.Count -gt ${count})`}; ` +
    `has_more_after = ${tail === undefined ? `($readLines.Count -gt ${offset - 1 + count})` : '$false'}; ` +
    'lines = @($selectedLines) } | ConvertTo-Json -Compress -Depth 3'
  );
}

function clientSearchCommand(name, pattern, scope, options) {
  const flags = [
    ...(options.include_hidden || options.include_ignored ? ['--glob-case-insensitive'] : []),
    ...(options.include_hidden ? ['--hidden'] : []),
    ...(options.include_ignored ? ['--no-ignore'] : []),
  ];
  if (options.include_hidden || options.include_ignored)
    for (const excluded of SEARCH_EXCLUSIONS) flags.push('--glob', quote('!' + excluded));
  const extra = flags.length ? ' ' + flags.join(' ') : '';
  const command =
    name === 'find_files'
      ? `rg --files --glob ${quote(pattern)}${extra} -- ${quote(scope)}`
      : `rg --no-heading --line-number --fixed-strings --max-count 100${extra} -- ${quote(pattern)} ${quote(scope)}`;
  return (
    OUTPUT_ENCODING +
    "$ErrorActionPreference = 'Stop'; " +
    command +
    '; if ($LASTEXITCODE -eq 1) { exit 0 }; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }'
  );
}

module.exports = { clientReadCommand, clientSearchCommand };
