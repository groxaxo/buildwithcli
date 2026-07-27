'use strict';

/*
 * Safe, dependency-free YAML subset used for agent metadata and generated
 * config fragments. It intentionally rejects aliases, tags, duplicate keys,
 * tabs, and ambiguous executable YAML features.
 */

function stripComment(value) {
  let single = false;
  let double = false;
  let escaped = false;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && double) {
      escaped = true;
      continue;
    }
    if (char === "'" && !double) single = !single;
    else if (char === '"' && !single) double = !double;
    else if (char === '#' && !single && !double && (i === 0 || /\s/.test(value[i - 1]))) {
      return value.slice(0, i).trimEnd();
    }
  }
  return value.trimEnd();
}

function splitInline(value, delimiter = ',') {
  const parts = [];
  let start = 0;
  let depth = 0;
  let single = false;
  let double = false;
  let escaped = false;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && double) {
      escaped = true;
      continue;
    }
    if (char === "'" && !double) single = !single;
    else if (char === '"' && !single) double = !double;
    else if (!single && !double) {
      if (char === '[' || char === '{') depth += 1;
      else if (char === ']' || char === '}') depth -= 1;
      else if (char === delimiter && depth === 0) {
        parts.push(value.slice(start, i).trim());
        start = i + 1;
      }
    }
  }
  if (single || double || depth !== 0) throw new Error(`Malformed inline YAML value: ${value}`);
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

function findUnquotedColon(value) {
  let single = false;
  let double = false;
  let escaped = false;
  let depth = 0;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && double) {
      escaped = true;
      continue;
    }
    if (char === "'" && !double) single = !single;
    else if (char === '"' && !single) double = !double;
    else if (!single && !double) {
      if (char === '[' || char === '{') depth += 1;
      else if (char === ']' || char === '}') depth -= 1;
      else if (char === ':' && depth === 0) return i;
    }
  }
  return -1;
}

function parseKey(raw) {
  const value = String(raw || '').trim();
  if (!value) throw new Error('YAML mapping key cannot be empty');
  if (/^[!&*]/.test(value)) throw new Error(`YAML tags and aliases are not supported: ${value}`);
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return String(parseScalar(value));
  }
  return value;
}

function setUnique(object, key, value, line) {
  if (Object.prototype.hasOwnProperty.call(object, key)) {
    throw new Error(`Duplicate YAML key '${key}'${line ? ` at line ${line}` : ''}`);
  }
  object[key] = value;
}

function parseScalar(raw) {
  const value = stripComment(String(raw || '').trim());
  if (value === '') return '';
  if (/^[!&*]/.test(value)) throw new Error(`YAML tags and aliases are not supported: ${value}`);
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch (error) {
      throw new Error(`Invalid quoted YAML string: ${error.message}`);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    return inner ? splitInline(inner).map(parseScalar) : [];
  }
  if (value.startsWith('{') && value.endsWith('}')) {
    const object = {};
    const inner = value.slice(1, -1).trim();
    if (!inner) return object;
    for (const pair of splitInline(inner)) {
      const colon = findUnquotedColon(pair);
      if (colon < 1) throw new Error(`Invalid inline YAML object entry: ${pair}`);
      const key = parseKey(pair.slice(0, colon));
      setUnique(object, key, parseScalar(pair.slice(colon + 1)));
    }
    return object;
  }
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === 'true';
  if (/^(null|~)$/i.test(value)) return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) return Number(value);
  return value;
}

function preprocess(text) {
  return String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((raw, index) => {
      const match = raw.match(/^([ \t]*)(.*)$/);
      if (!match) throw new Error(`Invalid YAML line ${index + 1}`);
      if (match[1].includes('\t')) throw new Error(`Tabs are not allowed for YAML indentation (line ${index + 1})`);
      return { raw, indent: match[1].length, text: match[2], line: index + 1 };
    });
}

function nextMeaningful(lines, start) {
  for (let i = start; i < lines.length; i += 1) {
    const trimmed = lines[i].text.trim();
    if (trimmed && !trimmed.startsWith('#')) return i;
  }
  return -1;
}

