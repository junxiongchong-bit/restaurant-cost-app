// ═══════════════════════════════════════════════════════════════════════════
// GMAIL → CLAUDE AI → INVOICE QUEUE
// Restaurant Cost Control App — Email Invoice Pipeline
//
// SETUP INSTRUCTIONS (run once):
//   1. Open Google Apps Script: https://script.google.com
//   2. Paste this entire file into Code.gs
//   3. Run setup() once — it creates your Google Sheet automatically
//   4. Go to Project Settings → Script Properties → Add property:
//        CLAUDE_API_KEY  →  your sk-ant-... key
//      (SHEET_ID is set automatically by setup())
//   5. Deploy as Web App:
//        Deploy → New Deployment → Web App
//        Execute as: Me | Who has access: Anyone
//        Copy the Web App URL → paste into your cost app Settings
//   6. Add time trigger:
//        Triggers → + Add Trigger
//        Function: checkNewInvoices | Event: Time-driven | Every 10 minutes
// ═══════════════════════════════════════════════════════════════════════════

// ── SUPPLIER WHITELIST ───────────────────────────────────────────────────────
// Add your supplier email addresses here (or partial domains).
// The script only processes emails from these senders.
const SUPPLIER_WHITELIST = [
  'invoices@bidvest.com.au',
  'orders@romafoods.com.au',
  'noreply@sysco.com',
  // Add more supplier emails here...
];

const SHEET_NAME = 'PendingInvoices';

// ── TIME TRIGGER FUNCTION ────────────────────────────────────────────────────
// Called automatically every 10 minutes by the time trigger.
function checkNewInvoices() {
  const props   = PropertiesService.getScriptProperties();
  const apiKey  = props.getProperty('CLAUDE_API_KEY');
  const sheetId = props.getProperty('SHEET_ID');

  if (!apiKey)  { Logger.log('ERROR: CLAUDE_API_KEY not set in Script Properties'); return; }
  if (!sheetId) { Logger.log('ERROR: SHEET_ID not set — run setup() first'); return; }

  const sheet = SpreadsheetApp.openById(sheetId).getSheetByName(SHEET_NAME);
  if (!sheet)   { Logger.log('ERROR: Sheet "' + SHEET_NAME + '" not found'); return; }

  // Build Gmail search query for whitelisted senders with attachments
  const fromQuery = SUPPLIER_WHITELIST.map(e => 'from:' + e).join(' OR ');
  const threads   = GmailApp.search('is:unread has:attachment (' + fromQuery + ')', 0, 50);

  let processed = 0;
  threads.forEach(function(thread) {
    thread.getMessages().forEach(function(msg) {
      if (!msg.isUnread()) return;

      // Parse sender name and email
      const fromRaw     = msg.getFrom();
      const senderEmail = (fromRaw.match(/<(.+?)>/) || [, fromRaw])[1].toLowerCase();
      const senderName  = fromRaw.replace(/<.+?>/, '').trim().replace(/^"|"$/g, '') || senderEmail;

      // Confirm sender is whitelisted
      const isWhitelisted = SUPPLIER_WHITELIST.some(function(e) {
        return senderEmail.includes(e.toLowerCase());
      });
      if (!isWhitelisted) return;

      // Find PDF attachments
      const pdfs = msg.getAttachments().filter(function(att) {
        return att.getContentType() === 'application/pdf' ||
               att.getName().toLowerCase().endsWith('.pdf');
      });

      if (pdfs.length === 0) {
        msg.markRead(); // No PDF — mark read and skip
        return;
      }

      pdfs.forEach(function(att) {
        try {
          const extracted = extractWithClaude(att, apiKey);
          if (extracted && extracted.length > 0) {
            appendToSheet(sheet, {
              id:           Utilities.getUuid(),
              receivedDate: Utilities.formatDate(msg.getDate(), Session.getScriptTimeZone(), 'yyyy-MM-dd'),
              supplierName: senderName,
              supplierEmail: senderEmail,
              filename:     att.getName(),
              status:       'pending',
              extractedJson: JSON.stringify(extracted),
              messageId:    msg.getId()
            });
            processed++;
            Logger.log('Queued: ' + att.getName() + ' from ' + senderEmail + ' (' + extracted.length + ' items)');
          }
        } catch (err) {
          Logger.log('ERROR processing ' + att.getName() + ': ' + err.toString());
        }
      });

      msg.markRead();
    });
  });

  Logger.log('Done. ' + processed + ' invoice(s) queued.');
}

