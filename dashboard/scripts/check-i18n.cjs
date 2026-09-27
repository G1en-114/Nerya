const fs = require('fs');
const path = require('path');

const root = process.cwd();
const locales = ['en', 'zh'];
const ignoredSourceDirs = new Set(['node_modules', '.next', 'tests']);

function walk(dir, predicate, output = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredSourceDirs.has(entry.name)) walk(file, predicate, output);
    } else if (predicate(file)) output.push(file);
  }
  return output;
}
function leaves(value, prefix = '', output = new Set()) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) leaves(child, prefix ? prefix + '.' + key : key, output);
  } else output.add(prefix);
  return output;
}
function readLocale(locale) {
  const folder = path.join(root, 'messages', locale);
  const files = fs.readdirSync(folder).filter((name) => name.endsWith('.json')).sort();
  if (!files.length) throw new Error('No locale resources in ' + folder);
  const values = Object.fromEntries(files.map((name) => [name, JSON.parse(fs.readFileSync(path.join(folder, name), 'utf8'))]));
  return { files, values, keys: new Set(files.flatMap((name) => [...leaves(values[name])])) };
}
function mergeCopy(resources) {
  const merge = (target, source) => Object.entries(source).reduce((merged, [key, value]) => ({
    ...merged,
    [key]: merged[key] && typeof merged[key] === 'object' && value && typeof value === 'object' && !Array.isArray(merged[key]) && !Array.isArray(value)
      ? merge(merged[key], value)
      : value,
  }), target);
  const collect = (resource) => !resource || typeof resource !== 'object' || Array.isArray(resource) ? {} : Object.entries(resource).reduce((copy, [key, value]) =>
    merge(copy, key === 'copy' && value && typeof value === 'object' && !Array.isArray(value) ? value : collect(value)), {});
  return Object.values(resources).reduce((copy, resource) => merge(copy, collect(resource)), {});
}
function messageAt(messages, key) {
  return key.split('.').reduce((value, part) => value && typeof value === 'object' ? value[part] : undefined, messages);
}
const resources = Object.fromEntries(locales.map((locale) => [locale, readLocale(locale)]));
if (resources.en.files.join() !== resources.zh.files.join()) throw new Error('Locale resource file sets differ');
for (const key of resources.en.keys) if (!resources.zh.keys.has(key)) throw new Error('Missing zh message: ' + key);
for (const key of resources.zh.keys) if (!resources.en.keys.has(key)) throw new Error('Missing en message: ' + key);
const oldImports = walk(root, (file) => /\.(ts|tsx)$/.test(file)).filter((file) => /messages\/(en|zh)\.json/.test(fs.readFileSync(file, 'utf8')));
if (oldImports.length) throw new Error('Legacy single-file locale imports remain:\n' + oldImports.join('\n'));
const sourceFiles = walk(root, (file) => file.endsWith('.ts') || file.endsWith('.tsx'));
const legacyPairs = sourceFiles.filter((file) => file.includes('keyOrZh: string') || file.includes('typeof enOrValues') || file.includes('PairedTranslator'));
if (legacyPairs.length) throw new Error('Components must resolve resource keys, not paired locale strings');
const copyKeys = [...new Set(sourceFiles.flatMap((file) => [...fs.readFileSync(file, 'utf8').matchAll(/["'](copy[.][A-Za-z0-9_.]+)["']/g)].map((match) => match[1])))];
for (const locale of locales) {
  const merged = { copy: mergeCopy(resources[locale].values) };
  const missing = copyKeys.filter((key) => typeof messageAt(merged, key) !== 'string');
  if (missing.length) throw new Error('Missing ' + locale + ' runtime copy messages: ' + missing.join(', '));
}
console.log('i18n resources valid: ' + resources.en.files.length + ' files per locale, ' + resources.en.keys.size + ' message leaves, ' + copyKeys.length + ' runtime copy keys');