function parseYamlSubset(text) {
  const lines = preprocess(text);
  const root = {};
  const stack = [{ indent: -1, type: 'map', value: root }];

  function parentFor(indent) {
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    return stack[stack.length - 1];
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.text.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parent = parentFor(line.indent);

    if (trimmed === '-' || trimmed.startsWith('- ')) {
      if (parent.type !== 'list') throw new Error(`Unexpected YAML list item at line ${line.line}`);
      const itemText = trimmed === '-' ? '' : trimmed.slice(2).trim();
      if (!itemText) {
        const nextIndex = nextMeaningful(lines, i + 1);
        const next = nextIndex >= 0 ? lines[nextIndex] : null;
        const isList = Boolean(next && next.indent > line.indent && next.text.trim().startsWith('-'));
        const value = isList ? [] : {};
        parent.value.push(value);
        stack.push({ indent: line.indent, type: isList ? 'list' : 'map', value });
        continue;
      }
      const colon = findUnquotedColon(itemText);
      if (colon > 0) {
        const object = {};
        parent.value.push(object);
        const key = parseKey(itemText.slice(0, colon));
        const rest = itemText.slice(colon + 1).trim();
        if (rest) {
          setUnique(object, key, parseScalar(rest), line.line);
          stack.push({ indent: line.indent, type: 'map', value: object });
        } else {
          const nextIndex = nextMeaningful(lines, i + 1);
          const next = nextIndex >= 0 ? lines[nextIndex] : null;
          const isList = Boolean(next && next.indent > line.indent && next.text.trim().startsWith('-'));
          const value = isList ? [] : {};
          setUnique(object, key, value, line.line);
          stack.push({ indent: line.indent, type: 'map', value: object });
          stack.push({ indent: line.indent + 1, type: isList ? 'list' : 'map', value });
        }
      } else {
        parent.value.push(parseScalar(itemText));
      }
      continue;
    }

    if (parent.type !== 'map') throw new Error(`Expected YAML list item at line ${line.line}`);
    const colon = findUnquotedColon(trimmed);
    if (colon < 1) throw new Error(`Invalid YAML mapping at line ${line.line}: ${trimmed}`);
    const key = parseKey(trimmed.slice(0, colon));
    const rest = trimmed.slice(colon + 1).trim();

    if (/^[|>][+-]?$/.test(rest)) {
      const folded = rest.startsWith('>');
      const keep = rest.endsWith('+');
      const strip = rest.endsWith('-');
      const body = [];
      const baseIndent = line.indent;
      let childIndent = null;
      let j = i + 1;
      for (; j < lines.length; j += 1) {
        const child = lines[j];
        if (child.text.trim() && child.indent <= baseIndent) break;
        if (childIndent == null && child.text.trim()) childIndent = child.indent;
        if (!child.text.trim()) body.push('');
        else body.push(child.raw.slice(Math.min(child.raw.length, childIndent ?? baseIndent + 2)));
      }
      i = j - 1;
      let block = folded
        ? body.reduce((acc, row, index) => index === 0 ? row : acc + (row === '' || body[index - 1] === '' ? '\n' : ' ') + row, '')
        : body.join('\n');
      if (strip) block = block.replace(/\n+$/, '');
      else if (keep) block += '\n';
      else block = block.replace(/\n+$/, '') + '\n';
      setUnique(parent.value, key, block, line.line);
      continue;
    }

    if (rest) {
      setUnique(parent.value, key, parseScalar(rest), line.line);
      continue;
    }

    const nextIndex = nextMeaningful(lines, i + 1);
    const next = nextIndex >= 0 ? lines[nextIndex] : null;
    const isList = Boolean(next && next.indent > line.indent && next.text.trim().startsWith('-'));
    const value = isList ? [] : {};
    setUnique(parent.value, key, value, line.line);
    stack.push({ indent: line.indent, type: isList ? 'list' : 'map', value });
  }
  return root;
}