// ── CLAUDE API EXTRACTION ────────────────────────────────────────────────────
function extractWithClaude(attachment, apiKey) {
  const pdfBase64 = Utilities.base64Encode(attachment.getBytes());

  const prompt =
    'Extract all product/ingredient line items from this supplier invoice. Return ONLY a valid JSON array, no markdown.\n' +
    'Each object: name(string), buy_unit(string: carton/case/bag/box/each/dozen/kg/L/lb/g/ml), buy_qty(number), ' +
    'total_price(number for this line), pack_count(number or null), pack_size(number or null), ' +
    'pack_unit(string: g/ml/kg/L), recipe_unit(string: g/ml/each), notes(string or "").\n' +
    'Examples:\n' +
    '"1 carton 6×800g cans @ $36" → {buy_unit:"carton",buy_qty:1,total_price:36,pack_count:6,pack_size:800,pack_unit:"g",recipe_unit:"g"}\n' +
    '"5kg flour $12" → {buy_unit:"kg",buy_qty:5,total_price:12,pack_count:null,pack_size:null,pack_unit:"g",recipe_unit:"g"}';

  const payload = {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 }
        },
        { type: 'text', text: prompt }
      ]
    }]
  };

  const response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method:            'POST',
    headers: {
      'Content-Type':    'application/json',
      'x-api-key':       apiKey,
      'anthropic-version': '2023-06-01'
    },
    payload:           JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const result = JSON.parse(response.getContentText());
  if (result.error) throw new Error(result.error.message);

  const text    = result.content[0].text.trim();
  const cleaned = text.replace(/^```json\n?|\n?```$/g, '').trim();
  return JSON.parse(cleaned);
}

// ── SHEET HELPERS ────────────────────────────────────────────────────────────
const HEADERS = ['id', 'receivedDate', 'supplierName', 'supplierEmail', 'filename', 'status', 'extractedJson', 'messageId'];

function ensureHeaders(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold').setBackground('#f0f0f0');
    sheet.setFrozenRows(1);
  }
}

function appendToSheet(sheet, data) {
  ensureHeaders(sheet);
  sheet.appendRow(HEADERS.map(function(h) { return data[h] || ''; }));
}

// ── WEB APP: GET pending invoices ────────────────────────────────────────────
function doGet(e) {
  try {
    const sheet = getSheet();
    const rows  = getRows(sheet);
    const pending = rows.filter(function(r) { return r.status === 'pending'; })
      .map(function(r) {
        return {
          id:           r.id,
          receivedDate: r.receivedDate,
          supplierName: r.supplierName,
          supplierEmail: r.supplierEmail,
          filename:     r.filename,
          extractedJson: JSON.parse(r.extractedJson || '[]')
        };
      });
    return json({ ok: true, pending: pending });
  } catch (err) {
    return json({ ok: false, error: err.toString() });
  }
}

// ── WEB APP: POST mark invoice status ────────────────────────────────────────
// Body: { id: "...", action: "imported" | "skipped" }
function doPost(e) {
  try {
    const body   = JSON.parse(e.postData.contents);
    const sheet  = getSheet();
    const data   = sheet.getDataRange().getValues();
    const idCol  = HEADERS.indexOf('id');
    const staCol = HEADERS.indexOf('status');

    for (var i = 1; i < data.length; i++) {
      if (data[i][idCol] === body.id) {
        sheet.getRange(i + 1, staCol + 1).setValue(body.action);
        break;
      }
    }
    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: err.toString() });
  }
}

// ── HELPERS ──────────────────────────────────────────────────────────────────
function getSheet() {
  const props   = PropertiesService.getScriptProperties();
  const sheetId = props.getProperty('SHEET_ID');
  if (!sheetId) throw new Error('SHEET_ID not configured — run setup() first');
  return SpreadsheetApp.openById(sheetId).getSheetByName(SHEET_NAME);
}

function getRows(sheet) {
  const data    = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  const headers = data[0];
  return data.slice(1).map(function(row) {
    var obj = {};
    headers.forEach(function(h, i) { obj[h] = row[i]; });
    return obj;
  });
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── ONE-TIME SETUP ───────────────────────────────────────────────────────────
// Run this function ONCE from the Apps Script editor to create the sheet.
function setup() {
  const ss    = SpreadsheetApp.create('Invoice Queue — Restaurant Cost App');
  const sheet = ss.getActiveSheet();
  sheet.setName(SHEET_NAME);
  ensureHeaders(sheet);

  PropertiesService.getScriptProperties().setProperty('SHEET_ID', ss.getId());

  Logger.log('');
  Logger.log('=== SETUP COMPLETE ===');
  Logger.log('Sheet created: ' + ss.getUrl());
  Logger.log('SHEET_ID saved to Script Properties.');
  Logger.log('');
  Logger.log('Next steps:');
  Logger.log('1. Script Properties → add CLAUDE_API_KEY = sk-ant-...');
  Logger.log('2. Edit SUPPLIER_WHITELIST array in Code.gs with your supplier emails');
  Logger.log('3. Deploy → New Deployment → Web App (Execute as: Me, Access: Anyone)');
  Logger.log('4. Copy the Web App URL → paste into cost app Settings → Gmail Invoice Queue URL');
  Logger.log('5. Triggers → + Add Trigger → checkNewInvoices → Time-driven → Every 10 minutes');
}
