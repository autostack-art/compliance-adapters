/**
 * Copyright (c) 2026 stellar-compliance-kit
 * SPDX-License-Identifier: MIT
 */

interface MetricGroup {
  helpLine?: string;
  typeLine?: string;
  sampleLines: string[];
}

function getMetricName(line: string): string | undefined {
  const match = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)/);
  return match ? match[1] : undefined;
}

function resolveGroupName(metricName: string, groups: Map<string, MetricGroup>): string {
  const suffixes = ['_bucket', '_sum', '_count'];
  for (const suffix of suffixes) {
    if (metricName.endsWith(suffix)) {
      const baseName = metricName.slice(0, -suffix.length);
      if (groups.has(baseName)) {
        return baseName;
      }
    }
  }

  return metricName;
}

export function combineExpositions(expositions: string[]): string {
  if (expositions.length === 0) {
    return '';
  }

  if (expositions.length === 1) {
    return expositions[0];
  }

  const groups = new Map<string, MetricGroup>();

  const ensureGroup = (name: string): MetricGroup => {
    let group = groups.get(name);
    if (!group) {
      group = { sampleLines: [] };
      groups.set(name, group);
    }
    return group;
  };

  for (const exposition of expositions) {
    const lines = exposition.split('\n');

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }

      const headerMatch = line.match(/^#\s*(HELP|TYPE)\s+([a-zA-Z_:][a-zA-Z0-9_:]*)\s*(.*)$/);
      if (headerMatch) {
        const [, headerKind, metricName] = headerMatch;
        const group = ensureGroup(metricName);
        if (headerKind === 'HELP' && !group.helpLine) {
          group.helpLine = line;
        } else if (headerKind === 'TYPE' && !group.typeLine) {
          group.typeLine = line;
        }
        continue;
      }

      const metricName = getMetricName(line);
      if (!metricName) {
        continue;
      }

      const groupName = resolveGroupName(metricName, groups);
      const group = ensureGroup(groupName);
      group.sampleLines.push(line);
    }
  }

  const orderedNames = [...groups.keys()].sort((a, b) => a.localeCompare(b));
  const output: string[] = [];

  for (const name of orderedNames) {
    const group = groups.get(name);
    if (!group) {
      continue;
    }

    if (group.helpLine) {
      output.push(group.helpLine);
    }
    if (group.typeLine) {
      output.push(group.typeLine);
    }
    output.push(...group.sampleLines);
  }

  return output.length > 0 ? `${output.join('\n')}\n` : '';
}