function parseFrontmatter(markdown) {
  const normalized = String(markdown || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!normalized.startsWith('---\n')) return { data: {}, body: normalized, raw: '' };
  const lines = normalized.split('\n');
  let boundary = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === '---' || lines[i] === '...') {
      boundary = i;
      break;
    }
  }
  if (boundary < 0) throw new Error('Frontmatter starts with --- but has no closing delimiter');
  const raw = lines.slice(1, boundary).join('\n');
  const body = lines.slice(boundary + 1).join('\n').replace(/^\n/, '');
  return { data: parseYamlSubset(raw), body, raw };
}

function needsQuotes(value) {
  return value === '' || /[:#\[\]{},&*!|>'"%@`\n\r\t]/.test(value) || /^[-?:](?:\s|$)/.test(value) || /^(true|false|null|~|[-+]?\d+(?:\.\d+)?)$/i.test(value) || /^\s|\s$/.test(value);
}

function yamlKey(value) {
  const text = String(value);
  return /^[A-Za-z0-9_.-]+$/.test(text) ? text : JSON.stringify(text);
}

function scalarToYaml(value) {
  if (value == null) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  const text = String(value);
  return needsQuotes(text) ? JSON.stringify(text) : text;
}

function dumpObject(object, indent, lines) {
  for (const key of Object.keys(object)) {
    const value = object[key];
    if (value === undefined) continue;
    dumpNode(value, indent, lines, yamlKey(key));
  }
}

function dumpNode(value, indent, lines, key = null) {
  const padding = ' '.repeat(indent);
  const prefix = key == null ? padding : `${padding}${key}:`;
  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(key == null ? `${padding}[]` : `${prefix} []`);
      return;
    }
    if (key != null) lines.push(prefix);
    const itemIndent = key == null ? indent : indent + 2;
    for (const item of value) {
      const itemPadding = ' '.repeat(itemIndent);
      if (Array.isArray(item)) {
        lines.push(`${itemPadding}-`);
        dumpNode(item, itemIndent + 2, lines);
      } else if (item && typeof item === 'object' && !Buffer.isBuffer(item)) {
        const entries = Object.entries(item).filter(([, child]) => child !== undefined);
        if (!entries.length) {
          lines.push(`${itemPadding}- {}`);
          continue;
        }
        const [[firstKey, firstValue], ...rest] = entries;
        if (firstValue && typeof firstValue === 'object') {
          lines.push(`${itemPadding}-`);
          dumpObject(item, itemIndent + 2, lines);
        } else {
          lines.push(`${itemPadding}- ${yamlKey(firstKey)}: ${scalarToYaml(firstValue)}`);
          if (rest.length) dumpObject(Object.fromEntries(rest), itemIndent + 2, lines);
        }
      } else {
        lines.push(`${itemPadding}- ${scalarToYaml(item)}`);
      }
    }
    return;
  }
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    if (Object.keys(value).length === 0) {
      lines.push(key == null ? `${padding}{}` : `${prefix} {}`);
      return;
    }
    if (key != null) lines.push(prefix);
    dumpObject(value, key == null ? indent : indent + 2, lines);
    return;
  }
  if (typeof value === 'string' && value.includes('\n')) {
    const normalized = value.replace(/\n$/, '');
    lines.push(`${prefix} |-`);
    for (const row of normalized.split('\n')) lines.push(`${padding}  ${row}`);
    return;
  }
  lines.push(key == null ? `${padding}${scalarToYaml(value)}` : `${prefix} ${scalarToYaml(value)}`);
}

function stringifyYaml(value) {
  const lines = [];
  if (value && typeof value === 'object' && !Array.isArray(value)) dumpObject(value, 0, lines);
  else dumpNode(value, 0, lines);
  return lines.join('\n') + '\n';
}

function stringifyFrontmatter(data, body = '') {
  const yaml = stringifyYaml(data).trimEnd();
  const content = String(body || '').replace(/^\n+/, '').replace(/\s*$/, '');
  return `---\n${yaml}\n---\n${content ? `\n${content}\n` : '\n'}`;
}

module.exports = {
  parseFrontmatter,
  parseScalar,
  parseYamlSubset,
  stringifyFrontmatter,
  stringifyYaml,
};
