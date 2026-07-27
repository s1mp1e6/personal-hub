const fs = require('fs');
const path = require('path');

const htmlPath = path.resolve(__dirname, '..', 'site', 'index.html');
const swPath = path.resolve(__dirname, '..', 'site', 'sw.js');
const html = fs.readFileSync(htmlPath, 'utf8');
const sw = fs.readFileSync(swPath, 'utf8');

function fail(message) {
  throw new Error(message);
}

const script = html.match(/<script>([\s\S]*)<\/script>/);
if (!script) fail('index.html script block not found');
new Function(script[1]);
new Function(sw);

if (html.includes('document.write')) fail('document.write should not be used');
if (html.includes('console.log(')) fail('console.log should not remain in production HTML');
if (/[�]/.test(html)) fail('replacement character found in HTML');

const blankTargetLinks = [...html.matchAll(/<a\b[^>]*target="_blank"[^>]*>/g)].map(match => match[0]);
const unsafeBlankLinks = blankTargetLinks.filter(tag => !/rel="[^"]*\bnoopener\b/.test(tag));
if (unsafeBlankLinks.length) fail(`target=_blank links missing noopener: ${unsafeBlankLinks.join(' | ')}`);

const report = {
  htmlBytes: Buffer.byteLength(html),
  buttonTags: (html.match(/<button/g) || []).length,
  ariaLabels: (html.match(/aria-label=/g) || []).length,
  blankTargetLinks: blankTargetLinks.length,
  scriptTags: (html.match(/<script/g) || []).length,
  localStorageRefs: (html.match(/localStorage/g) || []).length,
  indexedDBRefs: (html.match(/indexedDB/g) || []).length,
};

console.log(JSON.stringify(report, null, 2));
