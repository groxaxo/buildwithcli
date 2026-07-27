'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function toPosix(value) {
  return String(value).replace(/\\/g, '/').split(path.sep).join('/');
}

function slugify(value, fallback = 'unnamed') {
  const slug = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 64)
    .replace(/-+$/g, '');
  return slug || fallback;
}

function assertValidName(name, label = 'name') {
  if (typeof name !== 'string' || name.length < 1 || name.length > 64 || !NAME_RE.test(name)) {
    throw new Error(`${label} must be 1-64 lowercase alphanumeric/hyphen characters: ${JSON.stringify(name)}`);
  }
  return name;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableSort(value) {
  if (Array.isArray(value)) return value.map(stableSort);
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableSort(value[key])]));
  }
  return value;
}

function stableStringify(value, space = 2) {
  return JSON.stringify(stableSort(value), null, space) + '\n';
}

function asArray(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
  return [value];
}

function unique(values) {
  return [...new Set(values.filter((value) => value != null))];
}

function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function tomlKey(value) {
  const text = String(value);
  return /^[A-Za-z0-9_-]+$/.test(text) ? text : tomlString(text);
}

function tomlArray(values) {
  return `[${values.map((value) => tomlString(value)).join(', ')}]`;
}

function tomlInlineTable(object) {
  return `{ ${Object.entries(object || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${tomlKey(key)} = ${tomlString(value)}`)
    .join(', ')} }`;
}

function globToRegExp(glob) {
  let output = '^';
  const input = toPosix(glob || '*');
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (char === '*') {
      if (input[i + 1] === '*') {
        i += 1;
        if (input[i + 1] === '/') i += 1;
        output += '.*';
      } else {
        output += '[^/]*';
      }
    } else if (char === '?') {
      output += '[^/]';
    } else {
      output += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  output += '$';
  return new RegExp(output);
}

function matchesAny(value, patterns) {
  if (!patterns || patterns.length === 0) return true;
  return patterns.some((pattern) => globToRegExp(pattern).test(toPosix(value)));
}

function deepMerge(base, incoming) {
  if (Array.isArray(base) && Array.isArray(incoming)) return [...base, ...incoming];
  if (base && incoming && typeof base === 'object' && typeof incoming === 'object' && !Array.isArray(base) && !Array.isArray(incoming)) {
    const merged = { ...base };
    for (const [key, value] of Object.entries(incoming)) {
      merged[key] = key in merged ? deepMerge(merged[key], value) : value;
    }
    return merged;
  }
  return incoming;
}

function truncate(value, limit) {
  const text = String(value || '').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function parseJsonc(text) {
  const input = String(text || '').replace(/^\uFEFF/, '');
  let output = '';
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    const next = input[i + 1];
    if (lineComment) {
      if (char === '\n') {
        lineComment = false;
        output += char;
      } else {
        output += ' ';
      }
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        output += '  ';
        i += 1;
        blockComment = false;
      } else {
        output += char === '\n' ? '\n' : ' ';
      }
      continue;
    }
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
    } else if (char === '/' && next === '/') {
      output += '  ';
      i += 1;
      lineComment = true;
    } else if (char === '/' && next === '*') {
      output += '  ';
      i += 1;
      blockComment = true;
    } else {
      output += char;
    }
  }
  if (inString || blockComment) throw new Error('Unterminated string or block comment in JSONC');
  // Remove trailing commas while respecting strings (comments are already blanked).
  let cleaned = '';
  inString = false;
  escaped = false;
  for (let i = 0; i < output.length; i += 1) {
    const char = output[i];
    if (inString) {
      cleaned += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      cleaned += char;
      continue;
    }
    if (char === ',') {
      let next = i + 1;
      while (next < output.length && /\s/.test(output[next])) next += 1;
      if (output[next] === '}' || output[next] === ']') continue;
    }
    cleaned += char;
  }
  return JSON.parse(cleaned);
}

function generationTimestamp(explicit) {
  if (explicit === false || explicit === null) return null;
  if (explicit instanceof Date) return explicit.toISOString();
  if (typeof explicit === 'string' && explicit) return new Date(explicit).toISOString();
  const epoch = process.env.SOURCE_DATE_EPOCH;
  if (epoch && /^\d+$/.test(epoch)) return new Date(Number(epoch) * 1000).toISOString();
  return explicit === true ? new Date().toISOString() : null;
}

module.exports = {
  NAME_RE,
  asArray,
  assertValidName,
  deepMerge,
  generationTimestamp,
  globToRegExp,
  matchesAny,
  parseJsonc,
  sha256,
  shellQuote,
  slugify,
  stableSort,
  stableStringify,
  toPosix,
  tomlArray,
  tomlInlineTable,
  tomlKey,
  tomlString,
  truncate,
  unique,
};
