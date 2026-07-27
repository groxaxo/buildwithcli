'use strict';

const { BuildWithCliError, normalizeNewlines, isPlainObject } = require('./base');

function parseScalar(raw) {
  const value = raw.trim();
  if (value === '') return '';
  if (value === 'null' || value === '~') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    if (value.startsWith('"')) {
      try {
        return JSON.parse(value);
      } catch {
        return value.slice(1, -1);
      }
    }
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return splitInlineYaml(inner).map(parseScalar);
  }
  if (value.startsWith('{') && value.endsWith('}')) {
    const inner = value.slice(1, -1).trim();
    const result = {};
    if (!inner) return result;
    for (const item of splitInlineYaml(inner)) {
      const separator = findUnquotedColon(item);
      if (separator === -1) continue;
      const key = parseScalar(item.slice(0, separator));
      result[String(key)] = parseScalar(item.slice(separator + 1));
    }
    return result;
  }
  return value;
}

function splitInlineYaml(value) {
  const result = [];
  let quote = null;
  let depth = 0;
  let current = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      current += char;
      if (char === quote && value[index - 1] !== '\\') quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '[' || char === '{' || char === '(') depth += 1;
    if (char === ']' || char === '}' || char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) result.push(current.trim());
  return result;
}

function findUnquotedColon(value) {
  let quote = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === quote && value[index - 1] !== '\\') quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    if (char === ':') return index;
  }
  return -1;
}

function parseSimpleYaml(yaml) {
  const lines = normalizeNewlines(yaml).split('\n');
  const root = {};
  const stack = [{ indent: -1, value: root }];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const originalLine = lines[lineIndex];
    if (!originalLine.trim() || originalLine.trimStart().startsWith('#')) continue;
    const indent = originalLine.length - originalLine.trimStart().length;
    const trimmed = originalLine.trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].value;

    if (trimmed.startsWith('- ')) {
      if (!Array.isArray(parent)) continue;
      parent.push(parseScalar(trimmed.slice(2)));
      continue;
    }

    const separator = findUnquotedColon(trimmed);
    if (separator === -1 || Array.isArray(parent)) continue;
    const key = String(parseScalar(trimmed.slice(0, separator)));
    const rawValue = trimmed.slice(separator + 1).trim();

    if (/^[>|][+-]?$/.test(rawValue)) {
      const blockIndent = findNextContentIndent(lines, lineIndex + 1, indent);
      const collected = [];
      while (lineIndex + 1 < lines.length) {
        const candidate = lines[lineIndex + 1];
        const candidateIndent = candidate.length - candidate.trimStart().length;
        if (candidate.trim() && candidateIndent <= indent) break;
        lineIndex += 1;
        if (!candidate.trim()) collected.push('');
        else collected.push(candidate.slice(Math.min(blockIndent, candidate.length)));
      }
      const folded = rawValue.startsWith('>');
      parent[key] = folded ? collected.join('\n').replace(/([^\n])\n([^\n])/g, '$1 $2') : collected.join('\n');
      continue;
    }

    if (rawValue === '') {
      const next = nextMeaningfulLine(lines, lineIndex + 1);
      const container = next && next.trimmed.startsWith('- ') ? [] : {};
      parent[key] = container;
      stack.push({ indent, value: container });
      continue;
    }

    parent[key] = parseScalar(rawValue);
  }

  return root;
}

function findNextContentIndent(lines, startIndex, parentIndent) {
  for (let index = startIndex; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    const indent = lines[index].length - lines[index].trimStart().length;
    return indent > parentIndent ? indent : parentIndent + 2;
  }
  return parentIndent + 2;
}

function nextMeaningfulLine(lines, startIndex) {
  for (let index = startIndex; index < lines.length; index += 1) {
    if (!lines[index].trim() || lines[index].trimStart().startsWith('#')) continue;
    return { index, trimmed: lines[index].trim() };
  }
  return null;
}

