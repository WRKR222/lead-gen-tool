/**
 * Reads the files companies upload:
 *  - business profiles (Word .docx, PDF, .txt/.md) -> plain text for AI analysis
 *  - customer lists (Excel .xlsx, .csv) -> rows keyed by header
 *
 * Pure JS (fflate for the ZIP containers that .docx/.xlsx are, unpdf for
 * PDF text), so nothing native has to compile on the host. Scanned PDFs
 * with no text layer are handed to Claude directly as a PDF document when
 * an API key is configured.
 */
const { unzipSync, strFromU8 } = require('fflate');
const llm = require('./llm');
const { parseCsv } = require('./csvImportService');

const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
const MAX_TEXT_CHARS = 80000;

function decodeUpload({ filename, base64 }) {
  if (!filename || !base64) throw new Error('filename and base64 file content are required');
  const buf = Buffer.from(String(base64).replace(/^data:[^,]*,/, ''), 'base64');
  if (!buf.length) throw new Error('The uploaded file is empty');
  if (buf.length > MAX_UPLOAD_BYTES) throw new Error('File is larger than 12 MB');
  const ext = (filename.split('.').pop() || '').toLowerCase();
  return { buf, ext };
}

function decodeXmlEntities(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

function unzip(buf) {
  try { return unzipSync(new Uint8Array(buf)); }
  catch { throw new Error('This file is not a valid .docx/.xlsx (could not open it). If it is an old .doc/.xls file, save it as .docx/.xlsx or PDF first.'); }
}

function docxToText(buf) {
  const files = unzip(buf);
  const xml = files['word/document.xml'];
  if (!xml) throw new Error('Not a Word document (word/document.xml missing)');
  const paragraphs = strFromU8(xml).split(/<\/w:p>/).map(p =>
    [...p.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g)]
      .map(m => (m[1] !== undefined ? m[1] : m[0] === '<w:tab/>' ? '\t' : '\n')).join(''));
  return decodeXmlEntities(paragraphs.map(p => p.trim()).filter(Boolean).join('\n'));
}

async function pdfToText(buf) {
  const { extractText, getDocumentProxy } = require('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { totalPages, text } = await extractText(pdf, { mergePages: true });
  return { text: (Array.isArray(text) ? text.join('\n') : text).trim(), pages: totalPages };
}

async function transcribePdfWithClaude(buf) {
  return llm.complete({
    effort: 'low',
    content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } },
      { type: 'text', text: 'This is a company business profile. Transcribe its substantive content as plain text: what the company does, services and prices, customers, locations, team and anything else useful for sales and marketing. No commentary.' }
    ]
  });
}

/**
 * @param {{filename: string, base64: string}} upload
 * @returns {Promise<{text: string, chars: number, pages?: number, method: string}>}
 */
async function extractText(upload) {
  const { buf, ext } = decodeUpload(upload);
  let text; let pages; let method = ext;
  if (ext === 'docx') text = docxToText(buf);
  else if (ext === 'pdf') {
    ({ text, pages } = await pdfToText(buf));
    if (text.length < 200 && llm.enabled()) {
      text = await transcribePdfWithClaude(buf);
      method = 'pdf_via_claude';
    }
  } else if (['txt', 'md', 'csv', 'json'].includes(ext)) text = buf.toString('utf8');
  else if (ext === 'doc') throw new Error('Old .doc files are not supported - save it as .docx or PDF and upload again.');
  else throw new Error(`Unsupported file type ".${ext}" - upload a Word (.docx) or PDF file.`);
  text = text.replace(/\u0000/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) throw new Error('No readable text found in the file.');
  return { text: text.slice(0, MAX_TEXT_CHARS), chars: text.length, pages, method };
}

// ---------- spreadsheets ----------

function columnIndex(ref) {
  const letters = ref.replace(/\d+/g, '');
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function excelSerialToIso(serial) {
  return new Date(Math.round((serial - 25569) * 86400000)).toISOString().slice(0, 10);
}

function xlsxToRows(buf) {
  const files = unzip(buf);
  const shared = [];
  if (files['xl/sharedStrings.xml']) {
    for (const si of strFromU8(files['xl/sharedStrings.xml']).match(/<si>[\s\S]*?<\/si>/g) || []) {
      const parts = [...si.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(m => m[1]);
      shared.push(decodeXmlEntities(parts.join('')));
    }
  }
  const sheetPath = Object.keys(files).filter(p => /^xl\/worksheets\/sheet\d+\.xml$/.test(p)).sort()[0];
  if (!sheetPath) throw new Error('No worksheet found in this Excel file');
  const rows = [];
  for (const rowXml of strFromU8(files[sheetPath]).match(/<row[\s\S]*?<\/row>/g) || []) {
    const cells = [];
    for (const m of rowXml.matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = m[1]; const inner = m[2] || '';
      const ref = (attrs.match(/r="([A-Z]+\d+)"/) || [])[1];
      const type = (attrs.match(/t="(\w+)"/) || [])[1];
      const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      let value = '';
      if (type === 's') value = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') value = decodeXmlEntities([...inner.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(x => x[1]).join(''));
      else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
      else value = v != null ? decodeXmlEntities(v) : '';
      cells[ref ? columnIndex(ref) : cells.length] = value;
    }
    if (cells.some(c => c !== undefined && String(c).trim() !== '')) rows.push(Array.from(cells, c => (c == null ? '' : String(c))));
  }
  return rows;
}

/**
 * @param {{filename: string, base64?: string, text?: string}} upload
 * @returns {{header: string[], rows: object[]}} rows keyed by lower-cased header
 */
function parseSpreadsheet(upload) {
  let matrix;
  if (upload.text != null) matrix = parseCsv(String(upload.text).trim());
  else {
    const { buf, ext } = decodeUpload(upload);
    if (ext === 'xlsx') matrix = xlsxToRows(buf);
    else if (['csv', 'txt'].includes(ext)) matrix = parseCsv(buf.toString('utf8').trim());
    else if (ext === 'xls') throw new Error('Old .xls files are not supported - save it as .xlsx or .csv and upload again.');
    else throw new Error(`Unsupported file type ".${ext}" - upload .xlsx or .csv`);
  }
  if (matrix.length < 2) throw new Error('The file needs a header row and at least one data row');
  const header = matrix[0].map(h => String(h).trim().toLowerCase());
  const rows = matrix.slice(1).map(cells => Object.fromEntries(header.map((h, i) => [h, (cells[i] ?? '').toString().trim()])));
  return { header, rows };
}

module.exports = { extractText, parseSpreadsheet, excelSerialToIso, docxToText, xlsxToRows };
