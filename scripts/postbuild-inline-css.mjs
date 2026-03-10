#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DIST_DIR = path.resolve(process.cwd(), 'dist');
const INDEX_HTML_PATH = path.join(DIST_DIR, 'index.html');
const HEADERS_PATH = path.join(DIST_DIR, '_headers');

const LINK_TAG_PATTERN = /<link\b[^>]*>/gi;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function readCssLinks(indexHtml) {
  const matches = [];
  for (const match of indexHtml.matchAll(LINK_TAG_PATTERN)) {
    const linkTag = match[0];
    if (!/\brel=(["'])stylesheet\1/i.test(linkTag)) {
      continue;
    }

    const hrefMatch = linkTag.match(/\bhref=(["'])([^"']+\.css)\1/i);
    if (!hrefMatch) {
      continue;
    }

    matches.push({
      fullTag: linkTag,
      href: hrefMatch[2]
    });
  }
  return matches;
}

function addStyleHashToCsp(headersRaw, hashToken) {
  const lines = headersRaw.split('\n');
  let updated = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.includes('Content-Security-Policy:')) {
      continue;
    }

    const cspIndex = line.indexOf('Content-Security-Policy:');
    const prefix = line.slice(0, cspIndex) + 'Content-Security-Policy: ';
    const cspValue = line.slice(cspIndex + 'Content-Security-Policy:'.length).trim();

    const styleDirectiveMatch = cspValue.match(/style-src\s+([^;]+)/);
    assert(styleDirectiveMatch, 'Content-Security-Policy must include style-src before postbuild transform.');

    const styleValues = styleDirectiveMatch[1].trim();
    if (styleValues.includes(hashToken)) {
      return headersRaw;
    }

    const updatedStyleDirective = `style-src ${styleValues} ${hashToken}`;
    const updatedCsp = cspValue.replace(/style-src\s+([^;]+)/, updatedStyleDirective);
    lines[i] = `${prefix}${updatedCsp}`;
    updated = true;
    break;
  }

  assert(updated, 'Unable to locate Content-Security-Policy header in dist/_headers.');
  return lines.join('\n');
}

async function main() {
  const [indexHtmlRaw, headersRaw] = await Promise.all([
    readFile(INDEX_HTML_PATH, 'utf8'),
    readFile(HEADERS_PATH, 'utf8')
  ]);

  const cssLinks = readCssLinks(indexHtmlRaw);
  assert(cssLinks.length > 0, 'No stylesheet <link> found in dist/index.html.');
  assert(cssLinks.length === 1, `Expected exactly one stylesheet <link>, found ${cssLinks.length}.`);

  const cssHref = cssLinks[0].href;
  const cssPath = path.join(DIST_DIR, cssHref.replace(/^\//, ''));
  const cssText = await readFile(cssPath, 'utf8');
  assert(cssText.length > 0, 'Resolved stylesheet is empty, refusing to inline.');

  const inlineStyleTag = `<style>${cssText}</style>`;
  const updatedIndexHtml = indexHtmlRaw.replace(cssLinks[0].fullTag, inlineStyleTag);
  assert(updatedIndexHtml !== indexHtmlRaw, 'Failed to replace stylesheet <link> with inline <style>.');

  const styleHash = createHash('sha256').update(cssText, 'utf8').digest('base64');
  const hashToken = `'sha256-${styleHash}'`;
  const updatedHeaders = addStyleHashToCsp(headersRaw, hashToken);

  await Promise.all([
    writeFile(INDEX_HTML_PATH, updatedIndexHtml, 'utf8'),
    writeFile(HEADERS_PATH, updatedHeaders, 'utf8')
  ]);
}

await main();