function parseFrontmatter(text, sourcePath = '<memory>') {
  const normalized = normalizeNewlines(text).replace(/^\uFEFF/, '');
  if (!normalized.startsWith('---\n')) {
    return { data: {}, body: normalized, raw: normalized };
  }

  const endMatch = normalized.slice(4).match(/^---\s*$|^\.\.\.\s*$/m);
  if (!endMatch) {
    throw new BuildWithCliError(`Unterminated YAML frontmatter in ${sourcePath}`, {
      code: 'INVALID_FRONTMATTER',
    });
  }
  const endIndex = 4 + endMatch.index;
  const yaml = normalized.slice(4, endIndex);
  const bodyStart = normalized.indexOf('\n', endIndex) + 1;
  const body = bodyStart > 0 ? normalized.slice(bodyStart) : '';

  let data;
  try {
    // Prefer the repository's existing parser when dependencies are installed.
    // The fallback keeps the CLI usable for its own bootstrap and unit tests.
    // eslint-disable-next-line global-require, import/no-extraneous-dependencies
    const matter = require('gray-matter');
    data = matter(normalized).data;
  } catch (error) {
    if (error && error.code !== 'MODULE_NOT_FOUND') {
      throw new BuildWithCliError(`Unable to parse YAML frontmatter in ${sourcePath}: ${error.message}`, {
        code: 'INVALID_FRONTMATTER',
      });
    }
    data = parseSimpleYaml(yaml);
  }

  return { data: isPlainObject(data) ? data : {}, body, raw: normalized };
}

function yamlScalar(value) {
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  const text = String(value);
  if (
    text.length > 0 &&
    /^[A-Za-z0-9_./~+<>=-]+(?: [A-Za-z0-9_./~+<>=-]+)*$/.test(text) &&
    !/^(?:true|false|null|~|[-+]?\d+(?:\.\d+)?)$/i.test(text) &&
    !/^[!&*#?{}[\],|>@`]/.test(text) &&
    !text.includes(': ')
  ) {
    return text;
  }
  return JSON.stringify(text);
}

function emitYamlValue(value, indent) {
  const prefix = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${prefix}[]`];
    if (value.every((item) => !Array.isArray(item) && !isPlainObject(item))) {
      return [`${prefix}[${value.map(yamlScalar).join(', ')}]`];
    }
    const lines = [];
    for (const item of value) {
      if (Array.isArray(item) || isPlainObject(item)) {
        lines.push(`${prefix}-`);
        lines.push(...emitYamlValue(item, indent + 2));
      } else {
        lines.push(`${prefix}- ${yamlScalar(item)}`);
      }
    }
    return lines;
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value).filter(([, child]) => child !== undefined);
    if (entries.length === 0) return [`${prefix}{}`];
    const lines = [];
    for (const [key, child] of entries) {
      if (Array.isArray(child) || isPlainObject(child)) {
        if ((Array.isArray(child) && child.length === 0) || (isPlainObject(child) && Object.keys(child).length === 0)) {
          lines.push(`${prefix}${yamlScalar(key)}: ${Array.isArray(child) ? '[]' : '{}'}`);
        } else if (Array.isArray(child) && child.every((item) => !Array.isArray(item) && !isPlainObject(item))) {
          lines.push(`${prefix}${yamlScalar(key)}: [${child.map(yamlScalar).join(', ')}]`);
        } else {
          lines.push(`${prefix}${yamlScalar(key)}:`);
          lines.push(...emitYamlValue(child, indent + 2));
        }
      } else if (typeof child === 'string' && child.includes('\n')) {
        lines.push(`${prefix}${yamlScalar(key)}: |-`);
        for (const blockLine of child.split('\n')) lines.push(`${prefix}  ${blockLine}`);
      } else {
        lines.push(`${prefix}${yamlScalar(key)}: ${yamlScalar(child)}`);
      }
    }
    return lines;
  }
  return [`${prefix}${yamlScalar(value)}`];
}

function stringifyFrontmatter(data, body) {
  const rendered = emitYamlValue(data, 0).join('\n');
  return `---\n${rendered}\n---\n\n${normalizeNewlines(body).replace(/^\n+/, '').replace(/\s+$/, '')}\n`;
}

function parseToolList(value) {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.map(String).map((entry) => entry.trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((entry) => entry.trim()).filter(Boolean);
  return [String(value)];
}

module.exports = { parseFrontmatter, stringifyFrontmatter, parseToolList };
