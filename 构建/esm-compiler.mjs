import path from 'node:path';

// Purpose-built static ESM compiler for an explicitly supplied own-source
// graph. No npm template, source discovery, eval or upstream bundler.
export function tokensOf(source) {
  const tokens = []; let i = 0;
  const add = (type, start, end, value = source.slice(start, end)) => tokens.push({ type, start, end, value });
  while (i < source.length) {
    const start = i, c = source[i];
    if (/\s/.test(c)) { i++; continue; }
    if (source.startsWith('//', i)) { i = source.indexOf('\n', i + 2); if (i < 0) i = source.length; continue; }
    if (source.startsWith('/*', i)) { const end = source.indexOf('*/', i + 2); if (end < 0) throw new SyntaxError('Unterminated comment'); i = end + 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c; i++;
      while (i < source.length && source[i] !== quote) { if (source[i] === '\\') i++; i++; }
      if (i >= source.length) throw new SyntaxError('Unterminated string/template'); i++;
      if (quote === '`') add('template', start, i);
      else {
        // Module specifiers use plain relative strings; escapes there are
        // rejected so the graph can never hide an extra source path.
        const inner = source.slice(start + 1, i - 1);
        add('string', start, i, inner);
      }
      continue;
    }
    if (c === '/' && !source.startsWith('/=', i)) {
      const previous = tokens.at(-1)?.value;
      if (previous === undefined || ['=', '(', '[', '{', ',', ':', 'return', '=>', '!', '&&', '||', '?', ';'].includes(previous)) {
        i++; let bracket = false;
        while (i < source.length) {
          if (source[i] === '\\') { i += 2; continue; }
          if (source[i] === '[') bracket = true;
          if (source[i] === ']') bracket = false;
          if (source[i] === '/' && !bracket) { i++; break; }
          if (source[i] === '\n') throw new SyntaxError('Unterminated regexp'); i++;
        }
        while (/[a-z]/i.test(source[i] || '') && i < source.length) i++;
        add('regexp', start, i); continue;
      }
    }
    if (/[A-Za-z_$]/.test(c)) { i++; while (/[\w$]/.test(source[i] || '') && i < source.length) i++; add('word', start, i); continue; }
    if (/\d/.test(c)) { i++; while (/[\w.]/.test(source[i] || '') && i < source.length) i++; add('number', start, i); continue; }
    if (source.startsWith('=>', i) || source.startsWith('?.', i)) i += 2; else i++;
    add('punct', start, i);
  }
  return tokens;
}
function specifier(from, value, sources) {
  if (typeof value !== 'string' || !value.startsWith('./') && !value.startsWith('../') || value.includes('\\') || /[?#\0]/.test(value)) throw new Error('Only explicit relative ESM modules are allowed');
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(from), value));
  if (resolved.startsWith('../') || !sources.has(resolved) || !resolved.endsWith('.mjs')) throw new Error('Dependency outside source allowlist: ' + resolved);
  return resolved;
}
function namedBindings(tokens) {
  const names = []; let i = 0;
  while (i < tokens.length) {
    if (tokens[i].value === ',') { i++; continue; }
    const original = tokens[i++]?.value;
    if (!/^[\w$]+$/.test(original || '')) throw new SyntaxError('Named binding syntax');
    const alias = tokens[i]?.value === 'as' ? (i++, tokens[i++]?.value) : original;
    if (!/^[\w$]+$/.test(alias || '')) throw new SyntaxError('Named alias syntax');
    names.push([original, alias]);
  }
  return names;
}
export function parseModule(name, source, sources) {
  const t = tokensOf(source), edits = [], imports = [], exported = [], stars = [];
  let depth = 0;
  const statementEnd = index => {
    // Static declarations terminate at a semicolon, or at the end of their
    // quoted module specifier when author style omits semicolons.
    let end = index;
    while (end < t.length && t[end].value !== ';') end++;
    return end < t.length ? end : t.length - 1;
  };
  for (let i = 0; i < t.length; i++) {
    const token = t[i];
    if (token.type === 'word' && token.value === 'import' && t[i + 1]?.value === '(') throw new SyntaxError('Dynamic import unsupported in plugin bundle');
    if (depth === 0 && token.type === 'word' && token.value === 'import') {
      let end, specIndex;
      if (t[i + 1]?.type === 'string') specIndex = i + 1;
      else { specIndex = i + 1; while (specIndex < t.length && t[specIndex].value !== 'from') specIndex++; specIndex++; }
      if (t[specIndex]?.type !== 'string') throw new SyntaxError('Static import specifier');
      const dependency = specifier(name, t[specIndex].value, sources);
      end = t[specIndex + 1]?.value === ';' ? specIndex + 1 : specIndex;
      const clause = t.slice(i + 1, t[specIndex - 1]?.value === 'from' ? specIndex - 1 : specIndex);
      const bindings = [];
      if (clause.length) {
        if (clause[0].value === '*') {
          if (clause[1]?.value !== 'as' || !clause[2]) throw new SyntaxError('Namespace import');
          bindings.push({ namespace: clause[2].value });
        } else if (clause[0].value === '{') {
          if (clause.at(-1)?.value !== '}') throw new SyntaxError('Named import braces');
          for (const [original, alias] of namedBindings(clause.slice(1, -1))) bindings.push({ original, alias });
        } else throw new SyntaxError('Default imports are outside the own-module subset');
      }
      imports.push({ dependency, bindings }); edits.push({ start: token.start, end: t[end].end, text: '' }); i = end; continue;
    }
    if (depth === 0 && token.type === 'word' && token.value === 'export') {
      const next = t[i + 1];
      if (next?.value === 'default') throw new SyntaxError('Default exports are outside the own-module subset');
      if (next?.value === '*' || next?.value === '{') {
        let close = i + 1;
        if (next.value === '{') { while (close < t.length && t[close].value !== '}') close++; }
        const from = t[close + 1]?.value === 'from';
        const dependency = from ? specifier(name, t[close + 2]?.value, sources) : null;
        if (next.value === '*' && !dependency) throw new SyntaxError('Export star dependency');
        const final = from ? close + 2 : close;
        const end = t[final + 1]?.value === ';' ? final + 1 : final;
        if (next.value === '*') stars.push(dependency);
        else for (const [original, alias] of namedBindings(t.slice(i + 2, close))) exported.push({ original, alias, dependency });
        if (dependency) imports.push({ dependency, bindings: [] });
        edits.push({ start: token.start, end: t[end].end, text: '' }); i = end; continue;
      }
      let declaration = i + 1;
      if (t[declaration]?.value === 'async') declaration++;
      const kind = t[declaration]?.value;
      if (kind === 'function' || kind === 'class') {
        let n = declaration + 1; if (t[n]?.value === '*') n++;
        if (t[n]?.type !== 'word') throw new SyntaxError('Export declaration name');
        exported.push({ original: t[n].value, alias: t[n].value });
      } else if (['const', 'let', 'var'].includes(kind)) {
        const end = statementEnd(declaration); let localDepth = 0, expectName = true;
        for (let j = declaration + 1; j <= end; j++) {
          const v = t[j].value;
          if (expectName) {
            if (t[j].type !== 'word') throw new SyntaxError('Destructuring exports unsupported');
            exported.push({ original: v, alias: v }); expectName = false;
          }
          if (['(', '[', '{'].includes(v)) localDepth++;
          if ([')', ']', '}'].includes(v)) localDepth--;
          if (localDepth === 0 && v === ',') expectName = true;
        }
      } else throw new SyntaxError('Unsupported ESM export syntax');
      edits.push({ start: token.start, end: token.end, text: '' });
    }
    if (['{', '[', '('].includes(token.value) && token.type === 'punct') depth++;
    if (['}', ']', ')'].includes(token.value) && token.type === 'punct') depth--;
  }
  let body = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) body = body.slice(0, edit.start) + edit.text + body.slice(edit.end);
  if (new Set(exported.map(e => e.alias)).size !== exported.length) throw new SyntaxError('Duplicate export name');
  return { name, body, imports, exported, stars };
}
export function compileESM(sourcesInput, entry) {
  const sources = sourcesInput instanceof Map ? sourcesInput : new Map(Object.entries(sourcesInput));
  if (!sources.has(entry)) throw new Error('Entry not allowlisted');
  const parsed = new Map(), order = [], active = new Set(), visited = new Set();
  function visit(name) {
    if (active.has(name)) throw new Error('Cyclic plugin ESM graph unsupported');
    if (visited.has(name)) return;
    active.add(name);
    const module = parseModule(name, sources.get(name), sources); parsed.set(name, module);
    const dependencies = [...new Set([...module.imports.map(i => i.dependency), ...module.stars])].sort();
    for (const dependency of dependencies) visit(dependency);
    active.delete(name); visited.add(name); order.push(name);
  }
  visit(entry);
  const output = ['/* Independently compiled explicit own-source ESM graph. */', '(function(){', '"use strict";', 'const __independentModules = Object.create(null);'];
  for (const name of order) {
    const m = parsed.get(name), imports = [];
    for (const item of m.imports) {
      const dep = parsed.get(item.dependency);
      const available = new Set(dep.exported.map(e => e.alias));
      for (const binding of item.bindings) {
        if (binding.namespace) imports.push('const ' + binding.namespace + ' = __independentModules[' + JSON.stringify(item.dependency) + '];');
        else {
          if (!available.has(binding.original) && !dep.stars.length) throw new Error('Missing named export: ' + binding.original);
          imports.push('const ' + binding.alias + ' = __independentModules[' + JSON.stringify(item.dependency) + '][' + JSON.stringify(binding.original) + '];');
        }
      }
    }
    output.push('__independentModules[' + JSON.stringify(name) + '] = (function(){', ...imports, m.body, 'const __exports = Object.create(null);');
    for (const dep of m.stars) output.push('Object.assign(__exports, __independentModules[' + JSON.stringify(dep) + ']);');
    for (const e of m.exported) output.push('Object.defineProperty(__exports,' + JSON.stringify(e.alias) + ',{enumerable:true,get:()=> ' + (e.dependency ? '__independentModules[' + JSON.stringify(e.dependency) + '][' + JSON.stringify(e.original) + ']' : e.original) + '});');
    output.push('return __exports;', '})();');
  }
  output.push('return __independentModules[' + JSON.stringify(entry) + '];', '})();');
  return { code: output.join('\n'), order };
}
